// Aliyun endpoint 规范化单元测试。
//
// 这些测试故意不联网，也不需要真实 PikPak 账号。目标是把“哪些情况下允许改写、
// 哪些情况下必须拒绝猜测”的安全边界固定下来，避免未来重构时为了方便又把当前
// 新加坡实验写成永久硬编码。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PIKPAK_ALIYUN_PROVIDER,
  buildAliyunOssEndpoint,
  extractAliyunRegion,
  isSafeAliyunRegion,
  normalizeAliyunResumable,
} from '../src/aliyun-endpoint.mjs';

function makeResumable(overrides = {}) {
  return {
    provider: PIKPAK_ALIYUN_PROVIDER,
    params: {
      endpoint: 'upload-a10b.mypikpak.com',
      bucket: 'vip-lixian-07',
      key: 'upload_tmp/example',
      cname: 'true',
      // 测试值只用于证明“规范化函数原样保留其他字段”；不是真实 secret。
      access_key_id: 'TEST_ONLY_ACCESS_KEY',
      access_key_secret: 'TEST_ONLY_SECRET',
      security_token: 'TEST_ONLY_TOKEN',
      ...overrides.params,
    },
    ...overrides,
  };
}

test('isSafeAliyunRegion 接受常见 region，拒绝 URL/路径注入', () => {
  assert.equal(isSafeAliyunRegion('ap-southeast-1'), true);
  assert.equal(isSafeAliyunRegion('cn-hangzhou'), true);
  assert.equal(isSafeAliyunRegion('us-west-1'), true);

  assert.equal(isSafeAliyunRegion(''), false);
  assert.equal(isSafeAliyunRegion('ap_southeast_1'), false);
  assert.equal(isSafeAliyunRegion('https://evil.example'), false);
  assert.equal(isSafeAliyunRegion('../ap-southeast-1'), false);
  assert.equal(isSafeAliyunRegion('ap-southeast-1.evil.example'), false);
});

test('extractAliyunRegion 能解析 endpoint 与 bucket endpoint', () => {
  assert.equal(
    extractAliyunRegion('oss-ap-southeast-1.aliyuncs.com'),
    'ap-southeast-1',
  );

  assert.equal(
    extractAliyunRegion('vip-lixian-07.oss-ap-southeast-1.aliyuncs.com'),
    'ap-southeast-1',
  );

  assert.equal(
    extractAliyunRegion('https://vip-lixian-07.oss-cn-hangzhou.aliyuncs.com/path'),
    'cn-hangzhou',
  );

  // 自定义 PikPak CNAME 单独看 host 无法安全推出 region，必须返回 null。
  assert.equal(extractAliyunRegion('upload-a10b.mypikpak.com'), null);
  assert.equal(extractAliyunRegion('example.com'), null);
});

test('buildAliyunOssEndpoint 只接受安全 region', () => {
  assert.equal(
    buildAliyunOssEndpoint('ap-southeast-1'),
    'oss-ap-southeast-1.aliyuncs.com',
  );

  assert.throws(
    () => buildAliyunOssEndpoint('https://evil.example'),
    /无效或不安全/,
  );
});

test('direct-only + 可信 regionHint 会改写 endpoint 并关闭 cname', () => {
  const source = makeResumable();
  const result = normalizeAliyunResumable(source, {
    regionHint: 'ap-southeast-1',
    policy: 'direct-only',
  });

  assert.equal(result.route, 'direct');
  assert.equal(result.serverEndpoint, 'upload-a10b.mypikpak.com');
  assert.equal(result.effectiveEndpoint, 'oss-ap-southeast-1.aliyuncs.com');
  assert.equal(result.resumable.params.endpoint, 'oss-ap-southeast-1.aliyuncs.com');
  assert.equal(result.resumable.params.cname, 'false');

  // 其他上传参数必须原样保留，否则 Aliyun STS / object key 会失效。
  assert.equal(result.resumable.params.bucket, source.params.bucket);
  assert.equal(result.resumable.params.key, source.params.key);
  assert.equal(result.resumable.params.access_key_secret, source.params.access_key_secret);

  // 函数不得原地修改服务器响应，便于日志比较和安全回退。
  assert.equal(source.params.endpoint, 'upload-a10b.mypikpak.com');
  assert.equal(source.params.cname, 'true');
});

test('server policy 完全保留 PikPak endpoint', () => {
  const source = makeResumable();
  const result = normalizeAliyunResumable(source, {
    regionHint: 'ap-southeast-1',
    policy: 'server',
  });

  assert.equal(result.route, 'server');
  assert.equal(result.effectiveEndpoint, 'upload-a10b.mypikpak.com');
  assert.equal(result.resumable.params.endpoint, 'upload-a10b.mypikpak.com');
  assert.equal(result.resumable.params.cname, 'true');
});

test('direct-only 在自定义 CNAME 且没有可信 region 时必须失败', () => {
  assert.throws(
    () => normalizeAliyunResumable(makeResumable(), { policy: 'direct-only' }),
    /拒绝猜测/,
  );
});

test('prefer-direct 无法确定 region 时回退 server endpoint', () => {
  const result = normalizeAliyunResumable(makeResumable(), {
    policy: 'prefer-direct',
  });

  assert.equal(result.route, 'server');
  assert.equal(result.effectiveEndpoint, 'upload-a10b.mypikpak.com');
});

test('服务器已经返回标准 Aliyun endpoint 时可自动提取 region', () => {
  const source = makeResumable({
    params: {
      endpoint: 'oss-ap-southeast-1.aliyuncs.com',
      cname: 'false',
    },
  });

  const result = normalizeAliyunResumable(source, { policy: 'direct-only' });

  assert.equal(result.route, 'direct');
  assert.equal(result.effectiveEndpoint, 'oss-ap-southeast-1.aliyuncs.com');
});

test('非 Aliyun provider 必须安全失败', () => {
  assert.throws(
    () => normalizeAliyunResumable(
      makeResumable({ provider: 'PROVIDER_SOMETHING_ELSE' }),
      { regionHint: 'ap-southeast-1' },
    ),
    /不是 Aliyun/,
  );
});

test('缺少 endpoint、params 或非法 policy 都应抛出清晰错误', () => {
  assert.throws(
    () => normalizeAliyunResumable({ provider: PIKPAK_ALIYUN_PROVIDER }),
    /params 缺失/,
  );

  assert.throws(
    () => normalizeAliyunResumable(makeResumable({ params: { endpoint: '' } })),
    /没有返回上传 endpoint/,
  );

  assert.throws(
    () => normalizeAliyunResumable(makeResumable(), { policy: 'mystery' }),
    /未知 data route policy/,
  );
});
