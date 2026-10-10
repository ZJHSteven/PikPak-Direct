// Cloudflare Quick Tunnel 的一次性生命周期封装。
//
// Route B 只把一个已经绑定在 127.0.0.1 的临时单文件 HTTP 源站暴露出去。
// 这里不创建命名 Tunnel、不修改 DNS、不安装 Service，也不读取任何 Cloudflare 凭据。
// cloudflared 进程退出后，随机 trycloudflare.com URL 随即失效。

import { spawn } from 'node:child_process';

const DEFAULT_CLOUDFLARED_PATH = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 cloudflared 普通日志中提取 Quick Tunnel 的随机公网 URL。 */
export function parseTryCloudflareUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

/** 只接受 loopback HTTP origin，禁止这个模块顺手把局域网服务暴露出去。 */
export function assertSafeQuickTunnelOrigin(localUrl) {
  const url = new URL(localUrl);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !isLoopback) {
    throw new Error('Quick Tunnel origin 必须是本机 loopback HTTP 地址。');
  }
  return url;
}

/**
 * 等待 Quick Tunnel 真正从公网可用。
 *
 * cloudflared 打印随机 URL 只代表“URL 已分配”，Edge/connector 可能还需要短暂收敛。
 * 因此 Route B 不能在拿到字符串的同一毫秒就把 URL 交给 PikPak；这里用 HEAD 做 ready gate，
 * HEAD 不发送文件正文，不会污染 bytesServed。
 */
export async function waitForPublicFileHead({
  url,
  expectedSize,
  timeoutMs = 20_000,
  intervalMs = 500,
  fetchImpl = fetch,
}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(Math.min(5_000, timeoutMs)),
      });
      const size = Number(response.headers.get('content-length'));
      if (response.ok && size === Number(expectedSize)) return response;
      lastError = new Error(`HTTP ${response.status}, Content-Length=${response.headers.get('content-length')}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Quick Tunnel 公网 HEAD 在等待窗口内未就绪: ${lastError?.message || 'unknown'}`);
}

/**
 * 启动一个一次性 Quick Tunnel。
 *
 * @param {{
 *   localUrl: string,
 *   cloudflaredPath?: string,
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawn,
 * }} options
 */
export async function createQuickTunnel({
  localUrl,
  cloudflaredPath = process.env.CLOUDFLARED_PATH || DEFAULT_CLOUDFLARED_PATH,
  timeoutMs = 30_000,
  spawnImpl = spawn,
}) {
  assertSafeQuickTunnelOrigin(localUrl);

  // --no-autoupdate 是隐私/可重复性边界：一次冷备任务不允许后台把二进制自我替换。
  // info 足以拿到随机 URL；不要开 debug，因为 cloudflared 自己的 help 明确提示 debug
  // 可能记录 URL、Header 等敏感请求信息。
  const child = spawnImpl(cloudflaredPath, [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--url',
    localUrl,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let logTail = '';
  let publicBaseUrl = null;
  let registered = false;
  let settled = false;

  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      // 只在内存保留很短的尾部用于故障提示，不写盘。
      logTail = (logTail + text).slice(-8_000);
      publicBaseUrl ||= parseTryCloudflareUrl(logTail);
      registered ||= /Registered tunnel connection/i.test(logTail);

      // 不能只看到 trycloudflare URL 就宣布 ready。cloudflared 自己的 banner 也明确提示
      // “it may take some time to be reachable”；实机还观察到 URL 打印后约 1~2 秒才出现
      // Registered tunnel connection。若这时立即让 Node 做 DNS，可能把未注册阶段的
      // ENOTFOUND/负 DNS 结果缓存进当前进程，后续 HEAD 重试仍连续失败。
      if (publicBaseUrl && registered && !settled) {
        settled = true;
        resolve(publicBaseUrl);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `cloudflared 在 Quick Tunnel 完成注册前退出，code=${code}; ${logTail.slice(-1200)}`,
      ));
    });
  });

  let timeoutHandle;
  try {
    publicBaseUrl = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`等待 Cloudflare Quick Tunnel URL 超时（${timeoutMs} ms）。`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  let closed = false;
  return {
    publicBaseUrl,
    pid: child.pid,
    get logTail() {
      return logTail;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null) return;
      child.kill();

      // Windows/Go 正常情况下会很快退出；最多等 5 秒，避免 CLI 在清理阶段永久挂住。
      for (let i = 0; i < 50 && child.exitCode === null; i += 1) {
        await sleep(100);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
