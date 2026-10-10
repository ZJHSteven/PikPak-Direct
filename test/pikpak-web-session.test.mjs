// PikPak Web 控制面 bootstrap 的离线测试。
//
// 这里不连接真实浏览器，而是用 node:vm 模拟 webpackChunk*.push 的最小行为，专门覆盖
// 2026-09-28 实机回归暴露出来的“window.__ppWebpackRequire 已存在但不是 function”与
// “固定 probe chunk id 可能被 webpack 视为已加载”两类脆弱点。

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';

import {
  buildCloudDownloadBody,
  webpackBootstrapExpression,
} from '../src/pikpak-web-session.mjs';

function createWebpackRequire(moduleIds) {
  const requireFunction = (id) => ({ id });
  requireFunction.m = Object.fromEntries(moduleIds.map((id) => [id, () => {}]));
  return requireFunction;
}

function createChunkRuntime(requireFunction, onPush = () => {}) {
  const chunkArray = [];
  chunkArray.push = (payload) => {
    onPush(payload);
    const runtime = payload?.[2];
    if (typeof runtime === 'function') runtime(requireFunction);
    return 1;
  };
  return chunkArray;
}

function runBootstrap(windowObject) {
  const context = vm.createContext({
    window: windowObject,
    Date,
    Math,
  });
  return vm.runInContext(
    `(()=>{${webpackBootstrapExpression()} return typeof __ppReq;})()`,
    context,
  );
}

test('bootstrap 会替换 truthy 但非 function 的陈旧 require', () => {
  const validRequire = createWebpackRequire([99289, 18839]);
  const windowObject = {
    __ppWebpackRequire: { stale: true },
    webpackChunkpikpak_web: createChunkRuntime(validRequire),
  };

  assert.equal(runBootstrap(windowObject), 'function');
  assert.equal(windowObject.__ppWebpackRequire, validRequire);
});

test('bootstrap 在多个 webpack runtime 中只选择含目标模块的 runtime', () => {
  const wrongRequire = createWebpackRequire([1, 2, 3]);
  const validRequire = createWebpackRequire([99289, 18839]);
  const windowObject = {
    webpackChunkvendor: createChunkRuntime(wrongRequire),
    webpackChunkpikpak_web: createChunkRuntime(validRequire),
  };

  assert.equal(runBootstrap(windowObject), 'function');
  assert.equal(windowObject.__ppWebpackRequire, validRequire);
});

test('bootstrap 每次使用唯一 probe chunk id', () => {
  const validRequire = createWebpackRequire([99289, 18839]);
  const probeIds = [];
  const windowObject = {
    webpackChunkpikpak_web: createChunkRuntime(validRequire, (payload) => {
      probeIds.push(payload?.[0]?.[0]);
    }),
  };

  runBootstrap(windowObject);
  // 清掉缓存的 require，强制再次 probe；两次 id 不应相同。
  windowObject.__ppWebpackRequire = null;
  runBootstrap(windowObject);

  assert.equal(probeIds.length, 2);
  assert.notEqual(probeIds[0], probeIds[1]);
  assert.match(probeIds[0], /^pikpak-direct-/);
});

test('所有 runtime 都缺少目标模块时明确失败', () => {
  const wrongRequire = createWebpackRequire([1, 2, 3]);
  const windowObject = {
    webpackChunkpikpak_web: createChunkRuntime(wrongRequire),
  };

  assert.throws(
    () => runBootstrap(windowObject),
    /capture failed or expected modules are missing/,
  );
});

test('Cloud Download 请求体使用 UPLOAD_TYPE_URL 且根目录使用 DOWNLOAD folder_type', () => {
  assert.deepEqual(
    buildCloudDownloadBody({ url: 'https://example.test/file.bin' }),
    {
      kind: 'drive#file',
      folder_type: 'DOWNLOAD',
      upload_type: 'UPLOAD_TYPE_URL',
      url: { url: 'https://example.test/file.bin' },
      params: { with_thumbnail: 'true', from: 'manual' },
    },
  );
  const nested = buildCloudDownloadBody({
    url: 'https://example.test/a',
    parentId: 'folder-123',
  });
  assert.equal(nested.parent_id, 'folder-123');
  assert.equal('folder_type' in nested, false);
  assert.throws(
    () => buildCloudDownloadBody({ url: 'http://127.0.0.1/file' }),
    /必须是 HTTPS/,
  );
});

test('当前 Web bundle 的回收站与永久删除导出名必须保持区分', () => {
  // 这是对当前 2026-10-11 bundle 逆向得到的契约做一个显式回归锚点：
  // Cw = files:batchTrash；VK = files:batchDelete。
  // 真正运行时仍由 trashFile() 检查 Cw 是否存在；此测试避免后续维护者误把旧 VK 写回来。
  const source = PikPakWebSession.prototype.trashFile.toString();
  assert.match(source, /fileApi\.Cw/);
  assert.doesNotMatch(source, /fileApi\.VK/);
});

