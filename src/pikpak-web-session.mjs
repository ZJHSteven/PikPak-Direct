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
function webpackBootstrapExpression() {
  return `
    const __ppChunkKey=Object.keys(window).find(k=>k.startsWith('webpackChunk'));
    if(!__ppChunkKey) throw new Error('PikPak webpack chunk global not found');
    if(!window.__ppWebpackRequire){
      window[__ppChunkKey].push([[987654321],{},r=>window.__ppWebpackRequire=r]);
    }
    const __ppReq=window.__ppWebpackRequire;
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

export class PikPakWebSession {
  constructor(cdp, target) {
    this.cdp = cdp;
    this.target = target;
  }

  /**
   * 连接已登录 PikPak Web 页面。
   *
   * @param {{cdpUrl?: string}} options
   */
  static async connect({ cdpUrl = DEFAULT_CDP_URL } = {}) {
    const target = await findPikPakTarget(cdpUrl);
    if (!target) {
      throw new Error('没有找到已打开的 PikPak Drive 标签页。请先在当前 CDP Chrome 中登录 PikPak。');
    }

    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    return new PikPakWebSession(cdp, target);
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
        message:task?.message??null
      };
    })()`;

    const evaluation = await this.cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    return unwrapEvaluation(evaluation);
  }

  /**
   * 等待 PikPak 服务端把 OSS 对象检入为完成。
   *
   * 注意：OSS multipartUpload 成功只代表“数据已经到对象存储”，不代表 PikPak 元数据一定
   * 已经同步完成。2026-08-29 还观察到过 1 MiB 文件在 15 秒内保持 PENDING，因此这里默认
   * 给 60 秒，而不是把 progress=0 立即当作上传失败。
   */
  async waitTaskComplete(
    taskId,
    { timeoutMs = 60_000, intervalMs = 500 } = {},
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
        await fileApi.VK([${JSON.stringify(fileId)}]);
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

  close() {
    this.cdp.close();
  }
}
