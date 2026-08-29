// PikPak Aliyun region 自动发现单元测试。
//
// 网络一致性逻辑全部用 mock fetch 验证，避免单元测试依赖公网 DNS。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverAliyunRegion,
  extractPikPakRegionFromCname,
  parseDohCnameAnswers,
} from '../src/region-discovery.mjs';

const providers = [
  { name: 'A', url: 'https://a.example/dns-query' },
  { name: 'B', url: 'https://b.example/dns-query' },
  { name: 'C', url: 'https://c.example/dns-query' },
];

function makeFetch(answerByHost) {
  return async (url) => {
    const providerHost = new URL(url).hostname;
    const answer = answerByHost[providerHost];

    if (answer instanceof Error) throw answer;

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          Answer: answer || [],
        };
      },
    };
  };
}

function cname(data) {
  return {
    name: 'upload-a10b.mypikpak.com.',
    type: 5,
    TTL: 600,
    data,
  };
}

test('extractPikPakRegionFromCname 从 bucket.region.thepacificphs.com 提取 region', () => {
  assert.deepEqual(
    extractPikPakRegionFromCname(
      'vip-lixian-07.ap-southeast-1.thepacificphs.com.',
      'vip-lixian-07',
    ),
    {
      bucket: 'vip-lixian-07',
      region: 'ap-southeast-1',
      cname: 'vip-lixian-07.ap-southeast-1.thepacificphs.com',
    },
  );
});

test('extractPikPakRegionFromCname bucket 不匹配时拒绝证据', () => {
  assert.equal(
    extractPikPakRegionFromCname(
      'some-other-bucket.ap-southeast-1.thepacificphs.com',
      'vip-lixian-07',
    ),
    null,
  );
});

test('parseDohCnameAnswers 只保留 type=5 CNAME', () => {
  assert.deepEqual(
    parseDohCnameAnswers({
      Answer: [
        { type: 1, data: '47.79.49.2' },
        { type: 5, data: 'vip-lixian-07.ap-southeast-1.thepacificphs.com.' },
      ],
    }),
    ['vip-lixian-07.ap-southeast-1.thepacificphs.com'],
  );
});

test('标准 aliyuncs server endpoint 不联网也能直接提取 region', async () => {
  let fetchCalls = 0;
  const result = await discoverAliyunRegion({
    serverEndpoint: 'oss-ap-southeast-1.aliyuncs.com',
    expectedBucket: 'vip-lixian-07',
    providers,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('不应调用网络');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.region, 'ap-southeast-1');
  assert.equal(result.source, 'server-endpoint');
  assert.equal(fetchCalls, 0);
});

test('三家 DoH 中两家一致即可接受 region', async () => {
  const target = 'vip-lixian-07.ap-southeast-1.thepacificphs.com.';
  const result = await discoverAliyunRegion({
    serverEndpoint: 'upload-a10b.mypikpak.com',
    expectedBucket: 'vip-lixian-07',
    providers,
    fetchImpl: makeFetch({
      'a.example': [cname(target)],
      'b.example': [cname(target)],
      'c.example': [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.region, 'ap-southeast-1');
  assert.equal(result.consensus, 2);
  assert.equal(result.source, 'doh-cname-consensus');
});

test('只有一家给出 region 时达不到默认共识，应安全失败', async () => {
  const target = 'vip-lixian-07.ap-southeast-1.thepacificphs.com.';
  const result = await discoverAliyunRegion({
    serverEndpoint: 'upload-a10b.mypikpak.com',
    expectedBucket: 'vip-lixian-07',
    providers,
    fetchImpl: makeFetch({
      'a.example': [cname(target)],
      'b.example': [],
      'c.example': [],
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /没有达到 2 家一致/);
});

test('DoH provider 网络失败不应让整个发现流程直接抛错', async () => {
  const target = 'vip-lixian-07.ap-southeast-1.thepacificphs.com.';
  const result = await discoverAliyunRegion({
    serverEndpoint: 'upload-a10b.mypikpak.com',
    expectedBucket: 'vip-lixian-07',
    providers,
    fetchImpl: makeFetch({
      'a.example': [cname(target)],
      'b.example': [cname(target)],
      'c.example': new Error('network down'),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.region, 'ap-southeast-1');
  assert.equal(result.consensus, 2);
});

test('bucket 不匹配的 CNAME 即使三家一致也必须拒绝', async () => {
  const wrong = 'other-bucket.ap-southeast-1.thepacificphs.com.';
  const result = await discoverAliyunRegion({
    serverEndpoint: 'upload-a10b.mypikpak.com',
    expectedBucket: 'vip-lixian-07',
    providers,
    fetchImpl: makeFetch({
      'a.example': [cname(wrong)],
      'b.example': [cname(wrong)],
      'c.example': [cname(wrong)],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.length, 0);
});

test('并列冲突 region 时拒绝猜测', async () => {
  const providerSet = [
    { name: 'A', url: 'https://a.example/dns-query' },
    { name: 'B', url: 'https://b.example/dns-query' },
  ];

  const result = await discoverAliyunRegion({
    serverEndpoint: 'upload-a10b.mypikpak.com',
    expectedBucket: 'vip-lixian-07',
    providers: providerSet,
    minimumConsensus: 1,
    fetchImpl: makeFetch({
      'a.example': [cname('vip-lixian-07.ap-southeast-1.thepacificphs.com.')],
      'b.example': [cname('vip-lixian-07.us-west-1.thepacificphs.com.')],
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /并列冲突/);
});
