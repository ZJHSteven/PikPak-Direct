// PikPak Aliyun region 自动发现。
//
// 2026-08-30 对当前上传 endpoint 的三家独立 DoH 查询均观察到：
//
//   upload-a10b.mypikpak.com
//     CNAME -> vip-lixian-07.ap-southeast-1.thepacificphs.com
//
// 这条 CNAME 同时暴露了：
//   - bucket: vip-lixian-07
//   - region: ap-southeast-1
//
// 因此正式 CLI 不需要硬编码新加坡。为了避免 DNS 污染/单点错误，本模块默认查询多个
// 公共 DoH，并要求至少两个 provider 对“bucket + region”达成一致才接受结果。
//
// 这仍然是“当前 PikPak 基础设施观察”，不是官方 API；未来 CNAME 形式变化时应安全失败。

import { extractAliyunRegion, isSafeAliyunRegion } from './aliyun-endpoint.mjs';

export const DEFAULT_DOH_PROVIDERS = Object.freeze([
  {
    name: 'AliDNS',
    url: 'https://dns.alidns.com/resolve',
  },
  {
    name: 'Cloudflare',
    url: 'https://cloudflare-dns.com/dns-query',
  },
  {
    name: 'Google',
    url: 'https://dns.google/resolve',
  },
]);

/**
 * 清理 DNS 返回的绝对域名末尾 `.`，统一小写。
 */
function normalizeDnsName(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 从当前观察到的 PikPak CNAME 结构提取 bucket/region。
 *
 * 例如：
 *   vip-lixian-07.ap-southeast-1.thepacificphs.com
 *
 * 为了安全，只有：
 * - bucket 与 PikPak task 返回值完全一致；
 * - region 通过格式校验；
 * 才返回证据。
 *
 * @param {string} cname
 * @param {string} expectedBucket
 * @returns {{bucket: string, region: string, cname: string}|null}
 */
export function extractPikPakRegionFromCname(cname, expectedBucket) {
  const normalized = normalizeDnsName(cname);
  const bucket = String(expectedBucket || '').trim().toLowerCase();

  if (!normalized || !bucket) return null;

  // bucket 名中允许小写字母、数字与连字符。region 同样只接受安全字符。
  const match = normalized.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.thepacificphs\.com$/);
  if (!match) return null;

  const cnameBucket = match[1];
  const region = match[2];

  if (cnameBucket !== bucket) return null;
  if (!isSafeAliyunRegion(region)) return null;

  return {
    bucket: cnameBucket,
    region,
    cname: normalized,
  };
}

/**
 * 解析单个 DoH JSON 响应中的 CNAME。
 */
export function parseDohCnameAnswers(payload) {
  const answers = Array.isArray(payload?.Answer) ? payload.Answer : [];

  return answers
    .filter((answer) => Number(answer?.type) === 5)
    .map((answer) => normalizeDnsName(answer?.data))
    .filter(Boolean);
}

/**
 * 向一个 JSON DoH provider 查询 CNAME。
 *
 * 支持依赖注入 fetchImpl，方便单元测试完全离线。
 */
async function queryCname(provider, host, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(provider.url);
    url.searchParams.set('name', host);
    url.searchParams.set('type', 'CNAME');

    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/dns-json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    return parseDohCnameAnswers(payload);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动发现 PikPak Aliyun region。
 *
 * 优先级：
 * 1. 如果 serverEndpoint 本身已经是标准 `*.aliyuncs.com`，直接从 host 提取 region；
 * 2. 对自定义 CNAME，查询多家 DoH；
 * 3. 只接受与 expectedBucket 匹配的 PikPak CNAME；
 * 4. 至少 `minimumConsensus` 家 provider 给出同一 region 才成功。
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   region?: string,
 *   source?: string,
 *   consensus?: number,
 *   evidence?: Array<object>,
 *   reason?: string
 * }>}
 */
export async function discoverAliyunRegion({
  serverEndpoint,
  expectedBucket,
  providers = DEFAULT_DOH_PROVIDERS,
  minimumConsensus = 2,
  fetchImpl = fetch,
} = {}) {
  const host = normalizeDnsName(serverEndpoint);
  const bucket = String(expectedBucket || '').trim().toLowerCase();

  if (!host) {
    return { ok: false, reason: 'serverEndpoint 为空。' };
  }

  const directRegion = extractAliyunRegion(host);
  if (directRegion) {
    return {
      ok: true,
      region: directRegion,
      source: 'server-endpoint',
      consensus: 1,
      evidence: [{ provider: 'server-endpoint', host, region: directRegion }],
    };
  }

  if (!bucket) {
    return { ok: false, reason: 'expectedBucket 为空，无法校验 CNAME 证据。' };
  }

  if (!Number.isInteger(minimumConsensus) || minimumConsensus < 1) {
    throw new Error('minimumConsensus 必须是 >= 1 的整数。');
  }

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const cnames = await queryCname(provider, host, { fetchImpl });
      const matches = cnames
        .map((cname) => extractPikPakRegionFromCname(cname, bucket))
        .filter(Boolean);

      return {
        provider: provider.name,
        cnames,
        matches,
      };
    }),
  );

  const evidence = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const provider = providers[index];

    if (result.status === 'fulfilled') {
      for (const match of result.value.matches) {
        evidence.push({
          provider: provider.name,
          cname: match.cname,
          bucket: match.bucket,
          region: match.region,
        });
      }
    }
  }

  const counts = new Map();
  for (const item of evidence) {
    counts.set(item.region, (counts.get(item.region) || 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];

  if (!winner || winner[1] < minimumConsensus) {
    return {
      ok: false,
      reason: `DoH CNAME 没有达到 ${minimumConsensus} 家一致的可信 region。`,
      evidence,
    };
  }

  // 如果存在票数相同但 region 不同的结果，也拒绝决定，避免 split-brain 时猜测。
  if (ranked[1] && ranked[1][1] === winner[1] && ranked[1][0] !== winner[0]) {
    return {
      ok: false,
      reason: 'DoH CNAME 出现并列冲突 region，拒绝猜测。',
      evidence,
    };
  }

  return {
    ok: true,
    region: winner[0],
    source: 'doh-cname-consensus',
    consensus: winner[1],
    evidence,
  };
}
