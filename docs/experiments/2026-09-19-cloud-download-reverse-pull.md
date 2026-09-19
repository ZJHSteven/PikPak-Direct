# 2026-09-19 Cloud Download 反向拉取实验

## 目的

验证以下链路是否真实可行：

```text
本地文件
  ↓
127.0.0.1 临时 HTTP 服务
  ↓
Cloudflare Quick Tunnel
  ↓
PikPak Cloud Download
  ↓
PikPak 云盘
```

核心目标不是“换一种上传客户端”，而是让 PikPak 服务器主动来取本机文件，
从而把正文传输归入 Cloud Download 路径，而不是普通 Upload 路径。

## 实验边界

- 不修改 Mihomo 全局 mode。
- 不修改现有命名 Cloudflare Tunnel 或 DNS。
- 不安装 PikPak CLI。
- 不读取或落盘 PikPak 账号密码、Cookie、PAT。
- 只使用 1 MiB 随机测试文件。
- 测试结束后删除 PikPak 远端测试文件并关闭临时公网入口。

## 实验步骤

### 1. 本地源文件

生成一个 1,048,576 字节随机文件：

```text
%TEMP%\pikpak-cloudpull-smoke\smoke-1m.bin
```

### 2. 临时 HTTP

仅监听：

```text
127.0.0.1:18765
```

因此局域网和公网都不能直接访问该端口。

### 3. Cloudflare Quick Tunnel

使用独立 Quick Tunnel 把上述 localhost 服务临时暴露为 HTTPS。

公网 HEAD 探针得到：

```text
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 1048576
CF-Cache-Status: DYNAMIC
```

说明 Cloudflare -> localhost 链路成立。

### 4. PikPak Web 创建 Cloud Download

在已经登录的 PikPak Web 官方页面中打开“云下载”，提交临时 HTTPS URL。

页面首先显示：

```text
smoke-1m.bin
未知 保存中
0%
```

随后本地 HTTP 服务实际观察到 PikPak/Cloudflare 方向的多次 GET：

```text
GET /smoke-1m.bin HTTP/1.1 -> 200
GET /smoke-1m.bin HTTP/1.1 -> 200
GET /smoke-1m.bin HTTP/1.1 -> 200
GET /smoke-1m.bin HTTP/1.1 -> 200
```

这些 GET 不是本机预检产生的；本机预检只做过一次 HEAD。
因此可以确认正文确实由远端主动通过 Tunnel 回拉。

### 5. PikPak 结果确认

Cloud Download 活跃任务从列表消失后，通过一次性 WebDAV/rclone 只读查询确认：

```text
My Pack/smoke-1m.bin
```

文件实际存在于 PikPak 云盘，证明不是只创建了占位 task。

随后执行测试清理并再次查询，确认该测试文件已不再存在。

## 结论

### 已确认

1. **反向拉取链路真实可行。**
2. PikPak Cloud Download 可以通过 Cloudflare Tunnel 主动读取本机临时 HTTP 文件。
3. 这条路径不要求本机向 PikPak 上传数据面 endpoint 建立长时间大流量连接。
4. Quick Tunnel 可以只在单次任务期间存在，任务结束后立即关闭。
5. 因为测试是从 PikPak 官方 Web 创建 Cloud Download，控制面没有引入额外 Connected App 凭据。

### 尚未确认

1. 这次 1 MiB 文件出现了 4 次完整 GET；需要正式 HTTP server 增加请求统计、
   Range/HEAD 支持与日志，判断大文件时是探测、重试还是会造成重复完整读取。
2. 尚未通过“Transfer Quota Details”做前后差分，因此不能仅凭架构断言该流量
   最终一定按哪一个 Connected Apps / Web 子分类计费。
3. 当前实验用的是 Cloudflare Quick Tunnel；自有域名 / named tunnel 尚未接入。
4. 当前仅验证单文件；目录打包、持久 manifest、加密、增量均未实现。

## 下一步

正式版本应建立一个受控临时文件服务器：

- 只监听 `127.0.0.1`；
- URL 路径包含至少 128~256 bit 随机 token；
- 不提供目录列表；
- 只暴露本次选中的单一文件；
- 支持 GET / HEAD / 单段 Range；
- 记录请求次数、Range、累计发送字节数；
- Cloud Download 完成或超时后立即关闭 server 与 tunnel。

控制面优先继续复用 PikPak 官方 Web 会话；官方 CLI 作为 Connected App 会受到
Connected Apps 25% 子额度，而且闭源二进制无法仅凭公开文档证明“零遥测”，因此不作为
本项目默认依赖。
