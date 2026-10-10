// PikPak-Direct 加密仓库 v1 的 PikPak 远端同步层。
//
// 设计约束：
// - PikPak 上只有一个稳定、可见的仓库根目录；默认名 `PikPak-Direct Vault`；
// - 远端不暴露原始目录/文件名/chunk hash。对象名只有固定 repo.json 与随机 pack/snapshot id；
// - pack/snapshot 都是 immutable：同名远端对象一旦 COMPLETE 且 size 一致就复用，size 不一致
//   视为冲突/损坏，不做“覆盖”或猜测；
// - repo.json 很小且是固定名，推送时会下载远端副本逐字节比较，避免同 size 不同内容被误跳过；
// - push 使用现有 Route A：Web 只拿 control-plane task + STS，正文仍 Node -> Aliyun OSS；
// - pull 使用 PikPak `/files/{id}` 返回的短期下载 ticket，URL 永不打印/写盘；
// - fresh machine 不依赖 latest.json、本地 SQLite 或同步清单：只要能枚举远端根目录，就能下载
//   repo.json + 所有 pack/snapshot，再由加密仓库层自行重建 index / 枚举 snapshot。

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isSafeAliyunRegion } from './aliyun-endpoint.mjs';
import { sha1File } from './file-hash.mjs';
import { uploadFileToPikPakOss } from './oss-uploader.mjs';
import { PikPakWebSession } from './pikpak-web-session.mjs';
import { discoverAliyunRegion } from './region-discovery.mjs';

export const DEFAULT_REMOTE_REPOSITORY_FOLDER = 'PikPak-Direct Vault';

const PACK_REMOTE_RE = /^pack-([a-f0-9]{32})\.ppdp$/i;
const SNAPSHOT_REMOTE_RE = /^snapshot-([a-f0-9]{32})\.ppds$/i;

/** 列出一个 PikPak 目录的全部页面，并检测 page_token 循环。 */
export async function listAllPikPakFiles(web, parentId = '', { maxPages = 10_000 } = {}) {
  const files = [];
  const seenTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < maxPages; page += 1) {
    const result = await web.listFiles({ parentId, pageToken, limit: 1000 });
    files.push(...result.files);
    if (!result.nextPageToken) return files;
    if (seenTokens.has(result.nextPageToken)) {
      throw new Error('PikPak listFiles 返回循环 page_token，拒绝继续无限分页。');
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw new Error(`PikPak 目录分页超过安全上限 ${maxPages} 页。`);
}

/**
 * 查找稳定仓库根目录；create=true 时不存在就创建。
 * 精确同名 active folder 只能有一个，多于一个直接报错，避免把对象分散进多个“同名根”。
 */
export async function resolveRemoteRepositoryRoot(web, {
  folderName = DEFAULT_REMOTE_REPOSITORY_FOLDER,
  create = false,
} = {}) {
  if (!String(folderName || '').trim()) throw new Error('远端仓库根目录名称不能为空。');
  const rootFiles = await listAllPikPakFiles(web, '');
  const sameName = rootFiles.filter((file) => file.name === folderName && !file.trashed);
  const folders = sameName.filter((file) => file.kind === 'drive#folder');
  const nonFolders = sameName.filter((file) => file.kind !== 'drive#folder');

  if (nonFolders.length > 0) {
    throw new Error(`PikPak 根目录已有同名非文件夹对象: ${folderName}`);
  }
  if (folders.length > 1) {
    throw new Error(`PikPak 根目录存在 ${folders.length} 个同名仓库文件夹，拒绝猜测使用哪一个: ${folderName}`);
  }
  if (folders.length === 1) return folders[0];
  if (!create) throw new Error(`PikPak 远端仓库根目录不存在: ${folderName}`);

  const created = await web.createFolder({ name: folderName, parentId: '' });
  if (created.kind !== 'drive#folder' || !created.id) {
    throw new Error('PikPak 创建仓库根目录后返回异常。');
  }
  return created;
}

/**
 * 把本地 repository v1 物化为不暴露原始路径的远端对象名。
 * latest.json 故意不上云：snapshot 本身可枚举，fresh restore 不依赖可变指针。
 */
export async function collectRepositoryArtifacts(repoDir) {
  const root = resolve(repoDir);
  const artifacts = [];

  const headerPath = join(root, 'repo.json');
  const headerStat = await stat(headerPath);
  if (!headerStat.isFile()) throw new Error(`缺少 repo.json: ${headerPath}`);
  artifacts.push({
    kind: 'header',
    localPath: headerPath,
    remoteName: 'repo.json',
    size: headerStat.size,
  });

  const packNames = (await readdir(join(root, 'packs'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{32}\.ppdp$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of packNames) {
    const localPath = join(root, 'packs', name);
    const info = await stat(localPath);
    artifacts.push({
      kind: 'pack',
      localPath,
      remoteName: `pack-${name}`,
      size: info.size,
    });
  }

  const snapshotNames = (await readdir(join(root, 'snapshots'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{32}\.ppds$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of snapshotNames) {
    const localPath = join(root, 'snapshots', name);
    const info = await stat(localPath);
    artifacts.push({
      kind: 'snapshot',
      localPath,
      remoteName: `snapshot-${name}`,
      size: info.size,
    });
  }

  return artifacts;
}

/** 把受控远端对象名映射回本地 repository 布局；未知对象返回 null。 */
export function remoteArtifactToLocalRelativePath(name) {
  if (name === 'repo.json') return 'repo.json';
  const pack = String(name || '').match(PACK_REMOTE_RE);
  if (pack) return join('packs', `${pack[1].toLowerCase()}.ppdp`);
  const snapshot = String(name || '').match(SNAPSHOT_REMOTE_RE);
  if (snapshot) return join('snapshots', `${snapshot[1].toLowerCase()}.ppds`);
  return null;
}

function indexRemoteRepositoryFiles(files) {
  const map = new Map();
  for (const file of files.filter((item) => !item.trashed)) {
    if (!remoteArtifactToLocalRelativePath(file.name)) continue;
    if (map.has(file.name)) {
      throw new Error(`远端仓库存在重复对象名，拒绝猜测: ${file.name}`);
    }
    map.set(file.name, file);
  }
  return map;
}

/**
 * 下载一个 PikPak 文件到指定路径，使用临时文件 + fsync + rename。
 * 完整 signed URL 只在 ticket private field -> fetch() 这一跳出现。
 */
export async function downloadPikPakFile(web, remoteFile, destinationPath, {
  fetchImpl = fetch,
} = {}) {
  const ticket = await web.getDownloadTicket(remoteFile.id);
  const expectedSize = Number(remoteFile.size);
  const response = await fetchImpl(ticket.getUrl(), {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`PikPak 下载失败: HTTP ${response.status} (${remoteFile.name})`);
  }

  const outputPath = resolve(destinationPath);
  await mkdir(resolve(outputPath, '..'), { recursive: true }).catch(async () => {
    // 上面 resolve(file,'..') 在 Node path 语义里不是 dirname；fallback 由调用方预创建目录。
  });
  const tempPath = `${outputPath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = await open(tempPath, 'wx');
  let written = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await handle.write(buffer);
      written += buffer.length;
    }
    await handle.sync();
    await handle.close();
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && written !== expectedSize) {
      throw new Error(`PikPak 下载长度不一致: ${remoteFile.name}, expected=${expectedSize}, actual=${written}`);
    }
    await rename(tempPath, outputPath);
    return { path: outputPath, bytes: written };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadSmallFileBuffer(web, remoteFile, { fetchImpl = fetch, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (Number(remoteFile.size) > maxBytes) throw new Error(`远端小对象超过 ${maxBytes} 字节安全上限。`);
  const ticket = await web.getDownloadTicket(remoteFile.id);
  const response = await fetchImpl(ticket.getUrl(), {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`PikPak 小对象下载失败: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== Number(remoteFile.size)) throw new Error('PikPak 小对象下载长度不一致。');
  return buffer;
}

/** 通过现有 Route A 上传一个 immutable 仓库对象。 */
async function uploadRepositoryArtifact(web, artifact, parentId, {
  region = null,
  route = 'direct-only',
  parallel = 4,
  checkInTimeoutSec = 180,
} = {}) {
  const sha1 = await sha1File(artifact.localPath);
  const session = await web.createResumableUpload({
    name: artifact.remoteName,
    size: artifact.size,
    sha1,
    parentId,
  });

  let resolvedRegion = region;
  if (route !== 'server' && !resolvedRegion) {
    const discovery = await discoverAliyunRegion({
      serverEndpoint: session.serverEndpoint,
      expectedBucket: session.bucket,
    });
    if (discovery.ok) resolvedRegion = discovery.region;
    else if (route === 'direct-only') throw new Error(`无法自动确定 Aliyun region：${discovery.reason}`);
  }

  const uploaded = await uploadFileToPikPakOss({
    session,
    filePath: artifact.localPath,
    fileSize: artifact.size,
    regionHint: resolvedRegion,
    policy: route,
    parallel,
  });
  const checkIn = await web.waitTaskComplete(session.taskId, {
    timeoutMs: checkInTimeoutSec * 1000,
    intervalMs: 500,
  });
  if (!checkIn.allDone) {
    throw new Error(`仓库对象上传后未完成 PikPak check-in: ${artifact.remoteName} (fileId=${session.fileId}, taskId=${session.taskId})`);
  }
  return {
    fileId: session.fileId,
    taskId: session.taskId,
    region: resolvedRegion,
    route: uploaded.route,
  };
}

/**
 * 将本地加密仓库增量推送到 PikPak 固定根目录。
 * push 不删除远端对象；由于 pack/snapshot immutable，旧 snapshot 保留本来就是历史版本能力。
 */
export async function pushRepositoryToPikPak({
  repoDir,
  cdpUrl = 'http://127.0.0.1:9222',
  remoteFolderName = DEFAULT_REMOTE_REPOSITORY_FOLDER,
  region = null,
  route = 'direct-only',
  parallel = 4,
  checkInTimeoutSec = 180,
  onEvent = () => {},
} = {}) {
  if (region && !isSafeAliyunRegion(region)) throw new Error(`无效 Aliyun region: ${region}`);
  if (!['direct-only', 'prefer-direct', 'server'].includes(route)) throw new Error(`无效 route: ${route}`);
  const artifacts = await collectRepositoryArtifacts(repoDir);
  const web = await PikPakWebSession.connect({ cdpUrl });
  let resolvedRegion = region;

  try {
    const root = await resolveRemoteRepositoryRoot(web, { folderName: remoteFolderName, create: true });
    const remoteFiles = await listAllPikPakFiles(web, root.id);
    const remote = indexRemoteRepositoryFiles(remoteFiles);
    const result = { root, uploaded: [], skipped: [] };

    for (const artifact of artifacts) {
      const existing = remote.get(artifact.remoteName);
      if (existing) {
        if (existing.kind !== 'drive#file') throw new Error(`远端同名对象不是普通文件: ${artifact.remoteName}`);
        if (existing.phase !== 'PHASE_TYPE_COMPLETE') throw new Error(`远端同名对象未 COMPLETE: ${artifact.remoteName}`);
        if (Number(existing.size) !== Number(artifact.size)) {
          throw new Error(`远端 immutable 对象 size 冲突: ${artifact.remoteName}`);
        }

        // repo.json 是固定名，不具备随机 object id 的碰撞保护，因此每次都做小对象逐字节核对。
        if (artifact.kind === 'header') {
          const [local, cloud] = await Promise.all([
            readFile(artifact.localPath),
            downloadSmallFileBuffer(web, existing),
          ]);
          if (!local.equals(cloud)) throw new Error('远端 repo.json 与本地仓库 header 不一致，拒绝覆盖/混用。');
        }

        result.skipped.push({ name: artifact.remoteName, size: artifact.size, fileId: existing.id });
        onEvent({ type: 'skip', artifact, remoteFile: existing });
        continue;
      }

      onEvent({ type: 'upload-start', artifact });
      const uploaded = await uploadRepositoryArtifact(web, artifact, root.id, {
        region: resolvedRegion,
        route,
        parallel,
        checkInTimeoutSec,
      });
      if (!resolvedRegion && uploaded.region) resolvedRegion = uploaded.region;
      result.uploaded.push({ name: artifact.remoteName, size: artifact.size, fileId: uploaded.fileId });
      onEvent({ type: 'upload-complete', artifact, uploaded });
    }

    return result;
  } finally {
    await web.close();
  }
}

/**
 * 从 PikPak 固定根目录物化一个完整本地 repository v1。
 * 默认不覆盖任何现有文件；相同 size 的已有 immutable 对象直接跳过，随后由 repo-verify 做
 * 密码学完整性校验。`overwrite=true` 用于明确要求重新下载的灾难恢复场景。
 */
export async function pullRepositoryFromPikPak({
  repoDir,
  cdpUrl = 'http://127.0.0.1:9222',
  remoteFolderName = DEFAULT_REMOTE_REPOSITORY_FOLDER,
  overwrite = false,
  onEvent = () => {},
} = {}) {
  const rootPath = resolve(repoDir);
  const web = await PikPakWebSession.connect({ cdpUrl });
  try {
    const root = await resolveRemoteRepositoryRoot(web, { folderName: remoteFolderName, create: false });
    const remoteFiles = await listAllPikPakFiles(web, root.id);
    const remote = indexRemoteRepositoryFiles(remoteFiles);
    if (!remote.has('repo.json')) throw new Error('远端仓库缺少 repo.json。');

    await mkdir(join(rootPath, 'packs'), { recursive: true });
    await mkdir(join(rootPath, 'snapshots'), { recursive: true });

    const result = { root, downloaded: [], skipped: [], ignoredRemoteObjects: [] };
    for (const file of remoteFiles.filter((item) => !item.trashed)) {
      const relativePath = remoteArtifactToLocalRelativePath(file.name);
      if (!relativePath) {
        result.ignoredRemoteObjects.push(file.name);
        continue;
      }
      if (file.kind !== 'drive#file' || file.phase !== 'PHASE_TYPE_COMPLETE') {
        throw new Error(`远端仓库对象状态异常: ${file.name}`);
      }
      const localPath = join(rootPath, relativePath);

      if (!overwrite) {
        try {
          const local = await stat(localPath);
          if (!local.isFile()) throw new Error(`本地目标不是普通文件: ${localPath}`);
          if (local.size !== Number(file.size)) {
            throw new Error(`本地已有对象 size 与远端冲突: ${file.name}`);
          }
          result.skipped.push({ name: file.name, size: file.size, path: localPath });
          onEvent({ type: 'skip', remoteFile: file, localPath });
          continue;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        await rm(localPath, { force: true });
      }

      onEvent({ type: 'download-start', remoteFile: file, localPath });
      const downloaded = await downloadPikPakFile(web, file, localPath);
      result.downloaded.push({ name: file.name, size: downloaded.bytes, path: downloaded.path });
      onEvent({ type: 'download-complete', remoteFile: file, localPath, downloaded });
    }
    return result;
  } finally {
    await web.close();
  }
}
