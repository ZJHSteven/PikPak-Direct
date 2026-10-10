// PikPak-Direct 加密仓库 v1 的密钥层。
//
// 设计目标：
// 1. 仓库正文永远由随机 256-bit master key 加密，用户口令不直接加密正文；
// 2. password slot 与 recovery slot 只是两条“解锁同一个 master key”的入口；
// 3. 以后修改口令只需要重写很小的 key slot，不需要重加密 TB 级 pack；
// 4. 所有正文/TOC/snapshot 的子密钥都通过 HKDF 做上下文隔离，避免不同用途复用同一 key；
// 5. AEAD 使用 AES-256-GCM，nonce 每次随机生成 96 bit，认证 tag 固定 128 bit。
//
// 注意：repo header/key slot 元数据是恢复所必需的公开信息，但其中不包含 master key、
// 明文文件名、路径或正文。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';

export const REPO_AEAD = 'aes-256-gcm';
export const REPO_HASH = 'sha256';
export const RECOVERY_KEY_PREFIX = 'ppdr1-';

// 默认约 128 MiB scrypt 工作集：128 * N * r ≈ 128 MiB。
// maxmem 留出实现开销，避免 Node/OpenSSL 因边界估算略高而拒绝执行。
export const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
});

/** Buffer -> 无填充 base64url，便于 JSON 安全保存。 */
export function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** 无填充 base64url -> Buffer，并拒绝明显非法值。 */
export function fromBase64Url(text, fieldName = 'base64url') {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`${fieldName} 不是合法 base64url。`);
  }
  return Buffer.from(text, 'base64url');
}

/** 计算 SHA-256 Buffer；chunk id / 文件 hash 都复用同一个基础函数。 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

export function sha256Hex(buffer) {
  return sha256(buffer).toString('hex');
}

/**
 * 从 master key 派生用途隔离的子密钥。
 * repoId 作为 HKDF salt，把两个仓库的同一个 master key（理论上几乎不会发生）也隔离开。
 */
export function deriveContextKey(masterKey, repoId, context, length = 32) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('masterKey 必须是 32 字节 Buffer。');
  }
  if (!/^[a-f0-9]{32}$/i.test(String(repoId || ''))) {
    throw new Error('repoId 必须是 16 字节十六进制字符串。');
  }
  if (!context || Buffer.byteLength(String(context), 'utf8') > 512) {
    throw new Error('HKDF context 不能为空且不得超过 512 字节。');
  }

  return Buffer.from(hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(repoId, 'hex'),
    Buffer.from(`pikpak-direct/v1/${context}`, 'utf8'),
    length,
  ));
}

/**
 * 使用 AES-256-GCM 密封一段 Buffer。
 * AAD 不加密，但会被认证；调用者应把对象身份/版本/长度等不可被调包的字段放入 AAD。
 */
export function sealBuffer(plaintext, key, aad = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('AEAD key 必须是 32 字节 Buffer。');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(REPO_AEAD, key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    nonce,
    ciphertext,
    tag: cipher.getAuthTag(),
  };
}

/** AES-256-GCM 解封；任何 ciphertext/tag/AAD/key 不匹配都会在 final() 明确失败。 */
export function openBuffer(sealed, key, aad = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('AEAD key 必须是 32 字节 Buffer。');
  const nonce = Buffer.from(sealed?.nonce || []);
  const tag = Buffer.from(sealed?.tag || []);
  const ciphertext = Buffer.from(sealed?.ciphertext || []);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('AEAD nonce/tag 长度非法。');

  const decipher = createDecipheriv(REPO_AEAD, key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 把用户口令派生成 256-bit KEK。
 * 参数完整写入 slot，因此未来可以提高 N，而旧仓库仍能按原参数恢复。
 */
export function derivePasswordKek(password, salt, params = DEFAULT_SCRYPT_PARAMS) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('仓库口令至少需要 8 个字符。');
  }
  const safe = {
    N: Number(params.N),
    r: Number(params.r),
    p: Number(params.p),
    maxmem: Number(params.maxmem),
  };
  if (!Number.isInteger(safe.N) || safe.N < 2 || (safe.N & (safe.N - 1)) !== 0) {
    throw new Error('scrypt N 必须是 >=2 的 2 次幂。');
  }
  if (!Number.isInteger(safe.r) || safe.r < 1 || !Number.isInteger(safe.p) || safe.p < 1) {
    throw new Error('scrypt r/p 必须是正整数。');
  }
  if (!Number.isFinite(safe.maxmem) || safe.maxmem < 32 * 1024 * 1024) {
    throw new Error('scrypt maxmem 至少需要 32 MiB。');
  }
  return scryptSync(Buffer.from(password, 'utf8'), Buffer.from(salt), 32, safe);
}

/** 生成可离线保存的 256-bit recovery secret；前缀用于人工识别与版本升级。 */
export function generateRecoveryKey() {
  const raw = randomBytes(32);
  return {
    raw,
    text: `${RECOVERY_KEY_PREFIX}${toBase64Url(raw)}`,
  };
}

export function parseRecoveryKey(text) {
  if (typeof text !== 'string' || !text.startsWith(RECOVERY_KEY_PREFIX)) {
    throw new Error(`recovery key 必须以 ${RECOVERY_KEY_PREFIX} 开头。`);
  }
  const raw = fromBase64Url(text.slice(RECOVERY_KEY_PREFIX.length), 'recovery key');
  if (raw.length !== 32) throw new Error('recovery key 必须包含 32 字节随机密钥。');
  return raw;
}

function slotAad(repoId, slot) {
  return Buffer.from(`pikpak-direct:key-slot:v1:${repoId}:${slot.id}:${slot.type}`, 'utf8');
}

function encodeWrap(sealed) {
  return {
    nonce: toBase64Url(sealed.nonce),
    ciphertext: toBase64Url(sealed.ciphertext),
    tag: toBase64Url(sealed.tag),
  };
}

function decodeWrap(wrap) {
  return {
    nonce: fromBase64Url(wrap?.nonce, 'slot nonce'),
    ciphertext: fromBase64Url(wrap?.ciphertext, 'slot ciphertext'),
    tag: fromBase64Url(wrap?.tag, 'slot tag'),
  };
}

/** 创建 password slot；slot 只包装 32-byte master key。 */
export function createPasswordSlot({
  repoId,
  masterKey,
  password,
  scryptParams = DEFAULT_SCRYPT_PARAMS,
}) {
  const salt = randomBytes(16);
  const slot = {
    id: randomBytes(8).toString('hex'),
    type: 'password',
    kdf: {
      name: 'scrypt',
      salt: toBase64Url(salt),
      N: Number(scryptParams.N),
      r: Number(scryptParams.r),
      p: Number(scryptParams.p),
      maxmem: Number(scryptParams.maxmem),
    },
    wrap: null,
  };
  const kek = derivePasswordKek(password, salt, slot.kdf);
  slot.wrap = encodeWrap(sealBuffer(masterKey, kek, slotAad(repoId, slot)));
  kek.fill(0);
  return slot;
}

/** 创建 recovery slot；recovery secret 本身不写入仓库，只写随机 master key 的密文。 */
export function createRecoverySlot({ repoId, masterKey, recoveryKeyRaw }) {
  if (!Buffer.isBuffer(recoveryKeyRaw) || recoveryKeyRaw.length !== 32) {
    throw new Error('recoveryKeyRaw 必须是 32 字节 Buffer。');
  }
  const slot = {
    id: randomBytes(8).toString('hex'),
    type: 'recovery',
    kdf: {
      name: 'hkdf-sha256',
      info: 'recovery-slot',
    },
    wrap: null,
  };
  const kek = Buffer.from(hkdfSync(
    'sha256',
    recoveryKeyRaw,
    Buffer.from(repoId, 'hex'),
    Buffer.from('pikpak-direct/v1/recovery-slot', 'utf8'),
    32,
  ));
  slot.wrap = encodeWrap(sealBuffer(masterKey, kek, slotAad(repoId, slot)));
  kek.fill(0);
  return slot;
}

function tryUnlockPasswordSlot(repoId, slot, password) {
  const salt = fromBase64Url(slot.kdf?.salt, 'password slot salt');
  const kek = derivePasswordKek(password, salt, slot.kdf);
  try {
    return openBuffer(decodeWrap(slot.wrap), kek, slotAad(repoId, slot));
  } finally {
    kek.fill(0);
  }
}

function tryUnlockRecoverySlot(repoId, slot, recoveryKeyText) {
  const raw = parseRecoveryKey(recoveryKeyText);
  const kek = Buffer.from(hkdfSync(
    'sha256',
    raw,
    Buffer.from(repoId, 'hex'),
    Buffer.from('pikpak-direct/v1/recovery-slot', 'utf8'),
    32,
  ));
  raw.fill(0);
  try {
    return openBuffer(decodeWrap(slot.wrap), kek, slotAad(repoId, slot));
  } finally {
    kek.fill(0);
  }
}

/**
 * 使用 password 或 recovery key 解锁 master key。
 * 对外故意返回统一失败消息，不泄露“某个 slot 是否存在但口令错误”等细节。
 */
export function unlockMasterKey(header, { password = '', recoveryKey = '' } = {}) {
  const repoId = header?.repoId;
  const slots = Array.isArray(header?.keySlots) ? header.keySlots : [];
  if (!/^[a-f0-9]{32}$/i.test(String(repoId || '')) || slots.length === 0) {
    throw new Error('仓库 header 缺少有效 repoId/keySlots。');
  }

  const attempts = [];
  if (password) {
    for (const slot of slots.filter((item) => item?.type === 'password')) {
      attempts.push(() => tryUnlockPasswordSlot(repoId, slot, password));
    }
  }
  if (recoveryKey) {
    for (const slot of slots.filter((item) => item?.type === 'recovery')) {
      attempts.push(() => tryUnlockRecoverySlot(repoId, slot, recoveryKey));
    }
  }
  if (attempts.length === 0) throw new Error('需要仓库口令或 recovery key 才能解锁。');

  for (const attempt of attempts) {
    try {
      const masterKey = attempt();
      if (Buffer.isBuffer(masterKey) && masterKey.length === 32) return masterKey;
    } catch {
      // 继续尝试同类型的其他 slot；最终统一报错，避免暴露 slot 细节。
    }
  }
  throw new Error('无法解锁仓库：口令/recovery key 不正确，或 key slot 已损坏。');
}
