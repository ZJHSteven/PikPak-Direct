import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  assertSafeQuickTunnelOrigin,
  createQuickTunnel,
  parseTryCloudflareUrl,
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
    queueMicrotask(() => child.stderr.write(
      'INF Requesting new quick Tunnel\nhttps://route-b-smoke.trycloudflare.com\n',
    ));
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
