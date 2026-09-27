// 冷迁移 manifest 的纯本地单元测试。
// 测试只使用系统临时目录，不连接 PikPak，也不会触发任何真实上传。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createMigrationManifest,
  enumerateSource,
  inspectLocalEntry,
  loadMigrationManifest,
  makeRemoteName,
  sanitizeCheckpoint,
  saveMigrationManifest,
} from '../src/migration-manifest.mjs';

async function withTempDirectory(callback) {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-manifest-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('目录枚举稳定排序并保留相对路径', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(join(root, '子目录'));
    await writeFile(join(root, 'b.txt'), 'bb');
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, '子目录', 'c.txt'), 'ccc');

    const result = await enumerateSource(root);
    assert.equal(result.sourceType, 'directory');
    assert.deepEqual(result.files.map((file) => file.relativePath), [
      'a.txt',
      'b.txt',
      '子目录/c.txt',
    ]);
  });
});

test('manifest 为同名文件生成不同远端名，并记录恢复所需元数据', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(join(root, '甲'));
    await mkdir(join(root, '乙'));
    await writeFile(join(root, '甲', 'same.bin'), '1');
    await writeFile(join(root, '乙', 'same.bin'), '22');

    const manifest = await createMigrationManifest({
      sourcePath: root,
      backupId: 'demo-backup',
      parentId: 'parent-demo',
      now: new Date('2026-09-27T12:00:00.000Z'),
    });

    assert.equal(manifest.entries.length, 2);
    assert.notEqual(manifest.entries[0].remoteName, manifest.entries[1].remoteName);
    assert.deepEqual(manifest.entries.map((entry) => entry.relativePath), [
      '乙/same.bin',
      '甲/same.bin',
    ]);
    assert.equal(manifest.policy.encryption, 'none');
    assert.equal(manifest.policy.deleteLocalAfterUpload, false);
    assert.equal(manifest.summary.totalFiles, 2);
    assert.equal(manifest.summary.totalBytes, 3);
  });
});

test('远端名过长时会截断并保持稳定', () => {
  const relativePath = `dir/${'x'.repeat(240)}.zip`;
  const first = makeRemoteName({ backupId: 'backup', index: 3, relativePath });
  const second = makeRemoteName({ backupId: 'backup', index: 3, relativePath });
  assert.equal(first, second);
  assert.match(first, /^backup__000004__/);
  assert.ok(first.length < 220);
});

test('manifest 使用原子写入并可重新加载', async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, 'source.bin');
    const manifestPath = join(root, 'state', 'backup.json');
    await writeFile(source, 'hello');

    const manifest = await createMigrationManifest({ sourcePath: source, backupId: 'single' });
    manifest.entries[0].status = 'complete';
    manifest.entries[0].sha1 = 'a'.repeat(40);
    await saveMigrationManifest(manifestPath, manifest);

    const loaded = await loadMigrationManifest(manifestPath);
    assert.equal(loaded.summary.completedFiles, 1);
    assert.equal(loaded.entries[0].sha1, 'a'.repeat(40));
    assert.doesNotMatch(await readFile(manifestPath, 'utf8'), /accessKeySecret|securityToken/);
  });
});

test('checkpoint 只保留恢复所需白名单字段', () => {
  const safe = sanitizeCheckpoint({
    name: 'object-key',
    file: 'D:/demo.bin',
    fileSize: 123,
    partSize: 10,
    uploadId: 'upload-1',
    doneParts: [{ number: 1, etag: 'etag-1', secret: 'should-not-survive' }],
    accessKeySecret: 'never-write-this',
    client: { token: 'never-write-this-either' },
  });

  assert.deepEqual(safe, {
    name: 'object-key',
    file: 'D:/demo.bin',
    fileSize: 123,
    partSize: 10,
    uploadId: 'upload-1',
    doneParts: [{ number: 1, etag: 'etag-1' }],
  });
  assert.equal('accessKeySecret' in safe, false);
});

test('inspectLocalEntry 能识别源文件变化', async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, 'file.txt');
    await writeFile(source, 'before');
    const manifest = await createMigrationManifest({ sourcePath: source, backupId: 'inspect' });
    const before = await inspectLocalEntry(manifest, manifest.entries[0]);
    assert.equal(before.unchanged, true);

    await writeFile(source, 'after changed');
    const after = await inspectLocalEntry(manifest, manifest.entries[0]);
    assert.equal(after.unchanged, false);
  });
});

