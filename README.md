# PikPak-Direct

PikPak-Direct 是一个面向 Windows / Mihomo TUN 环境的实验性上传与冷仓工具项目。

它解决的核心问题是：**PikPak 的登录、地区判断和控制 API 需要按现有代理规则访问，但 TB 级文件正文不应该消耗用户有限的代理流量。**

当前已经在真实账号与真实网络上验证：PikPak Web 官方上传会创建 `UPLOAD_TYPE_RESUMABLE` 任务，并返回 Aliyun OSS 的临时上传参数。若把 PikPak 自定义 OSS CNAME 替换为对应的阿里云原生 OSS endpoint，正文可以通过现有 `aliyuncs.com -> DIRECT` 路由上传，同时 PikPak 服务端仍会正常把任务检入为完成。

2026-09-19 又验证了第二条互补路线：把本地单文件临时暴露为
`localhost HTTP -> Cloudflare Tunnel`，再由 PikPak Web 的 Cloud Download 主动回拉。
1 MiB smoke test 最终真实保存进 `My Pack`，证明这条“反向拉取”数据面成立。

> 重要：这是对当前 PikPak Web 实现的兼容性研究，不是 PikPak 官方公开稳定 API。项目必须保留 provider/region 检测、安全失败和回退机制。

## 当前架构

### 路线 A：Aliyun OSS Direct Upload（已有 CLI）

```text
                        少量控制流量
本机 / CLI  -------------------------------->  PikPak API
                现有 Mihomo Rule / PROXY       │
                                                │ 创建 resumable task
                                                ▼
                                      STS / bucket / key / endpoint
                                                │
                                                │ endpoint normalization
                                                ▼
                        TB 级文件正文     Aliyun OSS 原生 endpoint
本地文件  -------------------------------->  *.aliyuncs.com
                     DIRECT                      │
                                                │ multipart complete
                                                ▼
                                          PikPak task check-in
                                                │
                                                ▼
                                      progress=100 / COMPLETE
```

### 路线 B：Cloud Download 反向拉取（PoC 已验证，尚未一键化）

```text
本地文件
   │
   ▼
loopback-only 临时 HTTP
127.0.0.1:<random-port>
   │
   ▼
Cloudflare 临时 Tunnel
   │        PikPak 主动 GET
   └────────────────────────> PikPak Cloud Download
                                  │
                                  ▼
                              PikPak 云盘
```

这条路线的意义是把正文从“普通 Upload”变成“Cloud Download 从公网 URL 保存”。
当前已验证的是数据路径本身；Tunnel 生命周期和 PikPak Web 创建任务还没有封装成
`cloud-pull` 一键命令，因此 README 不把它宣传成已完成 CLI。

## 为什么不用 WebDAV 做主上传

WebDAV 仍然适合把 PikPak 挂成浏览盘、管理文件和偶尔传小文件，但本机实测存在两个问题：

1. `dav.pikpak.ai` 与 rclone 在部分目录操作上出现过 `MKCOL -> HTTP 500` 兼容问题。
2. WebDAV 持续 DIRECT 上传吞吐不稳定；而 Web 官方 Aliyun OSS multipart 路线可稳定完成，并且能把控制面与数据面拆开。

因此项目策略是：

- **WebDAV / rclone**：保留为一次性诊断或轻量管理手段，不再常驻挂载；
- **PikPak-Direct / OSS**：当前可用的正式单文件上传路线；
- **Cloud Download 反向拉取**：新的冷仓主候选路线，PoC 已通，正在固化。

2026-09-19 已确认 rclone VFS 无待上传数据后停止 `P:`，并禁用
`PikPak Mount` 登录计划任务。配置仍保留，但当前不会自启动。

## 已验证结果

2026-08-29 本机实验：

- 官方 Web 上传 provider：`PROVIDER_ALIYUN`；
- 当次 server endpoint：`upload-a10b.mypikpak.com`；
- 当次 bucket：`vip-lixian-07`；
- 原生 bucket endpoint `vip-lixian-07.oss-ap-southeast-1.aliyuncs.com` 真实 DIRECT TLS 正常；
- 8 MiB / 32 MiB multipart 上传均成功；
- PikPak task 最终达到 `progress=100`、`PHASE_TYPE_COMPLETE`；
- 32 MiB 当次样本：原 endpoint 经代理约 14.45 Mbps，标准 OSS endpoint 经 DIRECT 约 27.72 Mbps。

速度仅代表当时网络样本，不作为性能承诺。

2026-09-19 Cloud Download 实验：

- 本地源站仅监听 `127.0.0.1`；
- 独立 Cloudflare Quick Tunnel 成功提供公网 HTTPS；
- PikPak Web Cloud Download 创建任务后，本地源站真实收到 4 次远端 GET；
- 文件最终出现在 `My Pack/smoke-1m.bin`；
- 测试后远端文件、Quick Tunnel 和临时 HTTP 服务均已清理；
- 正式源站模块现已支持 256 bit 随机 URL、GET/HEAD/单段 Range 与实际发送字节统计。

完整记录见
[`docs/experiments/2026-09-19-cloud-download-reverse-pull.md`](./docs/experiments/2026-09-19-cloud-download-reverse-pull.md)。

## 安全边界

本项目最重要的规则：

- **绝不为了测试切换 Mihomo 全局 mode。**
- 不 reload 整份 Mihomo 配置来插入局部规则。
- 所有网络实验必须限制到单进程、单域名或上传器内部 endpoint 改写。
- Token、Cookie、WebDAV 密码、STS Secret/SecurityToken 永不写入 Git 或普通日志。
- 冷迁移默认只上传和校验，未经显式授权绝不删除本地文件。

详细规则见 [`AGENTS.md`](./AGENTS.md)。

## 目录

```text
PikPak-Direct/
├─ AGENTS.md                  项目硬规则
├─ PLANS.md                   长期执行计划
├─ PROGRESS.md                当前状态快照
├─ README.md                  项目入口
├─ docs/
│  ├─ architecture.md         协议与架构说明
│  └─ experiments/            可审计实验记录
├─ src/                       可复用核心模块
├─ tools/                     可直接运行的探针/维护工具
└─ test/                      单元测试
```

## 快速使用：当前单文件 CLI MVP

前提：

1. 当前 CDP Chrome（默认 `127.0.0.1:9222`）已经登录 PikPak Web；
2. 当前网络规则能让 `*.aliyuncs.com` 走 DIRECT；
3. Node.js >= 22。

安装依赖：

```bash
npm install
```

上传一个真实本地文件：

```bash
node bin/pikpak-direct.mjs upload "D:\\Archive\\example.zip"
```

默认行为：

- `direct-only`；
- 从 PikPak upload CNAME 通过 AliDNS / Cloudflare / Google DoH 共识自动发现 Aliyun region；
- Node 直接从本地文件系统读取文件并 multipart 上传；
- 不修改 Mihomo；
- PikPak check-in 最长默认等待 180 秒；
- 成功后保留云端文件；
- 不删除本地源文件。

人工指定 region：

```bash
node bin/pikpak-direct.mjs upload "D:\\Archive\\example.zip" --region ap-southeast-1
```

A/B 或故障回退才使用 server endpoint：

```bash
node bin/pikpak-direct.mjs upload "D:\\Archive\\example.zip" --route server
```

> `server` 路径可能让 TB 级正文重新命中 PikPak 代理规则，因此不应作为用户当前 200GB/月代理配额环境的默认模式。

运行回归探针：

```bash
npm run probe:web-upload -- --route direct --region ap-southeast-1 --size-mib 8
```

该探针生成随机测试数据，并在成功/失败后尝试清理自己创建的测试文件。

## 当前阶段

阶段 1“实验固化”已经完成；阶段 2“正式 CLI MVP”已有可工作的 OSS 单文件上传；
同时正在推进 **阶段 6：Cloud Download 反向拉取工具化**。

已经具备：

1. 单真实文件上传；
2. 流式 SHA-1；
3. PikPak Web 控制面 task create/check-in；
4. 多 DoH 共识自动发现 region；
5. Node `ali-oss` 原生 multipart；
6. secret 默认脱敏；
7. 28 个离线单元测试；
8. 真实 8 MiB Node CLI smoke test 完整成功；
9. loopback-only 临时单文件 HTTP 源站（随机 URL、HEAD/Range、发送字节统计）；
10. Cloudflare Tunnel -> PikPak Cloud Download -> `My Pack` 的 1 MiB 真实 smoke test。

尚未完成：

- 目录递归与远端目录创建；
- 持久 manifest；
- 持久 multipart checkpoint / pause / resume；
- STS 超过约 12 小时后的可靠换证；
- 冷仓扫描、校验和本地观察期删除流程。
- Cloud Download 的 Tunnel 自动生命周期；
- PikPak Web Cloud Download 控制面的一键自动化；
- 目录流式归档、客户端加密、SQLite manifest 与增量分块。

此外，当前 PikPak Web 前端对桌面文件有 20GiB UI 限制，但 create-task 后端已实测接受 21GiB 与 100GiB 声明任务；这不等于 100GiB+ 单文件已获得长期稳定支持，因为 STS 生命周期仍需解决。

实时状态请看 [`PROGRESS.md`](./PROGRESS.md)。
