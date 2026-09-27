// migration runner 的离线测试。
// 只覆盖 prepare / dry-run / 本地校验，不连接真实 PikPak，避免单元测试产生远端副作用。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { prepareMigration, runMigration, verifyManifestLocal } from '../src/migration-runner.mjs';

async function withTempDirectory(callback) {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-runner-test-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('prepareMigration 能创建 manifest，并从同一文件恢复', async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, 'source');
    const manifestPath = join(root, 'manifest.json');
    await mkdir(source);
    await writeFile(join(source, 'a.txt'), 'a');

    const first = await prepareMigration({
      sourcePath: source,
      manifestPath,
      backupId: 'resume-demo',
    });
    assert.equal(first.resumed, false);
    assert.equal(first.manifest.entries.length, 1);

    const second = await prepareMigration({ sourcePath: source, manifestPath });
    assert.equal(second.resumed, true);
    assert.equal(second.manifest.backupId, 'resume-demo');
  });
});

test('现有 manifest 不能被另一个源目录误用', async () => {
  await withTempDirectory(async (root) => {
    const sourceA = join(root, 'A');
    const sourceB = join(root, 'B');
    const manifestPath = join(root, 'manifest.json');
    await mkdir(sourceA);
    await mkdir(sourceB);
    await writeFile(join(sourceA, 'a.txt'), 'a');
    await writeFile(join(sourceB, 'b.txt'), 'b');
    await prepareMigration({ sourcePath: sourceA, manifestPath, backupId: 'guard' });

    await assert.rejects(
      prepareMigration({ sourcePath: sourceB, manifestPath }),
      /另一个源路径/,
    );
  });
});

test('runMigration dry-run 只生成清单，不需要 PikPak/CDP', async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, 'source');
    const manifestPath = join(root, 'dry-run.json');
    await mkdir(source);
    await writeFile(join(source, 'one.txt'), '1');
    await writeFile(join(source, 'two.txt'), '22');

    const result = await runMigration({
      sourcePath: source,
      manifestPath,
      backupId: 'dry-run',
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.manifest.summary.totalFiles, 2);
    assert.equal(result.manifest.summary.totalBytes, 3);
  });
});

test('verifyManifestLocal 能在文件改动后报告快照失配', async () => {
  await withTempDirectory(async (root) => {
    const source = join(root, 'source');
    const manifestPath = join(root, 'verify.json');
    await mkdir(source);
    const file = join(source, 'one.txt');
    await writeFile(file, '1');
    const prepared = await prepareMigration({
      sourcePath: source,
      manifestPath,
      backupId: 'verify',
    });

    assert.equal((await verifyManifestLocal(prepared.manifest)).ok, true);
    await writeFile(file, 'changed-content');
    assert.equal((await verifyManifestLocal(prepared.manifest)).ok, false);
  });
});

