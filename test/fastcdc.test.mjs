import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chunkBufferFastCdc, chunkFileFastCdc } from '../src/fastcdc.mjs';

const SMALL_CDC = Object.freeze({
  minSize: 4 * 1024,
  avgSize: 16 * 1024,
  maxSize: 64 * 1024,
  readSize: 7 * 1024,
});

function digest(chunk) {
  return createHash('sha256').update(chunk).digest('hex');
}

test('CDC 分块完整覆盖原始 Buffer，且每块不超过 maxSize', () => {
  const input = Buffer.alloc(512 * 1024);
  for (let i = 0; i < input.length; i += 1) input[i] = (i * 131 + (i >>> 5)) & 0xff;
  const chunks = chunkBufferFastCdc(input, SMALL_CDC);
  assert.deepEqual(Buffer.concat(chunks), input);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.length <= SMALL_CDC.maxSize));
});

test('局部插入后 CDC 能重新同步，绝大多数远端 chunk 仍可复用', () => {
  const original = Buffer.alloc(2 * 1024 * 1024);
  let x = 0x12345678;
  for (let i = 0; i < original.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    original[i] = x & 0xff;
  }
  const inserted = Buffer.concat([
    original.subarray(0, 700_000),
    Buffer.from('LOCAL-EDIT-THAT-SHOULD-NOT-RESHARD-THE-WHOLE-FILE'),
    original.subarray(700_000),
  ]);

  const before = chunkBufferFastCdc(original, SMALL_CDC).map(digest);
  const afterSet = new Set(chunkBufferFastCdc(inserted, SMALL_CDC).map(digest));
  const reused = before.filter((id) => afterSet.has(id)).length;
  assert.ok(reused / before.length > 0.7, `预期 >70% chunk 复用，实际 ${reused}/${before.length}`);
});

test('流式文件 CDC 与单 Buffer CDC 得到相同边界', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pikpak-fastcdc-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sample.bin');
  const input = Buffer.alloc(600 * 1024);
  for (let i = 0; i < input.length; i += 1) input[i] = (i * 17 + 29) & 0xff;
  await writeFile(filePath, input);

  const expected = chunkBufferFastCdc(input, SMALL_CDC).map(digest);
  const actual = [];
  for await (const chunk of chunkFileFastCdc(filePath, SMALL_CDC)) actual.push(digest(chunk));
  assert.deepEqual(actual, expected);
});
