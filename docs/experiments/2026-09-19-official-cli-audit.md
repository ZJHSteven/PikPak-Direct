# 2026-09-19 PikPak 官方 CLI v0.5.1 静态审计

## 目的

回答两个不同的问题，避免混为一谈：

1. 官方 CLI 是否明显包含恶意程序/安装器副作用？
2. 是否已经有足够证据证明它“零遥测、零后台联网、零自启动”，从而允许放进全局信任环境？

第二个问题的证明门槛明显更高。“没有发现恶意”不等于“可以证明没有遥测”。

## 官方来源

- CLI 页面：`https://mypikpak.com/en-US/cli`
- 版本配置：
  `https://config.mypikpak.com/config/v1/command_line?client=global`
- v0.5.1 Windows AMD64：
  `https://download.mypikpak.com/cli/release/v0.5.1/pikpak_windows_amd64.exe`
- 官方 checksums：
  `https://download.mypikpak.com/cli/release/v0.5.1/checksums.txt`

本轮只把二进制下载到 `%TEMP%` 做静态审计，**没有执行或安装 CLI**。

## 安装器观察

官方 `install.sh` 主要行为：

1. 访问 `config.mypikpak.com` 获取最新版与 asset URL；
2. 下载对应平台单个二进制；
3. Linux/macOS 默认放到 `~/.local/bin/pikpak`；
4. 若安装目录不在 PATH，会修改 shell profile 加 PATH；
5. 检测到 Claude/Codex/Gemini/Cursor 等 Agent 时只打印提示，
   不会自动执行 `pikpak skill install`。

在该安装器中没有看到创建 systemd/launchd/Windows Service、计划任务或登录自启动项的逻辑。

这只能证明**该安装器脚本**没有这些副作用，不能证明 CLI 二进制运行时没有后台行为。

## Windows 二进制供应链检查

下载文件大小：

```text
41,682,432 bytes
```

本机 SHA-256：

```text
57086092066f2ae8791290cf25870abdc165d855eaedb5fd175d9724e953ae51
```

官方 `checksums.txt` 中 `pikpak_windows_amd64.exe`：

```text
57086092066f2ae8791290cf25870abdc165d855eaedb5fd175d9724e953ae51
```

两者完全一致，因此当前下载文件与 PikPak 官方发布清单一致。

## Authenticode

Windows `Get-AuthenticodeSignature` 结果：

```text
SignatureStatus : NotSigned
```

即 v0.5.1 的 Windows EXE 当前没有可验证的 Authenticode 发布者签名。

这不意味着文件一定恶意，但意味着 Windows 侧缺少一层发布者身份/签名链验证；
供应链信任主要依赖 HTTPS 下载来源与官方 checksum。

## Defender

使用本机 Microsoft Defender 对该临时 EXE 做自定义静态扫描：

```text
Scan finished.
found no threats.
```

解释边界：

- 这是“没有发现已知恶意特征”的证据；
- 不是“代码无漏洞”的证明；
- 更不是“不会收集遥测/崩溃信息”的证明。

## 官方认证与权限模型

PikPak 官方 FAQ 明确说明：

- CLI 登录通过浏览器授权，CLI 不直接接触 PikPak 登录密码；
- 每个 CLI 会话作为 Connected App 出现在账号安全页面；
- 无人值守场景可使用 PAT；
- CLI 属于 Connected Apps，而不是 Android/iOS/Windows/macOS/Web/TV 官方客户端的配额分类。

因此从凭据设计看，官方 OAuth/Connected App 比“第三方 CLI 直接保存账号密码”更合理。

## 关于遥测：当前无法证明“零遥测”

截至本轮检查：

- 官方 CLI 页面/FAQ 没有给出“CLI 零遥测”承诺；
- Windows 二进制未公开对应源码，无法通过 source review 完成可重复证明；
- 本地安全层阻止了进一步对二进制做大规模字符串/端点提取，本轮没有绕过该限制；
- 未在全局环境执行二进制，因此也没有做运行时抓包。

所以目前最多能说：

> 没有证据证明它是恶意软件；但也没有足够证据证明它只与 PikPak 必要 API 通信、
> 不发送任何遥测或崩溃信息。

## 项目决策

按照本项目/用户的高隐私门槛：

1. **不把 PikPak 官方 CLI 安装进全局环境作为默认依赖。**
2. 当前 Cloud Download 优先复用已经登录的 PikPak 官方 Web 控制面。
3. 如果未来确实需要 CLI，再在 Sandbox Plus / 受控隔离环境中做动态网络审计：
   - 首次启动但不登录；
   - `--help` / `version`；
   - 浏览器 OAuth 登录；
   - list / upload / cloud-download 单项操作；
   - 退出后静置；
   分阶段记录 DNS、TCP/TLS 目标与持久化改动。
4. 只有在运行时行为也满足要求后，才重新评估是否移出沙盒。

## 临时文件

本轮下载的安装器、版本 JSON、checksums 和 EXE 仅用于静态审计，
审计完成后从 `%TEMP%` 删除，不纳入仓库。
