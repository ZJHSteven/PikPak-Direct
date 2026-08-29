// PikPak-Direct：Aliyun OSS endpoint 规范化模块。
//
// 这个文件只负责“根据已经可信的 region 信息，把 PikPak 返回的自定义 OSS CNAME
// 变成阿里云原生 OSS endpoint”。它故意不负责登录、不负责上传，也不主动联网猜 region。
// 这样可以把最危险的决策边界单独测试：
//
//   1. provider 必须明确是 PROVIDER_ALIYUN；
//   2. region 必须来自可信证据，不能因为当前实验是新加坡就永远硬编码 ap-southeast-1；
//   3. 只有满足条件时才把 cname 改成 false；
//   4. 其余 STS / bucket / key 等字段原样保留。
//
// 正式 CLI 后续会在更上层实现 region discovery；本模块只接收最终 regionHint。

/**
 * PikPak 当前 Web 前端观察到的 Aliyun provider 常量。
 * 独立常量便于未来 PikPak 改名时集中调整。
 */
export const PIKPAK_ALIYUN_PROVIDER = 'PROVIDER_ALIYUN';

/**
 * 校验 Aliyun region 名称是否符合常见 OSS region 形式。
 *
 * 这里不维护“所有合法 region 白名单”，因为阿里云未来可能新增 region；
 * 只做保守的字符格式校验，防止把任意 URL/路径注入 endpoint。
 *
 * @param {string} region - 例如 `ap-southeast-1`。
 * @returns {boolean}
 */
export function isSafeAliyunRegion(region) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(String(region || ''));
}

/**
 * 从“已经是标准 Aliyun OSS endpoint”的 host 中提取 region。
 *
 * 支持：
 * - oss-ap-southeast-1.aliyuncs.com
 * - bucket.oss-ap-southeast-1.aliyuncs.com
 *
 * 不支持 PikPak 自定义 CNAME，因为单看 `upload-a10b.mypikpak.com` 无法可靠知道 region。
 *
 * @param {string} hostOrUrl - host 或完整 URL。
 * @returns {string|null} region，无法安全识别时返回 null。
 */
export function extractAliyunRegion(hostOrUrl) {
  const raw = String(hostOrUrl || '').trim();
  if (!raw) return null;

  let host = raw;

  // URL() 只能解析带 scheme 的地址。若传入纯 host，则直接使用原字符串。
  if (/^https?:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch {
      return null;
    }
  }

  host = host.toLowerCase().replace(/\.$/, '');

  // `(?:^|\.)` 同时兼容 endpoint 本身与 `bucket.endpoint` 两种形式。
  const match = host.match(/(?:^|\.)oss-([a-z0-9-]+)\.aliyuncs\.com$/);
  if (!match) return null;

  return isSafeAliyunRegion(match[1]) ? match[1] : null;
}

/**
 * 根据 region 生成阿里云 OSS 标准 endpoint。
 *
 * @param {string} region - 例如 `ap-southeast-1`。
 * @returns {string} 例如 `oss-ap-southeast-1.aliyuncs.com`。
 */
export function buildAliyunOssEndpoint(region) {
  if (!isSafeAliyunRegion(region)) {
    throw new Error(`无效或不安全的 Aliyun region: ${String(region)}`);
  }

  return `oss-${region}.aliyuncs.com`;
}

/**
 * 安全规范化 PikPak resumable 上传参数。
 *
 * 这是当前项目的核心小函数：正式上传器拿到 PikPak 返回值后，只通过这个函数决定
 * 是否改写 endpoint。函数会新建对象，不修改调用方原始响应，避免后续调试难以比较
 * “服务器原值”和“实际使用值”。
 *
 * @param {object} resumable - PikPak 返回的 resumable 对象。
 * @param {object} options
 * @param {string|null} [options.regionHint] - 由上层通过可信证据得出的 region。
 * @param {'direct-only'|'prefer-direct'|'server'} [options.policy='direct-only']
 * @returns {{resumable: object, route: 'direct'|'server', reason: string, serverEndpoint: string, effectiveEndpoint: string}}
 */
export function normalizeAliyunResumable(
  resumable,
  { regionHint = null, policy = 'direct-only' } = {},
) {
  if (!resumable || typeof resumable !== 'object') {
    throw new Error('缺少 PikPak resumable 上传参数。');
  }

  const provider = resumable.provider;
  const params = resumable.params;

  if (provider !== PIKPAK_ALIYUN_PROVIDER) {
    throw new Error(`当前 provider 不是 Aliyun，拒绝套用 Aliyun endpoint 改写: ${String(provider)}`);
  }

  if (!params || typeof params !== 'object') {
    throw new Error('resumable.params 缺失，无法构造上传会话。');
  }

  const serverEndpoint = String(params.endpoint || '').trim();
  if (!serverEndpoint) {
    throw new Error('PikPak 没有返回上传 endpoint。');
  }

  if (!['direct-only', 'prefer-direct', 'server'].includes(policy)) {
    throw new Error(`未知 data route policy: ${policy}`);
  }

  // `server` 模式严格尊重 PikPak 返回值，主要用于故障回退和 A/B 对照。
  if (policy === 'server') {
    return {
      resumable: {
        ...resumable,
        params: { ...params },
      },
      route: 'server',
      reason: 'policy=server，保持 PikPak 原始 endpoint。',
      serverEndpoint,
      effectiveEndpoint: serverEndpoint,
    };
  }

  // 若服务器本身已经返回标准 Aliyun endpoint，则不需要 regionHint 也能安全复用。
  const regionFromServerEndpoint = extractAliyunRegion(serverEndpoint);
  const region = regionHint || regionFromServerEndpoint;

  if (!region || !isSafeAliyunRegion(region)) {
    if (policy === 'prefer-direct') {
      return {
        resumable: {
          ...resumable,
          params: { ...params },
        },
        route: 'server',
        reason: '无法可靠确定 Aliyun region，prefer-direct 回退到 PikPak 原始 endpoint。',
        serverEndpoint,
        effectiveEndpoint: serverEndpoint,
      };
    }

    throw new Error(
      '无法可靠确定 Aliyun region；direct-only 模式拒绝猜测，避免把文件正文误送到错误 endpoint。',
    );
  }

  const effectiveEndpoint = buildAliyunOssEndpoint(region);

  return {
    resumable: {
      ...resumable,
      params: {
        ...params,
        endpoint: effectiveEndpoint,
        // Aliyun SDK 在 cname=false 时会按 bucket + 标准 endpoint 构造主机名。
        // 这里沿用本轮成功实验的语义，而不是继续使用 PikPak 自定义 CNAME。
        cname: 'false',
      },
    },
    route: 'direct',
    reason: `使用可信 region=${region} 构造 Aliyun OSS 原生 endpoint。`,
    serverEndpoint,
    effectiveEndpoint,
  };
}
