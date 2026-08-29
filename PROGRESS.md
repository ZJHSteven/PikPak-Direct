# 项目状态快照

## 当前结论（必须最新）

- 现状：阶段 1“项目骨架与实验固化”已完成；阶段 2“正式 CLI MVP”已进入可真实上传单文件状态。
- 已完成：README/架构/完整实验记录、Web 官方上传探针、Node 本地文件 CLI、Aliyun endpoint 规范化、多 DoH region 自动发现、STS 默认脱敏、24 个单元测试。
- 已验证：`node bin/pikpak-direct.mjs upload <file>` 可从真实本地路径读取文件，自动发现 `ap-southeast-1`，正文走原生 Aliyun OSS endpoint，PikPak 最终 `PHASE_TYPE_COMPLETE`；8 MiB smoke test 已两次成功并清理远端测试文件。
- 正在做：把 CLI 从“单文件可用”推进到长期冷仓工具所需的 manifest、目录递归、checkpoint/恢复和大文件 STS 生命周期管理。
- 下一步：先加入持久 manifest 与可恢复状态目录；随后研究 STS 续证/超时预警，再做目录/冷仓迁移器。

## 关键决策与理由（防止“吃书”）

- 决策A：禁止任何测试切换 Mihomo 全局 `mode`。原因：Mihomo TUN 是整机网络底座，切全局 DIRECT 会破坏其他项目、Cloudflare Tunnel、浏览器与代理依赖链路。
- 决策B：采用“控制面代理、数据面 DIRECT”。原因：PikPak 官方 Web 上传通过 PikPak API 创建任务，但正文实际使用 Aliyun OSS multipart，可把自定义 PikPak OSS CNAME 改写为原生 Aliyun OSS endpoint。
- 决策C：当前 Aliyun endpoint 改写视为兼容技巧，不视为官方稳定 API。原因：PikPak 未来可能换 provider、region、bucket 或签名方式。
- 决策D：正式冷迁移默认只上传和校验，不删除本地。原因：冷仓迁移属于高风险数据操作，删除必须在校验完成后另行显式授权。
- 决策E：region 默认通过多家 DoH 的 CNAME 共识自动发现，而不是硬编码新加坡。当前 CNAME 形如 `bucket.region.thepacificphs.com`，至少两家一致且 bucket 匹配才接受。
- 决策F：STS 换证尚未验证前，不宣称支持任意 TB 单文件。当前 task STS 约 12h；相同 fileId 立即 recreate 返回同一 task/key/expiration。

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

## 常见坑 / 复现方法

- 坑1：不要 reload 保存于磁盘的完整 Clash/Mihomo 配置来做局部实验。曾发现配置文件中的 `mode` 与当前 runtime mode 不一致，reload 会意外改变全局网络行为。
- 坑2：系统处于 Fake-IP + TUN 时，单纯 `curl --interface WLAN` 仍可能拿到 198.18.x.x Fake-IP；做真实旁路测试必须同时使用真实 DNS 结果和 `--resolve`。
- 坑3：`upload-a10b.mypikpak.com` 与其后端 Aliyun OSS 可能落到相同 IP，但前者在大陆 DIRECT 下会 reset，原生 `*.aliyuncs.com` SNI/Host 则可正常 TLS。
- 坑4：所有日志/fixture 禁止保存 access token、Cookie、WebDAV password、STS access key secret/security token。
- 坑5：OSS multipart 完成不等于 PikPak task 立即 COMPLETE；曾出现约 61 秒 check-in 延迟。timeout 时必须保留 fileId/taskId 后续检查，不能自动误删。
- 坑6：Aliyun SDK 会提示配置 `refreshSTSToken`。当前 PikPak Web adapter 本身没有传 refresh callback；大文件换证仍是待验证能力。
