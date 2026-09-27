// PikPak-Direct 目录冷迁移执行器。
//
// 这一层把现有“单文件上传”能力组合成一条可恢复的目录迁移流水线：
//
//   建 manifest -> 校验源快照 -> SHA-1 -> 创建 PikPak task -> OSS multipart
//   -> 持久化 checkpoint -> 等待 PikPak COMPLETE -> 更新 manifest -> 上传便携 manifest
//
// 重要安全边界：
// - 永远不删除本地源文件；
// - 已建立 manifest 后，若源文件 size/mtime 发生变化，拒绝继续把它混进原快照；
// - 任何失败都先写 manifest 再抛错，保证下次运行有恢复上下文；
// - multipart checkpoint 只保证“SDK 断点状态被保存”，不宣称 PikPak 的短期 STS 可以无限期续签。

import { access, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSafeAliyunRegion } from './aliyun-endpoint.mjs';
import { sha1File } from './file-hash.mjs';
import {
  buildPortableManifest,
  createMigrationManifest,
  inspectLocalEntry,
  loadMigrationManifest,
  saveMigrationManifest,
} from './migration-manifest.mjs';
import { uploadFileToPikPakOss } from './oss-uploader.mjs';
import { PikPakWebSession } from './pikpak-web-session.mjs';
import { discoverAliyunRegion } from './region-discovery.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 新建或恢复一次迁移任务。
 *
 * 如果 manifest 已存在，它是本次快照的权威来源：backupId、parentId、route 都沿用原值，
 * 避免用户重跑命令时不小心把同一快照的一半文件传到另一个目的地。
 */
export async function prepareMigration({
  sourcePath,
  manifestPath = null,
  backupId = null,
  parentId = '',
  route = 'direct-only',
}) {
  const absoluteSource = resolve(sourcePath);
  let absoluteManifest = manifestPath ? resolve(manifestPath) : null;
  let manifest;
  let resumed = false;

  if (absoluteManifest && await pathExists(absoluteManifest)) {
    manifest = await loadMigrationManifest(absoluteManifest);
    resumed = true;

    if (resolve(manifest.source.root) !== absoluteSource) {
      throw new Error(
        `manifest 属于另一个源路径。manifest=${manifest.source.root}，本次=${absoluteSource}`,
      );
    }
    if (backupId && manifest.backupId !== backupId) {
      throw new Error(`--backup-id 与现有 manifest 不一致: ${backupId} != ${manifest.backupId}`);
    }
  } else {
    manifest = await createMigrationManifest({
      sourcePath: absoluteSource,
      backupId,
      parentId,
      route,
    });
    absoluteManifest ||= join(PROJECT_ROOT, 'manifests', `${manifest.backupId}.json`);
    manifest = await saveMigrationManifest(absoluteManifest, manifest);
  }

  return {
    manifest,
    manifestPath: absoluteManifest,
    resumed,
  };
}

/**
 * 验证 manifest 指向的本地源文件是否仍是同一个快照。
 * fullHash=false 时只比较 size/mtime，速度适合几十/几百 GB 目录；fullHash=true 时还会逐文件重算 SHA-1。
 */
export async function verifyManifestLocal(manifest, { fullHash = false } = {}) {
  const results = [];

  for (const entry of manifest.entries) {
    const local = await inspectLocalEntry(manifest, entry);
    let hashMatches = null;

    if (fullHash && local.unchanged && entry.sha1) {
      const currentSha1 = await sha1File(local.path);
      hashMatches = currentSha1 === entry.sha1;
    }

    results.push({
      index: entry.index,
      relativePath: entry.relativePath,
      exists: local.exists,
      metadataMatches: local.unchanged,
      hashMatches,
      status: entry.status,
    });
  }

  return {
    ok: results.every((item) => item.exists
      && item.metadataMatches
      && (item.hashMatches === null || item.hashMatches)),
    results,
  };
}

/**
 * 为一个 PikPak upload session 决定数据面 region。
 * migration 会连续上传很多文件，因此按 serverEndpoint+bucket 做进程内缓存，避免每个文件都重复 DoH。
 */
async function resolveRegion({ uploadSession, route, regionOverride, regionCache }) {
  if (route === 'server') return null;
  if (regionOverride) return regionOverride;

  const cacheKey = `${uploadSession.serverEndpoint}|${uploadSession.bucket}`;
  if (regionCache.has(cacheKey)) return regionCache.get(cacheKey);

  const discovery = await discoverAliyunRegion({
    serverEndpoint: uploadSession.serverEndpoint,
    expectedBucket: uploadSession.bucket,
  });

  if (!discovery.ok) {
    if (route === 'direct-only') {
      throw new Error(`无法自动确认 Aliyun region：${discovery.reason}`);
    }
    regionCache.set(cacheKey, null);
    return null;
  }

  regionCache.set(cacheKey, discovery.region);
  return discovery.region;
}

/**
 * 上传一个已经算好 SHA-1 的普通文件，并等待 PikPak 元数据完成 check-in。
 * 该函数不更新 manifest，便于普通数据文件和最后的便携 manifest 共用。
 */
async function uploadPreparedFile({
  web,
  filePath,
  size,
  sha1,
  remoteName,
  parentId,
  route,
  regionOverride,
  parallel,
  checkInTimeoutSec,
  checkpoint = null,
  onCheckpoint = null,
  onProgress = null,
  regionCache,
}) {
  const uploadSession = await web.createResumableUpload({
    name: remoteName,
    size,
    sha1,
    parentId,
  });

  const resolvedRegion = await resolveRegion({
    uploadSession,
    route,
    regionOverride,
    regionCache,
  });

  const ossResult = await uploadFileToPikPakOss({
    session: uploadSession,
    filePath,
    fileSize: size,
    regionHint: resolvedRegion,
    policy: route,
    parallel,
    checkpoint,
    onCheckpoint,
    onProgress,
  });

  const checkIn = await web.waitTaskComplete(uploadSession.taskId, {
    timeoutMs: checkInTimeoutSec * 1000,
    intervalMs: 500,
  });

  if (!checkIn.allDone) {
    throw new Error(
      `OSS 已完成但 PikPak task 未 COMPLETE: taskId=${uploadSession.taskId}, `
      + `phase=${checkIn.phase || 'unknown'}, progress=${checkIn.progress ?? 'unknown'}`,
    );
  }

  return {
    fileId: uploadSession.fileId,
    taskId: uploadSession.taskId,
    provider: uploadSession.provider,
    stsExpiration: uploadSession.expiration || null,
    effectiveEndpoint: ossResult.effectiveEndpoint,
    dataRoute: ossResult.route,
    checkIn,
  };
}

/**
 * 执行一次目录/文件迁移。
 *
 * dryRun 只建立 manifest，不连接浏览器或 PikPak；因此很适合先对一个大目录生成“将要上传什么”的清单。
 */
export async function runMigration({
  sourcePath,
  manifestPath = null,
  backupId = null,
  parentId = '',
  route = 'direct-only',
  region = null,
  parallel = 4,
  checkInTimeoutSec = 180,
  cdpUrl = DEFAULT_CDP_URL,
  dryRun = false,
  uploadPortableManifest = true,
  onEvent = () => {},
}) {
  if (region && !isSafeAliyunRegion(region)) {
    throw new Error(`无效 Aliyun region: ${region}`);
  }

  let prepared = await prepareMigration({
    sourcePath,
    manifestPath,
    backupId,
    parentId,
    route,
  });
  let { manifest } = prepared;
  const resolvedManifestPath = prepared.manifestPath;

  onEvent({ type: 'manifest-ready', manifestPath: resolvedManifestPath, manifest });
  if (dryRun) {
    return { manifest, manifestPath: resolvedManifestPath, dryRun: true };
  }

  const web = await PikPakWebSession.connect({ cdpUrl });
  const regionCache = new Map();

  try {
    for (let index = 0; index < manifest.entries.length; index += 1) {
      let entry = manifest.entries[index];
      const local = await inspectLocalEntry(manifest, entry);

      if (!local.exists || !local.unchanged) {
        entry.status = 'source-changed';
        entry.lastError = local.exists
          ? '源文件的 size/mtime 与建立 manifest 时不同。请为新版本建立新的 backup id。'
          : '源文件已经不存在。';
        manifest = await saveMigrationManifest(resolvedManifestPath, manifest);
        throw new Error(`${entry.relativePath}: ${entry.lastError}`);
      }

      if (entry.status === 'complete') {
        onEvent({ type: 'file-skip-complete', entry });
        continue;
      }

      // SHA-1 一旦写入 manifest，且 size/mtime 未变化，重跑时直接复用，避免重复读取几十 GB 文件。
      if (!entry.sha1) {
        onEvent({ type: 'hash-start', entry });
        entry.sha1 = await sha1File(local.path);
        manifest = await saveMigrationManifest(resolvedManifestPath, manifest);
        entry = manifest.entries[index];
        onEvent({ type: 'hash-complete', entry });
      }

      entry.status = 'uploading';
      entry.lastError = null;
      manifest = await saveMigrationManifest(resolvedManifestPath, manifest);
      entry = manifest.entries[index];
      onEvent({ type: 'upload-start', entry });

      let lastCheckpointWrite = 0;
      try {
        const upload = await uploadPreparedFile({
          web,
          filePath: local.path,
          size: entry.size,
          sha1: entry.sha1,
          remoteName: entry.remoteName,
          parentId: manifest.destination.parentId,
          route: manifest.policy.route,
          regionOverride: region,
          parallel,
          checkInTimeoutSec,
          checkpoint: entry.checkpoint,
          regionCache,
          async onCheckpoint(checkpoint) {
            entry.checkpoint = checkpoint;
            const now = Date.now();
            // 每 5 秒最多落盘一次：既能把中断损失控制在很小范围，也避免数千个 part 产生数千次磁盘写入。
            if (now - lastCheckpointWrite >= 5_000) {
              lastCheckpointWrite = now;
              await saveMigrationManifest(resolvedManifestPath, manifest);
            }
          },
          onProgress(progress) {
            onEvent({ type: 'upload-progress', entry, progress });
          },
        });

        entry.fileId = upload.fileId;
        entry.taskId = upload.taskId;
        entry.provider = upload.provider;
        entry.stsExpiration = upload.stsExpiration;
        entry.effectiveEndpoint = upload.effectiveEndpoint;
        entry.dataRoute = upload.dataRoute;
        entry.status = 'complete';
        entry.checkpoint = null;
        entry.completedAt = new Date().toISOString();
        entry.lastError = null;
        manifest = await saveMigrationManifest(resolvedManifestPath, manifest);
        onEvent({ type: 'upload-complete', entry: manifest.entries[index] });
      } catch (error) {
        entry.status = 'failed';
        entry.lastError = String(error?.message || error);
        await saveMigrationManifest(resolvedManifestPath, manifest);
        onEvent({ type: 'upload-failed', entry, error });
        throw error;
      }
    }

    if (uploadPortableManifest && manifest.entries.every((entry) => entry.status === 'complete')) {
      const portable = buildPortableManifest(manifest);
      const portablePath = join(dirname(resolvedManifestPath), `${manifest.backupId}.portable.json`);
      await writeFile(portablePath, `${JSON.stringify(portable, null, 2)}\n`, 'utf8');
      const portableStat = await stat(portablePath);
      const portableSha1 = await sha1File(portablePath);
      onEvent({ type: 'portable-manifest-upload-start', portablePath });

      try {
        const uploadedManifest = await uploadPreparedFile({
          web,
          filePath: portablePath,
          size: portableStat.size,
          sha1: portableSha1,
          remoteName: manifest.destination.manifestRemoteName,
          parentId: manifest.destination.parentId,
          route: manifest.policy.route,
          regionOverride: region,
          parallel: 1,
          checkInTimeoutSec,
          regionCache,
        });

        manifest.cloudManifest = {
          status: 'complete',
          remoteName: manifest.destination.manifestRemoteName,
          sha1: portableSha1,
          size: portableStat.size,
          fileId: uploadedManifest.fileId,
          taskId: uploadedManifest.taskId,
          completedAt: new Date().toISOString(),
        };
        manifest = await saveMigrationManifest(resolvedManifestPath, manifest);
        onEvent({ type: 'portable-manifest-upload-complete', cloudManifest: manifest.cloudManifest });
      } catch (error) {
        manifest.cloudManifest = {
          status: 'failed',
          remoteName: manifest.destination.manifestRemoteName,
          sha1: portableSha1,
          size: portableStat.size,
          lastError: String(error?.message || error),
        };
        await saveMigrationManifest(resolvedManifestPath, manifest);
        throw error;
      }
    }

    return {
      manifest,
      manifestPath: resolvedManifestPath,
      dryRun: false,
    };
  } finally {
    web.close();
  }
}

