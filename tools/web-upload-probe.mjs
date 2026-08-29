// PikPak Web 官方上传链路探针。
//
// 用途：在用户已经登录 PikPak Web、且 Chrome 开启 CDP（默认 127.0.0.1:9222）时，
// 创建一份小型随机测试文件，调用当前网页自己已经加载的 PikPak API / Aliyun OSS Adapter，
// 验证以下完整闭环：
//
//   PikPak create resumable task
//        -> Aliyun OSS multipart upload
//        -> PikPak task check-in
//        -> progress=100 / COMPLETE
//
// 安全边界：
// - 本工具不修改 Mihomo 配置，也不切换全局 mode；
// - direct 模式只改“当前上传会话里的 endpoint”；
// - 不输出 STS AccessKeySecret / SecurityToken / Cookie / access token；
// - 无论成功失败，默认都尝试把测试 file 移入 PikPak 回收站，避免污染云盘；
// - 当前 webpack module ID 来自 2026-08-29 的 PikPak Web 实测，前端升级后可能需要重新定位。

import process from 'node:process';

import { buildAliyunOssEndpoint, isSafeAliyunRegion } from '../src/aliyun-endpoint.mjs';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

/**
 * 解析极简命令行参数，避免为了一个探针引入 CLI 框架依赖。
 *
 * 支持：
 *   --size-mib 8
 *   --route server|direct
 *   --region ap-southeast-1
 *   --cdp http://127.0.0.1:9222
 */
function parseArgs(argv) {
  const args = {
    sizeMiB: 8,
    route: 'server',
    region: null,
    cdpUrl: DEFAULT_CDP_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag === '--size-mib') {
      args.sizeMiB = Number(value);
      i += 1;
    } else if (flag === '--route') {
      args.route = value;
      i += 1;
    } else if (flag === '--region') {
      args.region = value;
      i += 1;
    } else if (flag === '--cdp') {
      args.cdpUrl = value;
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`PikPak Web 官方上传探针

用法：
  npm run probe:web-upload -- --route server --size-mib 8
  npm run probe:web-upload -- --route direct --region ap-southeast-1 --size-mib 8

参数：
  --route server|direct     server=尊重 PikPak 返回 endpoint；direct=改写为原生 Aliyun OSS endpoint
  --region <region>         direct 模式必填，例如 ap-southeast-1
  --size-mib <MiB>          随机测试文件大小，默认 8，建议 smoke test 使用 1~32
  --cdp <url>               Chrome DevTools HTTP 地址，默认 ${DEFAULT_CDP_URL}

注意：
  - direct 模式不会改 Mihomo，只改变这个上传会话的 OSS endpoint。
  - 该工具依赖当前已经登录的 PikPak Web 标签页。
`);
}

function validateArgs(args) {
  if (!Number.isFinite(args.sizeMiB) || args.sizeMiB <= 0 || args.sizeMiB > 256) {
    throw new Error('--size-mib 必须是 0~256 之间的正数。探针默认禁止生成超大随机测试文件。');
  }

  if (!['server', 'direct'].includes(args.route)) {
    throw new Error('--route 只能是 server 或 direct。');
  }

  if (args.route === 'direct' && !isSafeAliyunRegion(args.region)) {
    throw new Error('direct 模式必须显式提供安全的 --region，例如 ap-southeast-1；当前不会自动猜 region。');
  }
}

/**
 * 建立一个最小 CDP RPC 客户端。
 * Node 22+ 已提供全局 WebSocket，因此当前项目不需要额外 ws 依赖。
 */
async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;

    const request = pending.get(message.id);
    if (!request) return;

    pending.delete(message.id);

    if (message.error) {
      request.reject(new Error(`${request.method}: ${message.error.message}`));
    } else {
      request.resolve(message.result);
    }
  };

  await opened;

  return {
    async call(method, params = {}) {
      const id = nextId;
      nextId += 1;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

/**
 * 寻找已经登录并打开的 PikPak Drive 页面。
 * 只连接 `mypikpak.com/drive` 页面，不自动导航/登录，避免改变用户浏览器状态。
 */
async function findPikPakTarget(cdpUrl) {
  const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json`);
  if (!response.ok) {
    throw new Error(`无法读取 Chrome CDP targets: HTTP ${response.status}`);
  }

  const targets = await response.json();
  return targets.find(
    (target) => target.type === 'page' && target.url?.includes('mypikpak.com/drive'),
  );
}

/**
 * 构造浏览器上下文表达式。
 *
 * 这里之所以在页面上下文执行，是为了复用 PikPak 当前登录态和官方前端已经加载的
 * API/OSS adapter。长期正式 CLI 会逐步把这部分从网页内部模块剥离出来；现阶段它是
 * 最可靠的“协议回归探针”。
 */
function buildBrowserExpression({ sizeMiB, route, directEndpoint }) {
  return `(async()=>{
    const SIZE_MIB=${JSON.stringify(sizeMiB)};
    const ROUTE=${JSON.stringify(route)};
    const DIRECT_ENDPOINT=${JSON.stringify(directEndpoint)};

    // 当前 PikPak Web 使用 webpack chunk。下面只把 require 暴露到当前页面内存，
    // 不修改页面资源、不安装扩展，也不把授权信息传回 Node 侧。
    const chunkKey=Object.keys(window).find(k=>k.startsWith('webpackChunk'));
    if(!chunkKey) return {ok:false,stage:'webpack',error:'webpack chunk global not found'};
    if(!window.__ppWebpackRequire){
      window[chunkKey].push([[987654323],{},r=>window.__ppWebpackRequire=r]);
    }
    const req=window.__ppWebpackRequire;

    // 2026-08-29 当前前端观察到的模块：
    // 99289: create upload file API
    // 45942: aliYunOssAdapter（由 8827/4089 chunk 懒加载）
    // 18839: file/task API（含 task query / batchTrash）
    await Promise.all([req.e(8827),req.e(4089)]);
    const create=req(99289).D;
    const Adapter=req(45942).default;
    const fileApi=req(18839);

    const size=Math.floor(SIZE_MIB*1024*1024);
    const bytes=new Uint8Array(size);

    // crypto.getRandomValues 单次最大 65536 bytes，因此分块填充。
    for(let offset=0;offset<size;offset+=65536){
      crypto.getRandomValues(bytes.subarray(offset,Math.min(offset+65536,size)));
    }

    // 当前前端创建任务时会携带 SHA-1 hash，这里沿用其行为。
    const digest=await crypto.subtle.digest('SHA-1',bytes);
    const hash=[...new Uint8Array(digest)]
      .map(byte=>byte.toString(16).padStart(2,'0'))
      .join('');

    const name='__pikpak_direct_probe_'+ROUTE+'_'+Date.now()+'.bin';
    const createBody={
      hash,
      name,
      size:String(size),
      kind:'drive#file',
      id:'',
      parent_id:'',
      upload_type:'UPLOAD_TYPE_RESUMABLE',
      folder_type:'NORMAL',
      resumable:{provider:'PROVIDER_ALIYUN'}
    };

    let fileId='';

    try{
      const createResponse=await create(createBody);
      const data=createResponse?.data?.value||createResponse?.data||createResponse;

      if(!data?.resumable){
        return {
          ok:false,
          stage:'create',
          // 不序列化完整响应，避免未来 PikPak 把敏感字段塞入 error payload。
          errorCode:createResponse?.error?.value?.error||createResponse?.error?.error||null,
          responseKeys:data?Object.keys(data):[]
        };
      }

      fileId=data?.file?.id||'';

      const provider=data.resumable?.provider||'';
      const serverEndpoint=data.resumable?.params?.endpoint||'';
      const bucket=data.resumable?.params?.bucket||'';

      if(provider!=='PROVIDER_ALIYUN'){
        return {ok:false,stage:'provider',provider,serverEndpoint,bucket};
      }

      // 只浅拷贝当前上传会话。绝不把 params 对象返回给 Node，因为其中有 STS secret。
      const resumable={...data.resumable,params:{...data.resumable.params}};

      if(ROUTE==='direct'){
        resumable.params.endpoint=DIRECT_ENDPOINT;
        resumable.params.cname='false';
      }

      const effectiveEndpoint=resumable.params.endpoint;
      const file=new File([bytes],name,{type:'application/octet-stream'});
      const uploader=new Adapter(data.task.id,resumable);
      let maxProgress=0;
      const started=performance.now();

      const uploadResult=await new Promise(resolve=>{
        let settled=false;
        const done=(value)=>{
          if(settled) return;
          settled=true;
          resolve(value);
        };

        uploader.register({
          onProgress:()=>{
            maxProgress=Math.max(maxProgress,Number(uploader.displayProgress||0));
          },
          onComplete:()=>done({ok:true}),
          onError:(error)=>done({
            ok:false,
            stage:'upload',
            error:String(error?.message||error),
            code:error?.troubleshootingCode||error?.ecCode||null
          })
        });

        Promise.resolve(uploader.start(file)).catch(error=>done({
          ok:false,
          stage:'upload-start',
          error:String(error?.message||error)
        }));
      });

      const elapsedSeconds=(performance.now()-started)/1000;
      let checkIn={progress:null,phase:null,allDone:false,polls:0};

      if(uploadResult.ok){
        // 与当前 PikPak 前端相同：OSS 完成后轮询 task，确认云盘服务端正式认账。
        for(let index=0;index<30;index+=1){
          try{
            const taskResponse=await fileApi.kd(data.task.id);
            const task=taskResponse?.data?.value||taskResponse?.data||taskResponse;
            checkIn={
              progress:task?.progress??null,
              phase:task?.phase??null,
              allDone:Number(task?.progress)===100,
              polls:index+1
            };
            if(checkIn.allDone) break;
          }catch{}

          await new Promise(resolve=>setTimeout(resolve,500));
        }
      }

      return {
        ...uploadResult,
        provider,
        serverEndpoint,
        effectiveEndpoint,
        bucket,
        sizeMiB:SIZE_MIB,
        elapsedSeconds,
        mibPerSecond:SIZE_MIB/elapsedSeconds,
        megabitsPerSecond:(SIZE_MIB*8)/elapsedSeconds,
        maxProgress,
        checkIn
      };
    }finally{
      if(fileId){
        // batchTrash 只用于清理本工具自己刚创建的测试文件。
        try{await fileApi.VK([fileId]);}catch{}
      }
    }
  })()`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  validateArgs(args);

  const directEndpoint = args.route === 'direct'
    ? buildAliyunOssEndpoint(args.region)
    : null;

  const target = await findPikPakTarget(args.cdpUrl);
  if (!target) {
    throw new Error('没有找到已打开的 PikPak Drive 标签页。请先在当前 CDP Chrome 中登录 PikPak。');
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  try {
    const expression = buildBrowserExpression({
      sizeMiB: args.sizeMiB,
      route: args.route,
      directEndpoint,
    });

    const evaluation = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (evaluation.exceptionDetails) {
      const description = evaluation.exceptionDetails.exception?.description
        || evaluation.exceptionDetails.text
        || 'unknown browser exception';
      throw new Error(`PikPak 页面探针异常: ${description}`);
    }

    const result = evaluation.result?.value;
    if (!result) {
      throw new Error('浏览器没有返回可序列化的探针结果。');
    }

    // 输出已经在浏览器内主动裁剪过的非敏感结果。
    console.log(JSON.stringify(result, null, 2));

    if (!result.ok || !result.checkIn?.allDone) {
      process.exitCode = 2;
    }
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(`[pikpak-direct] ${error.message}`);
  process.exitCode = 1;
});
