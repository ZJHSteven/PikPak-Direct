// PikPak Web 控制面会话。
//
// 这个模块只负责通过 Chrome DevTools Protocol（CDP）复用“已经登录的 PikPak Web 页面”，
// 调用页面当前加载的 PikPak 前端模块完成：
//
//   - 创建 resumable upload task；
//   - 查询 task 状态；
//   - 等待 task check-in 完成；
//   - 在失败/探针场景清理测试文件。
//
// 它不负责 OSS 文件正文上传。这样控制面天然继续走用户当前浏览器/Mihomo 规则，
// 而数据面可以由 Node 进程单独通过 Aliyun OSS 原生 endpoint 上传。
//
// 安全设计：
// - STS AccessKeySecret / SecurityToken 必须回到 Node 内存，否则 Node 无法直接向 OSS 上传；
// - 这些字段存入 class private field，不参与 Object.keys / JSON.stringify；
// - util.inspect/console.log 只显示脱敏后的公共信息；
// - 本模块绝不把完整 PikPak API response 写盘。

import { inspect } from 'node:util';
import {
  PIKPAK_DRIVE_URL,
  acquirePikPakBrowserLease,
} from './pikpak-browser-lifecycle.mjs';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

/**
 * 当前 2026-08-29 PikPak Web bundle 中已验证的 webpack module ID。
 *
 * 这是“前端内部实现观察”，不是官方稳定 API。未来 PikPak Web 更新后，如果 module ID 变化，
 * smoke test 应明确失败，再重新定位，而不是静默猜测。
 */
const WEBPACK_MODULES = Object.freeze({
  createUploadFile: 99289,
  fileAndTaskApi: 18839,
});

/** 构造 PikPak Web 当前使用的 Cloud Download / URL 保存请求体。 */
export function buildCloudDownloadBody({ url, parentId = '' }) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    throw new Error('Cloud Download URL 必须是 HTTPS。');
  }
  return {
    kind: 'drive#file',
    ...(parentId ? { parent_id: parentId } : { folder_type: 'DOWNLOAD' }),
    upload_type: 'UPLOAD_TYPE_URL',
    url: { url: String(url) },
    params: {
      with_thumbnail: 'true',
      from: 'manual',
    },
  };
}

/** 构造当前 PikPak Web `POST /files` 使用的普通文件夹创建请求体。 */
export function buildCreateFolderBody({ name, parentId = '' }) {
  if (!String(name || '').trim()) throw new Error('文件夹名称不能为空。');
  return {
    kind: 'drive#folder',
    name: String(name),
    parent_id: String(parentId || ''),
    folder_type: 'NORMAL',
  };
}

/**
 * 对象代表一次 PikPak 上传任务。
 *
 * public fields 只保留可以安全记录到 manifest 的信息；
 * STS credentials 存入 #ossCredentials 私有字段。
 */
export class PikPakUploadSession {
  #ossCredentials;

  constructor(payload) {
    this.fileId = payload.fileId;
    this.taskId = payload.taskId;
    this.provider = payload.provider;
    this.serverEndpoint = payload.endpoint;
    this.bucket = payload.bucket;
    this.objectKey = payload.key;
    this.cname = payload.cname;
    this.expiration = payload.expiration;
    this.name = payload.name;
    this.size = payload.size;

    this.#ossCredentials = Object.freeze({
      accessKeyId: payload.accessKeyId,
      accessKeySecret: payload.accessKeySecret,
      stsToken: payload.securityToken,
    });

    Object.freeze(this);
  }

  /**
   * 仅供真正的 OSS uploader 使用。
   * 每次返回一个新对象，防止调用方修改 session 内部凭据状态。
   */
  getOssCredentials() {
    return { ...this.#ossCredentials };
  }

  /**
   * JSON.stringify(session) 时自动只留下非敏感字段。
   */
  toJSON() {
    return {
      fileId: this.fileId,
      taskId: this.taskId,
      provider: this.provider,
      serverEndpoint: this.serverEndpoint,
      bucket: this.bucket,
      objectKey: redactObjectKey(this.objectKey),
      cname: this.cname,
      expiration: this.expiration,
      name: this.name,
      size: this.size,
      credentials: '<redacted>',
    };
  }

  /**
   * console.log / util.inspect 同样走脱敏输出，降低调试误泄露风险。
   */
  [inspect.custom]() {
    return this.toJSON();
  }
}

/**
 * PikPak 下载签名 URL 的内存包装器。
 * URL 往往包含短期 token/query secret；默认打印/序列化永远不暴露完整 URL。
 */
export class PikPakDownloadTicket {
  #url;

  constructor({ fileId, name, size, hash, url, expire = null }) {
    this.fileId = fileId;
    this.name = name;
    this.size = Number(size);
    this.hash = hash || '';
    this.expire = expire;
    this.#url = String(url || '');
  }

  getUrl() {
    return this.#url;
  }

  toJSON() {
    return {
      fileId: this.fileId,
      name: this.name,
      size: this.size,
      hash: this.hash,
      expire: this.expire,
      url: '<redacted-signed-url>',
    };
  }

  [inspect.custom]() {
    return this.toJSON();
  }
}

/**
 * 对 object key 做轻量脱敏。
 * PikPak 当前 key 形如 `upload_tmp/<长随机串>`，长期日志没有必要记录完整值。
 */
function redactObjectKey(key) {
  const text = String(key || '');
  if (text.length <= 16) return text ? '<redacted-key>' : '';
  return `${text.slice(0, 12)}…${text.slice(-6)}`;
}

/**
 * 极简 CDP JSON-RPC 客户端。
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
 * 从 CDP target 列表寻找已经打开的 PikPak Drive 页面。
 * 不主动新开/导航页面，避免改变用户浏览器状态。
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
 * 在页面上下文注入一个只存在于当前内存中的 webpack require 引用。
 *
 * 这是当前控制面桥接的技术债：正式长期版本应优先寻找更稳定的官方 CLI/PAT/API 登录方式，
 * 但在现阶段，复用已登录 Web 会话最安全，也不需要把长期账号密码写入本项目。
 */
export function webpackBootstrapExpression() {
  return `
    const __ppRequiredModuleIds=[${WEBPACK_MODULES.createUploadFile},${WEBPACK_MODULES.fileAndTaskApi}];
    const __ppIsUsableRequire=(candidate)=>
      typeof candidate==='function'
      && candidate.m
      && __ppRequiredModuleIds.every(id=>Boolean(candidate.m[id]));

    let __ppReq=__ppIsUsableRequire(window.__ppWebpackRequire)
      ? window.__ppWebpackRequire
      : null;

    if(!__ppReq){
      const __ppChunkKeys=Object.keys(window).filter(k=>
        k.startsWith('webpackChunk')
        && window[k]
        && typeof window[k].push==='function'
      );

      if(__ppChunkKeys.length===0){
        throw new Error('PikPak webpack chunk global not found');
      }

      for(const __ppChunkKey of __ppChunkKeys){
        let __ppCaptured=null;
        try{
          // 旧实现固定使用 987654321 作为 probe chunk id。若同一页面曾执行过一次，
          // webpack 可能把该 chunk 视为已经加载，从而不再执行 runtime 回调。
          // 使用每次唯一的字符串 id，保证本轮 probe 一定是新的 chunk。
          const __ppProbeChunkId='pikpak-direct-'+Date.now()+'-'+Math.random().toString(16).slice(2);
          window[__ppChunkKey].push([
            [__ppProbeChunkId],
            {},
            r=>{__ppCaptured=r;}
          ]);
        }catch(_error){
          __ppCaptured=null;
        }

        // 页面未来如果出现多个 webpack runtime，只接受同时含有当前已验证目标模块的那个。
        // 这样不会把别的微前端/第三方 bundle 的 require 错当成 PikPak 主应用 runtime。
        if(__ppIsUsableRequire(__ppCaptured)){
          __ppReq=__ppCaptured;
          window.__ppWebpackRequire=__ppCaptured;
          break;
        }
      }
    }

    if(!__ppIsUsableRequire(__ppReq)){
      throw new Error('PikPak webpack require capture failed or expected modules are missing');
    }
  `;
}

/**
 * 把 CDP Runtime.evaluate 的结果安全转换为普通值。
 */
function unwrapEvaluation(evaluation) {
  if (evaluation.exceptionDetails) {
    const description = evaluation.exceptionDetails.exception?.description
      || evaluation.exceptionDetails.text
      || 'unknown browser exception';
    throw new Error(`PikPak 页面执行异常: ${description}`);
  }

  if (!Object.prototype.hasOwnProperty.call(evaluation.result || {}, 'value')) {
    throw new Error('PikPak 页面没有返回可序列化结果。');
  }

  return evaluation.result.value;
}

/**
 * PikPak SPA 在自动 reload / service-worker 切换的极短窗口里，window 上可能暂时没有
 * webpackChunk*。这种错误对 GET/list/task-poll 等只读调用可以安全等待 runtime 恢复后重试；
 * 对 create/upload/trash 等有副作用调用则绝不能自动重放，否则可能制造重复对象/任务。
 */
export function isRecoverableWebpackRuntimeError(error) {
  const message = String(error?.message || error || '');
  return /webpack chunk global not found|webpack require capture failed|expected modules are missing/i.test(message);
}

export class PikPakWebSession {
  constructor(cdp, target, browserLease = null) {
    this.cdp = cdp;
    this.target = target;
    this.browserLease = browserLease;
  }

  /**
   * 连接已登录 PikPak Web 页面。
   *
   * @param {{cdpUrl?: string}} options
   */
  static async connect({ cdpUrl = DEFAULT_CDP_URL } = {}) {
    const browserLease = await acquirePikPakBrowserLease({ cdpUrl });
    try {
      const cdp = await connectCdp(browserLease.target.webSocketDebuggerUrl);
      return new PikPakWebSession(cdp, browserLease.target, browserLease);
    } catch (error) {
      await browserLease.release();
      throw error;
    }
  }

  /**
   * 等待当前受管 tab 的 PikPak SPA runtime 回来；必要时最后才重新导航到 Drive。
   *
   * 第一阶段只等待，覆盖“刚好撞上页面 reload”的常见情况；5 秒仍没有 runtime 时才导航，
   * 避免无意义刷新一个其实正在正常恢复的页面。window.name marker 会跨导航保留。
   */
  async recoverReadOnlyRuntime({ passiveWaitMs = 5_000, navigateWaitMs = 20_000 } = {}) {
    const probe = async () => {
      const evaluation = await this.cdp.call('Runtime.evaluate', {
        expression: `(()=>({
          href:location.href,
          ready:document.readyState,
          hasWebpack:Object.keys(window).some(k=>k.startsWith('webpackChunk')&&window[k]&&typeof window[k].push==='function')
        }))()`,
        returnByValue: true,
      });
      return unwrapEvaluation(evaluation);
    };

    const waitUntilReady = async (timeoutMs) => {
      const started = Date.now();
      let last = null;
      while (Date.now() - started <= timeoutMs) {
        try {
          last = await probe();
          if (last?.hasWebpack && String(last.href || '').includes('mypikpak.com/drive')) return last;
          if (String(last?.href || '').includes('/login')) {
            const error = new Error('PikPak 受管页面在任务执行中掉登录，无法自动恢复只读控制面。');
            error.code = 'LOGIN_REQUIRED';
            throw error;
          }
        } catch (error) {
          if (error?.code === 'LOGIN_REQUIRED') throw error;
          // reload 的瞬间 Runtime.evaluate 自己也可能失败；继续等待。
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    };

    const passive = await waitUntilReady(passiveWaitMs);
    if (passive) return passive;

    await this.cdp.call('Page.enable');
    await this.cdp.call('Page.navigate', { url: PIKPAK_DRIVE_URL });
    const navigated = await waitUntilReady(navigateWaitMs);
    if (!navigated) {
      const error = new Error('PikPak 页面 runtime 在 reload/重新导航后仍未恢复。');
      error.code = 'WEB_RUNTIME_UNAVAILABLE';
      throw error;
    }
    return navigated;
  }

  /**
   * 仅供“确认无副作用”的页面查询使用。runtime 短暂丢失时最多重放一次相同表达式。
   */
  async evaluateReadOnly(expression) {
    const run = async () => {
      const evaluation = await this.cdp.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return unwrapEvaluation(evaluation);
    };

    try {
      return await run();
    } catch (error) {
      if (!isRecoverableWebpackRuntimeError(error)) throw error;
      await this.recoverReadOnlyRuntime();
      return run();
    }
  }

  /**
   * 创建 PikPak resumable upload task。
   *
   * 返回的 PikPakUploadSession 内含短生命周期 STS，但默认打印/序列化均会脱敏。
   */
  async createResumableUpload({ name, size, sha1, parentId = '' }) {
    if (!name) throw new Error('上传文件名不能为空。');
    if (!Number.isFinite(Number(size)) || Number(size) < 0) throw new Error('文件 size 无效。');
    if (!/^[a-f0-9]{40}$/i.test(String(sha1 || ''))) throw new Error('sha1 必须是 40 位十六进制字符串。');

    const body = {
      hash: String(sha1).toLowerCase(),
      name,
      size: String(size),
      kind: 'drive#file',
      id: '',
      parent_id: parentId,
      upload_type: 'UPLOAD_TYPE_RESUMABLE',
      folder_type: 'NORMAL',
      resumable: { provider: 'PROVIDER_ALIYUN' },
    };

    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const create=__ppReq(${WEBPACK_MODULES.createUploadFile}).D;
      const response=await create(${JSON.stringify(body)});
      const data=response?.data?.value||response?.data||response;

      if(!data?.resumable){
        return {
          ok:false,
          errorCode:response?.error?.value?.error||response?.error?.error||null,
          errorDescription:response?.error?.value?.error_description||response?.error?.error_description||null,
          responseKeys:data?Object.keys(data):[]
        };
      }

      const params=data.resumable?.params||{};

      return {
        ok:true,
        fileId:data?.file?.id||'',
        taskId:data?.task?.id||'',
        provider:data.resumable?.provider||'',
        endpoint:params.endpoint||'',
        bucket:params.bucket||'',
        key:params.key||'',
        cname:params.cname,
        expiration:params.expiration||'',
        accessKeyId:params.access_key_id||'',
        accessKeySecret:params.access_key_secret||'',
        securityToken:params.security_token||'',
        name:data?.file?.name||${JSON.stringify(name)},
        size:data?.file?.size||${JSON.stringify(String(size))}
      };
    })()`;

    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    const result = unwrapEvaluation(evaluation);

    if (!result?.ok) {
      // errorDescription 可能包含正常业务提示，但不应包含 STS；仍只在异常消息中短暂显示，
      // 不把完整 API response 序列化到日志。
      const detail = result?.errorDescription || result?.errorCode || 'unknown create error';
      throw new Error(`PikPak 创建上传任务失败: ${detail}`);
    }

    const required = [
      'fileId',
      'taskId',
      'provider',
      'endpoint',
      'bucket',
      'key',
      'accessKeyId',
      'accessKeySecret',
      'securityToken',
    ];

    for (const field of required) {
      if (!result[field]) {
        throw new Error(`PikPak 上传任务响应缺少必要字段: ${field}`);
      }
    }

    return new PikPakUploadSession(result);
  }

  /**
   * 用 PikPak 官方 Web 当前的 Cloud Download 控制面创建 URL 保存任务。
   *
   * 2026-10-11 实机 bundle 观察：
   * - NewFiles 组件把请求构造成 upload_type=UPLOAD_TYPE_URL；
   * - 通过 file/task API module 18839 的导出 x3 提交；
   * - 成功结果位于 response.data.value.task。
   *
   * 这是“复用官方 Web 会话里的内部模块”，不是承诺长期稳定的公开 API；模块变化时应明确失败。
   */
  async createCloudDownload({ url, parentId = '' }) {
    const body = buildCloudDownloadBody({ url, parentId });
    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      if(typeof fileApi?.x3!=='function'){
        return {ok:false,errorCode:'WEB_MODULE_CHANGED',errorDescription:'fileApi.x3 missing'};
      }
      const response=await fileApi.x3(${JSON.stringify(body)});
      const data=response?.data?.value||response?.data||response;
      const error=response?.error?.value||response?.error||null;
      if(error?.error){
        return {
          ok:false,
          errorCode:error.error||null,
          errorDescription:error.message||error.error_description||null
        };
      }
      const task=data?.task||null;
      const file=data?.file||null;
      if(!task?.id){
        return {
          ok:false,
          errorCode:'TASK_ID_MISSING',
          errorDescription:'Cloud Download response has no task id'
        };
      }
      return {
        ok:true,
        taskId:task.id,
        fileId:file?.id||task?.file_id||task?.file?.id||'',
        phase:task?.phase??null,
        progress:task?.progress??null,
        name:file?.name||task?.name||''
      };
    })()`;

    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = unwrapEvaluation(evaluation);
    if (!result?.ok) {
      const detail = result?.errorDescription || result?.errorCode || 'unknown create error';
      throw new Error(`PikPak 创建 Cloud Download 任务失败: ${detail}`);
    }
    return result;
  }

  /**
   * 创建普通 PikPak Drive 文件夹。
   * 2026-10-11 实机 probe 已验证：module 18839.x3 -> POST /files，body.kind=drive#folder。
   */
  async createFolder({ name, parentId = '' }) {
    const body = buildCreateFolderBody({ name, parentId });
    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      const response=await fileApi.x3(${JSON.stringify(body)});
      const data=response?.data?.value||response?.data||response;
      const error=response?.error?.value||response?.error||null;
      if(error?.error){
        return {ok:false,errorCode:error.error||null,errorDescription:error.message||error.error_description||null};
      }
      const file=data?.file||null;
      if(!file?.id){
        return {ok:false,errorCode:'FILE_ID_MISSING',errorDescription:'folder create response has no file id'};
      }
      return {
        ok:true,
        file:{
          id:file.id,
          name:file.name||${JSON.stringify(String(name))},
          kind:file.kind||'drive#folder',
          parentId:file.parent_id||'',
          folderType:file.folder_type||'NORMAL',
          trashed:Boolean(file.trashed)
        }
      };
    })()`;
    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = unwrapEvaluation(evaluation);
    if (!result?.ok) {
      throw new Error(`PikPak 创建文件夹失败: ${result?.errorDescription || result?.errorCode || 'unknown'}`);
    }
    return result.file;
  }

  /**
   * 列出一个 Drive 目录的一页内容。
   * 只把仓库同步需要的稳定字段带回 Node；缩略图、媒体信息、分享 token 等一律丢弃。
   */
  async listFiles({ parentId = '', pageToken = '', limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('PikPak listFiles limit 必须是 1~1000 的整数。');
    }
    const params = {
      parent_id: String(parentId || ''),
      limit,
      thumbnail_size: 'SIZE_SMALL',
      ...(pageToken ? { page_token: String(pageToken) } : {}),
    };
    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      const response=await fileApi.oc(${JSON.stringify(params)});
      const data=response?.data?.value||response?.data||response;
      return {
        nextPageToken:data?.next_page_token||'',
        files:(data?.files||[]).map(file=>({
          id:file.id||'',
          name:file.name||'',
          kind:file.kind||'',
          parentId:file.parent_id||'',
          size:Number(file.size||0),
          hash:file.hash||'',
          phase:file.phase||'',
          trashed:Boolean(file.trashed),
          modifiedTime:file.modified_time||'',
          folderType:file.folder_type||''
        }))
      };
    })()`;
    return this.evaluateReadOnly(expression);
  }

  /**
   * 获取普通文件的短期下载 ticket；完整签名 URL 只保存在 private field 中。
   * 当前 Web bundle module 18839.UV -> GET /files/{id}，正文链接位于
   * links['application/octet-stream'].url，web_content_link 仅作为兼容 fallback。
   */
  async getDownloadTicket(fileId) {
    if (!fileId) throw new Error('fileId 不能为空。');
    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      const response=await fileApi.UV(${JSON.stringify(String(fileId))},{});
      const file=response?.data?.value||response?.data||response;
      const link=file?.links?.['application/octet-stream']||null;
      const url=link?.url||file?.web_content_link||'';
      return {
        fileId:file?.id||${JSON.stringify(String(fileId))},
        name:file?.name||'',
        size:Number(file?.size||0),
        hash:file?.hash||'',
        url,
        expire:link?.expire||null
      };
    })()`;
    const result = await this.evaluateReadOnly(expression);
    if (!/^https:\/\//i.test(String(result?.url || ''))) {
      throw new Error(`PikPak file ${fileId} 没有可用 HTTPS 下载链接。`);
    }
    return new PikPakDownloadTicket(result);
  }

  /**
   * 查询一个 PikPak task 的公开状态。
   * 返回值严格裁剪，不把其他可能变化的 server payload 带出页面。
   */
  async getTaskStatus(taskId) {
    if (!taskId) throw new Error('taskId 不能为空。');

    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      const response=await fileApi.kd(${JSON.stringify(taskId)});
      const task=response?.data?.value||response?.data||response;
      return {
        progress:task?.progress??null,
        phase:task?.phase??null,
        error:task?.error??null,
        message:task?.message??null,
        fileId:task?.file_id||task?.file?.id||'',
        fileName:task?.file_name||task?.file?.name||task?.name||'',
        fileSize:task?.file_size??task?.file?.size??null
      };
    })()`;

    return this.evaluateReadOnly(expression);
  }

  /**
   * 删除一个或多个 offline / Cloud Download task。
   *
   * 2026-10-11 当前 Web bundle 中 module 18839.vq 对应：
   * DELETE /tasks?delete_files=<bool>&task_ids=<id>...
   *
   * Route B 的公网 URL 是一次性的；如果 CLI 已决定关闭 Tunnel，而 task 又没有成功，
   * 保留一个指向失效 URL 的 RUNNING task 没有恢复价值，因此 cloud-pull 的失败路径会
   * 用 deleteFiles=true 清理 task 与关联的未完成文件。
   */
  async deleteTasks(taskIds, { deleteFiles = true } = {}) {
    const ids = Array.from(new Set((taskIds || []).filter(Boolean)));
    if (ids.length === 0) return;

    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      if(typeof fileApi?.vq!=='function'){
        return {ok:false,error:'fileApi.vq missing'};
      }
      await fileApi.vq(${JSON.stringify(ids)},${deleteFiles ? 'true' : 'false'});
      return {ok:true};
    })()`;

    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = unwrapEvaluation(evaluation);
    if (!result?.ok) {
      throw new Error(`PikPak 删除 task 失败: ${result?.error || 'unknown'}`);
    }
  }

  /**
   * 等待 PikPak 服务端把 OSS 对象检入为完成。
   *
   * 注意：OSS multipartUpload 成功只代表“数据已经到对象存储”，不代表 PikPak 元数据一定
   * 已经同步完成。2026-08-29/30 观察到过：1 MiB 在 15 秒内保持 PENDING，Node 原生
   * 8 MiB 上传后 check-in 约 61 秒才 COMPLETE。因此这里默认给 180 秒，而不是把
   * progress=0 立即当作上传失败。
   */
  async waitTaskComplete(
    taskId,
    { timeoutMs = 180_000, intervalMs = 500 } = {},
  ) {
    const started = Date.now();
    let polls = 0;
    let last = null;

    while (Date.now() - started <= timeoutMs) {
      polls += 1;
      last = await this.getTaskStatus(taskId);

      if (Number(last?.progress) === 100 || last?.phase === 'PHASE_TYPE_COMPLETE') {
        return {
          ...last,
          allDone: true,
          polls,
          elapsedMs: Date.now() - started,
        };
      }

      // 某些未来错误 phase 可能需要更精细枚举；现阶段只要服务端明确给 error，就提前退出。
      if (last?.error) {
        return {
          ...last,
          allDone: false,
          polls,
          elapsedMs: Date.now() - started,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ...(last || {}),
      allDone: false,
      timeout: true,
      polls,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * 把指定 file 移入 PikPak 回收站。
   * 只应清理本工具自己创建的失败任务/探针文件；不要把它作为通用删除接口滥用。
   */
  async trashFile(fileId) {
    if (!fileId) return;

    const expression = `(async()=>{
      ${webpackBootstrapExpression()}
      const fileApi=__ppReq(${WEBPACK_MODULES.fileAndTaskApi});
      try{
        // 2026-10-11 当前 bundle 映射：
        //   Cw -> /files:batchTrash   （移入回收站）
        //   VK -> /files:batchDelete  （永久删除）
        // 这里必须使用 Cw；--trash-after-success 的语义绝不能悄悄退化成永久删除。
        if(typeof fileApi?.Cw!=='function'){
          return {ok:false,error:'fileApi.Cw missing'};
        }
        await fileApi.Cw([${JSON.stringify(fileId)}]);
        return {ok:true};
      }catch(error){
        return {ok:false,error:String(error?.message||error)};
      }
    })()`;

    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    const result = unwrapEvaluation(evaluation);
    if (!result?.ok) {
      throw new Error(`清理 PikPak 测试文件失败: ${result?.error || 'unknown error'}`);
    }
  }

  async close() {
    this.cdp.close();
    if (this.browserLease) await this.browserLease.release();
  }
}
