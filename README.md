# DSH 控制台

手机（鸿蒙）远程使用家里电脑上的 DSH。电脑侧是一个 DSH 插件，手机侧是一个原生 ArkTS App。
不在同一网络时，插件自己拉 cloudflared 隧道，校园网也能连回来。

```
┌────────────┐   局域网 8909 / https://xxx.trycloudflare.com    ┌──────────────┐
│  鸿蒙 App   │ ─────────────────────────────────────────────▶  │  DSH 桌面端   │
│  配对码 → 访问码 │         /v1/pair /v1/sessions /v1/cmd          │  插件 dsh-console-oh │
└────────────┘                                                  └──────────────┘
```

三块东西：

| 目录 | 是什么 | 装在哪 |
| --- | --- | --- |
| `plugin/` | DSH 插件（电脑侧）：局域网服务、6 位配对码、cloudflared 隧道、会话桥 | 电脑的 DSH |
| `app/` | 鸿蒙 App（ArkTS 工程）：配对、会话列表、对话 | 手机 |
| `tools/` | 演示服务器、图标生成、设计稿截图 | 只在电脑上跑，方便先看效果 |

---

## 快速开始

### 1. 电脑：装插件

DSH 侧栏 → 插件 → 添加插件 → 粘贴本目录 `plugin` 的绝对路径。
或者命令行（`desktop` 换成你自己的 profile 名）：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-console-oh\plugin
```

装完完全退出 DSH（含托盘）再启动。打开 **设置 → DSH 控制台**，能看到节点名、配对二维码、6 位配对码、局域网地址。

> 插件是 `link:` 方式装的，改完代码**完全退出 DSH 再启动**即可生效，不用重新 `add`。
> 二维码生成用的是包内自带的 `lib/vendor/qrcode`（MIT，从 npm `qrcode@1.5.4` 抠出来的最小集），所以插件零运行时依赖。

> 和社区里的 `dsh-console-hm` 不冲突：id 不同、端口用 8909，可以并存。

### 2. 手机：编译 App

用 DevEco Studio 打开 `app/`，首次会提示同步；然后：

1. `File → Project Structure → Signing Configs` 勾选自动签名（需要登录华为账号）
2. 设备选真机，Run

> 只在自己机器上用，不必上架，签名用调试证书就够。

如果 DevEco 报 SDK 版本不匹配，改 `app/build-profile.json5` 里的
`compatibleSdkVersion` / `targetSdkVersion`，换成你本机已安装的版本（例如 `"6.0.0(20)"`）。

### 3. 配对（两种，扫码最省事）

**扫码**：App 打开 → 「扫一扫，直接连上」→ 对着电脑面板上的二维码扫一下，完事。

二维码里装的是 `dshconsole://pair?u=<当前地址>&k=<一次性票据>&n=<节点名>`：
地址自动带（开了隧道就是那条 https），票据 2 分钟过期、扫一次即作废。

**手动**（扫不了时兜底）：

1. 面板 → 访问控制 → 打开「局域网访问」（默认只监听 127.0.0.1，关了手机连不进来）
2. 手机和电脑连同一个 WiFi
3. App 里填面板上的局域网地址，例如 `10.10.140.160:8909`（虚拟网卡已自动过滤）
4. 填面板上的 6 位码 → 连接

配对码 15 分钟有效、用掉一次就作废；配对成功后拿到的访问码存在手机本地，下次打开直接进会话列表。

### 4. 不在同一网络（校园网 → 家里）

1. 电脑面板 → 公网访问 → **开通**（第一次会自动下载 cloudflared，约 31MB；GitHub 直连不通会自动换镜像）
2. 拿到 `https://xxxx.trycloudflare.com`，点复制
3. 面板 → **异地配对** 开关打开（这是安全闸门，默认关；扫码配对不需要它）
4. 手机 App：点「扫一扫」扫面板二维码；扫不了就手动填 https 地址 + 新配对码
5. 连上之后，把异地配对关掉

隧道地址每次启动都会变；变了过去面板复制新地址即可。

自动下载都不通时，装一个现成的，插件会优先用它：

```powershell
winget install --id Cloudflare.cloudflared
# 或手动下载 cloudflared.exe 丢到：%USERPROFILE%\.dsh\dsh-console-oh\bin\
```

---

## 电脑侧插件做了什么

- 默认只监听 `127.0.0.1:8909`，公网走隧道；要同 WiFi 直连得在面板显式打开「局域网访问」
- 6 位码：15 分钟过期、一次一换；同一来源错 10 次锁 15 分钟（按真实来源分桶，不会被人用几个错码把你整体锁死）
- 二维码：一次性票据（2 分钟、兑换即焚），只印在电脑屏幕上，所以不受「异地配对」限制
- 访问码：24 字节随机，**state.json 里只存 sha256**，文件泄露也换不出可用的码；30 天过期
- 面板可以单独「断开」某台设备；也可以开「只读模式」，让手机只能看、不能发
- 公网来源（带 `x-forwarded-for`）必须开了「异地配对」才允许输 6 位码
- 只暴露 4 个动作给手机：列会话、读轮次、发消息、停止；不开放文件读写、不接受客户端指定工作目录
- 落地页和 `/health` 不含主机名、内网 IP、端口；不返回 CORS 头；不接受 `?token=`

### 手机侧接口

| 路径 | 方法 | 要访问码 | 作用 |
| --- | --- | --- | --- |
| `/` | GET | 否 | 落地页，确认服务在线（浏览器可直接打开） |
| `/health` | GET | 否 | 存活检查 |
| `/v1/pair` | POST | 否 | `{code,label}` → `{token,node}` |
| `/v1/pair/ticket` | POST | 否 | `{ticket,label}` → `{token,node}`（二维码里的一次性票据） |
| `/v1/info` | GET | 是 | 节点、DSH 状态、会话数、隧道状态 |
| `/v1/sessions` | GET | 是 | 会话列表（过滤子智能体与空会话） |
| `/v1/sessions/{id}/turns` | GET | 是 | 按轮次读对话 |
| `/v1/cmd` | POST | 是 | `send` / `cancel` / `create` / `rename` / `models` |

访问码只认 `x-console-token` 请求头（不接受 `?token=`，避免进日志和浏览器历史）。
错误一律 `{ok:false,error}`，不抛异常。

### 配置

写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖：

```yaml
- id: dsh-console-oh
  config:
    port: 8909
    name: "我的笔记本"
    tunnel: false            # 启动时是否自动拉隧道
    cloudflaredPath: ""      # 自己放的 cloudflared.exe 优先
    downloadBase: ""         # 下载镜像前缀，留空用内置的三路（github → gh-proxy → ghfast）
```

---

## 界面

深色、单一强调色、所有容器圆角 18–28（钝角）、1px 描边不用阴影。
三屏设计稿在 `tools/preview-*.png`，和 ArkTS 里的数值是同一套。

- **配对**：地址 + 6 格码，指针跟着输入走
- **会话**：节点状态灯、会话列表、运行中标记、新建/刷新
- **对话**：用户气泡靠右、回答整幅排版、代码块等宽可横滑、运行中有停止按钮

---

## 自测

```powershell
cd plugin
node test/selftest.mjs     # 服务层：配对、一次性、鉴权、公网闸、发消息、重启后访问码
node test/host-test.mjs    # 宿主半边：路由注册、会话过滤、prompt 透传
```

想先看手机端效果、又暂时不想装插件：

```powershell
node tools/demo-server.mjs     # 假数据，控制台打印配对码
```

然后用 App 连 `你的局域网IP:8909`，能走完配对、列表、对话、发消息全流程。

---

## 安全边界

这套东西的本质是「授权远程操作这台电脑」——发一条消息，DSH 的 agent 就会按你的权限改文件、跑命令。所以配对等于交出遥控器，按这个前提看：

| 项 | 现状 |
| --- | --- |
| 传输 | 公网段是 TLS（Cloudflare 终结），本机到 cloudflared 走回环；**局域网直连是明文 HTTP**，所以默认关着 |
| 认证 | 192 bit 访问码，服务端只存 sha256，恒定时间比较，30 天过期，可单台撤销 |
| 配对 | 二维码票据 128 bit / 2 分钟 / 一次性；6 位码按来源分桶限流 |
| 撤销 | 面板「已配对设备」里逐台断开，立即生效 |
| 最小权限 | 只读模式（只能看 + 停止）、不开放任意 cwd、不开放文件接口 |
| 信息暴露 | 落地页/健康检查不吐任何主机信息；没有 CORS 头；错误文案会抹掉本地路径 |
| 面板 | `/api/dsh-console-oh/*` 只接受回环 Host，DSH 端口被暴露也读不到配对码 |
| 依赖 | cloudflared 下载后校验 Authenticode，签名主体必须是 Cloudflare, Inc.，不符即删 |
| 信任边界 | Cloudflare 能看到明文内容；cloudflared 可执行文件来自镜像下载，目前只校验了大小（建议自己从官网放一份到 `~/.dsh/dsh-console-oh/bin/`） |

还剩的风险，说清楚：**访问码泄露 = 拿到 RCE**（没有二次确认，只读模式默认关）；**手机丢失且未锁屏 = 同上**；**局域网一旦打开就是明文**。这三条是设计取舍，不是 bug，介意就走隧道 + 开只读。

## 验证情况

已经在本机跑过：

- 插件服务层 + 宿主半边自测全部通过（`node test/selftest.mjs`、`node test/host-test.mjs`）
- 演示服务器上的真实 HTTP 往返：配对 → info → 会话 → 轮次 → 发消息 → 停止
- 扫码配对的服务端链路：`pairLink` 生成 → 票据换访问码 → 票据一次性 → 假票据被拒
- 二维码图形与 npm `qrcode@1.5.4` 逐字节一致（三段不同长度的链接都比对过）
- 面板 `/qr` 路由返回 `image/svg+xml`（宿主半边自测里跑过）
- App 在 DevEco 6.0.1 / HarmonyOS 6.0.1(21) 上 **编译 + 签名通过**（`BUILD SUCCESSFUL`），ScanKit 扫码接口已随包编译
- cloudflared：自动下载（GitHub 直连不通，落到镜像成功）、拉起、从日志抠出 `https://*.trycloudflare.com`、停止

没有验证：

- 扫码动作没在真机上点过（编译通过，但相机/扫码 UI 未实测）
- 插件没在你真实的 DSH 里逐字段核对：宿主契约按 `sessionController`（`list` / `projections` / `prompt` / `cancel`）实现，用 mock 全流程跑通

## 其它边界

- **对话是整轮刷新**（2.2 秒一次），不是逐字流式。DSH 的 `turnOutline` 目前只在轮次落定时给完整回答。
- 没做扫码配对和消息推送：配对走 6 位码，通知靠打开 App 时刷新。
- 隧道是 cloudflared 免费 quick tunnel，地址不固定；要固定域名得自己挂 frp 或 cloudflared 命名隧道。

MIT，自用为主。