import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  backupRepository,
  listRepositorySnapshots,
  restoreRepositorySnapshot,
  verifyRepository,
} from '../src/repository-backup.mjs';
import { initializeRepository } from '../src/repository-format.mjs';

const TEST_SCRYPT = Object.freeze({ N: 2 ** 10, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const TEST_CDC = Object.freeze({ minSize: 4 * 1024, avgSize: 16 * 1024, maxSize: 64 * 1024 });

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('加密仓库可增量 backup，并只凭 recovery key fresh restore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-repo-roundtrip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  const sourceDir = join(root, 'source');
  const restoreDir = join(root, 'fresh-restore');
  await mkdir(join(sourceDir, 'nested'), { recursive: true });

  const base = Buffer.alloc(700 * 1024);
  let x = 0xdeadbeef;
  for (let i = 0; i < base.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    base[i] = x & 0xff;
  }
  await writeFile(join(sourceDir, 'alpha.bin'), base);
  await writeFile(join(sourceDir, 'nested', 'same.bin'), base);
  await writeFile(join(sourceDir, 'empty.txt'), Buffer.alloc(0));
  await writeFile(join(sourceDir, 'note.txt'), '这是只应存在于加密 snapshot 的文件名/内容。');

  const initialized = await initializeRepository(repoDir, {
    password: 'repository-test-password',
    scryptParams: TEST_SCRYPT,
    cdc: TEST_CDC,
    packTargetBytes: 256 * 1024,
  });

  // repo.json 只能看到算法/key-slot；不能泄露源文件名或 recovery secret。
  const headerText = await readFile(join(repoDir, 'repo.json'), 'utf8');
  assert.doesNotMatch(headerText, /alpha\.bin|same\.bin|note\.txt/);
  assert.equal(headerText.includes(initialized.recoveryKey), false);

  const first = await backupRepository({
    repoDir,
    sourcePath: sourceDir,
    password: 'repository-test-password',
    cdc: TEST_CDC,
    packTargetBytes: 256 * 1024,
  });
  assert.ok(first.stats.newChunks > 0);
  assert.ok(first.stats.reusedChunkRefs > 0, 'same.bin 应复用 alpha.bin 已写入的 chunk');

  // 只在 alpha 中间插入很短一段，再做第二个 snapshot；绝大多数 chunk 应被旧 pack 复用。
  const edited = Buffer.concat([base.subarray(0, 300_000), Buffer.from('LOCAL-EDIT'), base.subarray(300_000)]);
  await writeFile(join(sourceDir, 'alpha.bin'), edited);
  const second = await backupRepository({
    repoDir,
    sourcePath: sourceDir,
    password: 'repository-test-password',
    cdc: TEST_CDC,
    packTargetBytes: 256 * 1024,
  });
  assert.ok(second.stats.reusedChunkRefs > second.stats.newChunks);

  const snapshots = await listRepositorySnapshots({
    repoDir,
    recoveryKey: initialized.recoveryKey,
  });
  assert.equal(snapshots.errors.length, 0);
  assert.equal(snapshots.snapshots.length, 2);

  // fresh restore 不使用 password、不依赖任何本地 index/cache，只扫描 pack TOC + snapshot。
  const restored = await restoreRepositorySnapshot({
    repoDir,
    destinationDir: restoreDir,
    snapshotId: second.snapshotId,
    recoveryKey: initialized.recoveryKey,
  });
  assert.equal(restored.ok, true, JSON.stringify(restored, null, 2));
  assert.equal(hash(await readFile(join(restoreDir, 'source', 'alpha.bin'))), hash(edited));
  assert.equal(hash(await readFile(join(restoreDir, 'source', 'nested', 'same.bin'))), hash(base));
  assert.equal((await readFile(join(restoreDir, 'source', 'empty.txt'))).length, 0);
  assert.equal((await readFile(join(restoreDir, 'source', 'note.txt'), 'utf8')), '这是只应存在于加密 snapshot 的文件名/内容。');

  const verified = await verifyRepository({ repoDir, recoveryKey: initialized.recoveryKey, full: true });
  assert.equal(verified.ok, true, JSON.stringify(verified, null, 2));
});

test('单 pack 损坏只污染该 pack，重建索引仍能报告其他 pack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-repo-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir, { recursive: true });

  for (let i = 0; i < 6; i += 1) {
    const content = Buffer.alloc(180 * 1024);
    // 旧夹具用线性公式 `(j*k+c)&255`，实际上每 256 字节就周期重复，Brotli 会把
    // 六个“180 KiB 文件”压到一个很小的 pack，导致测试根本制造不出多 pack 场景。
    // 固定 seed 的 xorshift32 既保持测试可复现，又足够接近不可压缩数据，能稳定跨过
    // 128 KiB pack target，真正验证“一个 pack 坏了，其余 pack 仍可扫描”。
    let state = (0x9e3779b9 ^ (i * 0x45d9f3b)) >>> 0;
    for (let j = 0; j < content.length; j += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      content[j] = state & 0xff;
    }
    await writeFile(join(sourceDir, `file-${i}.bin`), content);
  }

  const initialized = await initializeRepository(repoDir, {
    password: 'corruption-test-password',
    scryptParams: TEST_SCRYPT,
    cdc: TEST_CDC,
    packTargetBytes: 128 * 1024,
  });
  await backupRepository({
    repoDir,
    sourcePath: sourceDir,
    recoveryKey: initialized.recoveryKey,
    cdc: TEST_CDC,
    packTargetBytes: 128 * 1024,
  });

  const packNames = (await readdir(join(repoDir, 'packs'))).filter((name) => name.endsWith('.ppdp')).sort();
  assert.ok(packNames.length >= 2);
  const damaged = join(repoDir, 'packs', packNames[0]);
  const body = Buffer.from(await readFile(damaged));
  body[body.length - 1] ^= 0xff; // 直接破坏 footer magic，确保 TOC 扫描能定位损坏。
  await writeFile(damaged, body);

  const verified = await verifyRepository({ repoDir, recoveryKey: initialized.recoveryKey, full: false });
  assert.equal(verified.ok, false);
  assert.equal(verified.packErrors.length, 1);
  assert.ok(verified.packs >= 1, '其他未损坏 pack 仍应被成功扫描');
});
