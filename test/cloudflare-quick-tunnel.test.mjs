import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  assertSafeQuickTunnelOrigin,
  createQuickTunnel,
  parseTryCloudflareUrl,
  waitForPublicFileHead,
} from '../src/cloudflare-quick-tunnel.mjs';

test('parseTryCloudflareUrl 只提取 trycloudflare HTTPS 地址', () => {
  assert.equal(
    parseTryCloudflareUrl('INF Your quick Tunnel has been created! https://quiet-tree-123.trycloudflare.com'),
    'https://quiet-tree-123.trycloudflare.com',
  );
  assert.equal(parseTryCloudflareUrl('https://example.com'), null);
});

test('Quick Tunnel origin 只允许 loopback HTTP', () => {
  assert.equal(assertSafeQuickTunnelOrigin('http://127.0.0.1:18765').port, '18765');
  assert.throws(() => assertSafeQuickTunnelOrigin('http://192.168.1.10:8080'), /loopback/);
  assert.throws(() => assertSafeQuickTunnelOrigin('https://127.0.0.1:8443'), /loopback HTTP/);
});

test('createQuickTunnel 固定关闭自动更新并可从 stderr 拿 URL', async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 1234;
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    };
    queueMicrotask(() => {
      child.stderr.write(
        'INF Requesting new quick Tunnel\nhttps://route-b-smoke.trycloudflare.com\n',
      );
      child.stderr.write(
        'INF Registered tunnel connection connIndex=0 location=lax01 protocol=quic\n',
      );
    });
    return child;
  };

  const tunnel = await createQuickTunnel({
    localUrl: 'http://127.0.0.1:18765',
    cloudflaredPath: 'cloudflared-test',
    spawnImpl: fakeSpawn,
  });
  assert.equal(tunnel.publicBaseUrl, 'https://route-b-smoke.trycloudflare.com');
  assert.deepEqual(calls[0].args, [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--url',
    'http://127.0.0.1:18765',
  ]);
  assert.equal(calls[0].options.windowsHide, true);
  await tunnel.close();
});

test('createQuickTunnel 必须等 Registered tunnel connection，不能只看到 URL 就 ready', async () => {
  let child;
  const fakeSpawn = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 5678;
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    };
    return child;
  };

  let resolved = false;
  const pending = createQuickTunnel({
    localUrl: 'http://127.0.0.1:18765',
    spawnImpl: fakeSpawn,
    cloudflaredPath: 'cloudflared-test',
    timeoutMs: 2_000,
  }).then((value) => {
    resolved = true;
    return value;
  });

  child.stderr.write('INF https://not-yet-ready.trycloudflare.com\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);

  child.stderr.write('INF Registered tunnel connection connIndex=0 protocol=quic\n');
  const tunnel = await pending;
  assert.equal(tunnel.publicBaseUrl, 'https://not-yet-ready.trycloudflare.com');
  await tunnel.close();
});

test('公网 HEAD ready gate 会容忍 Quick Tunnel URL 刚分配时的短暂失败', async () => {
  let attempts = 0;
  const response = await waitForPublicFileHead({
    url: 'https://route-b-smoke.trycloudflare.com/file/token/x.bin',
    expectedSize: 1024,
    timeoutMs: 2_000,
    intervalMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('connector not ready');
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': '1024' },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});

test('Quick Tunnel 控制面首次失败时会有限重试，而不是直接终止 Route B', async () => {
  let spawns = 0;
  const fakeSpawn = () => {
    spawns += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 9000 + spawns;
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    };
    queueMicrotask(() => {
      if (spawns === 1) {
        child.exitCode = 1;
        child.stderr.write('failed to request quick Tunnel: context deadline exceeded\n');
        child.emit('exit', 1);
      } else {
        child.stderr.write('INF https://retry-ok.trycloudflare.com\n');
        child.stderr.write('INF Registered tunnel connection connIndex=0 protocol=quic\n');
      }
    });
    return child;
  };

  const tunnel = await createQuickTunnel({
    localUrl: 'http://127.0.0.1:18765',
    cloudflaredPath: 'cloudflared-test',
    spawnImpl: fakeSpawn,
    maxAttempts: 2,
    retryDelayMs: 1,
  });
  assert.equal(spawns, 2);
  assert.equal(tunnel.publicBaseUrl, 'https://retry-ok.trycloudflare.com');
  await tunnel.close();
});
