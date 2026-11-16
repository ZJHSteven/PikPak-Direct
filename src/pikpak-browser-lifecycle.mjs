// PikPak Route A 的浏览器 / 标签页生命周期管理。
//
// 这个模块只管理“控制面”：连接已经长期运行的日常 CDP Chrome、复用本工具创建的
// PikPak 标签页、必要时完成邮箱密码登录，并在最后一个使用者退出后只关闭本工具自己的 tab。
//
// 9222 Chrome 是用户的共享日常基础设施，不属于 PikPak-Direct：本项目永远不 spawn Chrome，
// 也永远不调用 Browser.close。这样不会因为启动参数漂移制造第二个 Chrome 实例，也不会误关
// ChatGPT Archive CLI / 用户 / 其他 Agent 正在共用的浏览器。
// 上传正文仍然完全由 Node -> Aliyun OSS 完成，绝不会经过这里。

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

export const PIKPAK_MANAGED_WINDOW_NAME = 'pikpak-direct:managed-control-plane:v1';
export const PIKPAK_DRIVE_URL = 'https://mypikpak.com/drive/';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const LEASE_STATE_PATH = join(tmpdir(), 'pikpak-direct-browser-lease.json');
const LEASE_LOCK_PATH = `${LEASE_STATE_PATH}.lock`;
const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程仍存活时返回 true；EPERM 也视为“活着但无权发信号”。 */
function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function withLeaseLock(fn) {
  const started = Date.now();
  while (true) {
    let handle = null;
    try {
      handle = await open(LEASE_LOCK_PATH, 'wx');
      return await fn();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Agent/CLI 被强杀时可能遗留 lock；超过 15 秒视为 stale，下一位执行者可回收。
      try {
        const info = await stat(LEASE_LOCK_PATH);
        if (Date.now() - info.mtimeMs > 15_000) {
          await unlink(LEASE_LOCK_PATH).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 10_000) {
        throw new Error('等待 PikPak 浏览器租约锁超时。');
      }
      await sleep(50);
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
        await unlink(LEASE_LOCK_PATH).catch(() => {});
      }
    }
  }
}

async function readLeaseState() {
  try {
    const state = JSON.parse(await readFile(LEASE_STATE_PATH, 'utf8'));
    state.holders = Array.isArray(state.holders)
      ? state.holders.filter((holder) => isPidAlive(holder?.pid))
      : [];
    return state;
  } catch {
    return { targetId: null, holders: [] };
  }
}

async function writeLeaseState(state) {
  await writeFile(LEASE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, timeoutMs = 3_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function listTargets(cdpUrl) {
  return fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/list`);
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  };
  await opened;
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluateTarget(target, expression) {
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面执行失败');
    }
    return result.result?.value;
  } finally {
    cdp.close();
  }
}

async function targetHasMarker(target) {
  try {
    return await evaluateTarget(target, 'window.name') === PIKPAK_MANAGED_WINDOW_NAME;
  } catch {
    return false;
  }
}

async function findManagedTarget(cdpUrl, preferredTargetId = null) {
  const targets = (await listTargets(cdpUrl)).filter((target) => target.type === 'page');
  // 9222 是用户长期使用的日常 Chrome，可能同时存在几十/上百个普通页面。旧实现当
  // state.targetId 丢失时会逐个连所有 page target，只为了读 window.name；任何一个页面
  // 的 CDP WebSocket 异常都可能拖住整个 acquire，而且无意义地触碰了用户所有日常 Tab。
  //
  // 受管 PikPak tab 在正常状态下一定满足以下两种情况之一：
  // 1. lease state 仍保存精确 targetId（包括刚 createTarget 后尚处于 about:blank 的短窗口）；
  // 2. state 丢失/进程重启，但页面已经导航到 mypikpak.com/drive，可通过 URL 缩小候选集。
  // 因此只检查 preferred target + PikPak Drive 页面，普通网页连 WebSocket 都不会打开。
  const preferred = preferredTargetId
    ? targets.filter((target) => target.id === preferredTargetId)
    : [];
  const pikpakCandidates = targets.filter(
    (target) => target.id !== preferredTargetId && String(target.url || '').includes('mypikpak.com/drive'),
  );
  const ordered = [...preferred, ...pikpakCandidates];
  for (const target of ordered) {
    if (await targetHasMarker(target)) return target;
  }
  return null;
}

async function createManagedTarget(cdpUrl) {
  const version = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`);
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  let targetId;
  try {
    ({ targetId } = await browser.call('Target.createTarget', { url: 'about:blank' }));
  } finally {
    browser.close();
  }

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    target = (await listTargets(cdpUrl)).find((candidate) => candidate.id === targetId);
    if (!target) await sleep(50);
  }
  if (!target) throw new Error('创建 PikPak 受管标签页后无法重新定位 target。');

  await evaluateTarget(target, `window.name=${JSON.stringify(PIKPAK_MANAGED_WINDOW_NAME)}; true`);
  return target;
}

async function closeManagedTarget(cdpUrl, targetId) {
  const target = (await listTargets(cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target || !(await targetHasMarker(target))) return false;
  const version = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`);
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  try {
    const result = await browser.call('Target.closeTarget', { targetId });
    return Boolean(result?.success);
  } finally {
    browser.close();
  }
}

async function ensureCdpAvailable({ cdpUrl }) {
  // 固定 9222 的端口「有响应」不代表就是原来已登录的那一个 Chrome：
  // 忘记给 --user-data-dir 中的 User Data 加引号，会生成另一个 User 目录；
  // Windows 还可能让新旧 Chrome 分别监听 IPv4 / IPv6 的 9222。
  // 在创建任何受管标签页之前先核验实际 PID 与完整 Profile；绝不接管错误实例。
  if (process.platform === 'win32' && cdpUrl.replace(/\/$/, '') === DEFAULT_CDP_URL) {
    const identityScript = 'D:\\Workspace\\browser-harness-js\\sdk\\ensure-daily-chrome.ps1';
    try {
      await execFileAsync('pwsh.exe', ['-NoProfile', '-File', identityScript, '-CheckOnly'], {
        windowsHide: true,
        timeout: 15_000,
      });
    } catch (cause) {
      const error = new Error(`CDP_IDENTITY_INVALID: 日常 Chrome 9222 不满足唯一正确 Profile 的条件：${cause.message}`);
      error.code = 'CDP_IDENTITY_INVALID';
      throw error;
    }
  }
  try {
    await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`, 1_000);
    return;
  } catch {
    const error = new Error(`日常 CDP Chrome 不可达: ${cdpUrl}。PikPak-Direct 不会自行启动第二个 Chrome，请先启动“Chrome CDP 日常用”。`);
    error.code = 'CDP_UNAVAILABLE';
    throw error;
  }
}

export function classifyPikPakAuthSnapshot(snapshot) {
  if (snapshot?.captcha) return 'captcha-required';
  if (snapshot?.authError) return 'auth-failed';
  if (!String(snapshot?.href || '').includes('/login')) return 'logged-in';
  return 'login-required';
}

function authSnapshotExpression() {
  return `(()=>{const text=(document.body?.innerText||'');const captcha=Boolean(
    document.querySelector('[class*="captcha" i],[id*="captcha" i],iframe[src*="captcha" i],iframe[src*="challenge" i]')
    || /验证码|人机验证|captcha|verify you are human|security verification/i.test(text)
  );const authError=/密码.*错误|账号.*错误|登录失败|incorrect password|invalid credentials/i.test(text);
  return {href:location.href,ready:document.readyState,captcha,authError,text:text.slice(0,1200)};})()`;
}

export function buildEmailLoginExpression(account, password) {
  return `(()=>{const inputs=[...document.querySelectorAll('input')];
    const email=inputs.find(e=>e.autocomplete==='email'||e.placeholder?.includes('邮箱'));
    const pass=inputs.find(e=>e.type==='password'||e.autocomplete==='current-password');
    if(!email||!pass)return {ok:false,reason:'email-login-inputs-missing'};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(email,${JSON.stringify(String(account || ''))});
    email.dispatchEvent(new Event('input',{bubbles:true}));
    email.dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(pass,${JSON.stringify(String(password || ''))});
    pass.dispatchEvent(new Event('input',{bubbles:true}));
    pass.dispatchEvent(new Event('change',{bubbles:true}));
    const button=[...document.querySelectorAll('[role="button"],button')]
      .find(e=>(e.innerText||'').trim()==='登录');
    if(!button)return {ok:false,reason:'login-button-missing'};
    button.click();
    return {ok:true};
  })()`;
}

async function ensureDriveAndLogin(target, {
  account = process.env.PIKPAK_ACCOUNT || '',
  password = process.env.PIKPAK_PASSWORD || '',
  loginTimeoutMs = 30_000,
} = {}) {
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.call('Page.enable');
    await cdp.call('Runtime.evaluate', {
      expression: `window.name=${JSON.stringify(PIKPAK_MANAGED_WINDOW_NAME)}; true`,
      returnByValue: true,
    });
    await cdp.call('Page.navigate', { url: PIKPAK_DRIVE_URL });

    let snapshot = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      const result = await cdp.call('Runtime.evaluate', {
        expression: authSnapshotExpression(),
        returnByValue: true,
      });
      snapshot = result.result?.value;
      if (snapshot?.ready === 'complete' && snapshot?.href) break;
    }
    let state = classifyPikPakAuthSnapshot(snapshot);
    if (state === 'logged-in') return;
    if (state === 'captcha-required') {
      const error = new Error('PikPak 登录需要人工完成人机验证。');
      error.code = 'CAPTCHA_REQUIRED';
      throw error;
    }

    // 登录首页默认只显示 OAuth；邮箱/密码入口藏在底部 icon-email。
    await cdp.call('Runtime.evaluate', {
      expression: `document.querySelector('.icon-email')?.parentElement?.click(); true`,
      returnByValue: true,
    });
    await sleep(250);
    if (!account || !password) {
      const error = new Error('PikPak 当前未登录，且没有提供 PIKPAK_ACCOUNT / PIKPAK_PASSWORD。');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }

    const fill = await cdp.call('Runtime.evaluate', {
      expression: buildEmailLoginExpression(account, password),
      returnByValue: true,
    });
    if (!fill.result?.value?.ok) {
      const error = new Error(`PikPak 邮箱登录表单不可用: ${fill.result?.value?.reason || 'unknown'}`);
      error.code = 'LOGIN_FORM_CHANGED';
      throw error;
    }

    const started = Date.now();
    while (Date.now() - started <= loginTimeoutMs) {
      await sleep(250);
      const result = await cdp.call('Runtime.evaluate', {
        expression: authSnapshotExpression(),
        returnByValue: true,
      });
      snapshot = result.result?.value;
      state = classifyPikPakAuthSnapshot(snapshot);
      if (state === 'logged-in') return;
      if (state === 'captcha-required') {
        const error = new Error('PikPak 登录触发人机验证；受管标签页将保留，完成验证后可重试命令。');
        error.code = 'CAPTCHA_REQUIRED';
        throw error;
      }
      if (state === 'auth-failed') {
        const error = new Error('PikPak 登录失败；请检查账号/密码或登录风控状态。');
        error.code = 'AUTH_FAILED';
        throw error;
      }
    }
    const error = new Error('PikPak 登录在等待窗口内未完成。');
    error.code = 'LOGIN_TIMEOUT';
    throw error;
  } finally {
    cdp.close();
  }
}

/**
 * 获取一个 Route A 控制面 lease。
 *
 * 重要性质：
 * - 只复用 window.name 带本项目 marker 的 tab；普通 PikPak 页面绝不被认领或关闭。
 * - holder 写入共享 lease state；多个 CLI 可以同时 attach 同一 tab。
 * - 最后一个 holder release 时才关闭受管 tab。
 * - 登录需要人工验证码时保留 tab，便于用户在真实 Chrome 中完成挑战后重试。
 */
export async function acquirePikPakBrowserLease({
  cdpUrl = DEFAULT_CDP_URL,
  account = process.env.PIKPAK_ACCOUNT || '',
  password = process.env.PIKPAK_PASSWORD || '',
} = {}) {
  const holder = { id: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() };
  let target;

  await withLeaseLock(async () => {
    let state = await readLeaseState();

    // 生命周期 state 只有一份。若上一次实验使用的是另一 CDP 且已经没有活 holder，
    // 可以安全重置；若仍有活 holder，则拒绝混用，避免两个端口互相关闭 target。
    if (state.cdpUrl && state.cdpUrl !== cdpUrl) {
      if (state.holders.length > 0) {
        throw new Error(`另一个 CDP (${state.cdpUrl}) 仍持有 PikPak BrowserLease。`);
      }
      state = { targetId: null, holders: [] };
    }

    // 9222 Chrome 是共享日常基础设施，只验证可达性；绝不在这里启动/关闭浏览器进程。
    await ensureCdpAvailable({ cdpUrl });
    // 兼容清理旧版本残留的 ownership 字段，避免未来版本误以为浏览器归本项目所有。
    delete state.browserOwned;
    delete state.browserPid;
    delete state.browserStartedAt;
    delete state.browserReleaseReason;

    target = await findManagedTarget(cdpUrl, state.targetId);
    if (!target) target = await createManagedTarget(cdpUrl);
    state.targetId = target.id;
    state.cdpUrl = cdpUrl;
    state.holders.push(holder);
    state.updatedAt = new Date().toISOString();
    await writeLeaseState(state);
  });

  try {
    // createTarget 后 target 的 ws URL 已固定；导航不会改变 target id。
    target = (await listTargets(cdpUrl)).find((candidate) => candidate.id === target.id) || target;
    await ensureDriveAndLogin(target, { account, password });
  } catch (error) {
    await releasePikPakBrowserLease({
      cdpUrl,
      targetId: target.id,
      holderId: holder.id,
      keepAlive: error?.code === 'CAPTCHA_REQUIRED' || error?.code === 'LOGIN_REQUIRED',
    });
    throw error;
  }

  target = (await listTargets(cdpUrl)).find((candidate) => candidate.id === target.id) || target;
  return {
    cdpUrl,
    target,
    holderId: holder.id,
    async release(options = {}) {
      await releasePikPakBrowserLease({
        cdpUrl,
        targetId: target.id,
        holderId: holder.id,
        keepAlive: Boolean(options.keepAlive),
      });
    },
  };
}

async function releasePikPakBrowserLease({ cdpUrl, targetId, holderId, keepAlive = false }) {
  await withLeaseLock(async () => {
    const state = await readLeaseState();
    state.holders = state.holders.filter((holder) => holder.id !== holderId);
    const isSameTarget = state.targetId === targetId;
    const shouldCloseTarget = isSameTarget && state.holders.length === 0 && !keepAlive;

    if (shouldCloseTarget) {
      // 在同一 lifecycle lock 内完成关闭，避免“最后一个 holder 判空”与下一位 acquire 交错。
      await closeManagedTarget(cdpUrl, targetId).catch(() => {});
      state.targetId = null;

    }

    state.updatedAt = new Date().toISOString();
    await writeLeaseState(state);
  });
}
