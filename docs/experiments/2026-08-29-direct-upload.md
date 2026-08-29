# 2026-08-29 PikPak Direct Upload 实验记录

## 目的

验证在 Windows + Mihomo TUN + Fake-IP 环境中，能否做到：

- PikPak Web/API 控制面继续走代理；
- 大文件上传正文走 DIRECT；
- 不切换 Mihomo 全局 mode；
- PikPak 最终仍把文件任务登记为完成。

本记录中的速度、域名和 bucket 均是**当次账号/网络的实测观察**，不是 PikPak 官方稳定承诺。

## 背景约束

- 用户代理服务总流量配额约 200GB/月，不能承载 TB 级冷仓上传。
- Mihomo 使用 TUN，承担整机代理路由；全局 mode 切换会影响其他项目与 Cloudflare Tunnel，因此之后被明确禁止。
- PikPak Web 在中国大陆真实 DIRECT 下无法正常加载。

## 1. WebDAV 早期实验

### 1.1 当前代理路径

64 MiB rclone/WebDAV 上传可持续工作，但只有约 100–135 KiB/s 量级。

### 1.2 WebDAV DIRECT

曾观察到：

- HTTPS 握手可成功；
- 小文件 PUT 可成功；
- 2–8 MiB 连续 PUT 吞吐明显塌陷并出现超时；
- rclone 对已存在测试目录重复执行 `MKCOL` 时，PikPak WebDAV 返回 HTTP 500，导致 rclone 显示 0 B 并重试。

因此 WebDAV 不被选为正式 bulk upload 主路径。

## 2. 找到 PikPak Web 官方上传实现

抓取并离线搜索当前 PikPak Web bundle 后观察到：

```text
upload_type = UPLOAD_TYPE_RESUMABLE
resumable.provider = PROVIDER_ALIYUN
```

上传主流程会懒加载：

```text
aliYunOssAdapter
```

Adapter 从 `resumable.params` 获取：

```text
access_key_id
access_key_secret
endpoint
bucket
expiration
security_token
key
cname
```

然后调用 Aliyun OSS SDK 的 multipart upload。

## 3. 创建无敏感输出的测试任务

通过已登录 PikPak Web 页面内部已加载的 webpack module 调用 task create，只输出结构信息，不打印 STS secret。

当次响应：

```text
provider = PROVIDER_ALIYUN
endpoint = upload-a10b.mypikpak.com
bucket   = vip-lixian-07
cname    = true
```

PikPak file/task id 在实验中产生，但不在长期文档中保留具体值。

## 4. 真实 DIRECT 隔离探针

### 4.1 为什么不能只用 `curl --interface`

Mihomo TUN + Fake-IP 下，系统 DNS 仍可能给：

```text
198.18.x.x
```

即使 curl 绑定物理 WLAN，这个 Fake-IP 在物理网络也不可路由。

因此采用：

1. 独立 DoH 查询真实 A 记录；
2. `curl --interface <WLAN IPv4>`；
3. `--resolve host:443:<real IP>`；
4. 对比 Mihomo rule hitCount，确认没有命中代理规则。

### 4.2 `upload-a10b.mypikpak.com`

三家 DoH 均返回相同一组：

```text
47.79.49.2
47.79.49.3
47.79.49.4
```

物理 WLAN 真实 DIRECT：

```text
TCP connect 成功
TLS ClientHello 后 connection reset
HTTP 也 reset
```

且 Mihomo PikPak rule hitCount 增量为 0，证明不是代理/TUN 引起。

### 4.3 对比其他 PikPak host

当次矩阵：

```text
dav.pikpak.ai             DIRECT TLS 正常，匿名 HTTPS 返回 401
api-drive.mypikpak.com     TCP 后 reset
mypikpak.com               TCP 后 reset
upload-a10b.mypikpak.com   TCP 后 reset
```

这表明并非 PikPak 所有域名都不可 DIRECT；`*.mypikpak.com` 族的 Host/SNI 路径存在明显差异。

## 5. 识别 Aliyun OSS 原生 endpoint

`upload-a10b.mypikpak.com` 的服务端错误响应包含：

```text
Server: AliyunOSS
```

结合 IP 与 Aliyun 新加坡 endpoint，测试：

```text
oss-ap-southeast-1.aliyuncs.com
vip-lixian-07.oss-ap-southeast-1.aliyuncs.com
```

物理 WLAN 真实 DIRECT：

```text
TLS 正常
匿名 bucket 请求返回 AliyunOSS 403 AccessDenied
```

尤其关键的是：bucket 原生域名落到与 PikPak 自定义 CNAME 相同的 47.79.49.x 地址，但不再 reset。

因此阻断差异与 Host/SNI 高度相关，而不是存储节点本身不可达。

## 6. 上传器 endpoint 改写实验

保持 PikPak 返回的：

```text
STS
bucket
key
expiration
```

不变，只把：

```text
endpoint = upload-a10b.mypikpak.com
cname    = true
```

改成：

```text
endpoint = oss-ap-southeast-1.aliyuncs.com
cname    = false
```

然后继续使用 PikPak Web 自己的 `aliYunOssAdapter` multipart upload。

### 6.1 8 MiB

成功：

```text
maxProgress = 100
elapsed ≈ 4.07 s（其中一次样本）
throughput ≈ 15.71 Mbps
```

上传后轮询 PikPak task：

```text
progress = 100
phase    = PHASE_TYPE_COMPLETE
allDone  = true
```

说明完整闭环成立。

### 6.2 32 MiB A/B

#### 原始 PikPak endpoint（现有规则，经代理）

```text
elapsed ≈ 17.71 s
throughput ≈ 14.45 Mbps
progress = 100
PHASE_TYPE_COMPLETE
```

#### 标准 Aliyun OSS endpoint（DIRECT）

```text
elapsed ≈ 9.24 s
throughput ≈ 27.72 Mbps
progress = 100
PHASE_TYPE_COMPLETE
```

两者都完整成功。DIRECT 样本约为代理样本 1.9 倍，但该比例不应被视为长期固定性能。

## 7. Mihomo 路由验证

用户当前规则中：

```text
DOMAIN-KEYWORD,pikpak -> 节点选择
aliyuncs.com           -> Neo拼车-cn -> 国内服务 -> DIRECT
```

在标准 OSS endpoint 上传样本中：

```text
PikPak 泛代理规则：数据阶段无新增命中
Neo拼车-cn：出现 OSS 请求命中
国内服务 selector：DIRECT
```

因此实现了真实：

```text
PikPak control plane -> proxy
Aliyun OSS data plane -> direct
```

## 8. 一次失败的测试方法与教训

早期为了做 A/B 曾切 Mihomo 全局 runtime mode 到 DIRECT，导致整机其他依赖代理的项目短暂断链。

之后又尝试“载入一份仅增加精确规则的完整临时配置”，但发现磁盘配置文件内保存的 `mode: direct` 与 runtime `mode: rule` 不一致；完整 reload 又意外影响全局 mode。测试脚本在上传前主动中止，并立即恢复 runtime 为 `rule`。

因此项目永久规定：

> 不切全局 mode，不 reload 整份 Mihomo 配置做局部实验。

最终成功方案完全不需要修改 Mihomo：只在上传器内部把 endpoint 改成已有规则天然 DIRECT 的 `aliyuncs.com`。

## 9. 清理

实验创建的测试 file/task 均通过 PikPak API 清理；文档与脚本不保留真实 STS secret、Cookie、token。

## 10. Node 原生文件 CLI 实验（2026-08-30 追加）

在网页内 Aliyun SDK 探针成功后，又实现了 Node 侧 `ali-oss` uploader：

```text
本地文件路径
  ↓ Node 流式 SHA-1
PikPak Web 控制面创建 task
  ↓ 短生命周期 STS（只在进程内存）
Node ali-oss multipartUpload(localPath)
  ↓ 原生 aliyuncs endpoint / DIRECT
PikPak task check-in
```

### 10.1 8 MiB 真实本地文件

测试文件位于项目 `.tmp/`，被 `.gitignore` 排除；成功后使用显式
`--trash-after-success` 清理 PikPak 测试文件。

第一次 Node 原生实验：

```text
local size       = 8 MiB
partSize         = 5 MiB
parallel         = 4
OSS elapsed      ≈ 4.5 s
PikPak check-in  ≈ 61 s
final progress   = 100
phase            = PHASE_TYPE_COMPLETE
```

这个样本暴露出一个重要边界：**OSS object 完成与 PikPak 元数据检入可能相差约一分钟。**
因此正式 CLI 的默认 check-in timeout 已从 60 秒提高为 180 秒；timeout 时不自动删除任务。

### 10.2 自动 region 发现

对 `upload-a10b.mypikpak.com` 查询 CNAME，AliDNS、Cloudflare、Google 三家 DoH 均一致返回：

```text
vip-lixian-07.ap-southeast-1.thepacificphs.com
```

其中同时包含：

```text
bucket = vip-lixian-07
region = ap-southeast-1
```

因此实现了自动发现策略：

- 多家 DoH 查询 CNAME；
- 至少两家对同一 region 达成一致；
- CNAME 中 bucket 必须与 PikPak task 返回 bucket 完全一致；
- 冲突或证据不足时 `direct-only` 拒绝猜测。

随后不传 `--region` 再跑 8 MiB Node CLI：

```text
region source    = doh-cname-consensus
consensus        = 3
OSS elapsed      ≈ 4.1 s
PikPak check-in  ≈ 20.6 s
final            = COMPLETE
```

说明“自动 region -> Node Direct upload -> PikPak complete”完整闭环已成立。

## 11. 单文件大小与 STS 有效期实验

当前 Web bundle 中定位到前端文件大小限制：

```text
桌面 Web：> 20 GiB -> 前端标记 UPLOAD_TASK_FAILED
移动 Web：> 4 GiB  -> 前端标记 UPLOAD_TASK_FAILED
```

其中单位常量为 `1024^3`，因此是 GiB 量级，不是十进制 GB。

为判断这是否是后端硬限制，进行了“只创建 task、不上传正文、随后立即清理”的实验：

```text
声明 21 GiB  -> create resumable task 成功
声明 100 GiB -> create resumable task 成功
```

说明至少当前 create-task 后端没有复刻 Web UI 的 20GiB 限制；Node CLI 理论上可以突破前端限制。

但两次 task 返回的 STS `expiration` 均约为**创建后 12 小时**。

这意味着：

- Web UI 的 20GiB 限制可能部分规避了超长上传与 STS 生命周期问题；
- Node CLI 若支持 100GiB 以上乃至 TB 级单文件，必须设计 STS refresh / credential renewal；
- 在换证机制验证前，不应声称“任意 TB 单文件稳定支持”。

## 12. 结论

当前账号/当前 PikPak Web 实现下，以下架构已经被完整验证：

```text
PikPak API create task
       ↓ PROXY
获取 Aliyun resumable 参数
       ↓
自定义 CNAME -> 标准 OSS endpoint
       ↓ DIRECT
Aliyun multipart upload
       ↓
PikPak task check-in
       ↓ PROXY
COMPLETE
```

这条路线可作为后续正式 CLI 与冷仓迁移器的技术基础。
