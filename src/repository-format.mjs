// PikPak-Direct 加密仓库 v1：repo header、不可变 pack、加密 TOC 与加密 snapshot。
//
// 远端恢复能力依赖三个自描述层次：
// 1. repo.json：公开的最小仓库 header + 加密 key slots；
// 2. packs/*.ppdp：chunk 密文正文 + 文件尾部“加密 TOC”；
// 3. snapshots/*.ppds：完整目录树/文件元数据/chunk 引用的加密快照。
//
// 本地 SQLite/缓存即使全部丢失，也可以扫描 pack 尾部 TOC 重建 chunkId -> pack/offset 索引，
// 再解密 snapshot 恢复路径与文件顺序。这正是 fresh-machine restore 的基础。

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

import {
  DEFAULT_SCRYPT_PARAMS,
  createPasswordSlot,
  createRecoverySlot,
  deriveContextKey,
  generateRecoveryKey,
  parseRecoveryKey,
  openBuffer,
  sealBuffer,
  sha256Hex,
  toBase64Url,
  fromBase64Url,
  unlockMasterKey,
} from './repo-crypto.mjs';
import { DEFAULT_CDC_OPTIONS, FASTCDC_ALGORITHM } from './fastcdc.mjs';

export const REPOSITORY_MAGIC = 'PIKPAK_DIRECT_REPOSITORY';
export const REPOSITORY_FORMAT_VERSION = 1;
export const REPOSITORY_HEADER_FILE = 'repo.json';
export const PACK_EXTENSION = '.ppdp';
export const SNAPSHOT_EXTENSION = '.ppds';

const PACK_MAGIC = Buffer.from('PPDPACK1', 'ascii');
const PACK_TOC_MAGIC = Buffer.from('PPDTOC01', 'ascii');
const SNAPSHOT_MAGIC = Buffer.from('PPDSNAP1', 'ascii');
const PACK_HEADER_SIZE = 8 + 4 + 16;
const PACK_FOOTER_SIZE = 12 + 16 + 4 + 8;
const SNAPSHOT_HEADER_SIZE = 8 + 4 + 16 + 12 + 16;
const MAX_TOC_CIPHERTEXT = 64 * 1024 * 1024;

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

async function atomicWriteFile(path, data) {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

async function atomicWriteJson(path, value) {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packAad(repoId, packId, purpose) {
  return Buffer.from(`pikpak-direct:pack:v1:${repoId}:${packId}:${purpose}`, 'utf8');
}

function chunkAad(repoId, packId, entry) {
  return Buffer.from(
    `pikpak-direct:chunk:v1:${repoId}:${packId}:${entry.id}:${entry.plainLength}:${entry.compression}`,
    'utf8',
  );
}

function snapshotAad(repoId, snapshotId) {
  return Buffer.from(`pikpak-direct:snapshot:v1:${repoId}:${snapshotId}`, 'utf8');
}

/**
 * 建立一个全新的本地仓库骨架。
 * recovery key 只通过返回值交给调用方一次，不写入 repo.json。
 */
export async function initializeRepository(repoDir, {
  password,
  recoveryKey = '',
  scryptParams = DEFAULT_SCRYPT_PARAMS,
  cdc = DEFAULT_CDC_OPTIONS,
  packTargetBytes = 128 * 1024 * 1024,
} = {}) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('初始化仓库需要至少 8 个字符的 password。');
  }
  // 生产默认仍是 128 MiB；64 KiB 下限只是为了允许测试/诊断仓库快速制造多个 pack。
  // 这个参数只决定“何时换新 pack”，不改变 pack 二进制格式或加密安全性，因此没有必要
  // 把 1 MiB 误当成格式级硬限制。
  if (!Number.isSafeInteger(packTargetBytes) || packTargetBytes < 64 * 1024) {
    throw new Error('packTargetBytes 至少需要 64 KiB。');
  }

  const root = resolve(repoDir);
  const headerPath = join(root, REPOSITORY_HEADER_FILE);
  try {
    await stat(headerPath);
    throw new Error(`仓库已经存在: ${headerPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await mkdir(join(root, 'packs'), { recursive: true });
  await mkdir(join(root, 'snapshots'), { recursive: true });

  const repoId = randomBytes(16).toString('hex');
  const masterKey = randomBytes(32);
  // CLI 可以先把 recovery key 安全写到用户指定的独立文件，再把同一 key 传进来初始化。
  // 这样即使 repo 初始化阶段后续失败，也不会出现“仓库已生成但 recovery key 只存在于
  // 已退出进程内存里”的不可恢复窗口。库调用方不传时仍保持原有一次性生成行为。
  const recovery = recoveryKey
    ? { raw: parseRecoveryKey(recoveryKey), text: recoveryKey }
    : generateRecoveryKey();
  const keySlots = [
    createPasswordSlot({ repoId, masterKey, password, scryptParams }),
    createRecoverySlot({ repoId, masterKey, recoveryKeyRaw: recovery.raw }),
  ];
  recovery.raw.fill(0);

  const header = {
    magic: REPOSITORY_MAGIC,
    formatVersion: REPOSITORY_FORMAT_VERSION,
    repoId,
    createdAt: new Date().toISOString(),
    algorithms: {
      aead: 'aes-256-gcm',
      hash: 'sha256',
      keyDerivation: 'hkdf-sha256',
      passwordKdf: 'scrypt',
      compression: 'brotli-or-none-v1',
      cdc: FASTCDC_ALGORITHM,
    },
    cdc: {
      minSize: Number(cdc.minSize ?? DEFAULT_CDC_OPTIONS.minSize),
      avgSize: Number(cdc.avgSize ?? DEFAULT_CDC_OPTIONS.avgSize),
      maxSize: Number(cdc.maxSize ?? DEFAULT_CDC_OPTIONS.maxSize),
    },
    pack: {
      targetBytes: packTargetBytes,
    },
    keySlots,
  };

  await atomicWriteJson(headerPath, header);
  return {
    repoDir: root,
    header,
    masterKey,
    recoveryKey: recovery.text,
  };
}

export async function loadRepositoryHeader(repoDir) {
  const root = resolve(repoDir);
  const header = JSON.parse(await readFile(join(root, REPOSITORY_HEADER_FILE), 'utf8'));
  if (header?.magic !== REPOSITORY_MAGIC || header?.formatVersion !== REPOSITORY_FORMAT_VERSION) {
    throw new Error('不是受支持的 PikPak-Direct repository v1。');
  }
  if (!/^[a-f0-9]{32}$/i.test(String(header.repoId || ''))) {
    throw new Error('repo.json 的 repoId 非法。');
  }
  return header;
}

export async function unlockRepository(repoDir, credentials = {}) {
  const root = resolve(repoDir);
  const header = await loadRepositoryHeader(root);
  const masterKey = unlockMasterKey(header, credentials);
  return { repoDir: root, header, masterKey };
}

/**
 * chunk 压缩策略：Brotli quality=4 偏速度；只有真正节省至少 64 字节才采用压缩结果。
 * 这避免随机/已压缩媒体因为 Brotli header 反而变大。
 */
function compressChunk(plain) {
  const compressed = brotliCompressSync(plain, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
    },
  });
  if (compressed.length + 64 < plain.length) {
    return { compression: 'brotli', stored: compressed };
  }
  return { compression: 'none', stored: Buffer.from(plain) };
}

function decompressChunk(stored, compression) {
  if (compression === 'none') return Buffer.from(stored);
  if (compression === 'brotli') return brotliDecompressSync(stored);
  throw new Error(`未知 chunk compression: ${compression}`);
}

/**
 * 一个 pack writer 只追加，不回写旧正文。
 * finalize 时才在末尾追加加密 TOC，并把 .tmp 原子改名为最终 .ppdp。
 */
export class RepositoryPackWriter {
  constructor({ repoDir, header, masterKey, packId, handle, tempPath, finalPath }) {
    this.repoDir = repoDir;
    this.header = header;
    this.masterKey = masterKey;
    this.packId = packId;
    this.handle = handle;
    this.tempPath = tempPath;
    this.finalPath = finalPath;
    this.position = PACK_HEADER_SIZE;
    this.entries = [];
    this.closed = false;
    this.dataKey = deriveContextKey(masterKey, header.repoId, `pack-data:${packId}`);
    this.tocKey = deriveContextKey(masterKey, header.repoId, `pack-toc:${packId}`);
  }

  static async create({ repoDir, header, masterKey }) {
    const packId = randomBytes(16).toString('hex');
    const packsDir = join(repoDir, 'packs');
    await mkdir(packsDir, { recursive: true });
    const finalPath = join(packsDir, `${packId}${PACK_EXTENSION}`);
    const tempPath = `${finalPath}.tmp-${process.pid}`;
    const handle = await open(tempPath, 'wx');

    const version = Buffer.alloc(4);
    version.writeUInt32BE(1, 0);
    await handle.write(Buffer.concat([PACK_MAGIC, version, Buffer.from(packId, 'hex')]), 0, PACK_HEADER_SIZE, 0);
    return new RepositoryPackWriter({ repoDir, header, masterKey, packId, handle, tempPath, finalPath });
  }

  get dataBytes() {
    return this.position - PACK_HEADER_SIZE;
  }

  async addChunk(plainChunk, chunkId = sha256Hex(plainChunk)) {
    if (this.closed) throw new Error('不能向已关闭的 pack 写 chunk。');
    const plain = Buffer.from(plainChunk);
    if (!/^[a-f0-9]{64}$/i.test(chunkId)) throw new Error('chunkId 必须是 SHA-256 hex。');

    const { compression, stored } = compressChunk(plain);
    const entryBase = {
      id: chunkId.toLowerCase(),
      offset: this.position,
      cipherLength: stored.length,
      plainLength: plain.length,
      storedLength: stored.length,
      compression,
    };
    const sealed = sealBuffer(stored, this.dataKey, chunkAad(this.header.repoId, this.packId, entryBase));
    entryBase.cipherLength = sealed.ciphertext.length;
    entryBase.nonce = toBase64Url(sealed.nonce);
    entryBase.tag = toBase64Url(sealed.tag);

    await this.handle.write(sealed.ciphertext, 0, sealed.ciphertext.length, this.position);
    this.position += sealed.ciphertext.length;
    this.entries.push(entryBase);
    return { ...entryBase, packId: this.packId, packPath: this.finalPath };
  }

  async finalize() {
    if (this.closed) throw new Error('pack 已经关闭。');
    this.closed = true;
    try {
      const toc = {
        magic: 'PIKPAK_DIRECT_PACK_TOC',
        version: 1,
        repoId: this.header.repoId,
        packId: this.packId,
        createdAt: new Date().toISOString(),
        chunks: this.entries,
      };
      const sealed = sealBuffer(
        jsonBuffer(toc),
        this.tocKey,
        packAad(this.header.repoId, this.packId, 'toc'),
      );
      if (sealed.ciphertext.length > MAX_TOC_CIPHERTEXT) throw new Error('pack TOC 超过 64 MiB 安全上限。');

      await this.handle.write(sealed.ciphertext, 0, sealed.ciphertext.length, this.position);
      this.position += sealed.ciphertext.length;

      const tocLen = Buffer.alloc(4);
      tocLen.writeUInt32BE(sealed.ciphertext.length, 0);
      const footer = Buffer.concat([sealed.nonce, sealed.tag, tocLen, PACK_TOC_MAGIC]);
      await this.handle.write(footer, 0, footer.length, this.position);
      this.position += footer.length;
      await this.handle.sync();
      await this.handle.close();
      await rename(this.tempPath, this.finalPath);
      this.dataKey.fill(0);
      this.tocKey.fill(0);
      return {
        packId: this.packId,
        path: this.finalPath,
        chunks: this.entries.length,
        bytes: this.position,
      };
    } catch (error) {
      await this.handle.close().catch(() => {});
      await rm(this.tempPath, { force: true }).catch(() => {});
      this.dataKey.fill(0);
      this.tocKey.fill(0);
      throw error;
    }
  }

  async abandon() {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => {});
    await rm(this.tempPath, { force: true }).catch(() => {});
    this.dataKey.fill(0);
    this.tocKey.fill(0);
  }
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error('仓库对象被截断。');
    offset += bytesRead;
  }
  return buffer;
}

/** 只读取 pack 的 header + footer + 加密 TOC，不扫描/解密 chunk 正文。 */
export async function readPackToc(packPath, header, masterKey) {
  const handle = await open(packPath, 'r');
  try {
    const info = await handle.stat();
    if (info.size < PACK_HEADER_SIZE + PACK_FOOTER_SIZE) throw new Error('pack 太短。');

    const packHeader = await readExact(handle, PACK_HEADER_SIZE, 0);
    if (!packHeader.subarray(0, 8).equals(PACK_MAGIC)) throw new Error('pack magic 不匹配。');
    if (packHeader.readUInt32BE(8) !== 1) throw new Error('pack version 不受支持。');
    const packId = packHeader.subarray(12, 28).toString('hex');

    const footer = await readExact(handle, PACK_FOOTER_SIZE, info.size - PACK_FOOTER_SIZE);
    if (!footer.subarray(32, 40).equals(PACK_TOC_MAGIC)) throw new Error('pack TOC footer magic 不匹配。');
    const nonce = footer.subarray(0, 12);
    const tag = footer.subarray(12, 28);
    const tocLength = footer.readUInt32BE(28);
    if (tocLength <= 0 || tocLength > MAX_TOC_CIPHERTEXT) throw new Error('pack TOC 长度非法。');
    const tocOffset = info.size - PACK_FOOTER_SIZE - tocLength;
    if (tocOffset < PACK_HEADER_SIZE) throw new Error('pack TOC offset 非法。');

    const tocCiphertext = await readExact(handle, tocLength, tocOffset);
    const tocKey = deriveContextKey(masterKey, header.repoId, `pack-toc:${packId}`);
    let plain;
    try {
      plain = openBuffer(
        { nonce, tag, ciphertext: tocCiphertext },
        tocKey,
        packAad(header.repoId, packId, 'toc'),
      );
    } finally {
      tocKey.fill(0);
    }
    const toc = JSON.parse(plain.toString('utf8'));
    if (toc?.repoId !== header.repoId || toc?.packId !== packId || !Array.isArray(toc?.chunks)) {
      throw new Error('pack TOC 身份字段不匹配。');
    }

    for (const chunk of toc.chunks) {
      if (!/^[a-f0-9]{64}$/i.test(String(chunk.id || ''))) throw new Error('pack TOC chunk id 非法。');
      if (!Number.isSafeInteger(chunk.offset) || !Number.isSafeInteger(chunk.cipherLength)) {
        throw new Error('pack TOC chunk offset/length 非法。');
      }
      if (chunk.offset < PACK_HEADER_SIZE || chunk.cipherLength < 0 || chunk.offset + chunk.cipherLength > tocOffset) {
        throw new Error('pack TOC chunk 越界。');
      }
    }
    return { packId, toc, path: packPath, size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * 扫描所有 pack 的加密 TOC 重建全局 chunk 索引。
 * 单个 pack 损坏只进入 errors，不阻止其他 pack 被索引，实现“损坏局部隔离”。
 */
export async function rebuildPackIndex(repoDir, header, masterKey) {
  const packsDir = join(repoDir, 'packs');
  const names = (await readdir(packsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{32}\.ppdp$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const index = new Map();
  const packs = [];
  const errors = [];
  const duplicateChunkIds = [];

  for (const name of names) {
    const path = join(packsDir, name);
    try {
      const pack = await readPackToc(path, header, masterKey);
      packs.push(pack);
      for (const entry of pack.toc.chunks) {
        const record = {
          ...entry,
          packId: pack.packId,
          packPath: path,
        };
        if (index.has(entry.id)) {
          duplicateChunkIds.push(entry.id);
          continue;
        }
        index.set(entry.id, record);
      }
    } catch (error) {
      errors.push({ pack: name, error: error.message });
    }
  }

  return { index, packs, errors, duplicateChunkIds };
}

/** 按 TOC 定位并解密一个 chunk；最后重新 SHA-256，避免静默返回错误正文。 */
export async function readChunkFromPack(record, header, masterKey) {
  const handle = await open(record.packPath, 'r');
  try {
    const ciphertext = await readExact(handle, record.cipherLength, record.offset);
    const key = deriveContextKey(masterKey, header.repoId, `pack-data:${record.packId}`);
    let stored;
    try {
      stored = openBuffer({
        nonce: fromBase64Url(record.nonce, 'chunk nonce'),
        tag: fromBase64Url(record.tag, 'chunk tag'),
        ciphertext,
      }, key, chunkAad(header.repoId, record.packId, record));
    } finally {
      key.fill(0);
    }
    const plain = decompressChunk(stored, record.compression);
    if (plain.length !== record.plainLength || sha256Hex(plain) !== record.id) {
      throw new Error(`chunk 完整性校验失败: ${record.id}`);
    }
    return plain;
  } finally {
    await handle.close();
  }
}

/** 写入一个加密 snapshot，并原子更新本地 latest.json。 */
export async function writeEncryptedSnapshot(repoDir, header, masterKey, snapshot) {
  const snapshotId = randomBytes(16).toString('hex');
  const normalized = {
    ...snapshot,
    magic: 'PIKPAK_DIRECT_SNAPSHOT',
    version: 1,
    repoId: header.repoId,
    snapshotId,
  };
  const key = deriveContextKey(masterKey, header.repoId, `snapshot:${snapshotId}`);
  const sealed = sealBuffer(jsonBuffer(normalized), key, snapshotAad(header.repoId, snapshotId));
  key.fill(0);

  const version = Buffer.alloc(4);
  version.writeUInt32BE(1, 0);
  const body = Buffer.concat([
    SNAPSHOT_MAGIC,
    version,
    Buffer.from(snapshotId, 'hex'),
    sealed.nonce,
    sealed.tag,
    sealed.ciphertext,
  ]);
  const snapshotsDir = join(repoDir, 'snapshots');
  await mkdir(snapshotsDir, { recursive: true });
  const path = join(snapshotsDir, `${snapshotId}${SNAPSHOT_EXTENSION}`);
  await atomicWriteFile(path, body);
  await atomicWriteJson(join(repoDir, 'latest.json'), {
    magic: 'PIKPAK_DIRECT_LATEST',
    version: 1,
    snapshotId,
  });
  return { snapshotId, path, snapshot: normalized };
}

export async function readEncryptedSnapshot(repoDir, header, masterKey, snapshotId) {
  if (!/^[a-f0-9]{32}$/i.test(String(snapshotId || ''))) throw new Error('snapshotId 非法。');
  const path = join(repoDir, 'snapshots', `${snapshotId}${SNAPSHOT_EXTENSION}`);
  const body = await readFile(path);
  if (body.length < SNAPSHOT_HEADER_SIZE) throw new Error('snapshot 文件太短。');
  if (!body.subarray(0, 8).equals(SNAPSHOT_MAGIC)) throw new Error('snapshot magic 不匹配。');
  if (body.readUInt32BE(8) !== 1) throw new Error('snapshot version 不受支持。');
  const embeddedId = body.subarray(12, 28).toString('hex');
  if (embeddedId !== snapshotId) throw new Error('snapshot 文件名与内嵌 id 不一致。');
  const nonce = body.subarray(28, 40);
  const tag = body.subarray(40, 56);
  const ciphertext = body.subarray(56);
  const key = deriveContextKey(masterKey, header.repoId, `snapshot:${snapshotId}`);
  let plain;
  try {
    plain = openBuffer({ nonce, tag, ciphertext }, key, snapshotAad(header.repoId, snapshotId));
  } finally {
    key.fill(0);
  }
  const snapshot = JSON.parse(plain.toString('utf8'));
  if (snapshot?.repoId !== header.repoId || snapshot?.snapshotId !== snapshotId) {
    throw new Error('snapshot 身份字段不匹配。');
  }
  return { snapshotId, path, snapshot };
}

/**
 * 枚举并解密 snapshot；不依赖 latest.json，因此云端 fresh restore 只要拿到所有 snapshot 对象即可。
 */
export async function listEncryptedSnapshots(repoDir, header, masterKey) {
  const dir = join(repoDir, 'snapshots');
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((item) => item.isFile() && /^[a-f0-9]{32}\.ppds$/i.test(item.name))
    .map((item) => basename(item.name, SNAPSHOT_EXTENSION))
    .sort();
  const snapshots = [];
  const errors = [];
  for (const snapshotId of entries) {
    try {
      snapshots.push(await readEncryptedSnapshot(repoDir, header, masterKey, snapshotId));
    } catch (error) {
      errors.push({ snapshotId, error: error.message });
    }
  }
  snapshots.sort((a, b) => String(a.snapshot.createdAt).localeCompare(String(b.snapshot.createdAt)));
  return { snapshots, errors };
}

export async function readLatestSnapshotId(repoDir) {
  try {
    const latest = JSON.parse(await readFile(join(repoDir, 'latest.json'), 'utf8'));
    if (latest?.magic === 'PIKPAK_DIRECT_LATEST' && /^[a-f0-9]{32}$/i.test(String(latest.snapshotId || ''))) {
      return latest.snapshotId;
    }
  } catch {
    // fresh machine / remote materialization 时 latest.json 可以不存在，调用方会退回解密枚举。
  }
  return null;
}
