// Route B Named Tunnel 的纯离线单元测试。
// 不连接 Cloudflare，只用假的 child_process 验证：
// - 固定公网入口参数边界；
// - Tunnel token 只进环境变量，不进入 argv；
// - 必须等 Registered tunnel connection 才 ready；
// - HEAD gate 可等待 connector / origin 收敛。

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createNamedTunnelConnector,
  validateNamedTunnelRoute,
  waitForNamedTunnelFileHead,
} from '../src/cloudflare-named-tunnel.mjs';

test('Named Tunnel 只接受固定 HTTPS origin + loopback origin', () => {
  assert.deepEqual(validateNamedTunnelRoute(), {
    publicBaseUrl: 'https://pikpak-pull.zjhstudio.com',
    originHost: '127.0.0.1',
    originPort: 18765,
  });
  assert.throws(
    () => validateNamedTunnelRoute({ publicBaseUrl: 'https://example.com/path' }),
    /纯 HTTPS origin/,
  );
  assert.throws(
    () => validateNamedTunnelRoute({ originHost: '0.0.0.0' }),
    /只允许 127\.0\.0\.1/,
  );
});

test('Named Tunnel token 只进 child env，不进入 cloudflared argv', async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4321;
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    };
    queueMicrotask(() => {
      child.stderr.write('INF Registered tunnel connection connIndex=0 protocol=quic\n');
    });
    return child;
  };

  const token = 'unit-test-secret-token';
  const connector = await createNamedTunnelConnector({
    token,
    cloudflaredPath: 'cloudflared-test',
    spawnImpl: fakeSpawn,
  });

  assert.deepEqual(calls[0].args, [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    'run',
  ]);
  assert.equal(calls[0].args.includes(token), false);
  assert.equal(calls[0].options.env.TUNNEL_TOKEN, token);
  assert.equal(calls[0].options.windowsHide, true);
  await connector.close();
});

test('Named Tunnel 缺 token 时明确失败，不回退 Quick Tunnel', async () => {
  await assert.rejects(
    createNamedTunnelConnector({ token: '' }),
    (error) => error?.code === 'ROUTEB_TUNNEL_TOKEN_REQUIRED',
  );
});

test('Named Tunnel 公网 HEAD gate 容忍 connector/origin 短暂未就绪', async () => {
  let attempts = 0;
  const response = await waitForNamedTunnelFileHead({
    url: 'https://pikpak-pull.zjhstudio.com/file/token/x.bin',
    expectedSize: 1024,
    timeoutMs: 2_000,
    intervalMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return new Response(null, { status: 502 });
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': '1024' },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});
