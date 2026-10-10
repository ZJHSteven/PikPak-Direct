import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createPasswordSlot,
  createRecoverySlot,
  deriveContextKey,
  generateRecoveryKey,
  openBuffer,
  sealBuffer,
  unlockMasterKey,
} from '../src/repo-crypto.mjs';

const TEST_SCRYPT = Object.freeze({ N: 2 ** 10, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

test('password slot 与 recovery slot 都能独立解锁同一个 master key', () => {
  const repoId = randomBytes(16).toString('hex');
  const masterKey = randomBytes(32);
  const recovery = generateRecoveryKey();
  const password = 'correct horse battery staple';

  const header = {
    repoId,
    keySlots: [
      createPasswordSlot({ repoId, masterKey, password, scryptParams: TEST_SCRYPT }),
      createRecoverySlot({ repoId, masterKey, recoveryKeyRaw: recovery.raw }),
    ],
  };

  assert.deepEqual(unlockMasterKey(header, { password }), masterKey);
  assert.deepEqual(unlockMasterKey(header, { recoveryKey: recovery.text }), masterKey);
  assert.throws(() => unlockMasterKey(header, { password: 'wrong password' }), /无法解锁仓库/);
});

test('AEAD 会检测 ciphertext/tag/AAD 篡改', () => {
  const key = randomBytes(32);
  const aad = Buffer.from('snapshot:v1');
  const sealed = sealBuffer(Buffer.from('secret payload'), key, aad);
  assert.equal(openBuffer(sealed, key, aad).toString(), 'secret payload');

  const tampered = {
    ...sealed,
    ciphertext: Buffer.from(sealed.ciphertext),
  };
  tampered.ciphertext[0] ^= 0x01;
  assert.throws(() => openBuffer(tampered, key, aad));
  assert.throws(() => openBuffer(sealed, key, Buffer.from('other-aad')));
});

test('HKDF context 隔离不同用途的仓库子密钥', () => {
  const masterKey = randomBytes(32);
  const repoId = randomBytes(16).toString('hex');
  const packKey = deriveContextKey(masterKey, repoId, 'pack-data:001');
  const tocKey = deriveContextKey(masterKey, repoId, 'pack-toc:001');
  assert.equal(packKey.length, 32);
  assert.equal(tocKey.length, 32);
  assert.notDeepEqual(packKey, tocKey);
});
