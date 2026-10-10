// 临时单文件 HTTP 源站的离线单元测试。
//
// 测试只访问 127.0.0.1，不建立任何公网连接，也不启动 Cloudflare Tunnel。
// 重点验证：
// - 随机 URL 才能访问文件；
// - HEAD 不发送正文；
// - GET / Range 返回精确字节；
// - 非法路径、非法 Range、非法方法不会泄露内容；
// - 统计值能反映真正发出的文件字节数。

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createTemporaryFileServer,
  parseSingleRange,
} from '../src/temporary-file-server.mjs';

test('parseSingleRange 支持普通、开放结尾和后缀 Range', () => {
  assert.deepEqual(parseSingleRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseSingleRange('bytes=6-', 10), { start: 6, end: 9 });
  assert.deepEqual(parseSingleRange('bytes=-4', 10), { start: 6, end: 9 });

  // end 超过文件末尾时按 HTTP Range 语义截到最后一个字节。
  assert.deepEqual(parseSingleRange('bytes=8-999', 10), { start: 8, end: 9 });
});

test('parseSingleRange 拒绝越界、多段和空 Range', () => {
  assert.equal(parseSingleRange('bytes=10-11', 10), null);
  assert.equal(parseSingleRange('bytes=5-4', 10), null);
  assert.equal(parseSingleRange('bytes=0-1,3-4', 10), null);
  assert.equal(parseSingleRange('bytes=-0', 10), null);
  assert.equal(parseSingleRange('bytes=-1', 0), null);
});

test('临时服务器只通过随机精确路径暴露单文件，并正确支持 HEAD/GET/Range', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pikpak-direct-http-test-'));
  const filePath = join(directory, '中文 sample.bin');

  // 内容故意短小且可肉眼验证 Range。
  const content = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
  await writeFile(filePath, content);

  const source = await createTemporaryFileServer({ filePath });
  t.after(async () => {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(source.host, '127.0.0.1');
  assert.equal(source.fileSize, content.length);
  assert.match(source.publicPath, /^\/file\/[0-9a-f]{64}\//);

  // 1. 错误路径必须是 404，且没有文件正文。
  const baseUrl = `http://127.0.0.1:${source.port}`;
  const missing = await fetch(`${baseUrl}/definitely-not-the-token`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.arrayBuffer()).byteLength, 0);

  // 2. HEAD 只返回元信息，不计入 bytesServed。
  const head = await fetch(source.localUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(content.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  // 3. 普通 GET 必须逐字节一致。
  const full = await fetch(source.localUrl);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);

  // 4. 单段 Range 精确返回 206 与 Content-Range。
  const partial = await fetch(source.localUrl, {
    headers: { Range: 'bytes=10-15' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 10-15/${content.length}`);
  assert.deepEqual(
    Buffer.from(await partial.arrayBuffer()),
    content.subarray(10, 16),
  );

  // 5. 非法 Range 必须 416，不能退化成把整个文件发出去。
  const invalidRange = await fetch(source.localUrl, {
    headers: { Range: 'bytes=999-1000' },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(
    invalidRange.headers.get('content-range'),
    `bytes */${content.length}`,
  );

  // 6. POST 不属于文件源站职责，明确拒绝。
  const post = await fetch(source.localUrl, {
    method: 'POST',
    body: 'do-not-accept',
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  assert.equal(source.stats.requests, 6);
  assert.equal(source.stats.getRequests, 2);
  assert.equal(source.stats.headRequests, 1);
  assert.equal(source.stats.rangeRequests, 1);
  assert.equal(source.stats.rejectedRequests, 3);
  // HEAD / 404 / 416 / POST 都不应计入文件正文发送量。
  assert.equal(source.stats.bytesServed, content.length + 6);
  assert.deepEqual(source.stats.requestLog, [
    { method: 'GET', status: 404, range: null, plannedBytes: 0 },
    { method: 'HEAD', status: 200, range: null, plannedBytes: 0 },
    { method: 'GET', status: 200, range: null, plannedBytes: content.length },
    { method: 'GET', status: 206, range: 'bytes=10-15', plannedBytes: 6 },
    { method: 'GET', status: 416, range: 'bytes=999-1000', plannedBytes: 0 },
    { method: 'POST', status: 405, range: null, plannedBytes: 0 },
  ]);
});

test('临时服务器拒绝绑定非 loopback 地址', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pikpak-direct-http-test-'));
  const filePath = join(directory, 'sample.bin');
  await writeFile(filePath, Buffer.from('x'));

  try {
    await assert.rejects(
      createTemporaryFileServer({
        filePath,
        host: '0.0.0.0',
      }),
      /只允许绑定 loopback/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('正文发送预算会在重复 GET 前硬截断，避免 Route B 无限回拉放大', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pikpak-direct-http-budget-test-'));
  const filePath = join(directory, 'budget.bin');
  const content = Buffer.from('0123456789', 'utf8');
  await writeFile(filePath, content);

  // 只允许发送 1 份完整正文；第二次完整 GET 必须在读盘/发正文前被 429 拒绝。
  const source = await createTemporaryFileServer({
    filePath,
    maxBytesServed: content.length,
  });
  t.after(async () => {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await fetch(source.localUrl);
  assert.equal(first.status, 200);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), content);

  const second = await fetch(source.localUrl);
  assert.equal(second.status, 429);
  assert.equal((await second.arrayBuffer()).byteLength, 0);
  assert.equal(source.stats.bytesServed, content.length);
  assert.equal(source.stats.budgetRejectedRequests, 1);
});
