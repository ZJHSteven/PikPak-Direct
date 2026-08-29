# PikPak-Direct 执行计划

## 项目目标

把本轮已经验证成功的 PikPak 官方上传链路沉淀成长期可维护项目，最终提供一个安全、可复现、可自动化的 Direct Upload / Cold Archive 工具链。

核心目标：

1. 保持 PikPak 登录、地区判断、任务创建等控制面按现有 Mihomo Rule 走代理。
2. 将 TB 级上传正文从 PikPak 自定义 OSS CNAME 改写为对应阿里云原生 OSS endpoint，使正文命中现有 `aliyuncs.com -> DIRECT` 路由。
3. 绝不通过切换 Mihomo 全局 mode 做网络测试；所有网络实验必须限定到单进程、单域名或上传器内部 endpoint 改写。
4. 所有账号 token、Cookie、STS AccessKey/Secret/SecurityToken 仅在运行时内存中使用，不写日志、不写 fixture、不提交 Git。
5. 正式迁移采用“上传 -> PikPak task check-in -> 校验 -> 观察期 -> 用户明确允许后才删除本地”的安全流程。

## 已有实验证据

- PikPak Web 官方上传会先通过 `api-drive.<domain>/drive/v1/files` 创建 `UPLOAD_TYPE_RESUMABLE` 任务。
- 当前账号返回 `provider = PROVIDER_ALIYUN`。
- 当前返回自定义数据面 endpoint：`upload-a10b.mypikpak.com`。
- 当前 bucket：`vip-lixian-07`。
- 前端懒加载 `aliYunOssAdapter`，使用 Aliyun OSS multipart upload。
- `*.mypikpak.com` 在中国大陆真实 DIRECT 链路上出现 TCP 建立后 HTTP/TLS reset；`dav.pikpak.ai` 真实 DIRECT 正常。
- 同一组 OSS IP 使用标准 `vip-lixian-07.oss-ap-southeast-1.aliyuncs.com` 时真实 DIRECT TLS 正常。
- 将上传器 endpoint 改写为 `oss-ap-southeast-1.aliyuncs.com`、`cname=false` 后，8 MiB 与 32 MiB 官方 multipart 上传均成功。
- 上传完成后 PikPak task 轮询达到 `progress=100`、`phase=PHASE_TYPE_COMPLETE`，证明完整闭环成立。
- 32 MiB A/B：原自定义 endpoint 经代理约 14.45 Mbps；标准 OSS endpoint 经 DIRECT 约 27.72 Mbps。该数值仅视为当次样本，不视为固定带宽。

## 阶段 1：项目骨架与实验固化（本轮）

- [ ] 建立项目级 `AGENTS.md`，写入网络安全边界与凭据规范。
- [ ] 建立 `PROGRESS.md`。
- [ ] 建立 `README.md`，解释项目用途、架构和当前状态。
- [ ] 建立 `docs/architecture.md`。
- [ ] 建立 `docs/experiments/2026-08-29-direct-upload.md`，记录本轮完整实验。
- [ ] 把 `_scratch` 中有价值的上传探针整理成项目内可复现工具，去除硬编码与敏感输出。
- [ ] 建立最小测试，覆盖 endpoint 解析/改写逻辑。
- [ ] 运行语法与单元测试。

## 阶段 2：正式 CLI MVP

- [ ] CLI 接受本地文件/目录。
- [ ] 使用受控浏览器登录态或未来官方登录方式获取控制面认证。
- [ ] 创建 PikPak resumable upload task。
- [ ] 根据 `provider`、bucket、server endpoint 动态推导原生 OSS endpoint。
- [ ] multipart 上传正文。
- [ ] 轮询 PikPak task 至 complete / error / timeout。
- [ ] 输出 manifest：本地 path、size、mtime、远端 file id、task id、完成状态；不记录任何 secret。
- [ ] 支持 pause/resume/checkpoint。

## 阶段 3：冷仓迁移器

- [ ] 扫描 D 盘候选并分类：可直接冷迁移 / 需备份后迁移 / 不建议动 / 缓存可删。
- [ ] 支持 `90_待删除观察区`。
- [ ] 上传后做文件数、size、抽样读取/可用 hash 的校验。
- [ ] 默认永不删除本地；只有显式 destructive flag + 校验完成才允许删除。
- [ ] 生成可审计迁移日志和恢复清单。

## 阶段 4：长期兼容与回退

- [ ] provider 不再是 Aliyun 时自动拒绝 endpoint 改写并回退安全路径。
- [ ] bucket region 无法确定时禁止猜测。
- [ ] 标准 OSS endpoint 失败时回退 server endpoint，但明确提示可能消耗代理流量。
- [ ] 建立小文件 smoke test，检测 PikPak 前端/API 变更。
- [ ] 记录 WebDAV、CLI、Cloud Download、R2/B2 中转作为备选路径。

## 明确不做

- 不修改 Mihomo 全局 `mode` 进行测试。
- 不把 PikPak 整站做区域反代。
- 不把 access token、Cookie、WebDAV password、STS Secret 写入仓库。
- 不把当前实验观察误写成 PikPak 官方稳定 API 承诺。
- 不在未经校验和用户明确授权时删除本地源文件。
