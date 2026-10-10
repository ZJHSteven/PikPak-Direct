# PikPak-Direct 交接说明

## 项目定位

PikPak-Direct 是一个独立 Root 级项目，不属于手机备份项目。手机、电脑目录、项目归档等都只是它的上层使用场景。

最终目标不是“把文件传到 PikPak”，而是提供一个稳定、可恢复、客户端加密、支持增量/去重的通用备份仓库层。

## 当前 Route A 架构

Route A 当前是“浏览器控制面 + Node 数据面”的混合架构：

1. 预先存在一个启用 CDP 的 Chrome（默认 127.0.0.1:9222）。
2. Chrome 中存在一个已经登录的 https://mypikpak.com/drive 标签页。
3. PikPakWebSession.connect() 只查找并附着这个现有标签页，不负责启动 Chrome，也不主动创建或导航页面。
4. 通过 CDP Runtime.evaluate 捕获 PikPak Web 当前 webpack runtime，调用页面内部模块创建 resumable upload task，并拿到短生命周期 Aliyun OSS STS。
5. 文件正文不经过 Chrome。Node 直接从本地文件系统读取，通过 Aliyun OSS 原生 endpoint 做 multipart upload。
6. 浏览器只继续负责控制面：创建任务、查询 task、等待 PikPak check-in/COMPLETE、必要时清理测试对象。
7. CLI 完成后只关闭自己的 CDP WebSocket；不会自动关闭 Chrome 或 PikPak 标签页。

因此当前 Route A 没有 ChatGPT Archive 那种项目内置 Guardian，也没有后台浏览器自动生命周期管理。它依赖外部已有 CDP Chrome 和登录态。浏览器资源开销主要来自持续存在的 Chrome 进程/标签页，不是上传正文；大文件上传流量和 CPU/内存主要发生在 Node/Aliyun OSS 数据面。

## Route B

Route B 是 localhost HTTP -> Cloudflare Tunnel -> PikPak Cloud Download 的云拉取 PoC。
它与 Route A 是不同的数据传输路径；未来如果能把 Cloud Download 控制面改成稳定 API/CLI，就可以降低对网页控制面的依赖。
当前 Route B 不作为正式备份格式，也不阻塞 Route A。

## 已验证状态

- Route A Aliyun OSS DIRECT 已多次真实跑通。
- 0 字节文件迁移 bug 已修复：commit d0a0336。
- 同 backup-id 自动 resume 默认 manifest 已修复：commit 1de8765。
- 自动化测试：46/46 通过。
- 2026-10-10 P30 真实目录迁移用于 transport smoke：
  - 18 文件 / 28.76 GiB；
  - canonical manifest 当前 16/18 complete；
  - 已完成正文约 285 MiB；
  - shared_storage_full.tar 在约 45% multipart 时人为停止；
  - sms.txt 尚未上传。
- 这批明文对象只作 transport smoke 证据，不代表最终仓库格式。

## 用户对最终仓库的硬要求

1. PikPak 云盘里必须有明确、稳定、可见的独立仓库根目录，不能和普通文件混在一起。
2. 加密是 PikPak-Direct 仓库层的默认语义，与上层数据来源无关。
3. 除最小 repo header/README 外，原始文件名、路径、正文、snapshot、index 都应客户端加密。
4. 必须支持真正增量：文件局部变化不能导致整大包重传。优先采用 FastCDC/Rabin 内容定义分块。
5. 新 chunk 独立压缩 + AEAD 加密，再写入不可变 pack；建议 pack 约 128–256 MiB，避免单大容器损坏拖垮整个仓库。
6. 加密 snapshot manifest 保存目录树、元数据和有序 chunk 映射。
7. 本地 SQLite 只能是缓存，不能成为唯一索引。全局 index 丢失后必须能通过扫描云端 pack 自描述 TOC 重建。
8. 密钥不能只依赖当前电脑：随机 master key，至少有“用户口令派生 KEK”和“独立 recovery key”两个 key slot。
9. 真正验收标准不是上传 COMPLETE，而是“全新电脑 + 只有 PikPak 账号 + 密码或 recovery key”能够完整恢复并逐文件 hash 校验。
10. 单 pack 损坏必须局部隔离，不能导致整个仓库无法解密/恢复。

## 下一位执行者优先级

1. 不再继续手机明文冷备作为正式方案。
2. 先实现通用加密仓库 v1：repo header / key slots / CDC / pack / encrypted snapshot / rebuildable index。
3. 为 Route A 增加稳定的仓库目录创建与 parentId 固定绑定。
4. 做最小 backup -> 删除本地 cache/index -> fresh restore -> hash compare 灾难恢复 PoC。
5. 最后再清理 2026-10-10 transport smoke 产生的明文/重复对象。

## 需要补的生命周期问题

当前 Route A 不管理 Chrome 生命周期。后续应二选一：

- 复用一个低资源长期 CDP Profile，并由独立 supervisor/guardian 负责登录态与标签生命周期；
- 或实现控制面 API/CLI 登录，彻底取消 Chrome 依赖。

无论哪条路线，都应在任务结束后自动关闭自己创建的临时标签，不应把 PikPak Drive 永久留在用户前台。
