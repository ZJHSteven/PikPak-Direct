#!/usr/bin/env node

// PikPak-Direct 第一版真实文件 CLI。
//
// 目前只实现一个最重要命令：
//
//   pikpak-direct upload <local-file> --region ap-southeast-1
//
// 流程：
//   1. 流式 SHA-1 读取本地文件；
//   2. 通过已登录 PikPak Web/CDP 创建 resumable task；
//   3. 从 PikPak task 中取得短生命周期 Aliyun STS；
//   4. 把自定义 PikPak OSS CNAME 安全规范化为原生 Aliyun OSS endpoint；
//   5. Node 直接 multipartUpload 本地文件路径；
//   6. 轮询 PikPak task，确认 progress=100 / COMPLETE；
//   7. 输出不含 secret 的结果清单。
//
// 安全默认：
// - route 默认 direct-only；无法确认 region 时拒绝上传，不静默走代理正文；
// - 不修改 Mihomo 全局 mode / 配置；
// - 成功文件默认保留；
// - 失败/超时默认也不自动删除远端 placeholder，避免把“最终一致性延迟”误当失败后误删；
// - 只有显式 --trash-after-success 才在成功后把本次文件移入 PikPak 回收站，主要用于 smoke test。

import { basename, resolve } from 'node:path';
import process from 'node:process';
import { stat } from 'node:fs/promises';

import { sha1File } from '../src/file-hash.mjs';
import { uploadFileToPikPakOss } from '../src/oss-uploader.mjs';
import { isSafeAliyunRegion } from '../src/aliyun-endpoint.mjs';
import { loadMigrationManifest } from '../src/migration-manifest.mjs';
import { runMigration, verifyManifestLocal } from '../src/migration-runner.mjs';
import { PikPakWebSession } from '../src/pikpak-web-session.mjs';
import { discoverAliyunRegion } from '../src/region-discovery.mjs';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

function printHelp() {
  console.log(`PikPak-Direct

用法：
  pikpak-direct upload <local-file>

示例：
  node bin/pikpak-direct.mjs upload "D:\\Archive\\example.zip"
  node bin/pikpak-direct.mjs upload "D:\\Archive\\example.zip" --region ap-southeast-1

参数：
  --region <region>               可选人工 override；省略时通过多家 DoH CNAME 共识自动发现。
  --route <policy>                direct-only | prefer-direct | server，默认 direct-only。
  --name <remote-name>            PikPak 文件名，默认使用本地 basename。
  --parent-id <id>                PikPak 目标父目录 id，默认根目录。
  --parallel <n>                  multipart 并发，默认 4，范围 1~32。
  --checkin-timeout-sec <n>       OSS 上传后等待 PikPak 检入，默认 180 秒。
  --cdp <url>                     Chrome DevTools 地址，默认 ${DEFAULT_CDP_URL}。
  --trash-after-success           成功并检入后立刻移入回收站，仅建议 smoke test。
  -h, --help                      显示帮助。

重要：
  - 本工具不会切换 Mihomo 全局 mode。
  - direct-only 无法确定/验证 endpoint 时会失败，不会偷偷把 TB 正文走代理。
  - 当前控制面依赖已登录的 PikPak Web 标签页与 2026-08-29 已验证的 Web 前端模块。
`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const command = argv[0];
  if (!new Set(['upload', 'migrate', 'inspect-manifest', 'verify-local']).has(command)) {
    throw new Error(`当前只支持 upload 命令，收到: ${command}`);
  }

  const localFile = argv[1];
  if (!localFile || localFile.startsWith('--')) {
    throw new Error('upload 命令必须提供本地文件路径。');
  }

  const args = {
    command,
    localFile,
    region: null,
    route: 'direct-only',
    remoteName: null,
    parentId: '',
    parallel: 4,
    checkInTimeoutSec: 180,
    cdpUrl: DEFAULT_CDP_URL,
    trashAfterSuccess: false,
    manifestPath: command === 'inspect-manifest' || command === 'verify-local' ? localFile : null,
    backupId: null,
    dryRun: false,
    uploadPortableManifest: true,
    fullHash: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === '--region') {
      args.region = value;
      index += 1;
    } else if (flag === '--route') {
      args.route = value;
      index += 1;
    } else if (flag === '--name') {
      args.remoteName = value;
      index += 1;
    } else if (flag === '--parent-id') {
      args.parentId = value || '';
      index += 1;
    } else if (flag === '--parallel') {
      args.parallel = Number(value);
      index += 1;
    } else if (flag === '--checkin-timeout-sec') {
      args.checkInTimeoutSec = Number(value);
      index += 1;
    } else if (flag === '--cdp') {
      args.cdpUrl = value;
      index += 1;
    } else if (flag === '--trash-after-success') {
      args.trashAfterSuccess = true;
    } else if (flag === '--manifest') {
      args.manifestPath = value;
      index += 1;
    } else if (flag === '--backup-id') {
      args.backupId = value;
      index += 1;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--no-upload-manifest') {
      args.uploadPortableManifest = false;
    } else if (flag === '--full-hash') {
      args.fullHash = true;
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }

  return args;
}

function validateArgs(args) {
  if (args.command === 'inspect-manifest' || args.command === 'verify-local') return;

  if (!['direct-only', 'prefer-direct', 'server'].includes(args.route)) {
    throw new Error('--route 只能是 direct-only、prefer-direct 或 server。');
  }

  if (args.region && !isSafeAliyunRegion(args.region)) {
    throw new Error(`无效 Aliyun region: ${args.region}`);
  }

  if (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 32) {
    throw new Error('--parallel 必须是 1~32 的整数。');
  }

  if (!Number.isFinite(args.checkInTimeoutSec) || args.checkInTimeoutSec < 1 || args.checkInTimeoutSec > 3600) {
    throw new Error('--checkin-timeout-sec 必须是 1~3600 秒。');
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'unknown';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let number = value;
  let index = 0;

  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }

  return `${number.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDuration(ms) {
  const seconds = Number(ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}min`;
}

async function uploadCommand(args) {
  const filePath = resolve(args.localFile);
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error(`当前 MVP 只支持单个普通文件，不支持目录: ${filePath}`);
  }

  const remoteName = args.remoteName || basename(filePath);

  console.log(`[1/5] 本地文件: ${filePath}`);
  console.log(`      大小: ${formatBytes(fileStat.size)}`);
  console.log(`      远端文件名: ${remoteName}`);
  console.log(`      数据路由策略: ${args.route}${args.region ? ` / region=${args.region}` : ''}`);

  // SHA-1 是纯本地读盘，不产生网络流量。为避免刷屏，每读取约 5% 才更新一次提示。
  console.log('[2/5] 计算 SHA-1（流式，不把整个文件读入内存）...');
  let lastHashProgressBucket = -1;
  const sha1Started = Date.now();

  const sha1 = await sha1File(filePath, {
    onProgress({ bytesRead }) {
      if (fileStat.size <= 0) return;
      const percent = Math.min(100, (bytesRead / fileStat.size) * 100);
      const bucket = Math.floor(percent / 5);
      if (bucket !== lastHashProgressBucket) {
        lastHashProgressBucket = bucket;
        process.stderr.write(`\r      hash ${percent.toFixed(1)}%`);
      }
    },
  });

  if (fileStat.size > 0) process.stderr.write('\r      hash 100.0%\n');
  console.log(`      SHA-1 完成，用时 ${formatDuration(Date.now() - sha1Started)}`);

  console.log('[3/5] 连接已登录 PikPak Web，创建 resumable upload task...');
  const web = await PikPakWebSession.connect({ cdpUrl: args.cdpUrl });
  let uploadSession = null;

  try {
    uploadSession = await web.createResumableUpload({
      name: remoteName,
      size: fileStat.size,
      sha1,
      parentId: args.parentId,
    });

    // console.log(session) 会自动脱敏；这里仍只主动输出最需要的非敏感字段。
    console.log(`      provider: ${uploadSession.provider}`);
    console.log(`      server endpoint: ${uploadSession.serverEndpoint}`);
    console.log(`      bucket: ${uploadSession.bucket}`);
    console.log(`      fileId: ${uploadSession.fileId}`);
    console.log(`      taskId: ${uploadSession.taskId}`);

    // direct 路线优先自动从 PikPak upload CNAME 发现 region。
    // 当前已观察到 CNAME 形如：bucket.region.thepacificphs.com。
    // discoverAliyunRegion 默认要求多家 DoH 共识，并校验 CNAME bucket 与 task bucket 一致。
    let resolvedRegion = args.region;
    if (args.route !== 'server' && !resolvedRegion) {
      console.log('      自动发现 Aliyun region（多家 DoH CNAME 共识）...');
      const discovery = await discoverAliyunRegion({
        serverEndpoint: uploadSession.serverEndpoint,
        expectedBucket: uploadSession.bucket,
      });

      if (discovery.ok) {
        resolvedRegion = discovery.region;
        console.log(
          `      region: ${resolvedRegion} `
          + `(source=${discovery.source}, consensus=${discovery.consensus})`,
        );
      } else if (args.route === 'direct-only') {
        throw new Error(`无法自动确定 Aliyun region：${discovery.reason}`);
      } else {
        console.warn(
          `      [warn] 无法自动确定 Aliyun region：${discovery.reason}；`
          + 'prefer-direct 将允许 uploader 回退 server endpoint。',
        );
      }
    } else if (resolvedRegion) {
      console.log(`      region: ${resolvedRegion} (manual override)`);
    }

    console.log('[4/5] Node -> Aliyun OSS multipart upload...');
    let lastUploadBucket = -1;

    const ossResult = await uploadFileToPikPakOss({
      session: uploadSession,
      filePath,
      fileSize: fileStat.size,
      regionHint: resolvedRegion,
      policy: args.route,
      parallel: args.parallel,
      onProgress(state) {
        const percent = Math.min(100, Number(state.percentage || 0) * 100);
        const bucket = Math.floor(percent / 2);
        if (bucket !== lastUploadBucket) {
          lastUploadBucket = bucket;
          process.stderr.write(
            `\r      upload ${percent.toFixed(1)}%  `
            + `${formatBytes(state.uploadedBytesApprox)} / ${formatBytes(fileStat.size)}`,
          );
        }
      },
    });

    process.stderr.write('\r      upload 100.0%'.padEnd(78) + '\n');
    console.log(`      effective endpoint: ${ossResult.effectiveEndpoint}`);
    console.log(`      route: ${ossResult.route}`);
    console.log(`      partSize: ${formatBytes(ossResult.partSize)}, parallel=${ossResult.parallel}`);
    console.log(`      OSS 用时: ${formatDuration(ossResult.elapsedMs)}`);

    console.log('[5/5] 等待 PikPak 服务端 check-in...');
    const checkIn = await web.waitTaskComplete(uploadSession.taskId, {
      timeoutMs: args.checkInTimeoutSec * 1000,
      intervalMs: 500,
    });

    const finalResult = {
      ok: Boolean(checkIn.allDone),
      localPath: filePath,
      localSize: fileStat.size,
      localSha1: sha1,
      remoteName,
      fileId: uploadSession.fileId,
      taskId: uploadSession.taskId,
      provider: uploadSession.provider,
      serverEndpoint: ossResult.serverEndpoint,
      effectiveEndpoint: ossResult.effectiveEndpoint,
      dataRoute: ossResult.route,
      partSize: ossResult.partSize,
      parallel: ossResult.parallel,
      ossElapsedMs: ossResult.elapsedMs,
      checkIn,
    };

    if (!checkIn.allDone) {
      console.error(
        '      PikPak 尚未在等待窗口内完成检入。文件/任务不会自动删除；'
        + '请保留 fileId/taskId 后续检查，避免把最终一致性延迟误判成失败。',
      );
      console.log(JSON.stringify(finalResult, null, 2));
      process.exitCode = 3;
      return;
    }

    console.log(`      COMPLETE，轮询 ${checkIn.polls} 次，用时 ${formatDuration(checkIn.elapsedMs)}`);

    if (args.trashAfterSuccess) {
      console.log('      --trash-after-success 已启用：把本次成功文件移入 PikPak 回收站。');
      await web.trashFile(uploadSession.fileId);
      finalResult.trashedAfterSuccess = true;
    }

    console.log('\n上传结果（无 secret）：');
    console.log(JSON.stringify(finalResult, null, 2));
  } catch (error) {
    // 实际上传失败时不自动 trash：部分网络错误可能发生在 OSS 已完成、PikPak 尚未同步阶段。
    // 如果已经拿到 file/task id，就把它们给用户/上层恢复流程，而不是武断删除。
    if (uploadSession) {
      console.error(`      已创建远端 fileId=${uploadSession.fileId} taskId=${uploadSession.taskId}`);
      console.error('      为避免误删，CLI 不自动清理该任务。');
    }
    throw error;
  } finally {
    web.close();
  }
}

/**
 * 把 migration runner 的结构化事件压缩成适合人工观察的终端日志。
 * multipart progress 只按 5% 桶输出一次，避免大文件几千个 part 把终端刷满。
 */
function createMigrationEventPrinter() {
  const progressBuckets = new Map();

  return (event) => {
    if (event.type === 'manifest-ready') {
      console.log(`manifest: ${event.manifestPath}`);
      console.log(
        `backup=${event.manifest.backupId}, files=${event.manifest.summary.totalFiles}, `
        + `size=${formatBytes(event.manifest.summary.totalBytes)}`,
      );
      return;
    }

    if (event.type === 'file-skip-complete') {
      console.log(`[skip] ${event.entry.relativePath}`);
      return;
    }

    if (event.type === 'hash-start') {
      console.log(`[hash] ${event.entry.relativePath}`);
      return;
    }

    if (event.type === 'upload-start') {
      console.log(`[upload] ${event.entry.relativePath} -> ${event.entry.remoteName}`);
      return;
    }

    if (event.type === 'upload-progress') {
      const percent = Math.min(100, Number(event.progress?.percentage || 0) * 100);
      const bucket = Math.floor(percent / 5);
      if (progressBuckets.get(event.entry.index) !== bucket) {
        progressBuckets.set(event.entry.index, bucket);
        console.log(`         ${percent.toFixed(1)}%`);
      }
      return;
    }

    if (event.type === 'upload-complete') {
      console.log(`[done] ${event.entry.relativePath}`);
      return;
    }

    if (event.type === 'upload-failed') {
      console.error(`[failed] ${event.entry.relativePath}: ${event.error?.message || event.error}`);
      return;
    }

    if (event.type === 'portable-manifest-upload-start') {
      console.log(`[manifest upload] ${event.portablePath}`);
      return;
    }

    if (event.type === 'portable-manifest-upload-complete') {
      console.log(`[manifest done] ${event.cloudManifest.remoteName}`);
    }
  };
}

/** 执行文件/目录冷迁移；默认只 copy，不删除任何本地源。 */
async function migrateCommand(args) {
  const result = await runMigration({
    sourcePath: resolve(args.localFile),
    manifestPath: args.manifestPath,
    backupId: args.backupId,
    parentId: args.parentId,
    route: args.route,
    region: args.region,
    parallel: args.parallel,
    checkInTimeoutSec: args.checkInTimeoutSec,
    cdpUrl: args.cdpUrl,
    dryRun: args.dryRun,
    uploadPortableManifest: args.uploadPortableManifest,
    onEvent: createMigrationEventPrinter(),
  });

  console.log('\n迁移状态：');
  console.log(JSON.stringify({
    manifestPath: result.manifestPath,
    backupId: result.manifest.backupId,
    dryRun: result.dryRun,
    summary: result.manifest.summary,
    cloudManifest: result.manifest.cloudManifest || null,
    encryption: result.manifest.policy.encryption,
  }, null, 2));
}

/** 查看一份本地运行态 manifest 的总体状态和每个文件的云端映射。 */
async function inspectManifestCommand(args) {
  const manifest = await loadMigrationManifest(args.manifestPath);

  console.log(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    source: manifest.source,
    destination: manifest.destination,
    policy: manifest.policy,
    summary: manifest.summary,
    cloudManifest: manifest.cloudManifest || null,
    warnings: manifest.warnings || [],
  }, null, 2));

  console.table(manifest.entries.map((entry) => ({
    index: entry.index,
    status: entry.status,
    size: formatBytes(entry.size),
    relativePath: entry.relativePath,
    remoteName: entry.remoteName,
    fileId: entry.fileId || '',
  })));
}

/**
 * 校验 manifest 对应的本地源是否还是建立快照时的版本。
 * 默认 size/mtime 快速校验；--full-hash 会对已经有 SHA-1 的条目重新读盘比对。
 */
async function verifyLocalCommand(args) {
  const manifest = await loadMigrationManifest(args.manifestPath);
  const result = await verifyManifestLocal(manifest, { fullHash: args.fullHash });
  const problems = result.results.filter((item) => (
    !item.exists || !item.metadataMatches || item.hashMatches === false
  ));

  console.log(
    `verify-local: ${result.ok ? 'OK' : 'FAILED'}; `
    + `files=${result.results.length}; problems=${problems.length}`,
  );
  if (problems.length > 0) console.table(problems);
  if (!result.ok) process.exitCode = 4;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  validateArgs(args);

  if (args.command === 'upload') {
    await uploadCommand(args);
  }
}

main().catch((error) => {
  // 这里只输出 error.message，不 dump error/cause/client，避免底层 SDK 把 client options 或
  // STS 信息间接打印出来。需要深入诊断时应另做显式脱敏的 debug 模式。
  console.error(`[pikpak-direct] ${error.message}`);
  process.exitCode = 1;
});
