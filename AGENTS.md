# PikPak-Direct 项目规则

## 项目定位

本项目用于研究并实现 PikPak 的低代理流量上传、Direct Upload、冷仓迁移与相关网络/协议实验。

## 网络安全硬规则

1. **禁止切换 Mihomo/Clash 全局 mode。** 不得为了 A/B 测试把整机从 `rule` 切成 `direct`、`global` 或其他模式。
2. Mihomo TUN 视为整机网络底座。任何测试必须把影响限制在：
   - 单个测试进程；或
   - 单个精确域名；或
   - 上传器内部 endpoint 改写；或
   - 独立网络 namespace / 独立代理实例（如未来有）。
3. 不允许 reload 一份完整 Mihomo 配置仅为了插入临时规则。磁盘配置的 `mode` 可能与 runtime mode 不一致，完整 reload 有全局副作用。
4. 如需真实 DIRECT 探针，优先使用：
   - `curl --interface <物理网卡IP>`；
   - 使用独立 DoH 获取真实 A/AAAA；
   - `curl --resolve host:443:real_ip`；
   从而同时绕过 TUN Fake-IP 与代理规则。
5. 每次网络实验结束都必须验证 Mihomo runtime 仍为 `rule`，且不得改变用户当前代理组选择。

## 凭据与隐私

以下内容绝不写入源码、测试 fixture、日志、README、Issue 或 Git 历史：

- PikPak access token / refresh token；
- Cookie；
- WebDAV 用户名/密码；
- user_id；
- STS `access_key_id` / `access_key_secret` / `security_token`；
- captcha token；
- 任何真实授权 header。

调试输出必须只保留：是否存在、长度、endpoint、bucket、key 的非敏感结构信息；若 key 可能形成用户关联，也应在正式日志中脱敏。

## 上传链路原则

1. 控制面：PikPak Web/API，可按用户现有 Mihomo 规则走代理。
2. 数据面：若 provider 为 Aliyun，并能可靠推导 region，则优先把 PikPak 自定义 OSS CNAME 改为原生 Aliyun OSS endpoint，使正文走 DIRECT。
3. 不得永久硬编码 `oss-ap-southeast-1`。必须通过响应、endpoint/IP、bucket/region 证据动态确定；无法确定时安全失败或回退。
4. provider 不是 `PROVIDER_ALIYUN` 时，不得套用 Aliyun endpoint 改写。
5. 回退到 PikPak 自定义 endpoint 时必须明确提示该路径可能消耗代理流量。

## 数据安全

1. 默认只做 copy/upload，不做 move/delete。
2. 冷迁移必须遵循：上传 -> task complete -> 校验 -> 记录 manifest -> 观察期 -> 显式授权后删除。
3. `pagefile.sys`、活跃 Workspace、运行中 AppData/WSL 等不得因为“体积大”自动进入迁移队列。
4. 唯一不可替代资料不能只保留 PikPak 单副本。

## 开发流程

1. 复杂任务先更新 `PLANS.md`。
2. 每轮开发都维护 `PROGRESS.md`，保持当前结论、已完成、正在做、下一步和常见坑为最新状态。
3. 所有代码必须有详细中文教学注释，特别解释协议、认证、endpoint 改写、回退和危险边界。
4. 模块保持少而完整：不要为了抽象把一行逻辑拆成多个文件。
5. 每次修改后运行对应语法测试/单元测试；网络集成测试默认使用小文件并清理测试任务。
6. 实验结论必须写入 `docs/experiments/`，并明确区分“本机实测观察”与“官方保证”。
7. Git 提交使用 Conventional Commits，中文说明优先。

## 当前禁止事项

- 禁止修改 Mihomo 全局 mode。
- 禁止把 PikPak 整站通过 Worker 做区域规避反代作为本项目默认方案。
- 禁止提交任何真实 secret。
- 禁止未经校验删除本地源文件。
