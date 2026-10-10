// Route A 浏览器生命周期的离线单元测试。
// 真实 Chrome/CDP 登录另做 smoke；这里专门把“分类与 secret 表达式”这些容易回归的纯逻辑钉住。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PIKPAK_MANAGED_WINDOW_NAME,
  buildEmailLoginExpression,
  classifyPikPakAuthSnapshot,
  isIgnorableBrowserPageUrl,
  parseLocalCdpUrl,
} from '../src/pikpak-browser-lifecycle.mjs';

test('只允许 loopback http CDP 进入自动启动路径', () => {
  assert.deepEqual(parseLocalCdpUrl('http://127.0.0.1:9222'), { host: '127.0.0.1', port: 9222 });
  assert.deepEqual(parseLocalCdpUrl('http://localhost:9333'), { host: 'localhost', port: 9333 });
  assert.equal(parseLocalCdpUrl('https://127.0.0.1:9222'), null);
  assert.equal(parseLocalCdpUrl('http://192.168.1.10:9222'), null);
});

test('登录状态分类优先识别人机验证与认证失败', () => {
  assert.equal(classifyPikPakAuthSnapshot({ href: 'https://mypikpak.com/drive/all' }), 'logged-in');
  assert.equal(classifyPikPakAuthSnapshot({ href: 'https://mypikpak.com/drive/login?redirect=/all' }), 'login-required');
  assert.equal(classifyPikPakAuthSnapshot({ href: 'https://mypikpak.com/drive/login', captcha: true }), 'captcha-required');
  assert.equal(classifyPikPakAuthSnapshot({ href: 'https://mypikpak.com/drive/login', authError: true }), 'auth-failed');
});

test('邮箱登录表达式正确转义测试凭据且不把密码写进返回对象', () => {
  const expression = buildEmailLoginExpression('demo+\"x@example.com', 'p\\ass\"word');
  assert.match(expression, /demo\+/);
  assert.match(expression, /login-button-missing/);
  assert.doesNotMatch(expression, /passwordLen|password:/);
});

test('受管 tab marker 稳定且有项目命名空间', () => {
  assert.match(PIKPAK_MANAGED_WINDOW_NAME, /^pikpak-direct:/);
});

test('浏览器级 idle-close 只把真正空白页视为可忽略，不会误关普通页面', () => {
  assert.equal(isIgnorableBrowserPageUrl('about:blank'), true);
  assert.equal(isIgnorableBrowserPageUrl('chrome://newtab/'), true);
  assert.equal(isIgnorableBrowserPageUrl('chrome://new-tab-page/'), true);
  assert.equal(isIgnorableBrowserPageUrl('https://mypikpak.com/drive/all'), false);
  assert.equal(isIgnorableBrowserPageUrl('https://example.com/'), false);
});
