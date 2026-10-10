// PikPak-Direct 仓库 v1 的内容定义分块（CDC）。
//
// 这是一个 FastCDC 风格的 Gear rolling hash 实现：
// - minSize 前绝不切块，避免产生大量碎片；
// - minSize~avgSize 使用更严格 mask，降低过早切块概率；
// - avgSize~maxSize 使用更宽松 mask，促使边界回到目标平均值附近；
// - maxSize 强制切块，给内存、pack 与恢复路径一个确定上界。
//
// Gear 表不是随机运行时生成，而是由固定 seed + 固定 xorshift32 算法生成；因此只要算法版本
// `fastcdc-gear32-v1` 不变，同一字节序列在任何机器/进程上都会得到完全相同的边界。

import { createReadStream } from 'node:fs';

export const FASTCDC_ALGORITHM = 'fastcdc-gear32-v1';
export const DEFAULT_CDC_OPTIONS = Object.freeze({
  minSize: 256 * 1024,
  avgSize: 1024 * 1024,
  maxSize: 4 * 1024 * 1024,
  readSize: 4 * 1024 * 1024,
});

/** 固定 xorshift32 生成 Gear table；这里的 seed 是格式的一部分，不能在 v1 中修改。 */
function createGearTable() {
  let state = 0x243f6a88 >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[i] = state >>> 0;
  }
  return table;
}

const GEAR = createGearTable();

export function normalizeCdcOptions(options = {}) {
  const normalized = {
    minSize: Number(options.minSize ?? DEFAULT_CDC_OPTIONS.minSize),
    avgSize: Number(options.avgSize ?? DEFAULT_CDC_OPTIONS.avgSize),
    maxSize: Number(options.maxSize ?? DEFAULT_CDC_OPTIONS.maxSize),
    readSize: Number(options.readSize ?? DEFAULT_CDC_OPTIONS.readSize),
  };

  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 64) {
      throw new Error(`CDC ${name} 必须是 >=64 的安全整数。`);
    }
  }
  if (!(normalized.minSize < normalized.avgSize && normalized.avgSize < normalized.maxSize)) {
    throw new Error('CDC 必须满足 minSize < avgSize < maxSize。');
  }
  if (normalized.maxSize > 256 * 1024 * 1024) {
    throw new Error('CDC maxSize 不得超过 256 MiB。');
  }
  return normalized;
}

function maskForBits(bits) {
  const safeBits = Math.max(1, Math.min(30, bits));
  return (2 ** safeBits - 1) >>> 0;
}

/**
 * 创建一个可跨 read buffer 延续的边界检测器。
 * hash 只在 chunk 边界处清零，因此插入/删除局部字节后通常能在后续内容重新同步边界。
 */
function createBoundaryState(options) {
  const avgBits = Math.max(2, Math.round(Math.log2(options.avgSize)));
  const strictMask = maskForBits(avgBits + 1);
  const looseMask = maskForBits(avgBits - 1);
  let hash = 0;
  let chunkLength = 0;

  return {
    pushByte(byte) {
      hash = (((hash << 1) >>> 0) + GEAR[byte]) >>> 0;
      chunkLength += 1;

      if (chunkLength < options.minSize) return false;
      if (chunkLength >= options.maxSize) {
        hash = 0;
        chunkLength = 0;
        return true;
      }

      const mask = chunkLength < options.avgSize ? strictMask : looseMask;
      if ((hash & mask) === 0) {
        hash = 0;
        chunkLength = 0;
        return true;
      }
      return false;
    },
    get chunkLength() {
      return chunkLength;
    },
  };
}

/** 小数据/单元测试用的同步 Buffer 分块。 */
export function chunkBufferFastCdc(buffer, options = {}) {
  const input = Buffer.from(buffer);
  if (input.length === 0) return [];
  const cfg = normalizeCdcOptions(options);
  const state = createBoundaryState(cfg);
  const chunks = [];
  let start = 0;

  for (let index = 0; index < input.length; index += 1) {
    if (state.pushByte(input[index])) {
      chunks.push(input.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < input.length) chunks.push(input.subarray(start));
  return chunks;
}

/**
 * 大文件流式 CDC。
 * 内存峰值主要受 maxSize + readSize 限制；不会把整个文件读进内存。
 */
export async function* chunkFileFastCdc(filePath, options = {}) {
  const cfg = normalizeCdcOptions(options);
  const state = createBoundaryState(cfg);
  const pieces = [];
  let chunkLength = 0;

  for await (const block of createReadStream(filePath, { highWaterMark: cfg.readSize })) {
    let pieceStart = 0;
    for (let index = 0; index < block.length; index += 1) {
      chunkLength += 1;
      if (!state.pushByte(block[index])) continue;

      pieces.push(block.subarray(pieceStart, index + 1));
      yield Buffer.concat(pieces, chunkLength);
      pieces.length = 0;
      chunkLength = 0;
      pieceStart = index + 1;
    }

    if (pieceStart < block.length) {
      pieces.push(block.subarray(pieceStart));
    }
  }

  if (chunkLength > 0) {
    yield Buffer.concat(pieces, chunkLength);
  }
}
