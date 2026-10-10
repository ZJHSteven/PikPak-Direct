# 项目状态快照

## 2026-10-11 Route A/B 收尾已认领

- Live Ops 已新增两个独立子项：Route A“Chrome 生命周期与自动登录”、Route B“Cloud Download 无网页 fallback”，均置为 doing。
- Route A 当前已做独立登录页实测：全新 9333 临时 Chrome 访问 /drive 会跳到 /drive/login?redirect=/all；默认可见 Google/Facebook/Apple 登录，底部有手机/邮箱/二维码入口；点击邮箱后出现“请输入邮箱”“请输入密码”和“登录”按钮。
- DevSpace Secrets 已确认存在 pikpak_account / pikpak_password 两个 key；后续只允许通过运行时 Secret 注入，不把明文读入源码、日志或文档。
- 真正提交账号密码的自动化探针被当前主机安全层拦截一次，因此没有为了“测通”而回读明文 secret 或绕开拦截；登录 DOM/入口机制本身已经确认。
- Route A 下一步实现受管 Browser/Tab Lease：默认复用 9222 日常 Chrome；受管 tab 用 ownership 标记 + 跨进程 refcount 共享，防止并发任务重复开 tab 或互相关页；最后一个 lease 退出时才关闭本工具创建的 tab。
- Route B 不是从零开始：2026-09-19 的 1 MiB 反向拉取 E2E 已有真实证据；当前缺口是把“手工 Quick Tunnel + Web 提交 URL”做成 cloud-pull CLI，并尽量直接复用 Web/API 控制面而非黑盒官方 CLI。

## 2026-10-10 手机冷备实战：P30 Route A 已重新验证，发现并修复空文件边界

- 现有 P30 备份 D:\\PhoneBackups\\Huawei_P30_VOG-AL00_2026-09-20 已实测进入冷迁移流程：18 个文件、28.76 GiB，dry-run manifest 正常生成。
- 当前 CDP Chrome 已打开并保持 PikPak Drive 登录态；真实迁移中 _test_sounds.tar、calendar_events.txt 已通过 Route A 完成 Aliyun OSS DIRECT 上传并达到 PikPak COMPLETE，证明 2026-10-10 这条主链仍然可用。
- 第三个文件 calllog.txt 为 0 字节，旧逻辑仍尝试创建 resumable task，PikPak 返回 unknown create error 并中止整次迁移。
- 修复策略：0 字节文件不再创建远端数据对象，而是计算标准空文件 SHA-1 后在 manifest 中写成 storageMode=manifest-only-empty、status=complete；portable manifest 同步携带该字段，恢复端可按路径/mtime/size 无歧义重建空文件。
- 该处理不会删除或忽略空文件语义，只是避免为“没有正文的数据”强行制造 PikPak upload task。
- 自动化测试已更新为 45/45 全绿。
- 随后实战重跑又发现第二个断点恢复问题：只传同一 backup-id 时，旧实现没有自动发现默认 manifests/<backup-id>.json，而是重新创建并覆盖 manifest，导致已完成状态丢失并开始重复上传。
- 已确定修复方向：prepareMigration 在未显式传 manifestPath 时，若 backup-id 对应的默认 manifest 已存在，则直接加载并标记 resumed；仅在不存在时创建新快照。
- 自动 resume 测试已补齐，完整测试套件 46/46 全绿。
- 下一步：提交断点恢复修复，然后继续 P30 迁移。

## 2026-09-28 恢复记录：目录冷迁移已落地，PikPak Web bootstrap 回归修复中

- 已新增可恢复冷迁移基础设施：目录递归、稳定远端命名、持久 JSON manifest、源文件 size/mtime 变化保护、SHA-1 映射、便携恢复 manifest、Aliyun multipart checkpoint 持久化接口。
- CLI 已新增 `migrate`、`inspect-manifest`、`verify-local`；`migrate --dry-run -> inspect-manifest -> verify-local` 已用 `C:\\Temp` 两文件目录做整链离线 smoke，实际通过。
- 当前自动化测试在 bootstrap 修复前为 39/39 通过；本轮新增 PikPak Web bootstrap 回归测试，专门覆盖陈旧 `__ppWebpackRequire`、多个 webpack runtime 与 probe chunk id 冲突。
- 2026-09-28 真实 1 MiB Direct smoke 尚未产生 OSS 数据上传：第一次因没有已打开 PikPak Drive 标签页安全退出；打开 Drive 页后第二次在创建 resumable task 前因 `__ppReq is not a function` 退出。
- 实机只读探针确认当前 PikPak Web 仍只有 `webpackChunkpikpak_web` 主 runtime；module `99289` 与 `18839` 仍存在，导出分别仍包含 `D` 与 `kd`。因此当前问题是 bootstrap 捕获脆弱，而不是已验证的 create/task 模块消失。
- bootstrap 修复策略：只有 `typeof require === 'function'` 且同时含 99289/18839 才接受；使用每次唯一 probe chunk id；存在多个 webpack chunk global 时逐个捕获并按目标 module id 验证。
- bootstrap 修复完成后自动化测试为 **43/43 通过**。
- 2026-09-28 真实 1 MiB Direct smoke 已再次成功：`PROVIDER_ALIYUN`、server endpoint `upload-a10b.mypikpak.com`、bucket `vip-lixian-07`；多家 DoH 共识识别 `ap-southeast-1`；实际数据面 endpoint 为 `oss-ap-southeast-1.aliyuncs.com`，route=`direct`。
- 本次 1 MiB smoke 的 OSS 阶段约 **4.9 s**，PikPak check-in 约 **1.1 s** 即达到 `progress=100 / PHASE_TYPE_COMPLETE`；`--trash-after-success` 成功把测试文件移入 PikPak 回收站。
- 因此 2026-09-28 当前结论是：Direct OSS 数据面仍可用，当前回归故障已确认并修复为 Web webpack runtime 捕获问题，而不是 PikPak 上传协议/module ID 失效。

## 当前结论（必须最新）

- 现状：阶段 1“项目骨架与实验固化”已完成；阶段 2“正式 CLI MVP”已有 Aliyun OSS 单文件直传；阶段 6“Cloud Download 反向拉取”已完成真实端到端 PoC，正在从手工 PoC 固化为可自动化工具。
- 已完成：README/架构/实验记录、Web 官方上传探针、Node 本地文件 CLI、Aliyun endpoint 规范化、多 DoH region 自动发现、STS 默认脱敏，以及 Cloud Download 用的受控 localhost 单文件 HTTP 源站。
- 已验证：`node bin/pikpak-direct.mjs upload <file>` 可从真实本地路径读取文件，自动发现 `ap-southeast-1`，正文走原生 Aliyun OSS endpoint，PikPak 最终 `PHASE_TYPE_COMPLETE`；8 MiB smoke test 已两次成功并清理远端测试文件。
- 已验证（2026-09-19）：1 MiB 随机文件通过 `127.0.0.1 HTTP -> Cloudflare Quick Tunnel -> PikPak Web Cloud Download -> My Pack` 成功保存；源站实际收到 4 次远端 GET，证明正文由 PikPak/Cloudflare 方向主动回拉。测试文件、Quick Tunnel 与临时 HTTP 服务均已清理。
- 正在做：把 Cloud Download PoC 从“网页手工提交 URL”推进到可恢复的一键工具；并继续补 manifest、目录/归档、加密和增量快照设计。
- 下一步：先完成 Quick Tunnel 生命周期与 PikPak Web Cloud Download 控制面的安全自动化；随后加入持久 manifest/SQLite 索引，再做目录流式归档与分块加密。
- 本轮最终自检：28/28 单元测试通过；Git working tree clean；Cloud Download smoke 远端测试文件已删除；Quick Tunnel/临时 HTTP 已停止；`P:` 不存在且无 rclone 常驻挂载。
- 当前可用命令：`node bin/pikpak-direct.mjs upload "<local-file>"`，默认 direct-only + CNAME/DoH 自动 region 发现；真实 8MiB smoke test 已验证。
- Cloud Download 源站模块：`src/temporary-file-server.mjs` 已实现 loopback-only、256 bit 随机 URL、GET/HEAD/单段 Range、无目录列表和实际发送字节统计；对应测试全绿。
- Windows WebDAV 挂载：2026-09-19 已按用户决定停用。停用前确认 VFS cache 为 0 个对象、0 B、待上传 0；随后停止 rclone、禁用 `PikPak Mount` 登录计划任务并确认 `P:` 消失。配置保留但不再自启。
- 2026-09-18 挂载回归：`P:` 可列目录；测试文件可写入并立即读回；VFS 成功写回；直接 `rclone lsf PikPak:__network_test__` 可在远端看到测试文件；删除后本地消失；最终 `TERMINAL_COUNT=0`。

## 关键决策与理由（防止“吃书”）

- 决策A：禁止任何测试切换 Mihomo 全局 `mode`。原因：Mihomo TUN 是整机网络底座，切全局 DIRECT 会破坏其他项目、Cloudflare Tunnel、浏览器与代理依赖链路。
- 决策B：采用“控制面代理、数据面 DIRECT”。原因：PikPak 官方 Web 上传通过 PikPak API 创建任务，但正文实际使用 Aliyun OSS multipart，可把自定义 PikPak OSS CNAME 改写为原生 Aliyun OSS endpoint。
- 决策C：当前 Aliyun endpoint 改写视为兼容技巧，不视为官方稳定 API。原因：PikPak 未来可能换 provider、region、bucket 或签名方式。
- 决策D：正式冷迁移默认只上传和校验，不删除本地。原因：冷仓迁移属于高风险数据操作，删除必须在校验完成后另行显式授权。
- 决策E：region 默认通过多家 DoH 的 CNAME 共识自动发现，而不是硬编码新加坡。当前 CNAME 形如 `bucket.region.thepacificphs.com`，至少两家一致且 bucket 匹配才接受。
- 决策F：STS 换证尚未验证前，不宣称支持任意 TB 单文件。当前 task STS 约 12h；相同 fileId 立即 recreate 返回同一 task/key/expiration。
- 决策G：Cloud Download 新路线优先复用 PikPak 官方 Web 控制面，而不是把官方 CLI 作为默认依赖。原因：CLI/WebDAV/Rclone 都属于 Connected Apps，合计受月度 Transfer Quota 的 25% 子限额；Web 属于官方应用，不受该 Connected Apps 子限额。
- 决策H：临时公网源站必须是“loopback 单文件源站 + 临时 Tunnel”，不能把整个目录、局域网服务或管理端口直接暴露公网。

## 已验证实验摘要

- 当前 Web 官方上传 provider：`PROVIDER_ALIYUN`。
- 当前 server endpoint：`upload-a10b.mypikpak.com`。
- 当前 bucket：`vip-lixian-07`。
- 原生 OSS 新加坡 endpoint 可真实 DIRECT 访问。
- endpoint 改写后 8 MiB / 32 MiB multipart upload 成功。
- PikPak task 最终达到 `progress=100`、`PHASE_TYPE_COMPLETE`。
- 32 MiB 当次样本：代理原 endpoint 约 14.45 Mbps；DIRECT 原生 OSS endpoint 约 27.72 Mbps。
- Node 原生 `ali-oss` 8 MiB：OSS 阶段约 4.1~4.5 秒；PikPak check-in 曾分别约 20.6 秒与 61 秒，说明元数据检入存在明显最终一致性延迟。
- Web 前端明确限制桌面 >20GiB、移动 >4GiB；后端 create-task 实测接受 21GiB 与 100GiB 声明任务，因此 20GiB 至少不是当前 create-task 后端硬限制。
- 当前 21/100GiB task 下发 STS expiration 约为创建后 12 小时。
- Cloud Download 反向拉取 1 MiB smoke：公网 HEAD 正常；PikPak 创建任务后本地源站收到 4 次完整 GET；最终文件出现在 `My Pack/smoke-1m.bin`；测试结束后删除并复查不存在。完整记录见 `docs/experiments/2026-09-19-cloud-download-reverse-pull.md`。

## 常见坑 / 复现方法

- 坑1：不要 reload 保存于磁盘的完整 Clash/Mihomo 配置来做局部实验。曾发现配置文件中的 `mode` 与当前 runtime mode 不一致，reload 会意外改变全局网络行为。
- 坑2：系统处于 Fake-IP + TUN 时，单纯 `curl --interface WLAN` 仍可能拿到 198.18.x.x Fake-IP；做真实旁路测试必须同时使用真实 DNS 结果和 `--resolve`。
- 坑3：`upload-a10b.mypikpak.com` 与其后端 Aliyun OSS 可能落到相同 IP，但前者在大陆 DIRECT 下会 reset，原生 `*.aliyuncs.com` SNI/Host 则可正常 TLS。
- 坑4：所有日志/fixture 禁止保存 access token、Cookie、WebDAV password、STS access key secret/security token。
- 坑5：OSS multipart 完成不等于 PikPak task 立即 COMPLETE；曾出现约 61 秒 check-in 延迟。timeout 时必须保留 fileId/taskId 后续检查，不能自动误删。
- 坑6：Aliyun SDK 会提示配置 `refreshSTSToken`。当前 PikPak Web adapter 本身没有传 refresh callback；大文件换证仍是待验证能力。
- 坑7：在 Windows Terminal 被设为默认终端宿主时，计划任务直接启动 `rclone.exe` 即使附加 `--no-console`，仍可能产生常驻空白 Terminal 窗口；而直接结束该 Terminal 还可能把同控制台生命周期内的挂载一起带掉。当前使用 GUI 子系统的 `wscript.exe` 作为隐藏启动器，并让 VBS 等待 rclone 退出，以兼顾“无黑框”和计划任务 Running 状态。
- 坑8：旧版 Windows Script Host 对无 BOM 的 UTF-8 VBS 源文件兼容差，中文注释可能触发 VBScript 解析错误。`bin/mount-pikpak-hidden.vbs` 因此保持 ASCII-only，详细中文说明保留在本状态文档与执行计划中。
- 坑9：简单 HTTP 源站在 1 MiB Cloud Download smoke 中观察到 4 次完整 GET；在大文件前必须用正式源站记录 Range/累计发送量，否则重复完整拉取可能放大本机上行流量。
- 坑10：Cloudflare Quick Tunnel 的自动生命周期封装尚未落盘；当前只把“手工启动 cloudflared + Web 页面提交 URL”的 PoC 视为已验证，不把它写成“一键 CLI 已完成”。
