// PikPak-Direct 冷迁移 manifest 模块。
//
// 这个文件解决的不是“怎么上传”，而是更重要的“上传以后怎么知道云端那堆对象原来是什么”。
// 冷备份如果只有若干远端文件、却没有原路径、哈希、大小和远端 fileId 的对应关系，恢复时几乎等于白备份。
// 因此本模块把一次迁移定义成一个持久化 JSON manifest，并且每次状态变化都使用“临时文件 + rename”原子写盘。
//
// 设计边界：
// 1. manifest 只记录恢复所需的非 secret 信息，绝不保存 PikPak Cookie、STS secret 或 access token；
// 2. 当前远端不依赖 PikPak 内部“建目录”接口，而是给每个对象生成稳定、无冲突的名字；
// 3. 真正的目录结构保存在 relativePath 中，恢复时以 manifest 为准；
// 4. multipart checkpoint 只保存 ali-oss 官方文档明确需要的字段，避免把 SDK client/凭据意外序列化；
// 5. 第一版 encryption 明确写成 none，防止“有字段就误以为已经加密”。

import { createHash } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 把任意用户输入压缩成适合作为远端对象名前缀的 backup id。
 * 中文目录名可以保留在 manifest 的 relativePath；backup id 则故意限制为较保守的 ASCII，减少云端兼容问题。
 */
export function sanitizeBackupId(value) {
  const text = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  if (!text) throw new Error('backup id 不能为空，且必须至少包含一个字母、数字、点、下划线或短横线。');
  return text;
}

/**
 * 未指定 backup id 时生成一个“可读时间 + 源目录名”的默认值。
 * 时间使用 UTC，避免换时区后出现同一任务名字不一致；用户也可以用 --backup-id 显式固定名字。
 */
export function createDefaultBackupId(sourcePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const sourceName = basename(resolve(sourcePath)) || 'root';
  return sanitizeBackupId(`${stamp}-${sourceName}`);
}

/**
 * 远端对象名必须同时满足：稳定、无冲突、肉眼还能大致看懂。
 *
 * 完整恢复关系不靠文件名猜，而靠 manifest；这里仍附 basename 是为了在 PikPak UI 里浏览时不至于全是哈希。
 * 对特别长的 basename 会截断，并把 relativePath 的 SHA-256 前 10 位加进去，避免截断后重名。
 */
export function makeRemoteName({ backupId, index, relativePath }) {
  const safeId = sanitizeBackupId(backupId);
  const sequence = String(Number(index) + 1).padStart(6, '0');
  const originalBase = basename(relativePath).replace(/[\0/\\]+/g, '_') || 'file';
  const pathTag = createHash('sha256').update(String(relativePath)).digest('hex').slice(0, 10);
  const maxBaseLength = 140;
  const safeBase = originalBase.length > maxBaseLength
    ? `${originalBase.slice(0, maxBaseLength)}-${pathTag}`
    : originalBase;

  return `${safeId}__${sequence}__${safeBase}`;
}

/**
 * 递归枚举一个文件或目录，输出按 relativePath 排序的普通文件列表。
 *
 * 符号链接 / junction / 其他 reparse point 不自动跟随：冷迁移最怕把一个 junction 指向的整块目录
 * 意外重复备份，甚至造成递归环。第一版遇到链接会明确跳过并记录 warning，由上层展示给用户。
 */
export async function enumerateSource(sourcePath) {
  const absoluteSource = resolve(sourcePath);
  const rootInfo = await lstat(absoluteSource);
  const files = [];
  const warnings = [];

  if (rootInfo.isSymbolicLink()) {
    throw new Error(`源路径本身是符号链接/重解析点，第一版不自动跟随: ${absoluteSource}`);
  }

  if (rootInfo.isFile()) {
    files.push({
      absolutePath: absoluteSource,
      relativePath: basename(absoluteSource),
      size: rootInfo.size,
      mtimeMs: Math.trunc(rootInfo.mtimeMs),
    });
    return { sourceType: 'file', files, warnings };
  }

  if (!rootInfo.isDirectory()) {
    throw new Error(`仅支持普通文件或目录: ${absoluteSource}`);
  }

  async function walk(currentDirectory) {
    const children = await readdir(currentDirectory, { withFileTypes: true });
    // 不使用 localeCompare：不同 Windows/Node locale 可能把中文、ASCII 排出不同顺序，
    // 会进一步改变 index -> remoteName，导致同一目录在不同机器上生成不同 manifest。
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const child of children) {
      const childPath = join(currentDirectory, child.name);
      const childInfo = await lstat(childPath);

      if (childInfo.isSymbolicLink()) {
        warnings.push({
          relativePath: normalizeRelativePath(relative(absoluteSource, childPath)),
          reason: 'symlink-or-reparse-point-skipped',
        });
        continue;
      }

      if (childInfo.isDirectory()) {
        await walk(childPath);
        continue;
      }

      if (!childInfo.isFile()) {
        warnings.push({
          relativePath: normalizeRelativePath(relative(absoluteSource, childPath)),
          reason: 'non-regular-file-skipped',
        });
        continue;
      }

      files.push({
        absolutePath: childPath,
        relativePath: normalizeRelativePath(relative(absoluteSource, childPath)),
        size: childInfo.size,
        mtimeMs: Math.trunc(childInfo.mtimeMs),
      });
    }
  }

  await walk(absoluteSource);
  files.sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  return { sourceType: 'directory', files, warnings };
}

function normalizeRelativePath(value) {
  return String(value).replaceAll('\\', '/');
}

/**
 * 创建一份全新的迁移 manifest。
 */
export async function createMigrationManifest({
  sourcePath,
  backupId = null,
  parentId = '',
  route = 'direct-only',
  now = new Date(),
}) {
  const sourceRoot = resolve(sourcePath);
  const id = sanitizeBackupId(backupId || createDefaultBackupId(sourceRoot, now));
  const inventory = await enumerateSource(sourceRoot);
  const createdAt = now.toISOString();

  const entries = inventory.files.map((file, index) => ({
    index,
    relativePath: file.relativePath,
    size: file.size,
    mtimeMs: file.mtimeMs,
    sha1: null,
    remoteName: makeRemoteName({ backupId: id, index, relativePath: file.relativePath }),
    status: 'pending',
    fileId: null,
    taskId: null,
    provider: null,
    effectiveEndpoint: null,
    dataRoute: null,
    checkpoint: null,
    completedAt: null,
    lastError: null,
  }));

  return refreshManifestSummary({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    backupId: id,
    createdAt,
    updatedAt: createdAt,
    source: {
      root: sourceRoot,
      type: inventory.sourceType,
    },
    destination: {
      parentId: String(parentId || ''),
      manifestRemoteName: `${id}__manifest.json`,
    },
    policy: {
      route,
      encryption: 'none',
      deleteLocalAfterUpload: false,
    },
    warnings: inventory.warnings,
    entries,
    summary: {},
  }, now);
}

/**
 * 只从磁盘加载 manifest，并做最基本 schema 检查。
 */
export async function loadMigrationManifest(manifestPath) {
  const absolutePath = resolve(manifestPath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));

  if (parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`不支持的 manifest schemaVersion: ${parsed?.schemaVersion ?? 'missing'}`);
  }
  if (!parsed?.backupId || !parsed?.source?.root || !Array.isArray(parsed?.entries)) {
    throw new Error('manifest 缺少 backupId/source.root/entries 等必要字段。');
  }

  return parsed;
}

/**
 * 原子保存 manifest：先在同目录写临时文件，成功 fsync 语义由 Node/文件系统负责，最后 rename 覆盖正式文件。
 * 这样即使程序在 JSON 写到一半时被强拆，上一版 manifest 仍然完整存在。
 */
export async function saveMigrationManifest(manifestPath, manifest) {
  const absolutePath = resolve(manifestPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  const refreshed = refreshManifestSummary(manifest);
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(refreshed, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, absolutePath);
  return refreshed;
}

/**
 * 计算汇总字段。汇总永远由 entries 重新推导，不信任旧文件中的计数，避免中途崩溃留下不一致。
 */
export function refreshManifestSummary(manifest, now = new Date()) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const completed = entries.filter((entry) => entry.status === 'complete');
  const failed = entries.filter((entry) => entry.status === 'failed');
  const uploading = entries.filter((entry) => entry.status === 'uploading');
  const totalBytes = entries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
  const completedBytes = completed.reduce((sum, entry) => sum + Number(entry.size || 0), 0);

  return {
    ...manifest,
    updatedAt: now.toISOString(),
    summary: {
      totalFiles: entries.length,
      totalBytes,
      completedFiles: completed.length,
      completedBytes,
      failedFiles: failed.length,
      uploadingFiles: uploading.length,
      pendingFiles: entries.length - completed.length - failed.length - uploading.length,
    },
  };
}

/**
 * ali-oss checkpoint 可能随着 SDK 版本附带额外对象。
 * 为了避免把凭据/client/response 整体写入 manifest，这里只白名单保存恢复 multipart 所需字段。
 */
export function sanitizeCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;

  return {
    name: checkpoint.name || null,
    file: typeof checkpoint.file === 'string' ? checkpoint.file : null,
    fileSize: Number.isFinite(Number(checkpoint.fileSize)) ? Number(checkpoint.fileSize) : null,
    partSize: Number.isFinite(Number(checkpoint.partSize)) ? Number(checkpoint.partSize) : null,
    uploadId: checkpoint.uploadId || null,
    doneParts: Array.isArray(checkpoint.doneParts)
      ? checkpoint.doneParts.map((part) => ({
        number: Number(part.number),
        etag: part.etag || null,
      }))
      : [],
  };
}

/**
 * 迁移重跑前检查本地源文件是否仍与 manifest 建立时一致。
 * 只比较 size + mtime 是为了避免每次启动都把整个 TB 数据重新 hash 一遍；真正上传前仍会计算 SHA-1。
 */
export async function inspectLocalEntry(manifest, entry) {
  const sourcePath = manifest.source.type === 'file'
    ? manifest.source.root
    : join(manifest.source.root, ...String(entry.relativePath).split('/'));

  try {
    const fileInfo = await stat(sourcePath);
    const current = {
      exists: fileInfo.isFile(),
      path: sourcePath,
      size: fileInfo.size,
      mtimeMs: Math.trunc(fileInfo.mtimeMs),
    };
    current.unchanged = current.exists
      && current.size === Number(entry.size)
      && current.mtimeMs === Number(entry.mtimeMs);
    return current;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, unchanged: false, path: sourcePath, size: null, mtimeMs: null };
    }
    throw error;
  }
}

/**
 * 生成适合上传到云端的“便携恢复 manifest”。
 *
 * 本地运行态 manifest 需要绝对路径和 multipart checkpoint，方便断点续传；但把这些内容直接上传
 * 会暴露 Windows 用户名/本机目录结构中不必要的部分，也可能把临时 uploadId 带到云端。
 * 便携版只保留恢复一份冷备份真正需要的信息：源根目录的显示名、相对路径、大小、mtime、SHA-1、
 * 远端对象名和 PikPak file/task id。它不包含 cookie、STS、checkpoint，也不包含本机绝对路径。
 */
export function buildPortableManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: 'pikpak-direct-portable-manifest',
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    exportedAt: new Date().toISOString(),
    source: {
      label: basename(manifest.source.root),
      type: manifest.source.type,
    },
    destination: {
      parentId: manifest.destination?.parentId || '',
    },
    policy: {
      route: manifest.policy?.route || 'unknown',
      encryption: manifest.policy?.encryption || 'none',
    },
    summary: refreshManifestSummary(manifest).summary,
    entries: manifest.entries.map((entry) => ({
      index: entry.index,
      relativePath: entry.relativePath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      sha1: entry.sha1,
      remoteName: entry.remoteName,
      status: entry.status,
      fileId: entry.fileId,
      taskId: entry.taskId,
      provider: entry.provider,
      completedAt: entry.completedAt,
    })),
  };
}

