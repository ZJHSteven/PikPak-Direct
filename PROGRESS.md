# 项目状态快照

## 当前结论（必须最新）

- 现状：项目已在 `D:\Workspace\PikPak-Direct` 初始化 Git，并建立长期执行计划。
- 已完成：`PLANS.md`、`PROGRESS.md`、项目级 `AGENTS.md` 已提交；其中已把“禁止切 Mihomo 全局 mode”与 secret 禁止落盘设为硬规则。
- 正在做：建立 README、架构/实验文档、可复现探针与最小 CLI 骨架。
- 下一步：写入 README、架构与实验记录，然后整理 endpoint 推导代码并执行单元/集成测试。

## 关键决策与理由（防止“吃书”）

- 决策A：禁止任何测试切换 Mihomo 全局 `mode`。原因：Mihomo TUN 是整机网络底座，切全局 DIRECT 会破坏其他项目、Cloudflare Tunnel、浏览器与代理依赖链路。
- 决策B：采用“控制面代理、数据面 DIRECT”。原因：PikPak 官方 Web 上传通过 PikPak API 创建任务，但正文实际使用 Aliyun OSS multipart，可把自定义 PikPak OSS CNAME 改写为原生 Aliyun OSS endpoint。
- 决策C：当前 Aliyun endpoint 改写视为兼容技巧，不视为官方稳定 API。原因：PikPak 未来可能换 provider、region、bucket 或签名方式。
- 决策D：正式冷迁移默认只上传和校验，不删除本地。原因：冷仓迁移属于高风险数据操作，删除必须在校验完成后另行显式授权。

## 已验证实验摘要

- 当前 Web 官方上传 provider：`PROVIDER_ALIYUN`。
- 当前 server endpoint：`upload-a10b.mypikpak.com`。
- 当前 bucket：`vip-lixian-07`。
- 原生 OSS 新加坡 endpoint 可真实 DIRECT 访问。
- endpoint 改写后 8 MiB / 32 MiB multipart upload 成功。
- PikPak task 最终达到 `progress=100`、`PHASE_TYPE_COMPLETE`。
- 32 MiB 当次样本：代理原 endpoint 约 14.45 Mbps；DIRECT 原生 OSS endpoint 约 27.72 Mbps。

## 常见坑 / 复现方法

- 坑1：不要 reload 保存于磁盘的完整 Clash/Mihomo 配置来做局部实验。曾发现配置文件中的 `mode` 与当前 runtime mode 不一致，reload 会意外改变全局网络行为。
- 坑2：系统处于 Fake-IP + TUN 时，单纯 `curl --interface WLAN` 仍可能拿到 198.18.x.x Fake-IP；做真实旁路测试必须同时使用真实 DNS 结果和 `--resolve`。
- 坑3：`upload-a10b.mypikpak.com` 与其后端 Aliyun OSS 可能落到相同 IP，但前者在大陆 DIRECT 下会 reset，原生 `*.aliyuncs.com` SNI/Host 则可正常 TLS。
- 坑4：所有日志/fixture 禁止保存 access token、Cookie、WebDAV password、STS access key secret/security token。
