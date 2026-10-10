// PikPak-Direct 加密仓库 v1 的离线 backup / restore / verify 主流程。
//
// 这里故意不依赖 PikPak：先把“仓库格式本身能否独立灾难恢复”做成可重复测试。
// 云端同步只是把 repo.json、pack、snapshot 这些不可变/小型对象送到 PikPak，不能改变其语义。

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { chunkFileFastCdc } from './fastcdc.mjs';
import {
  RepositoryPackWriter,
  listEncryptedSnapshots,
  readChunkFromPack,
  readEncryptedSnapshot,
  readLatestSnapshotId,
  rebuildPackIndex,
  unlockRepository,
  writeEncryptedSnapshot,
} from './repository-format.mjs';
import { sha256Hex } from './repo-crypto.mjs';

function toPortableRelativePath(path) {
  return path.split(sep).join('/');
}

function assertSafeSnapshotPath(path) {
  if (typeof path !== 'string' || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`snapshot 路径非法: ${path}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '')) {
    throw new Error(`snapshot 路径包含非法段: ${path}`);
  }
  return parts;
}

/** 稳定枚举目录；v1 明确拒绝 symlink，避免备份时意外越出源根或恢复时产生权限/指向歧义。 */
export async function scanRepositorySource(sourcePath) {
  const absolute = resolve(sourcePath);
  const rootStat = await lstat(absolute);
  if (rootStat.isSymbolicLink()) throw new Error('仓库 v1 暂不支持以 symlink 作为源根。');
  const sourceName = basename(absolute);
  const entries = [];

  if (rootStat.isFile()) {
    entries.push({
      type: 'file',
      path: sourceName,
      absolutePath: absolute,
      size: rootStat.size,
      mtimeMs: rootStat.mtimeMs,
      mode: rootStat.mode,
    });
    return { sourceType: 'file', sourceName, rootPath: absolute, entries };
  }
  if (!rootStat.isDirectory()) throw new Error('仓库 v1 只支持普通文件或目录。');

  async function walk(directory) {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const full = join(directory, child.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        // 不静默跳过，因为那会让“备份成功”实际丢数据/结构。
        throw new Error(`仓库 v1 暂不支持 symlink: ${full} -> ${await readlink(full)}`);
      }
      const path = toPortableRelativePath(relative(absolute, full));
      if (info.isDirectory()) {
        entries.push({ type: 'directory', path, absolutePath: full, mtimeMs: info.mtimeMs, mode: info.mode });
        await walk(full);
      } else if (info.isFile()) {
        entries.push({
          type: 'file',
          path,
          absolutePath: full,
          size: info.size,
          mtimeMs: info.mtimeMs,
          mode: info.mode,
        });
      } else {
        throw new Error(`仓库 v1 不支持的文件类型: ${full}`);
      }
    }
  }

  await walk(absolute);
  return { sourceType: 'directory', sourceName, rootPath: absolute, entries };
}

async function hashFileSha256(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

/**
 * 创建一个加密 snapshot。
 * 已存在 chunk 直接复用；只有 index 中不存在的新 chunk 才进入新 pack。
 */
export async function backupRepository({
  repoDir,
  sourcePath,
  password = '',
  recoveryKey = '',
  packTargetBytes = null,
  cdc = null,
} = {}) {
  const unlocked = await unlockRepository(repoDir, { password, recoveryKey });
  const { header, masterKey } = unlocked;
  const scan = await scanRepositorySource(sourcePath);
  const rebuilt = await rebuildPackIndex(unlocked.repoDir, header, masterKey);
  if (rebuilt.errors.length > 0) {
    masterKey.fill(0);
    throw new Error(`现有仓库包含 ${rebuilt.errors.length} 个损坏 pack；为避免在不完整索引上错误去重，拒绝继续 backup。`);
  }

  const index = rebuilt.index;
  const cfgCdc = cdc || header.cdc;
  const targetBytes = Number(packTargetBytes || header.pack?.targetBytes || 128 * 1024 * 1024);
  const snapshotEntries = [];
  const createdPacks = [];
  const statsSummary = {
    files: 0,
    directories: 0,
    logicalBytes: 0,
    totalChunkRefs: 0,
    reusedChunkRefs: 0,
    newChunks: 0,
    newPlainBytes: 0,
    packsCreated: 0,
  };
  let writer = null;

  async function ensureWriter() {
    if (!writer) writer = await RepositoryPackWriter.create({ repoDir: unlocked.repoDir, header, masterKey });
    return writer;
  }

  async function finalizeWriter() {
    if (!writer) return;
    if (writer.entries.length === 0) {
      await writer.abandon();
      writer = null;
      return;
    }
    const result = await writer.finalize();
    createdPacks.push(result);
    statsSummary.packsCreated += 1;
    writer = null;
  }

  try {
    for (const sourceEntry of scan.entries) {
      if (sourceEntry.type === 'directory') {
        statsSummary.directories += 1;
        snapshotEntries.push({
          type: 'directory',
          path: sourceEntry.path,
          mtimeMs: sourceEntry.mtimeMs,
          mode: sourceEntry.mode,
        });
        continue;
      }

      statsSummary.files += 1;
      statsSummary.logicalBytes += sourceEntry.size;
      const fileHash = createHash('sha256');
      const chunkIds = [];

      for await (const chunk of chunkFileFastCdc(sourceEntry.absolutePath, cfgCdc)) {
        fileHash.update(chunk);
        const chunkId = sha256Hex(chunk);
        chunkIds.push(chunkId);
        statsSummary.totalChunkRefs += 1;

        if (index.has(chunkId)) {
          statsSummary.reusedChunkRefs += 1;
          continue;
        }

        const current = await ensureWriter();
        const record = await current.addChunk(chunk, chunkId);
        index.set(chunkId, record);
        statsSummary.newChunks += 1;
        statsSummary.newPlainBytes += chunk.length;

        // pack 可以比目标略大一个 chunk；下一 chunk 前换包即可，不需要回滚本次写入。
        if (current.dataBytes >= targetBytes) await finalizeWriter();
      }

      const finalHash = sourceEntry.size === 0
        ? sha256Hex(Buffer.alloc(0))
        : fileHash.digest('hex');
      const after = await stat(sourceEntry.absolutePath);
      if (after.size !== sourceEntry.size || Math.trunc(after.mtimeMs) !== Math.trunc(sourceEntry.mtimeMs)) {
        throw new Error(`备份过程中源文件发生变化，拒绝写入不一致 snapshot: ${sourceEntry.path}`);
      }

      snapshotEntries.push({
        type: 'file',
        path: sourceEntry.path,
        size: sourceEntry.size,
        mtimeMs: sourceEntry.mtimeMs,
        mode: sourceEntry.mode,
        sha256: finalHash,
        chunks: chunkIds,
      });
    }

    await finalizeWriter();
    const snapshotResult = await writeEncryptedSnapshot(unlocked.repoDir, header, masterKey, {
      createdAt: new Date().toISOString(),
      source: {
        type: scan.sourceType,
        name: scan.sourceName,
      },
      entries: snapshotEntries,
      stats: statsSummary,
    });
    return {
      repoDir: unlocked.repoDir,
      snapshotId: snapshotResult.snapshotId,
      snapshot: snapshotResult.snapshot,
      createdPacks,
      indexChunks: index.size,
      stats: statsSummary,
    };
  } catch (error) {
    if (writer) await writer.abandon().catch(() => {});
    throw error;
  } finally {
    masterKey.fill(0);
  }
}

export async function listRepositorySnapshots({ repoDir, password = '', recoveryKey = '' } = {}) {
  const unlocked = await unlockRepository(repoDir, { password, recoveryKey });
  try {
    const result = await listEncryptedSnapshots(unlocked.repoDir, unlocked.header, unlocked.masterKey);
    return {
      snapshots: result.snapshots.map(({ snapshot }) => ({
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        source: snapshot.source,
        stats: snapshot.stats,
      })),
      errors: result.errors,
    };
  } finally {
    unlocked.masterKey.fill(0);
  }
}

/**
 * 恢复 snapshot。每个文件独立临时写入 + hash 校验 + 原子 rename；单 pack/chunk 损坏不会
 * 让已经成功恢复的其他文件回滚。
 */
export async function restoreRepositorySnapshot({
  repoDir,
  destinationDir,
  snapshotId = null,
  password = '',
  recoveryKey = '',
  overwrite = false,
} = {}) {
  const unlocked = await unlockRepository(repoDir, { password, recoveryKey });
  const { header, masterKey } = unlocked;
  try {
    let chosenId = snapshotId || await readLatestSnapshotId(unlocked.repoDir);
    if (!chosenId) {
      const listed = await listEncryptedSnapshots(unlocked.repoDir, header, masterKey);
      if (listed.snapshots.length === 0) throw new Error('仓库没有可恢复 snapshot。');
      chosenId = listed.snapshots.at(-1).snapshotId;
    }
    const { snapshot } = await readEncryptedSnapshot(unlocked.repoDir, header, masterKey, chosenId);
    const rebuilt = await rebuildPackIndex(unlocked.repoDir, header, masterKey);

    const root = resolve(destinationDir);
    await mkdir(root, { recursive: true });
    const restoreRoot = join(root, snapshot.source.name);
    const results = [];

    // 先建目录，文件恢复失败也不会影响其他目录/文件继续处理。
    if (snapshot.source.type === 'directory') await mkdir(restoreRoot, { recursive: true });
    for (const entry of snapshot.entries.filter((item) => item.type === 'directory')) {
      const parts = assertSafeSnapshotPath(entry.path);
      const path = join(restoreRoot, ...parts);
      await mkdir(path, { recursive: true });
    }

    for (const entry of snapshot.entries.filter((item) => item.type === 'file')) {
      const parts = assertSafeSnapshotPath(entry.path);
      const outputPath = snapshot.source.type === 'file'
        ? join(root, ...parts)
        : join(restoreRoot, ...parts);
      await mkdir(dirname(outputPath), { recursive: true });

      if (!overwrite) {
        try {
          await access(outputPath);
          results.push({ path: entry.path, ok: false, error: 'destination-exists' });
          continue;
        } catch {
          // 不存在才继续。
        }
      }

      const tempPath = `${outputPath}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
      const handle = await open(tempPath, 'wx');
      const hash = createHash('sha256');
      let written = 0;
      try {
        for (const chunkId of entry.chunks) {
          const record = rebuilt.index.get(chunkId);
          if (!record) throw new Error(`缺少 chunk: ${chunkId}`);
          const plain = await readChunkFromPack(record, header, masterKey);
          await handle.write(plain);
          hash.update(plain);
          written += plain.length;
        }
        await handle.sync();
        await handle.close();
        const digest = hash.digest('hex');
        if (written !== entry.size || digest !== entry.sha256) {
          throw new Error(`文件 hash/size 校验失败: ${entry.path}`);
        }
        if (overwrite) await rm(outputPath, { force: true });
        await rename(tempPath, outputPath);
        const time = new Date(entry.mtimeMs);
        await utimes(outputPath, time, time).catch(() => {});
        results.push({ path: entry.path, ok: true, size: written });
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(tempPath, { force: true }).catch(() => {});
        results.push({ path: entry.path, ok: false, error: error.message });
      }
    }

    return {
      snapshotId: chosenId,
      destination: restoreRoot,
      packErrors: rebuilt.errors,
      files: results,
      ok: rebuilt.errors.length === 0 && results.every((item) => item.ok),
    };
  } finally {
    masterKey.fill(0);
  }
}

/** 全量读取所有索引 chunk 做 AEAD + 解压 + SHA-256 校验，适合作为灾难恢复前完整体检。 */
export async function verifyRepository({ repoDir, password = '', recoveryKey = '', full = true } = {}) {
  const unlocked = await unlockRepository(repoDir, { password, recoveryKey });
  const { header, masterKey } = unlocked;
  try {
    const rebuilt = await rebuildPackIndex(unlocked.repoDir, header, masterKey);
    const snapshots = await listEncryptedSnapshots(unlocked.repoDir, header, masterKey);
    const chunkErrors = [];
    if (full) {
      for (const [chunkId, record] of rebuilt.index) {
        try {
          await readChunkFromPack(record, header, masterKey);
        } catch (error) {
          chunkErrors.push({ chunkId, packId: record.packId, error: error.message });
        }
      }
    }
    return {
      ok: rebuilt.errors.length === 0
        && rebuilt.duplicateChunkIds.length === 0
        && snapshots.errors.length === 0
        && chunkErrors.length === 0,
      packs: rebuilt.packs.length,
      chunks: rebuilt.index.size,
      snapshots: snapshots.snapshots.length,
      packErrors: rebuilt.errors,
      duplicateChunkIds: rebuilt.duplicateChunkIds,
      snapshotErrors: snapshots.errors,
      chunkErrors,
    };
  } finally {
    masterKey.fill(0);
  }
}
