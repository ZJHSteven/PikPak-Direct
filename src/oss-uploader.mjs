// Node 侧 Aliyun OSS 数据面上传器。
//
// 与 tools/web-upload-probe 不同，这个模块真正从 Node 文件系统读取本地文件路径，
// 因此未来可以直接处理 D 盘上的 GB/TB 文件，而不需要把文件塞进浏览器内存或 CDP。
//
// 认证来源是 PikPak 控制面创建任务时下发的短生命周期 STS。调用方把
// PikPakUploadSession 传入本模块，本模块只在内存中读取 credentials，不打印它们。

import OSS from 'ali-oss';

import { normalizeAliyunResumable } from './aliyun-endpoint.mjs';
import { sanitizeCheckpoint } from './migration-manifest.mjs';

const MIB = 1024 * 1024;

/**
 * 根据文件大小选择 multipart part size。
 *
 * 设计目标：
 * - 小文件/普通大文件至少 5 MiB，降低 HTTP 请求数量；
 * - 超大文件把总 part 数控制在约 9000 以下，给 OSS 10000 parts 上限留余量；
 * - 结果按整 MiB 向上取整，便于日志理解。
 *
 * @param {number} fileSizeBytes
 * @returns {number} bytes
 */
export function choosePartSize(fileSizeBytes) {
  const size = Number(fileSizeBytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error('文件大小无效，无法选择 multipart part size。');
  }

  const minimum = 5 * MIB;
  const required = Math.ceil(size / 9000);
  const roundedRequired = Math.ceil(required / MIB) * MIB;

  return Math.max(minimum, roundedRequired);
}

/**
 * 把 PikPakUploadSession 转换为 normalizeAliyunResumable 所需的形状。
 *
 * 这里会暂时在内存中拼回 STS params，但对象不会被序列化或写盘。
 */
function sessionToResumable(session) {
  const credentials = session.getOssCredentials();

  return {
    provider: session.provider,
    params: {
      endpoint: session.serverEndpoint,
      bucket: session.bucket,
      key: session.objectKey,
      cname: session.cname,
      expiration: session.expiration,
      access_key_id: credentials.accessKeyId,
      access_key_secret: credentials.accessKeySecret,
      security_token: credentials.stsToken,
    },
  };
}

/**
 * 构造 Aliyun OSS SDK client。
 *
 * 注意：这里刻意不设置 authorizationV4。当前 PikPak Web 官方 adapter 在实测 bundle 中
 * 也没有显式开启 authorizationV4；第一版优先复刻已经验证成功的签名行为。未来如果
 * PikPak/OSS 切换签名策略，应通过集成测试后再调整。
 */
function createOssClient(normalizedResumable) {
  const params = normalizedResumable.params;

  return new OSS({
    accessKeyId: params.access_key_id,
    accessKeySecret: params.access_key_secret,
    stsToken: params.security_token,
    bucket: params.bucket,
    endpoint: `https://${params.endpoint}`,
    cname: String(params.cname) === 'true',
    secure: true,
    // 大文件上传需要给单个 OSS 请求更宽松的超时；multipart 本身仍可逐 part 重试。
    timeout: '120s',
    retryMax: 3,
  });
}

/**
 * 将 OSS error 压缩为不含 client options / STS 的安全结构。
 */
export function sanitizeOssError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || error?.status || null,
    status: error?.status || null,
    requestId: error?.requestId || error?.requestid || null,
    message: String(error?.message || error || 'Unknown OSS error'),
  };
}

/**
 * 使用 PikPak STS 将本地文件上传到 Aliyun OSS。
 *
 * @param {object} options
 * @param {import('./pikpak-web-session.mjs').PikPakUploadSession} options.session
 * @param {string} options.filePath
 * @param {number} options.fileSize
 * @param {string|null} options.regionHint
 * @param {'direct-only'|'prefer-direct'|'server'} [options.policy='direct-only']
 * @param {number} [options.parallel=4]
 * @param {object|null} [options.checkpoint]
 * @param {(state: object) => void} [options.onProgress]
 * @param {(checkpoint: object) => (void|Promise<void>)} [options.onCheckpoint]
 * @returns {Promise<object>} 非敏感上传结果。
 */
export async function uploadFileToPikPakOss({
  session,
  filePath,
  fileSize,
  regionHint,
  policy = 'direct-only',
  parallel = 4,
  checkpoint = null,
  onProgress,
  onCheckpoint,
}) {
  if (!session?.getOssCredentials) {
    throw new Error('缺少有效 PikPakUploadSession。');
  }

  if (!filePath) {
    throw new Error('filePath 不能为空。');
  }

  if (!Number.isFinite(Number(fileSize)) || Number(fileSize) < 0) {
    throw new Error('fileSize 无效。');
  }

  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) {
    throw new Error('parallel 必须是 1~32 的整数。');
  }

  const normalized = normalizeAliyunResumable(
    sessionToResumable(session),
    { regionHint, policy },
  );

  const client = createOssClient(normalized.resumable);
  const partSize = choosePartSize(Number(fileSize));
  let latestCheckpoint = null;
  let latestProgress = 0;
  const startedAt = Date.now();

  try {
    const result = await client.multipartUpload(
      session.objectKey,
      filePath,
      {
        parallel,
        partSize,
        // ali-oss 官方支持把上一次 progress 回调给出的 checkpoint 再传回 multipartUpload，
        // 这样可以跳过已经上传成功的 part。上层负责把 checkpoint 持久化到 migration manifest。
        checkpoint: checkpoint || undefined,
        async progress(percentage, nextCheckpoint, response) {
          latestCheckpoint = nextCheckpoint || latestCheckpoint;
          latestProgress = Math.max(latestProgress, Number(percentage || 0));

          // 只把恢复 multipart 必需的白名单字段交给上层，避免把 STS/client/response 意外写盘。
          if (latestCheckpoint && onCheckpoint) {
            await onCheckpoint(sanitizeCheckpoint(latestCheckpoint));
          }

          onProgress?.({
            percentage: latestProgress,
            uploadedBytesApprox: Math.min(
              Number(fileSize),
              Math.round(Number(fileSize) * latestProgress),
            ),
            partSize,
            parallel,
            // 只暴露是否拿到 checkpoint，不把 checkpoint 整体打日志。
            hasCheckpoint: Boolean(latestCheckpoint),
            requestId: response?.res?.headers?.['x-oss-request-id']
              || response?.headers?.['x-oss-request-id']
              || null,
          });
        },
      },
    );

    const elapsedMs = Date.now() - startedAt;

    return {
      ok: true,
      route: normalized.route,
      routeReason: normalized.reason,
      serverEndpoint: normalized.serverEndpoint,
      effectiveEndpoint: normalized.effectiveEndpoint,
      bucket: session.bucket,
      objectKey: '<redacted>',
      partSize,
      parallel,
      progress: 1,
      elapsedMs,
      bytesPerSecond: elapsedMs > 0
        ? Math.round(Number(fileSize) / (elapsedMs / 1000))
        : null,
      requestId: result?.res?.headers?.['x-oss-request-id'] || null,
      etag: result?.res?.headers?.etag || result?.etag || null,
    };
  } catch (error) {
    const safeError = sanitizeOssError(error);
    const wrapped = new Error(`Aliyun OSS 上传失败: ${safeError.message}`);
    wrapped.cause = safeError;
    throw wrapped;
  }
}
