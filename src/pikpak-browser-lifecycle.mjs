// PikPak Route A 的浏览器 / 标签页生命周期管理。
//
// 这个模块只管理“控制面”：确保一个可连接的本机 CDP Chrome 存在、复用本工具创建的
// PikPak 标签页、必要时完成邮箱密码登录，并在最后一个使用者退出后只关闭本工具自己的 tab。
// 如果 Chrome 本身也是本工具启动的，则还会在“没有任何外来页面”的前提下关闭整个浏览器；
// 一旦观察到其他 Agent/用户页面，就主动放弃浏览器级 ownership，绝不为了省内存误关别人的工作。
// 上传正文仍然完全由 Node -> Aliyun OSS 完成，绝不会经过这里。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export const PIKPAK_MANAGED_WINDOW_NAME = 'pikpak-direct:managed-control-plane:v1';
export const PIKPAK_DRIVE_URL = 'https://mypikpak.com/drive/';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_CHROME_PROFILE = 'D:\\AppData\\Chrome\\Chrome-CDP\\User Data';
const LEASE_STATE_PATH = join(tmpdir(), 'pikpak-direct-browser-lease.json');
const LEASE_LOCK_PATH = `${LEASE_STATE_PATH}.lock`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只允许自动启动本机 loopback CDP，避免误把“浏览器启动”逻辑指向远程地址。 */
export function parseLocalCdpUrl(cdpUrl) {
  const url = new URL(cdpUrl);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (!isLoopback || url.protocol !== 'http:') return null;
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: url.hostname, port };
}

/**
 * 判断一个 page target 是否只是 Chrome 启动时自动留下的空白页。
 * 只有这些页面存在时，本工具才允许关闭自己启动的整个 Chrome。
 */
export function isIgnorableBrowserPageUrl(url) {
  const value = String(url || '').replace(/\/$/, '');
  return value === 'about:blank'
    || value === 'chrome://newtab'
    || value === 'chrome://new-tab-page';
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
  const ordered = preferredTargetId
    ? [...targets.filter((t) => t.id === preferredTargetId), ...targets.filter((t) => t.id !== preferredTargetId)]
    : targets;
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

/**
 * 仅在不存在外来 page target 时关闭整个 Browser。
 *
 * 调用方必须已经确认这个 Chrome 是 PikPak-Direct 自己启动的。这里仍做第二层保护：
 * 任何非 about:blank / Chrome New Tab 的页面都会阻止 Browser.close。
 */
async function closeOwnedBrowserIfIdle(cdpUrl) {
  const pages = (await listTargets(cdpUrl)).filter((target) => target.type === 'page');
  const foreignPages = pages.filter((target) => !isIgnorableBrowserPageUrl(target.url));
  if (foreignPages.length > 0) {
    return { closed: false, reason: 'foreign-pages', foreignPageCount: foreignPages.length };
  }

  const version = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`);
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  try {
    await browser.call('Browser.close');
    return { closed: true, reason: 'idle-owned-browser' };
  } finally {
    browser.close();
  }
}

async function ensureCdpAvailable({
  cdpUrl,
  chromePath = process.env.PIKPAK_CHROME_PATH || DEFAULT_CHROME_PATH,
  chromeProfile = process.env.PIKPAK_CHROME_PROFILE || DEFAULT_CHROME_PROFILE,
}) {
  try {
    await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`, 1_000);
    return { startedBrowser: false };
  } catch {
    const local = parseLocalCdpUrl(cdpUrl);
    if (!local) throw new Error(`CDP 不可达且不是可自动启动的本机地址: ${cdpUrl}`);
    if (cdpUrl !== DEFAULT_CDP_URL && !process.env.PIKPAK_ALLOW_CUSTOM_CDP_AUTOSTART) {
      throw new Error(`CDP 不可达: ${cdpUrl}；自定义端口默认不自动启动 Chrome。`);
    }
    const child = spawn(chromePath, [
      `--remote-debugging-port=${local.port}`,
      `--user-data-dir=${chromeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      try {
        await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/version`, 500);
        return { startedBrowser: true, browserPid: child.pid };
      } catch {
        // 继续等 Chrome 初始化；总上限约 15 秒。
      }
    }
    throw new Error(`已启动 Chrome 但 15 秒内仍无法连接 CDP: ${cdpUrl}`);
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

    // 把“检查 + 必要时启动 Chrome”也放进同一个跨进程锁，避免 9222 同时不可达时
    // 三个 CLI 一起 spawn 三个 Chrome。
    const availability = await ensureCdpAvailable({ cdpUrl });
    if (availability.startedBrowser) {
      state.browserOwned = true;
      state.browserPid = availability.browserPid || null;
      state.browserStartedAt = new Date().toISOString();
    } else if (state.browserOwned && state.browserPid && !isPidAlive(state.browserPid)) {
      // state 残留但原 owner 已不存在，宁可放弃 ownership，也绝不能猜测当前 Chrome 仍归我们。
      state.browserOwned = false;
      state.browserPid = null;
    }

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

      if (state.browserOwned && state.cdpUrl === cdpUrl) {
        try {
          const browserResult = await closeOwnedBrowserIfIdle(cdpUrl);
          // 无论是成功关闭，还是因为发现外来页面而拒绝关闭，都不再保留 browser ownership：
          // 后者说明这个 Chrome 已经变成共享资源，未来命令不得伺机把它关掉。
          state.browserOwned = false;
          state.browserPid = null;
          state.browserReleaseReason = browserResult.reason;
        } catch {
          // 无法证明浏览器仍归自己/仍空闲时，一律放弃 ownership，不做进程级强杀。
          state.browserOwned = false;
          state.browserPid = null;
          state.browserReleaseReason = 'browser-close-unverified';
        }
      }
    }

    state.updatedAt = new Date().toISOString();
    await writeLeaseState(state);
  });
}
