// Route B 专用的 Cloudflare Named Tunnel 生命周期封装。
//
// 与历史 Quick Tunnel PoC 不同，这里不创建 Tunnel、不修改 DNS、不申请随机 hostname。
// Cloudflare 侧长期保存一个专用 Remote-managed Tunnel：
//   hostname: pikpak-pull.zjhstudio.com
//   service : http://127.0.0.1:18765
//
// CLI 每次任务只做两件事：
// 1. 在本机 127.0.0.1:18765 临时启动单文件 origin；
// 2. 用已有 Tunnel token 临时启动一个 cloudflared connector。
//
// connector 退出后 DNS/Tunnel 配置仍原样保留；下一次可以在另一台机器上用同一专用
// Tunnel 启动 connector，因此“origin 可以移动，公网地址不变”。

import { spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_CLOUDFLARED_PATH = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

export const DEFAULT_ROUTE_B_PUBLIC_BASE_URL = 'https://pikpak-pull.zjhstudio.com';
export const DEFAULT_ROUTE_B_ORIGIN_HOST = '127.0.0.1';
export const DEFAULT_ROUTE_B_ORIGIN_PORT = 18765;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 校验 Route B 固定入口与本地 origin 参数。
 *
 * publicBaseUrl 只允许 HTTPS origin，不允许携带 path/query/hash/账号信息，避免调用方
 * 不小心把一次性随机路径、token 或额外路由混进“长期基础设施地址”。
 */
export function validateNamedTunnelRoute({
  publicBaseUrl = DEFAULT_ROUTE_B_PUBLIC_BASE_URL,
  originHost = DEFAULT_ROUTE_B_ORIGIN_HOST,
  originPort = DEFAULT_ROUTE_B_ORIGIN_PORT,
} = {}) {
  const publicUrl = new URL(publicBaseUrl);
  if (
    publicUrl.protocol !== 'https:'
    || publicUrl.username
    || publicUrl.password
    || publicUrl.search
    || publicUrl.hash
    || !['', '/'].includes(publicUrl.pathname)
  ) {
    throw new Error('Route B publicBaseUrl 必须是纯 HTTPS origin，例如 https://pikpak-pull.example.com。');
  }
  if (originHost !== '127.0.0.1') {
    throw new Error('Route B named Tunnel origin 只允许 127.0.0.1。');
  }
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65535) {
    throw new Error('Route B originPort 必须是 1~65535 的整数。');
  }
  return {
    publicBaseUrl: publicUrl.origin,
    originHost,
    originPort,
  };
}

/**
 * 等待固定公网 URL 真正命中当前任务的单文件 origin。
 *
 * 使用 HEAD 的原因是它只验证 hostname -> Tunnel -> connector -> origin 的整链连通性，
 * 不发送文件正文，也不会消耗 Route B 的正文读取预算。
 */
export async function waitForNamedTunnelFileHead({
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
        cache: 'no-store',
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

  throw new Error(`Route B 固定公网入口在等待窗口内未命中当前 origin: ${lastError?.message || 'unknown'}`);
}

/**
 * 启动现有 Remote-managed Named Tunnel 的临时 connector。
 *
 * 安全要点：
 * - token 通过子进程环境变量 TUNNEL_TOKEN 传给 cloudflared，不进入 argv，因此不会出现在
 *   常规进程命令行列表中；
 * - 不把 token 写入配置文件或临时文件；
 * - 固定 --no-autoupdate，任务执行中不允许 cloudflared 自行替换二进制；
 * - 只等到 cloudflared 明确打印 Registered tunnel connection 才宣布 connector ready。
 */
export async function createNamedTunnelConnector({
  token = process.env.PIKPAK_ROUTEB_TUNNEL_TOKEN || '',
  cloudflaredPath = process.env.CLOUDFLARED_PATH || DEFAULT_CLOUDFLARED_PATH,
  timeoutMs = 30_000,
  spawnImpl = spawn,
} = {}) {
  if (!token) {
    const error = new Error('缺少 PIKPAK_ROUTEB_TUNNEL_TOKEN；不会动态创建 Quick Tunnel 作为替代。');
    error.code = 'ROUTEB_TUNNEL_TOKEN_REQUIRED';
    throw error;
  }

  const args = [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    'run',
  ];

  const child = spawnImpl(cloudflaredPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // 只在 child 环境里增加 TUNNEL_TOKEN；父进程其他环境保持不变。
    env: {
      ...process.env,
      TUNNEL_TOKEN: token,
    },
  });

  let logTail = '';
  let registered = false;
  let settled = false;

  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      logTail = (logTail + text).slice(-8_000);
      registered ||= /Registered tunnel connection/i.test(logTail);
      if (registered && !settled) {
        settled = true;
        resolve();
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
      reject(new Error(`cloudflared 在 Named Tunnel 注册前退出，code=${code}; ${logTail.slice(-1200)}`));
    });
  });

  let timeoutHandle;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`等待 Cloudflare Named Tunnel connector 注册超时（${timeoutMs} ms）。`)),
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
    pid: child.pid,
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null) return;
      child.kill();

      // 正常 SIGTERM/TerminateProcess 后给 connector 5 秒自行断开；最后才强制结束。
      for (let i = 0; i < 50 && child.exitCode === null; i += 1) {
        await sleep(100);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
