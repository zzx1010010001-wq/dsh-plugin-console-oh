# dsh-plugin-console-oh · DSH 控制台（电脑侧插件）

DSH 里的控制台面板：出 6 位配对码、起局域网服务、按需拉 cloudflared 隧道，
配套 **HarmonyOS NEXT 手机 App「DSH 控制台」**，随时随地查看会话、读对话、发消息、停生成。

## 功能

- **会话管理**：列会话、新建、归档/恢复/删除（走 DSH 原生回收站）、批量操作、重命名
- **对话**：完整回合流（含思考过程）、生成中插话、图片随消息发送、模式切换、模型目录
- **配对**：6 位配对码（15 分钟一次一换）/ 二维码一次性票据；「我的电脑」信任直连——设备密钥签名，token 失效免扫码重连
- **面板**：节点信息、双通道配对码（局域网/公网）、隧道开关与地址复制、异地配对开关、设备列表（含信任标记）

## 安装（桌面端）

**方式一 · 添加插件对话框**（推荐）：DSH 插件页 → 添加插件 → 输入包名 `dsh-plugin-console-oh` → 安装 → 完全退出 DSH（含托盘）重启。

**方式二 · 命令行**：

```powershell
cd ~/.dsh/profiles/desktop
pnpm add dsh-plugin-console-oh
# 再把 dsh-plugin-console-oh 加入 package.json 的 dsh.profile.bundles 数组，重启 DSH
```

**方式三 · 本地开发（改代码即时生效）**：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-console-oh\plugin
```

装完在 **设置 → DSH 控制台** 打开面板。

## 手机端

HarmonyOS NEXT 应用「DSH 控制台」：扫面板二维码或输 6 位配对码完成首次配对；
之后 token 过期/失效时，配对页点「我的电脑」即可用设备密钥签名免扫码重连。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：sessionController → 手机窄接口，注册面板路由 |
| `lib/server.mjs` | HTTP 服务：配对、信任直连、鉴权、会话、指令 |
| `lib/tunnel.mjs` | cloudflared 下载与生命周期 |
| `lib/client.js` | 面板 UI（`window.__ModuleLoader__` 格式，无构建步骤） |
| `test/selftest.mjs` | 服务层自测 |
| `test/host-test.mjs` | 宿主半边自测 |

## 安全

- 默认只监听 `127.0.0.1`，公网走隧道；同 WiFi 直连要在面板手动打开「局域网访问」（那一段是明文 HTTP）
- 配对码一次性、15 分钟；同一来源错 10 次锁 15 分钟（按真实来源分桶）
- 访问码 192 bit，state.json 只存 sha256，恒定时间比较，30 天过期，面板可单台撤销
- 信任直连：手机端生成 ECC P-256 密钥对，电脑端只存公钥哈希；签名带 ±60s 时间窗与防重放缓存；踢掉设备即吊销信任；新设备首次公网连接必须先完成扫码验证
- 支持只读模式：手机只能读会话、停止生成，发不出消息
- 公网来源的 6 位码配对必须显式打开「异地配对」；二维码票据不受限（只出现在电脑屏幕上）
- 手机只能：列会话、读轮次、发消息、停止、新建、改名。没有文件读写、不接受客户端指定工作目录
- 落地页与 /health 不含主机名/内网 IP/端口；不返回 CORS 头；不接受 ?token=
- 面板路由只接受回环 Host，非回环一律 403
- cloudflared 下载后校验 Authenticode 签名（Cloudflare, Inc.），不符即删除并拒绝启动

## 跨平台

- 服务本体是纯 Node.js，跟随 DSH 桌面端运行（Windows / macOS / Linux）
- cloudflared 按平台自动下载：Windows amd64（ARM64 Windows 走系统 x64 模拟，官方无原生包）、macOS Intel/Apple Silicon（tgz 自动解包）、Linux amd64/arm64（便携裸二进制）
- 供应链校验：Windows 验 Authenticode、macOS 验 codesign（签名者必须 Cloudflare, Inc.），不符即删除拒绝启动；**Linux 无统一签名机制，走镜像下载时无本地校验**，介意者可在配置里指定 cloudflaredPath 用自备二进制
- 真机验证状态：Windows x64 全量验证；macOS / Linux 为代码级验证（test/matrix.mjs 平台矩阵 12 项）+ 待真机回归
- 鸿蒙电脑：插件本身纯 Node 可随宿主运行，但官方无 cloudflared 鸿蒙资产——局域网模式可用，隧道待宿主生态支持

## 开发

```powershell
node test/selftest.mjs   # 服务层自测
node test/host-test.mjs  # 宿主半边自测
```

`@deepseek-ai/*` peer 依赖均标 optional，独立开发/发布不需要私有仓库访问权。

## License

MIT
