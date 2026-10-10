# 项目状态快照

## 2026-10-11 Route A/B 收尾已认领

- 2026-10-11 用户进一步明确真实架构：9222 是长期共享的“Chrome CDP 日常用”，不是 PikPak-Direct 私有进程；Route A 现在已删除 Chrome spawn / Browser.close 设计，项目只拥有带 marker 的 PikPak tab。当前真实 9222 主进程与桌面/开始菜单快捷方式参数完全一致：同一 Chrome 可执行文件、`D:\AppData\Chrome\Chrome-CDP\User Data`、Default profile、9222、127.0.0.1、no-first-run/no-default-browser-check。
- Route B 架构也已纠偏：正式方案不再动态创建 Quick Tunnel。用户已有长期保存的 Cloudflare Tunnel + DNS routing，CLI 只需要让对应 origin 在任务期间上线/下线；Tunnel/DNS 映射本身保持不变。Quick Tunnel 代码降级为历史 PoC/诊断证据，不再作为大文件正式 fallback。
- Cloudflare 账号已只读核实：专用 Remote-managed Tunnel 名为 `PikPak-RouteB`，固定 ingress 为 `pikpak-pull.zjhstudio.com -> http://127.0.0.1:18765`，当前 connector 可按任务临时上线；DevSpace Secrets 已存在 `pikpak_routeb_tunnel_token`。正式实现用 child env `TUNNEL_TOKEN` 注入，不把 token 放进 cloudflared argv、源码或日志。
- cloud-pull 已切换为 Named Tunnel 模型：固定 18765 loopback origin + 临时 connector + 固定公网 hostname HEAD gate；不创建/删除 Tunnel，不改 DNS。并增加默认 4x 正文发送硬预算，超预算 GET 在发正文前拒绝，以限制此前实测 5.58x 的回拉放大。
- 本轮终点扩展为整个 PikPak CLI 收口：完成上述两项后继续实现客户端加密仓库、CDC/pack、snapshot/index 与 fresh-machine restore，不在 Route A/B 停止。
- 加密仓库 v1 已开始落地：新增随机 256-bit master key 的密码/recovery 双 key-slot 基础设施。Password slot 用 scrypt（默认约 128 MiB 工作集）派生 KEK；recovery slot 使用独立 256-bit recovery secret + HKDF；正文用途再以 repoId + context 做 HKDF 域隔离。AES-256-GCM 统一提供机密性与篡改检测。
- CDC 已落地为 `fastcdc-gear32-v1`：固定 seed 的 Gear hash + min/avg/max 双 mask，支持真正流式文件分块；局部插入后边界会重新同步，为 chunk-level 去重/增量提供稳定基础。
- repository v1 对象格式已落地：`repo.json` 只保存最小公开 header/key slots；pack 逐 chunk 压缩+AES-GCM，末尾加密 TOC；snapshot 将原始路径、文件名、mtime、whole-file hash 和 chunk 顺序整体加密。远端 pack 文件名只需要随机 packId，不暴露 chunk hash。
- pack index 不再依赖 SQLite：`rebuildPackIndex()` 只读每个 pack 的 header/footer/加密 TOC 即可恢复 `chunkId -> pack/offset`；单 pack TOC 损坏会被隔离进 errors，不阻塞其他 pack 扫描。
- 离线灾难恢复主流程已实现：backup 做 chunk-level 去重与不可变 snapshot；restore 可仅用 recovery key 重新扫描 pack/snapshot 并逐文件 hash 校验；verify-repo 可全量逐 chunk 解密/解压/SHA-256 体检。
- 加密仓库 CLI 接口开始接入现有 `pikpak-direct`：参数层已加入 `repo-init/repo-backup/repo-list/repo-restore/repo-verify`，并明确禁止把 password/recovery key 放进 argv；凭据只读 `PIKPAK_REPO_PASSWORD` / `PIKPAK_REPO_RECOVERY_KEY`。`repo-init` 强制要求独立的 `--recovery-key-out`，且 recovery 文件不能位于 repo-dir 内。下一提交补齐各命令执行函数与端到端 CLI smoke。
- 上述五个 repository 命令的执行层已接通：`repo-init` 先原子创建独立 recovery 文件、再提交 repo header，失败会清理孤儿 recovery 文件；backup/list/restore/verify 统一只从环境变量取凭据。CLI 输出只包含 repoId/snapshotId/统计与路径，不回显 password/recovery key。下一步进行独立 CLI 进程端到端 smoke。
- 真实 CLI 进程端到端 smoke 已通过：临时仓库初始化并把 recovery key 写到 repo 外；备份 2 个文件；随后删除 `PIKPAK_REPO_PASSWORD`，只从 recovery 文件读入 `PIKPAK_REPO_RECOVERY_KEY` 完成 snapshot 枚举、full verify、fresh restore，最后 PowerShell SHA-256 对比一致并输出 `CLI_SMOKE_OK`。测试目录已在 finally 清理。
- 继续反查 PikPak Web 远端目录能力时发现 Route A acquire 的一个共享 Chrome 性能/隔离问题：lease state 没有 targetId 时旧代码会逐个连接 9222 的所有普通 page target 读取 `window.name`，日常 Chrome 页面多时可能被某个异常 target 卡住。已收窄为“精确 preferred targetId + 其余仅 mypikpak.com/drive 页面”；普通日常网页不再建立 CDP WebSocket。
- 当前 Web bundle 的远端仓库所需 API 已完成实机定位：`18839.x3 -> POST /files` 可用 `kind=drive#folder` 创建文件夹；`18839.oc -> GET /files?...` 支持 parent_id/page_token 分页列目录；`18839.UV -> GET /files/{id}` 返回普通文件详情，正文链接在 `links['application/octet-stream'].url`。已把三项封装进 `PikPakWebSession`，下载签名 URL 用 private ticket 包装，默认 stringify/inspect 永不泄露 URL/token。
- 云同步前补齐 repository v1 header 完整性：`repo.json` 除 key-slot 自身 AEAD 外，现在还用 master-key HKDF 派生独立 header-auth key，以 AES-256-GCM 空明文 + canonical JSON AAD 认证全部公开 header 字段。这样存储侧修改 CDC/pack/算法/slot 元数据也会在解锁后立即报“header 认证失败”，不会静默接受被篡改配置。
- 远端同步层第一版已落地：默认仓库根 `PikPak-Direct Vault`；远端平铺为 `repo.json`、`pack-<随机id>.ppdp`、`snapshot-<随机id>.ppds`，不上传 latest.json，也不暴露用户原始文件名/路径/chunk hash。push 复用 Route A 的 Node->OSS 数据面；pull 用 private signed download ticket 原子下载。固定 repo.json 推送时强制下载远端副本逐字节核对，immutable pack/snapshot 同名但 size/status 冲突时直接失败，不覆盖猜测。
- CLI 已增加 `repo-push/repo-pull`：push 在联网前先用仓库凭据做 full verify，再经 Route A 上传缺失对象；pull 要求 recovery/password，下载完默认 full verify，确保“PikPak 账号 + recovery secret”足以从空本地状态重建并验证 repository。远端根名称可用 `--remote-repo-name` 改写，默认稳定为 `PikPak-Direct Vault`。
- 第一次真实 cloud repository E2E 已证明 `repo.json` 与 pack 可经 Route A 上传并 check-in；第三个 snapshot 等待 check-in 时，受管 PikPak SPA 恰逢 runtime 丢失，`getTaskStatus` 报 `webpack chunk global not found`。probe Vault `PikPak-Direct Vault E2E Probe 316ed2aacdfb` 已精确移入回收站。已新增“只读调用 runtime 自动恢复”：task poll/list/file detail 遇到 webpack runtime 短暂缺失时先被动等待，必要时重新导航受管 PikPak tab 后只重试一次；所有有副作用的 create/upload/trash 调用仍绝不自动重放。
- 新仓库测试首轮暴露的唯一前置失败是测试 pack 设为 128/256 KiB，而初始化器把 packTargetBytes 最低限制为 1 MiB；该限制与格式/密码学无关，已放宽为 64 KiB，生产默认仍保持 128 MiB，便于快速覆盖多 pack 与损坏隔离测试。
- 仓库 round-trip 已实际通过：第二个增量 snapshot 能在没有本地 index/cache、没有 password 的情况下，仅凭 recovery key 扫描 pack TOC + snapshot 完整恢复，逐文件 SHA-256 一致。剩余“单 pack 损坏隔离”测试失败定位为夹具数据具有 256-byte 周期、被 Brotli 极度压缩而没形成多 pack；已改为固定 seed xorshift32 不可压缩夹具，确保测试真的覆盖多个 pack。

- Live Ops 已新增两个独立子项：Route A“Chrome 生命周期与自动登录”、Route B“Cloud Download 无网页 fallback”，均置为 doing。
- Route A 当前已做独立登录页实测：全新 9333 临时 Chrome 访问 /drive 会跳到 /drive/login?redirect=/all；默认可见 Google/Facebook/Apple 登录，底部有手机/邮箱/二维码入口；点击邮箱后出现“请输入邮箱”“请输入密码”和“登录”按钮。
- DevSpace Secrets 已确认存在 pikpak_account / pikpak_password 两个 key；后续只允许通过运行时 Secret 注入，不把明文读入源码、日志或文档。
- 真正提交账号密码的自动化探针被当前主机安全层拦截一次，因此没有为了“测通”而回读明文 secret 或绕开拦截；登录 DOM/入口机制本身已经确认。
- Route A 下一步实现受管 Browser/Tab Lease：默认复用 9222 日常 Chrome；受管 tab 用 ownership 标记 + 跨进程 refcount 共享，防止并发任务重复开 tab 或互相关页；最后一个 lease 退出时才关闭本工具创建的 tab。
- Route B 不是从零开始：2026-09-19 的 1 MiB 反向拉取 E2E 已有真实证据；当前缺口是把“手工 Quick Tunnel + Web 提交 URL”做成 cloud-pull CLI，并尽量直接复用 Web/API 控制面而非黑盒官方 CLI。
- Route A 浏览器生命周期代码已落盘：新增受管 tab marker、跨进程 holder/refcount、9222 不可达时按固定 Chrome-CDP Profile 自动启动、邮箱登录 DOM 自动化、captcha 检测与保留 tab 的人工接管语义；PikPakWebSession.close() 改为异步释放 lease，upload/migrate 调用方均等待清理完成。待本轮完整测试与真实 9222 smoke 后再标记完成。
- Route A 离线自动测试现为 50/50 全绿。
- Route A 真实 9222 单任务 smoke 已通过：日常 Chrome 起初没有 PikPak 页面，acquire 自动创建受管 tab 并进入 https://mypikpak.com/drive/all，证明当前日常 Profile 登录态可直接复用；release 后该受管 tab 被关闭。
- Route A 真实 3 路跨进程并发 smoke 已通过：持有期间 PikPak tab 数为 1，三个进程获得同一 targetId；最后一个 holder 退出后 PikPak tab 数变为 0。由此确认“并发复用一个控制面 tab + 最后一个人关门”的实现有效。
- Route A 浏览器级 ownership 设计已废弃：PikPak-Direct 不再启动或关闭整个 Chrome。最后一个 holder 只关闭本项目 marker tab；9222 不在线时返回 CDP_UNAVAILABLE，要求用户启动现有“Chrome CDP 日常用”。
- 修正一个既有清理语义 bug：当前 Web bundle 中 module 18839.Cw 才是 /files:batchTrash，VK 实际是 /files:batchDelete。trashFile() 已从 VK 改为 Cw，确保 --trash-after-success 真正进入回收站而不是永久删除。本轮此前被 VK 删除的对象均是明确创建的 smoke 测试文件，没有触及业务对象。
- 独立 9333 无痕登录探针及 9877 Browser Harness 实验服务已全部停止，C:\Temp\pikpak-incognito-probe 已删除，不留临时浏览器/Profile/监听端口。
- Route B 历史官方 CLI 审计已复核：官方 v0.5.1 二进制 checksum 匹配，但未签 Authenticode、闭源且没有零遥测证据；因此本轮继续选择“Web/API 协议复刻优先，不引入官方 CLI”。
- Route B 当前 Web 协议已经定位：NewFiles 组件构造 kind=drive#file、upload_type=UPLOAD_TYPE_URL、url.url=<公网链接>，通过 webpack module 18839.x3 创建任务；根目录时 folder_type=DOWNLOAD。已新增 createCloudDownload()，不依赖官方 PikPak CLI。
- 新增 cloudflared Quick Tunnel 生命周期封装：只接受 loopback HTTP、显式 --no-autoupdate、只保留短日志尾部、不输出随机公网 URL、退出时关闭进程。
- 新增 cloud-pull CLI 第一版：单文件 HTTP 源站、Quick Tunnel、HEAD 预检、Cloud Download task、任务完成轮询与 source GET/HEAD/Range/bytesServed 统计全部进入同一 try/finally 生命周期。待自动测试与真实 1 MiB smoke。
- 第一次真实 1 MiB cloud-pull smoke 在 PikPak task 创建前被公网 HEAD gate 拦下：cloudflared 已分配 URL，但立即 fetch 仍报 fetch failed，属于 Quick Tunnel URL 分配与 Edge/connector 真正 ready 之间的竞态。finally 已实测把 cloudflared、HTTP 监听和受管 PikPak tab 全部清零。现已把 HEAD gate 改为 20 秒窗口内重试，仍不发送文件正文。
- 第二次 smoke 与独立诊断进一步定位：cloudflared 会先打印随机 URL，随后才打印 Registered tunnel connection；只有后者出现后，同一随机域名才由 curl/Node 稳定访问。手工诊断中 Registered 后请求能到 Cloudflare Edge（故意指向不存在 origin 时正确返回 502）。因此 Quick Tunnel ready 条件已从“看到 URL”升级为“同时看到 URL + Registered tunnel connection”，避免首次过早 DNS 查询造成负缓存。
- 第三次 smoke 遇到 Cloudflare Quick Tunnel 控制面本身超时：api.trycloudflare.com/tunnel 在返回 headers 前 deadline exceeded，cloudflared code=1，仍未创建 PikPak task。Route B 现对“尚未获得已注册 Tunnel”的创建阶段增加最多 3 次有限重试；一旦 Tunnel 已注册则绝不自动换 hostname，避免让已创建的 PikPak task 指向失效 URL。
- 第四次 smoke 成功拿到已注册 Quick Tunnel、公网 HEAD 通过，并通过 Web x3 真正创建 Cloud Download task。1 MiB 源文件在 180 秒内仍停留 RUNNING/0%，但本机已经收到 14 次 GET（10 次 Range），累计发送 5,847,312 B，约为源文件 5.58 倍；Tunnel 关闭后 task 一度升到 38%，随后额外 2 分钟保持 38% 不动。因此 Route B 当前不能标完成：重复回拉放大已被实证，且需要明确 task 超时清理。
- 已定位 Web task 删除接口：module 18839.vq -> DELETE /tasks?delete_files=...&task_ids=...。cloud-pull 现对“task 已创建但命令最终未成功”的路径默认 delete_files=true 清理 task/关联未完成文件，然后才关闭 Tunnel/HTTP；同时 getTaskStatus 会持续回收 fileId/fileName/fileSize。
- 临时 HTTP 源站新增最多 64 条安全 requestLog，仅记录 method/status/Range/plannedBytes，不记录随机 URL/token、IP、Cookie 或 User-Agent，便于下一次 smoke 精确判断 5.58x 放大来自哪些 Range/整文件重试。

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
- 下一步：Route B 绑定已有固定 Cloudflare Tunnel/DNS 公网入口，并把 cloud-pull 改成只管理临时 origin；随后直接进入加密仓库主线：key slots -> CDC/chunk/pack -> snapshot/index -> fresh-machine restore。
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
- 决策H：临时公网源站采用“固定 Cloudflare Tunnel/DNS 映射 + 任务期 loopback 单文件 origin”。Tunnel/DNS 作为长期基础设施保持不变；本项目不再按任务创建 Quick Tunnel，也不能把整个目录、局域网服务或管理端口直接暴露公网。

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
