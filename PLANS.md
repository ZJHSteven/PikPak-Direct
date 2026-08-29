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

## 阶段 1：项目骨架与实验固化（已完成）

- [x] 建立项目级 `AGENTS.md`，写入网络安全边界与凭据规范。
- [x] 建立 `PROGRESS.md`。
- [x] 建立 `README.md`，解释项目用途、架构和当前状态。
- [x] 建立 `docs/architecture.md`。
- [x] 建立 `docs/experiments/2026-08-29-direct-upload.md`，记录 WebDAV、Web OSS、Node OSS、region 与大文件实验。
- [x] 把 `_scratch` 中有价值的上传探针整理成项目内 `tools/web-upload-probe.mjs`，去除敏感输出。
- [x] 建立 endpoint、region discovery、part size、STS 脱敏等单元测试。
- [x] 运行语法与单元测试；当前 24 tests 全绿。
- [x] 真实运行 Node CLI 8 MiB 本地文件，Direct OSS + PikPak check-in 完整成功并清理测试文件。

## 阶段 2：正式 CLI MVP（进行中）

- [x] CLI 接受单个本地文件；目录递归尚未实现。
- [x] 使用受控浏览器登录态获取控制面认证，STS 只保留在 Node 内存并默认脱敏。
- [x] 创建 PikPak resumable upload task。
- [x] 根据 provider、bucket、CNAME 多 DoH 共识动态推导原生 OSS region/endpoint；`--region` 保留人工 override。
- [x] Node `ali-oss` multipart 上传真实本地文件路径。
- [x] 轮询 PikPak task 至 complete / error / timeout，默认等待 180 秒；timeout 不误删任务。
- [x] CLI 输出不含 secret 的本地 path、size、SHA-1、远端 file id、task id、endpoint、完成状态。
- [ ] 把结果写成持久 manifest 文件，并设计可恢复状态目录。
- [ ] 支持目录递归、远端目录创建与冲突策略。
- [ ] 支持持久 checkpoint / pause / resume。
- [ ] 研究并验证 STS 换证：当前 STS 约 12h；相同 fileId 立即 recreate 不刷新 expiration；需验证临近/超过 expiry 后行为或寻找专门刷新 API。
- [ ] 在 STS 换证完成前，对预计传输时长可能超过 token TTL 的单文件给出安全预警/拒绝策略。

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
