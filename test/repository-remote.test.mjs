import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectRepositoryArtifacts,
  listAllPikPakFiles,
  remoteArtifactToLocalRelativePath,
  resolveRemoteRepositoryRootPath,
  resolveRepositoryObjectLayout,
  resolveRemoteRepositoryRoot,
} from '../src/repository-remote.mjs';

test('远端仓库对象名只暴露随机 pack/snapshot id，不暴露原始路径', () => {
  assert.equal(remoteArtifactToLocalRelativePath('repo.json'), 'repo.json');
  assert.equal(
    remoteArtifactToLocalRelativePath('pack-00112233445566778899aabbccddeeff.ppdp'),
    join('packs', '00112233445566778899aabbccddeeff.ppdp'),
  );
  assert.equal(
    remoteArtifactToLocalRelativePath('snapshot-ffeeddccbbaa99887766554433221100.ppds'),
    join('snapshots', 'ffeeddccbbaa99887766554433221100.ppds'),
  );
  assert.equal(remoteArtifactToLocalRelativePath('../secret.txt'), null);
  assert.equal(remoteArtifactToLocalRelativePath('pack-not-a-real-id.ppdp'), null);
});

test('collectRepositoryArtifacts 忽略 latest.json，只上传 header + immutable pack/snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pikpak-remote-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packs'), { recursive: true });
  await mkdir(join(root, 'snapshots'), { recursive: true });
  await writeFile(join(root, 'repo.json'), '{}');
  await writeFile(join(root, 'latest.json'), '{"snapshotId":"should-not-upload"}');
  await writeFile(join(root, 'packs', '00112233445566778899aabbccddeeff.ppdp'), 'pack');
  await writeFile(join(root, 'snapshots', 'ffeeddccbbaa99887766554433221100.ppds'), 'snapshot');

  const artifacts = await collectRepositoryArtifacts(root);
  assert.deepEqual(artifacts.map((item) => item.remoteName), [
    'repo.json',
    'pack-00112233445566778899aabbccddeeff.ppdp',
    'snapshot-ffeeddccbbaa99887766554433221100.ppds',
  ]);
});

test('PikPak 分页会完整收集并拒绝循环 token', async () => {
  const pages = new Map([
    ['', { files: [{ id: '1' }], nextPageToken: 'a' }],
    ['a', { files: [{ id: '2' }], nextPageToken: 'b' }],
    ['b', { files: [{ id: '3' }], nextPageToken: '' }],
  ]);
  const web = { listFiles: async ({ pageToken }) => pages.get(pageToken) };
  assert.deepEqual((await listAllPikPakFiles(web)).map((item) => item.id), ['1', '2', '3']);

  const loopWeb = {
    listFiles: async ({ pageToken }) => ({ files: [], nextPageToken: pageToken || 'same' }),
  };
  await assert.rejects(listAllPikPakFiles(loopWeb), /循环 page_token/);
});

test('仓库根目录精确复用，缺失时只创建一次，重复同名时拒绝猜测', async () => {
  const reusedWeb = {
    listFiles: async () => ({
      files: [{ id: 'root-1', name: 'PikPak-Direct Vault', kind: 'drive#folder', trashed: false }],
      nextPageToken: '',
    }),
    createFolder: async () => { throw new Error('should not create'); },
  };
  assert.equal((await resolveRemoteRepositoryRoot(reusedWeb, { create: true })).id, 'root-1');

  let creates = 0;
  const createWeb = {
    listFiles: async () => ({ files: [], nextPageToken: '' }),
    createFolder: async ({ name }) => {
      creates += 1;
      return { id: 'new-root', name, kind: 'drive#folder', trashed: false };
    },
  };
  assert.equal((await resolveRemoteRepositoryRoot(createWeb, { create: true })).id, 'new-root');
  assert.equal(creates, 1);

  const duplicateWeb = {
    listFiles: async () => ({
      files: [
        { id: 'a', name: 'PikPak-Direct Vault', kind: 'drive#folder', trashed: false },
        { id: 'b', name: 'PikPak-Direct Vault', kind: 'drive#folder', trashed: false },
      ],
      nextPageToken: '',
    }),
  };
  await assert.rejects(resolveRemoteRepositoryRoot(duplicateWeb), /同名仓库文件夹/);
});

test('PikPak冷备三级目录按 parentId 创建，禁止相对路径及重名', async () => {
  const content = new Map([['', []]]);
  let serial = 0;
  const web = {
    listFiles: async ({ parentId }) => ({
      files: content.get(parentId) || [],
      nextPageToken: '',
    }),
    createFolder: async ({ parentId, name }) => {
      const folder = { id: 'dir-' + ++serial, name, kind: 'drive#folder', trashed: false };
      content.get(parentId).push(folder);
      content.set(folder.id, []);
      return folder;
    },
  };
  const path = 'PikPak冷备/加密仓库/oldcourse-20261018';
  const root = await resolveRemoteRepositoryRootPath(web, { folderName: path, create: true });
  assert.equal(serial, 3);
  assert.equal(root.name, 'oldcourse-20261018');
  assert.equal((await resolveRemoteRepositoryRootPath(web, { folderName: path })).id, root.id);
  assert.equal(serial, 3);
  await assert.rejects(resolveRemoteRepositoryRootPath(web, {
    folderName: 'PikPak冷备/../别人的目录', create: true,
  }), /相对路径/);
  await assert.rejects(resolveRemoteRepositoryRootPath(web, {
    folderName: '/PikPak冷备/加密仓库', create: true,
  }), /路径无效/);
  content.get(root.id).push({ id: 'bad', name: 'packs', kind: 'drive#file', trashed: false });
  await assert.rejects(resolveRepositoryObjectLayout(web, root, { nested: true, create: true }), /目录冲突/);
});

test('新云端仓库将 pack 和 snapshot 放进独立目录并兼容旧版逻辑对象名', async () => {
  const objects = new Map([
    ['root-id', [
      { id: 'head', name: 'repo.json', kind: 'drive#file', size: 1419, trashed: false },
      { id: 'pack-dir', name: 'packs', kind: 'drive#folder', trashed: false },
      { id: 'snapshot-dir', name: 'snapshots', kind: 'drive#folder', trashed: false },
    ]],
    ['pack-dir', [
      { id: 'pack1', name: '00112233445566778899aabbccddeeff.ppdp', kind: 'drive#file', trashed: false },
    ]],
    ['snapshot-dir', [
      { id: 'snap1', name: 'ffeeddccbbaa99887766554433221100.ppds', kind: 'drive#file', trashed: false },
    ]],
  ]);
  const web = {
    listFiles: async ({ parentId }) => ({ files: objects.get(parentId) || [], nextPageToken: '' }),
    createFolder: async () => { throw new Error('已有目录不应重复创建'); },
  };
  const root = { id: 'root-id', name: 'oldcourse-20261018', kind: 'drive#folder' };
  const layout = await resolveRepositoryObjectLayout(web, root, { nested: true });
  assert.deepEqual(layout.folderByKind, {
    header: 'root-id', pack: 'pack-dir', snapshot: 'snapshot-dir',
  });
  assert.deepEqual(layout.remoteFiles.map((x) => x.name), [
    'repo.json',
    'pack-00112233445566778899aabbccddeeff.ppdp',
    'snapshot-ffeeddccbbaa99887766554433221100.ppds',
  ]);
  const flat = await resolveRepositoryObjectLayout(web, root, { nested: false });
  assert.equal(flat.folderByKind.pack, 'root-id');
});
