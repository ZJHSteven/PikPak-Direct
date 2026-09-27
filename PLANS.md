# PikPak-Direct 执行计划

## 2026-09-27：冷迁移 Manifest / 目录迁移落地计划

本轮把项目从“单文件上传器”推进为真正可恢复的冷迁移工具。实现时坚持一个核心原则：
**云端文件即使脱离本机目录结构，也必须能够仅凭 manifest 无歧义地恢复到原路径。**

- [ ] 新增原子写入的 JSON manifest：记录 schema、backup id、源根目录、创建时间、路由策略与每个文件的相对路径、大小、mtime、SHA-1、远端名、fileId/taskId、上传状态和错误。
- [ ] 新增 `migrate <file-or-directory>`：目录递归枚举、稳定排序、逐文件上传；默认永不删除本地源文件。
- [ ] 远端对象名采用 `backup-id + 稳定序号 + basename`，真实层级完全保存在 manifest，避免同名冲突，也避免依赖 PikPak 当前内部的建目录 API。
- [ ] 迁移中每个状态变化都原子落盘；中断后重新运行同一 manifest 时，已完成且本地元数据未变化的文件直接跳过。
- [ ] 持久化 Aliyun multipart checkpoint；明确标注其受 PikPak STS 有效期限制，过期不得伪装成可无缝续传。
- [ ] 迁移完成后生成一份可携带的 manifest 副本；支持把 manifest 本身作为最后一个对象上传到同一 parent-id。
- [ ] 新增 `inspect-manifest` / `verify-local`，让恢复前可以确认源文件变化、远端映射和完成度。
- [ ] 第一版加密字段固定为 `encryption: none`。在没有完成真正流式加密前，不提供会产生整文件临时密文副本的“伪加密迁移”。后续优先结合 Cloud Download 临时 HTTP 源实现流式 AEAD/分块加密。
- [ ] 为 manifest、目录枚举、断点恢复、冲突/源文件变化等边界补单元测试，并跑完整测试套件。


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

## 阶段 5：Windows WebDAV 挂载维护

- [x] 保留 `P:` = PikPak WebDAV 的登录自动挂载能力。
- [x] 将计划任务从“直接启动控制台版 rclone”改为 `wscript.exe` 隐藏启动器，避免 Windows Terminal 黑框常驻。
- [x] 重启挂载后验证：`P:` 可列目录、VFS 写回成功、远端可见、测试文件可删除。
- [x] 验证不存在 Windows Terminal 时 rclone 与 `P:` 仍独立存活。
- [x] 2026-09-19 按用户决定停用该实验性挂载：确认 VFS 缓存无待上传数据后停止 rclone，并禁用 `PikPak Mount` 登录计划任务；配置文件保留，便于未来需要时恢复。

## 阶段 6：Cloud Download 反向拉取 PoC（进行中）

目标：把“本机主动上传到 PikPak”改成“PikPak Cloud Download 主动从本机临时公网入口拉取”，验证能否同时绕开 PikPak 直传上行链路问题与普通 Upload 月配额瓶颈。

第一版严格限定为单文件 PoC：

- [ ] 在现有 `PikPakWebSession` 中增加 `UPLOAD_TYPE_URL` Cloud Download 创建接口，继续复用已登录 PikPak Web 控制面，不引入额外账号密码或长期 token。
- [x] 建立只监听 `127.0.0.1` 的临时 HTTP 文件服务；公网路径使用 256 bit 随机 token，不开放目录列表。
- [x] HTTP 服务支持 `GET`、`HEAD` 与单段 `Range`，并统计实际发送字节；离线单元测试已覆盖。
- [ ] 使用独立的 Cloudflare Quick Tunnel 暴露该临时 HTTP 服务；不修改现有命名 Tunnel、DNS、Mihomo 或全局网络配置。
- [ ] 新增 CLI 命令 `cloud-pull <local-file>`：启动 HTTP -> 启动 Tunnel -> 创建 PikPak Cloud Download -> 等待完成 -> 自动关闭 Tunnel/HTTP。
- [ ] 对失败/超时保留 PikPak task/file 标识并停止公网服务；不自动删除用户已有云端文件。
- [ ] 使用小文件完成一次真实端到端 smoke test，并在成功后清理本次测试文件。
- [ ] 把请求次数、实际向 PikPak/Cloudflare 发送的字节数与 task 状态写入脱敏结果，确认是否发生完整拉取、Range 重试或秒传。

已完成的手工 PoC 证据（尚不等于上面的一键 CLI 已完成）：

- [x] 2026-09-19 使用 1 MiB 随机文件，手工启动 localhost HTTP + Cloudflare Quick Tunnel，并在 PikPak 官方 Web 创建 Cloud Download。
- [x] 本地源站真实收到 4 次远端完整 GET，最终 `My Pack/smoke-1m.bin` 存在；随后测试文件与临时服务均清理。

第二版（PoC 成功后）：

- [ ] 支持目录先打包再 Cloud Download；先选择一种可流式、可恢复的归档格式，避免为了打包复制出第二份超大临时文件。
- [ ] 支持已有命名 Cloudflare Tunnel + 自有域名，仍保持“仅任务期间开放”的生命周期。
- [ ] 为 Cloud Download 建立持久 manifest / SQLite 索引，记录本地原路径、归档对象、PikPak file/task ID、hash、时间和恢复信息。
- [ ] 设计客户端加密层；优先评估分块/内容寻址方案，而不是把整个目录加密成单一巨型密文。
- [ ] 在加密层之上评估增量：chunk-level dedup / snapshot，而不是尝试对任意整体 AEAD 密文做原地 diff。

## 明确不做

- 不修改 Mihomo 全局 `mode` 进行测试。
- 不把 PikPak 整站做区域反代。
- 不把 access token、Cookie、WebDAV password、STS Secret 写入仓库。
- 不把当前实验观察误写成 PikPak 官方稳定 API 承诺。
- 不在未经校验和用户明确授权时删除本地源文件。
