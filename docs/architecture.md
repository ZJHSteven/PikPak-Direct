# 架构说明

## 1. 问题模型

PikPak-Direct 面对的是一个典型的“控制面与数据面必须分流”的问题。

用户当前 Windows 网络由 Mihomo TUN 接管。PikPak Web 的登录、地区判断、账号 API 在中国大陆真实 DIRECT 链路下不可稳定访问，因此这些请求需要保留现有代理规则；但代理服务每月只有有限流量额度，不能承载 TB 级文件正文。

因此项目不能追求“整个 PikPak DIRECT”，而应追求：

```text
控制面 -> PROXY
数据面 -> DIRECT
```

## 2. 官方 Web 上传链路（本机逆向观察）

当前 Web 前端的上传过程可抽象为：

```text
本地文件
   │
   │ 读取/计算 hash
   ▼
POST PikPak /drive/v1/files
   │
   │ body 中声明：
   │ upload_type = UPLOAD_TYPE_RESUMABLE
   │ provider    = PROVIDER_ALIYUN
   ▼
PikPak 返回
   ├─ file.id
   ├─ task.id
   └─ resumable.params
      ├─ access_key_id
      ├─ access_key_secret
      ├─ security_token
      ├─ expiration
      ├─ endpoint
      ├─ bucket
      ├─ key
      └─ cname
   │
   ▼
aliYunOssAdapter
   │
   │ Aliyun OSS multipartUpload(key, file)
   ▼
OSS object complete
   │
   ▼
GET PikPak /drive/v1/tasks/{taskId}
   │
   ▼
progress = 100
phase = PHASE_TYPE_COMPLETE
```

前端 bundle 中观察到的核心行为：

- Web 会懒加载 `aliYunOssAdapter`；
- Adapter 使用 Aliyun OSS SDK；
- `resumable.params.endpoint`、`bucket`、`key`、STS 凭据直接来自 PikPak task create 响应；
- `cname=true` 时 SDK 使用 PikPak 自定义 OSS CNAME；
- 上传完成后前端轮询 PikPak task，而不是再次把正文传给 PikPak API。

## 3. 为什么 endpoint 可以改写

当次实验返回：

```text
endpoint = upload-a10b.mypikpak.com
bucket   = vip-lixian-07
cname    = true
```

对真实公网 IP 的隔离探针发现：

```text
upload-a10b.mypikpak.com
同一组 47.79.49.x IP
TCP connect 成功
HTTP/TLS 在 Host/SNI 阶段 reset
```

而标准 Aliyun OSS bucket 域名：

```text
vip-lixian-07.oss-ap-southeast-1.aliyuncs.com
```

在相同 47.79.49.x IP 上真实 DIRECT：

```text
TLS 正常
匿名请求返回标准 AliyunOSS 403
```

因此阻断点不是 OSS 节点本身，而与 PikPak 自定义 Host/SNI 强相关。

将上传参数改为：

```text
endpoint = oss-ap-southeast-1.aliyuncs.com
cname    = false
```

其余 STS、bucket、key 不变，multipart upload 与 PikPak task check-in 均成功。

## 4. Mihomo 中的实际路由

用户现有规则中：

```text
DOMAIN-KEYWORD,pikpak -> 节点选择（代理）
*.aliyuncs.com        -> Neo拼车-cn -> 国内服务 -> DIRECT
```

因此 endpoint 改写后，最终效果天然是：

```text
api-drive.mypikpak.com
        -> PROXY

vip-lixian-07.oss-ap-southeast-1.aliyuncs.com
        -> DIRECT
```

不需要修改 Mihomo 全局 mode，也不需要新增长期规则。

## 5. 正式实现必须解决的动态 region 问题

当前实验中的 `ap-southeast-1` 不能永久硬编码。

正式实现应按以下优先级推导 region：

1. 如果 PikPak 响应未来直接提供 region 字段，优先使用显式字段；
2. 如果自定义 endpoint 可通过 DNS/CNAME 解析出标准 OSS region，使用该证据；
3. 如果 bucket 可通过 Aliyun OSS 错误响应/region header 安全探测，使用只读探针；
4. 必要时维护“已验证 endpoint -> region”缓存，但必须带时间与证据来源；
5. 无法可靠确定时不得猜测，回退到 server endpoint 或安全失败。

## 6. 回退策略

```text
provider == PROVIDER_ALIYUN ?
    │
    ├─ 能确定 region
    │    └─ 原生 aliyuncs endpoint -> DIRECT
    │
    └─ 不能确定 region
         ├─ 用户允许代理正文 -> server endpoint
         └─ 用户禁止代理正文 -> fail closed

provider != PROVIDER_ALIYUN
    └─ 不做 Aliyun 改写；进入 provider-specific handler 或安全失败
```

正式 CLI 应提供类似：

```text
--data-route direct-only
--data-route prefer-direct
--data-route server
```

其中：

- `direct-only`：无法确定安全 DIRECT endpoint 就停止；
- `prefer-direct`：优先 DIRECT，必要时提示并回退；
- `server`：完全尊重 PikPak 返回 endpoint。

对用户当前 200GB/月代理配额的场景，长期默认应考虑 `direct-only` 或 `prefer-direct`，避免静默把 TB 正文送进代理。

## 7. 凭据生命周期

STS 参数只能存在于短生命周期内存对象中：

```text
PikPak API response
      ↓
memory-only UploadSession
      ↓
Aliyun SDK
      ↓
完成/过期后释放
```

禁止：

```text
console.log(resumable.params)
JSON.stringify 全响应到磁盘
fixture 录制真实响应
将 access_key_secret 写入错误报告
```

持久 manifest 只能记录非敏感信息，例如：

- local path；
- size / mtime；
- PikPak file id；
- task id；
- provider；
- endpoint 的域名（可选）；
- bucket（若确认不涉及敏感身份）；
- object key 脱敏摘要；
- complete / verified 状态；
- 时间戳。

## 8. 网络实验隔离原则

由于 Mihomo 使用 TUN + Fake-IP：

单纯：

```text
curl --interface 192.168.x.x https://host
```

不够。系统 DNS 仍可能返回 198.18.x.x Fake-IP。

真正旁路探针应同时做：

```text
独立 DoH -> real IP
curl --interface <physical IPv4>
     --resolve host:443:<real IP>
```

并验证 Mihomo 对应规则的 `hitCount` 没有增加。

这种探针只用于诊断，不应成为生产上传主路径；生产上传应通过原生 `aliyuncs.com` 域名自然命中现有 DIRECT 规则。

## 9. 冷仓迁移的上层流程

未来 Cold Archive 不直接调用“移动”，而是：

```text
scan
 ↓
classify
 ↓
upload
 ↓
PikPak task COMPLETE
 ↓
verify
 ↓
write manifest
 ↓
90_待删除观察区
 ↓
显式 destructive approval
 ↓
delete local
```

这样 Direct Upload 只负责可靠传输，文件生命周期策略由更上层的迁移器负责。
