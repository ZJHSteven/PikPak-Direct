import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeRepository, unlockRepository } from '../src/repository-format.mjs';

const TEST_SCRYPT = Object.freeze({ N: 2 ** 10, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

test('repo.json 的公开配置也受 master-key 派生认证保护', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-repo-header-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  const password = 'header-auth-test-password';

  const initialized = await initializeRepository(repoDir, {
    password,
    scryptParams: TEST_SCRYPT,
  });
  initialized.masterKey.fill(0);

  const unlocked = await unlockRepository(repoDir, { password });
  unlocked.masterKey.fill(0);

  const headerPath = join(repoDir, 'repo.json');
  const header = JSON.parse(await readFile(headerPath, 'utf8'));
  header.pack.targetBytes += 1;
  await writeFile(headerPath, `${JSON.stringify(header, null, 2)}\n`, 'utf8');

  await assert.rejects(
    unlockRepository(repoDir, { password }),
    /header 认证失败/,
  );
});
