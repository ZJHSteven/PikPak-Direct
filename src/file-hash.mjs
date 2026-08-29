// 本地文件 hash 工具。
//
// PikPak 当前 Web 上传在创建 resumable task 前会携带 SHA-1。为了让正式 Node CLI 行为尽量
// 与官方 Web 一致，这里用流式读取计算 SHA-1，而不是把整个文件读进内存。
//
// 对 TB 级文件而言，完整 SHA-1 本身会额外读盘一遍；这是后续性能优化点，但第一版优先
// 保证协议一致和行为可解释。未来若验证 PikPak 支持其他快速 hash/秒传策略，可在上层替换。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * 流式计算本地文件 SHA-1。
 *
 * @param {string} filePath - 本地文件完整路径。
 * @param {{onProgress?: (state: {bytesRead: number}) => void}} options
 * @returns {Promise<string>} 40 位小写十六进制 SHA-1。
 */
export async function sha1File(filePath, { onProgress } = {}) {
  const hash = createHash('sha1');
  const stream = createReadStream(filePath);
  let bytesRead = 0;

  for await (const chunk of stream) {
    hash.update(chunk);
    bytesRead += chunk.length;
    onProgress?.({ bytesRead });
  }

  return hash.digest('hex');
}
