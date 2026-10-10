# PikPak-Direct 执行计划

## 2026-10-11：Route A/B 最终收口 + 加密仓库主链

本轮目标不是继续堆传输 PoC，而是把两条真正可用的数据路线都收口成一次性、可无人值守、可安全恢复的 CLI。

### Route A：受管 Chrome / Tab / 登录租约

- [x] 用独立 9333 临时无痕 Chrome 实测 PikPak 登录页：默认展示 Google/Facebook/Apple；底部另有手机、邮箱、二维码入口。
- [x] 实测点击邮箱入口后出现标准邮箱 + 密码输入框与登录按钮。
- [x] 9222 明确视为用户长期运行的“日常 CDP Chrome”共享基础设施：PikPak-Direct 只连接，不启动、不关闭整个 Chrome；9222 不可达时明确失败，避免参数漂移或第二 Chrome 实例。
- [x] 受管 PikPak tab 使用明确 `window.name` ownership 标记，不把“任意打开的 PikPak 页面”视为本工具所有。
- [x] 已加跨进程 lease/refcount：并发多个 Route A 任务共享同一个受管控制面 tab；最后一个 lease 释放后才关闭该 tab。
- [x] 受管 tab 不存在时创建并导航到 https://mypikpak.com/drive/；存在时直接复用，不重复开页。
- [x] 已实现登录态检查与运行时 `PIKPAK_ACCOUNT / PIKPAK_PASSWORD` 邮箱登录；凭据只从运行时环境/Secret 进入内存。真实“未登录 Profile + Secret 注入”E2E 被宿主安全门禁阻止，不读取明文、不绕过门禁。
- [x] 已检测 captcha / verification / challenge；触发时返回 `CAPTCHA_REQUIRED` 并保留受管 tab 供人工接管，不绕过验证码。
- [x] Route A 在创建任务/查询 task/清理文件期间持有 tab lease；释放时只关闭本项目 marker tab，永不启动/关闭整个 9222 日常 Chrome。
- [x] tab 复用、ownership、并发 lease、登录分类、异常清理均有回归测试；9222 单任务与 3 进程并发真机 smoke 已通过。
- [x] 为 tab 复用、ownership、并发 lease、登录状态判断、异常清理补单测；完整测试已达 50/50。
- [x] 9222 真机生命周期 smoke：无现成 PikPak tab 时自动创建受管 tab，复用日常 Profile 登录态进入 /drive/all，release 后自动关闭。
- [x] 3 路跨进程并发 smoke：运行中始终只有 1 个 PikPak tab，3 个进程拿到同一 target；全部 release 后 tab 数恢复为 0。

### Route B：Cloud Download 反向拉取自动化

- [x] 既有真实证据：2026-09-19 的 1 MiB 文件已经通过 127.0.0.1 HTTP -> Cloudflare Quick Tunnel -> PikPak Web Cloud Download -> My Pack 完成。
- [x] 已盘点 Cloud Download Web 控制面并复用当前 Web bundle 内部 API；正式路径不依赖黑盒官方 CLI。
- [x] 定位当前 Web 控制面：NewFiles 组件调用 webpack module 18839 的 x3，body 为 upload_type=UPLOAD_TYPE_URL + url.url；已据此实现 PikPakWebSession.createCloudDownload()。
- [x] 复核 2026-09-19 官方 CLI 静态审计：v0.5.1 checksum 与官方一致、Defender 未报已知威胁，但 Windows EXE 未签名且闭源，无法证明零遥测；因此继续维持“不作为默认依赖”的决策。
- [x] 官方 CLI v0.5.1 已完成静态审计并决定默认不用；除非未来出现现有 Web/API 路径无法覆盖的新能力，否则不再引入该依赖。
- [x] cloud-pull 改为“既有固定 Cloudflare Tunnel / DNS 公网入口 + 临时本地 origin”：已确认 `PikPak-RouteB` 远端配置固定为 `pikpak-pull.zjhstudio.com -> http://127.0.0.1:18765`；CLI 不再申请 Quick Tunnel，只启动任务期 origin + named connector，并用 HEAD 验证固定公网入口。
- [x] Route B 新增正文硬预算，默认最多向公网发送源文件大小的 4 倍；超预算 GET 在发送正文前 429，防止先前 5.58x 乃至无限重试继续烧上行。
- [x] Quick Tunnel 可执行模块/单测已删除，只保留 2026-09-19 历史实验文档作为“反向拉取可行”的证据；正式代码不存在动态 Quick Tunnel fallback。
- [x] 已记录 Range/GET 次数和累计发送字节，并增加默认 4x 正文发送硬预算，超预算 GET 在发送正文前拒绝。
- [x] 已记录 GET/HEAD/Range/累计字节，并在真实 1 MiB smoke 观测到 5.58x 读取放大；新增安全 requestLog 精确记录各请求的 Range/计划字节。下一步需基于请求序列定位放大原因后再决定是否允许大文件 Route B。
- [x] Route B 失败清理语义已补：已创建但未成功的 offline task 在一次性 URL 失效前通过 Web task DELETE(delete_files=true) 清理，不把 RUNNING 尾巴留在 PikPak。
- [x] Route A 不会静默进入 Route B；`upload/repo-push` 与 `cloud-pull` 是显式独立命令，数据路径不会在失败时暗中切换。

### 加密仓库 / CDC / 恢复链

- [x] 已定义并实现 repository v1：`repo.json` 只含最小版本/算法/key slots；pack 正文为逐 chunk AEAD 密文，文件尾部 TOC 整体加密；snapshot 目录树/路径/元数据/chunk 引用整体加密。
- [x] master key 随机生成；已实现 password slot + recovery slot 两个独立包装入口，任何 slot 都只包装 master key；口令使用 scrypt，recovery key 使用 HKDF，上层正文子密钥继续按用途 HKDF 隔离。
- [x] 已实现 `fastcdc-gear32-v1` 流式内容定义分块：固定 Gear seed、min/avg/max 双 mask、跨 read buffer 保持边界；chunk id 后续使用 SHA-256，且只进入加密 snapshot/TOC。
- [x] chunk 先 Brotli-or-none 压缩，再 AES-256-GCM 加密并聚合进不可变 pack；pack 尾部加密 TOC 可单独扫描，已实现无需本地数据库的全局 chunk index 重建，并对损坏 pack 做局部隔离。
- [x] snapshot manifest 已记录目录树、文件元数据、whole-file SHA-256 与有序 chunk 引用，整体 AEAD 加密；本地 latest.json 只是便利指针，fresh restore 可直接解密枚举所有 snapshot，不依赖它。
- [x] 离线 fresh-machine 恢复链已实现：不依赖 SQLite/cache，只凭 repo 对象 + password/recovery key 重建 pack index、逐 chunk AEAD/hash 校验并原子恢复文件。下一步把这些对象同步/枚举到 PikPak 固定仓库根目录。
- [x] CLI 已增加 `repo-init / repo-backup / repo-list / repo-restore / repo-verify`；凭据只从环境/Secret 注入，不允许 password/recovery key 进入 argv。`repo-init` 强制把 recovery key 写到 repo-dir 外的独立文件且不回显。库级 round-trip、去重、增量、损坏隔离与错误凭据测试已覆盖；下一步跑真实 CLI 进程 smoke 并接 PikPak 远端仓库同步。
- [x] 独立 CLI 进程 smoke 已通过：`repo-init -> repo-backup -> 清除 password -> 只用 recovery key -> repo-list -> full verify -> repo-restore -> SHA-256 compare`，最终 `CLI_SMOKE_OK`，且 recovery key 未出现在 CLI 输出。
- [x] PikPak 远端仓库同步已接入 CLI：`repo-push` 固定可见根目录默认 `PikPak-Direct Vault`，先 full verify 再只新增缺失 immutable 对象；固定 `repo.json` 必须逐字节一致。`repo-pull` 分页枚举 + private signed download ticket 物化完整本地 repo，随后立即用 password/recovery key 做 full verify（可显式 `--quick`）。真实小仓库 cloud round-trip 已通过并清理 probe：删除本地 repo 后从 PikPak pull，仅凭 recovery key full verify + restore/hash 成功。

## 2026-10-10：手机冷备实战 / 0 字节文件边界修复

- [x] 用现有 P30 备份目录跑 migrate --dry-run，确认 18 个文件、28.76 GiB 能正确建 manifest。
- [x] 打开已登录 PikPak Drive 标签页并开始真实 Route A / Aliyun OSS DIRECT 迁移。
- [x] 实机确认普通非空文件可继续完成 DIRECT 上传与 PikPak COMPLETE。
- [x] 修复 0 字节文件：不再向 PikPak 创建 resumable task，而是在 manifest 中标记为 manifest-only-empty；恢复时按 manifest 重建空文件。
- [x] 为 0 字节文件语义补单元测试，并跑完整测试套件。
- [x] 修复同一 backup-id 重跑时未自动复用默认 manifest 的断点恢复问题。
- [x] 为默认 manifest 自动 resume 补测试，确保无需手写 --manifest。
- [ ] 从现有 manifest 断点继续 P30 冷备；已 COMPLETE 的文件跳过，不重复上传。
- [ ] 全部文件与 portable manifest 完成后，再做云端校验；未经用户明确授权不删除本地 P30 备份。

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

- [x] 在现有 `PikPakWebSession` 中增加 `UPLOAD_TYPE_URL` Cloud Download 创建接口，继续复用已登录 PikPak Web 控制面，不引入额外账号密码或长期 token。
- [x] 建立只监听 `127.0.0.1` 的临时 HTTP 文件服务；公网路径使用 256 bit 随机 token，不开放目录列表。
- [x] HTTP 服务支持 `GET`、`HEAD` 与单段 `Range`，并统计实际发送字节；离线单元测试已覆盖。
- [x] 正式 Route B 固定复用已有 `PikPak-RouteB` Named Tunnel + DNS；CLI 只启动任务期 connector 与 `127.0.0.1:18765` origin，不修改 Tunnel/DNS/Mihomo，也不存在 Quick Tunnel fallback。
- [x] 已新增 `cloud-pull <local-file>`：启动单文件 HTTP -> 启动 Named Tunnel connector -> HEAD gate -> 创建 PikPak Cloud Download -> 等待完成 -> finally 关闭 connector/HTTP。
- [x] 失败/超时会清理本次 CLI 自己创建且已失效的 offline task/file，不触碰用户已有云端文件；成功 smoke 可显式 `--trash-after-success` 回收测试文件。
- [x] 已有真实 Cloud Download 小文件 E2E 证据；Named Tunnel 版本的真实 token 注入 E2E 因宿主安全门禁无法执行，代码不会为测试绕过门禁或退回 Quick Tunnel。
- [x] 请求次数、Range、实际发送字节与 task 状态均有脱敏统计；实测曾观察 5.58x 回拉放大，因此正式实现新增默认 4x 硬预算。

已完成的手工 PoC 证据（尚不等于上面的一键 CLI 已完成）：

- [x] 2026-09-19 使用 1 MiB 随机文件，手工启动 localhost HTTP + Cloudflare Quick Tunnel，并在 PikPak 官方 Web 创建 Cloud Download。
- [x] 本地源站真实收到 4 次远端完整 GET，最终 `My Pack/smoke-1m.bin` 存在；随后测试文件与临时服务均清理。

第二版（PoC 成功后）：

- [ ] 支持目录先打包再 Cloud Download；先选择一种可流式、可恢复的归档格式，避免为了打包复制出第二份超大临时文件。
- [x] 已支持已有命名 Cloudflare Tunnel + 自有域名，并保持 connector/origin 仅任务期间开放，Tunnel/DNS 映射长期保存。
- [x] 原“Cloud Download 专用 manifest/SQLite”需求由 repository v1 取代：恢复真相在加密 snapshot + pack TOC，本地索引只是可重建缓存，不再把 SQLite 作为恢复单点。
- [x] 客户端加密层已实现为 CDC + chunk/pack + AEAD，不把整个目录做成单一巨型密文。
- [x] 增量已落实为 chunk-level dedup + immutable snapshot；局部插入测试验证 CDC 能重新同步并大量复用旧 chunk。

## 明确不做

- 不修改 Mihomo 全局 `mode` 进行测试。
- 不把 PikPak 整站做区域反代。
- 不把 access token、Cookie、WebDAV password、STS Secret 写入仓库。
- 不把当前实验观察误写成 PikPak 官方稳定 API 承诺。
- 不在未经校验和用户明确授权时删除本地源文件。
