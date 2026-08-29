// Node OSS uploader / secret redaction 单元测试。
//
// 这里不联网、不调用 PikPak。重点固定两个长期安全边界：
// 1. TB 级文件 partSize 不会制造超过约 9000 个 part；
// 2. PikPakUploadSession 即使被 console.log / JSON.stringify，也不会泄露 STS secret。

import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import { choosePartSize, sanitizeOssError } from '../src/oss-uploader.mjs';
import { PikPakUploadSession } from '../src/pikpak-web-session.mjs';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

test('choosePartSize 小文件保持至少 5 MiB', () => {
  assert.equal(choosePartSize(0), 5 * MIB);
  assert.equal(choosePartSize(1 * MIB), 5 * MIB);
  assert.equal(choosePartSize(32 * MIB), 5 * MIB);
});

test('choosePartSize 超大文件会扩大 part，控制 part 数', () => {
  const fileSize = 10 * TIB;
  const partSize = choosePartSize(fileSize);
  const partCount = Math.ceil(fileSize / partSize);

  assert.ok(partSize >= 5 * MIB);
  assert.equal(partSize % MIB, 0);
  assert.ok(partCount <= 9000, `partCount=${partCount} 应 <= 9000`);
});

test('choosePartSize 拒绝非法文件大小', () => {
  assert.throws(() => choosePartSize(-1), /文件大小无效/);
  assert.throws(() => choosePartSize(Number.NaN), /文件大小无效/);
});

test('PikPakUploadSession 的默认序列化与 inspect 必须脱敏 STS', () => {
  const session = new PikPakUploadSession({
    fileId: 'file-test',
    taskId: 'task-test',
    provider: 'PROVIDER_ALIYUN',
    endpoint: 'upload-a10b.mypikpak.com',
    bucket: 'vip-lixian-07',
    key: 'upload_tmp/THIS_IS_A_LONG_FAKE_OBJECT_KEY_FOR_TEST',
    cname: 'true',
    expiration: '2099-01-01T00:00:00Z',
    name: 'fake.bin',
    size: '123',
    accessKeyId: 'FAKE_ACCESS_KEY_ID_SHOULD_NOT_PRINT',
    accessKeySecret: 'FAKE_ACCESS_KEY_SECRET_SHOULD_NOT_PRINT',
    securityToken: 'FAKE_SECURITY_TOKEN_SHOULD_NOT_PRINT',
  });

  const json = JSON.stringify(session);
  const inspected = inspect(session);

  for (const secret of [
    'FAKE_ACCESS_KEY_ID_SHOULD_NOT_PRINT',
    'FAKE_ACCESS_KEY_SECRET_SHOULD_NOT_PRINT',
    'FAKE_SECURITY_TOKEN_SHOULD_NOT_PRINT',
  ]) {
    assert.equal(json.includes(secret), false);
    assert.equal(inspected.includes(secret), false);
  }

  assert.match(json, /<redacted>/);
  assert.match(inspected, /credentials/);

  // 真正 uploader 仍必须能显式取出一份短生命周期 credentials。
  const credentials = session.getOssCredentials();
  assert.equal(credentials.accessKeyId, 'FAKE_ACCESS_KEY_ID_SHOULD_NOT_PRINT');
  assert.equal(credentials.accessKeySecret, 'FAKE_ACCESS_KEY_SECRET_SHOULD_NOT_PRINT');
  assert.equal(credentials.stsToken, 'FAKE_SECURITY_TOKEN_SHOULD_NOT_PRINT');
});

test('sanitizeOssError 只保留安全诊断字段', () => {
  const error = {
    name: 'RequestError',
    code: 'ConnectionTimeoutError',
    status: 504,
    requestId: 'req-test',
    message: 'timeout',
    // 模拟底层 error 上可能挂着不该打印的 client 配置。
    client: {
      accessKeySecret: 'SECRET_MUST_NOT_SURVIVE',
    },
  };

  const safe = sanitizeOssError(error);
  const serialized = JSON.stringify(safe);

  assert.deepEqual(safe, {
    name: 'RequestError',
    code: 'ConnectionTimeoutError',
    status: 504,
    requestId: 'req-test',
    message: 'timeout',
  });
  assert.equal(serialized.includes('SECRET_MUST_NOT_SURVIVE'), false);
});
