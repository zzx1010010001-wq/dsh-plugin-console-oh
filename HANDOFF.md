# DSH 控制台 — 交接摘要

> 用途：换平台/换会话后接续开发，避免重复踩坑。
> 修订：2026-11-20（v2.1；按"陌生人能否跑起来"重写，仅改本文件，未改动任何代码/配置/环境）
> 标注口径：**[已验证]** 有命令输出或截图证据；**[未验证]** 未执行过；**[待确认]** 事实不明，须向项目所有者确认。
> 修订记录：
> - v1：初版，事实未经独立抽检。
> - v2（2026-11-20）：重写为可交接版，新增 §0 基线、§7 验收清单、§9 仓库与回滚。
> - v2 补充事实：签名证书 2026-12-02 到期（`keytool -printcert`）、DSH 版本锚点 0.2.2-rc.5（`harness/resources/app/package.json`）、限流 `FAIL_LIMIT_PER_IP=10` / 15 min（`plugin/lib/server.mjs:24-25`）、思考上限 120000/400000（`plugin/lib/index.js:32,34`）。
> - v2.1（本轮）：修正轮询数值口径、P1#7 落点、§9 方案③ 前置。
> - v2.1（本轮）：补 §8「运维与清理」、R6 时限，以及本 changelog。

## 0. 基线信息（接手先核对）

| 项 | 值 | 状态 |
| --- | --- | --- |
| DSH 桌面端 | 0.2.2-rc.5（Electron 44.7.0，buildCommit `3f85d888…e179a4`，通道 nightly） | [已验证] `harness/resources/app/package.json` |
| DSH 可执行文件 | `D:\dsh-archive-20261120\02_程序目录_Programs\harness\DeepSeek Harness.exe` | [待确认] 是否最终位置 |
| 插件 | `dsh-console-oh` 0.4.2 | [已验证] `/health` 返回 `"version":"0.4.2"` |
| 插件安装 | profile `%USERPROFILE%\.dsh\profiles\desktop` 的 `dependencies` 中为 `link:D:/千问办公/…/outputs/dsh-console-oh/plugin` | [已验证] profile `package.json` |
| App 标识 | `com.dshconsole.phone`，versionName `1.0.0`，versionCode `1000000` | [已验证] `AppScope/app.json5` |
| 编译 SDK | target/compatible `6.0.1(21)`，runtimeOS `HarmonyOS` | [已验证] 编译副本 `build-profile.json5` |
| HAP | `entry-default-signed.hap`，823,504 B，构建于 2026-11-20 14:50:28 | [已验证] 文件属性 + `install bundle successfully` |
| 签名 | DevEco 自动签名（debug，`keyAlias=debugKey`，`SHA256withECDSA`）；证书 `CN="unknown(2086479494201250625),Development"`，SHA-256 `98:33:68:…:ED:3E:2D`，**有效期 2026-11-18 ~ 2026-12-02**；中间 `0D:AA:8A:…:71:80`、根 `Huawei CBG Root CA G2` `DF:21:A3:…:3A:37` | [已验证] `keytool -printcert` |
| 手机 | HUAWEI Pura X（`VOL-AL00`），`OpenHarmony-7.0.0.111`，`const.ohos.apiversion=26`，软件版本 `7.0.0.111(SP10C10E100R5P6)` | [已验证] `hdc shell param get` |
| hdc 序列号 | `8BBUT26A10002914` | [已验证] `hdc list targets` |
| 隧道 | cloudflared quick tunnel，进程起于 2026-11-20 15:03:01 | [已验证] 进程 + `/health` |
| 本轮时间线 | 14:50 构建 HAP → 15:03 隧道起来 → 读 `/health 0.4.2` → 首页/抽屉/筛选/工具条截图核对 | [已验证] 见 §7 |

> 签名证书 2026-12-02 到期（距基线日 12 天），到期后无法用同一签名重出包，见 R6。

## 1. 一句话现状

插件 0.4.2 + 隧道在跑，签名 HAP 已装机；本轮完成分类页、对话页、控制台头部三处 UI 重构，**首页、抽屉、筛选、对话工具条已真机核对**；下拉刷新、「+」三入口、更多操作、「↓ 回到最新」、相机图标观感、长会话思考滚动、系统返回键**均未验证**。DSH 目录与"分类页/控制台是否同屏"两项需先确认，否则 P0 验收无法收口。

## 2. 目标与边界

- 目标：在外面（手机 5G）操作家里电脑上的 DSH。
- 链路：手机 → `https://*.trycloudflare.com`（临时隧道）→ 本机 `127.0.0.1:8909`（插件）→ DSH `sessionController` / `workspaceController`。
- 形态：HarmonyOS ArkTS App（`app/`）+ DSH 插件（Node，`link:` 装入 profile）。
- 分发：hdc 侧载 / 分享 HAP，**不上架**。理由：软著 + APP 备案 + 隐私合规成本高，且"必须输入配对码才能用"与审核指南 3.2/3.4 冲突（依据 2026-10-30 版指南文本，[待确认] 后续版本是否变化）。
- 所有者偏好：只改指定项；交互不用隐藏手势（长按已被否），要可见标识 + 文案 + 确认框；讨厌反复扫码/重启。

一次发消息的路径（按段定位故障）：

1. `ChatView.send()` → `Api.sendRich()` → `POST /v1/cmd {op:'send'}`，图片以 base64 放进 `images`。
2. `server.mjs` 校验 token / 只读 → `bridge.command('send')`。
3. `index.js` 组装 `prompt` 内容块（text + image）→ `sessionController.prompt`。
4. App **对话页 2.2 s 轮询**（`ChatView.ets:118-120`）`GET /v1/sessions/:id/turns`；插件读 `events()`（失败退 `page()`）折成轮次。注意与列表轮询是两个独立定时器（列表见 `Index.ets:62-64`，9 s）。
5. 返回 `turns[]`（`response` 全文、`thinking`、`tokens`、`context`），App 重建 `Msg[]` 并决定是否跟随滚动。

## 3. 代码结构

根目录 `D:\千问办公\2026-11-18\mwm1li8r4dny42kj\outputs\dsh-console-oh\`（**唯一副本，无 git**）：

```
plugin/            电脑侧插件（零运行时依赖，二维码内嵌）
  lib/index.js     宿主半边：控制器桥接、归档/删除、思考抽取、历史翻页、8 条面板路由
  lib/server.mjs   手机侧 8909：鉴权、限流、配对码、二维码、/v1/*、VERSION 常量
  lib/tunnel.mjs   cloudflared 下载（GitHub→gh-proxy 回退）+ Authenticode 验签 + 拉起
  lib/client.js    DSH 设置面板里的「DSH 控制台」页
  lib/vendor/qrcode/  内嵌二维码（裁剪自 npm qrcode，MIT）
  test/            selftest host-test qr-test history-test tunnel-test thinking-real
app/               鸿蒙源码（编译需 ASCII 路径副本，见 §8）
  entry/src/main/ets/pages/Index.ets        路由状态机、列表 9 s 轮询（`Index.ets:62-64`）、断连回配对
  entry/src/main/ets/view/HomeView.ets      首页 = 控制台头部 + 分类列表（本轮大改）
  entry/src/main/ets/view/ChatView.ets      对话页（本轮大改；对话轮询 2.2 s，`ChatView.ets:118-120`）
  entry/src/main/ets/view/{PairView,ArchiveView,Dialogs}.ets
  entry/src/main/ets/service/{Api,Prefs,Scanner}.ets
  entry/src/main/ets/model/Types.ets、common/{Theme,Fmt}.ets
tools/             prepare-deveco / check-migrate / tap-session / make-icon / shot / demo-server
```

**测试套件（`cd plugin` 后 `node test/<name>.mjs`）**

| 套件 | 覆盖 | 断言 |
| --- | --- | --- |
| `selftest` | 配对码一次性、限流、鉴权、只读、设备撤销、`state.json` 无明文、默认只绑回环 | 20+ |
| `host-test` | 8 条面板路由、桥接归一化、归档态来源、跨页补历史、模型目录、图片消息、批量删除/回收站 | 30+ |
| `qr-test` | 二维码形状/内容、`u=&c=` 备选地址编码 | 5+ |
| `history-test` | 事件折叠、翻页游标、思考分离与上限、真实会话样本 | 20+ |
| `tunnel-test` | cloudflared 验签通过 / 伪造二进制被拒 | 2 |

**改哪里**

| 要改的东西 | 落点 |
| --- | --- |
| 首页布局、文件夹卡片、筛选、抽屉 | `view/HomeView.ets` |
| 对话页气泡、工具条、附件、更多操作 | `view/ChatView.ets` |
| 页面切换、轮询、断连回配对 | `pages/Index.ets` |
| 新增接口调用 / 错误文案 | `service/Api.ets` + `plugin/lib/server.mjs` |
| 会话数据形状 | `plugin/lib/index.js`（`listSessions`/`turns`）+ `model/Types.ets` |
| 颜色、圆角、间距 | `common/Theme.ets`（唯一来源，勿在页面硬编码） |

## 4. DSH 侧关键契约

以下每条都是实测结论，别再猜；改动前先确认 DSH 版本是否仍为 0.2.2-rc.5。

| 事项 | 结论 | 状态 |
| --- | --- | --- |
| 会话 id / 标题 | 在 `sessionId` 与 `projections.values.title`（不是 `id`/`title`，读错静默得到空列表） | [已验证] host-test + 真机 |
| 归档字段 | 会话摘要**没有** `archived`；归档集合在 `%USERPROFILE%\.dsh\storages\workspace.json` → `global.archivedSessionIds` | [已验证] 真机归档前后对比 |
| 归档 / 恢复 | `workspaceController.archiveSession({sessionId, stopActivity})` / `unarchiveSession({sessionId})`，返回完整归档集合 | [已验证] host-test + 真机 |
| 正文 | `turnOutline` 是导航预览（源码写死 `PROMPT_PREVIEW_LIMIT=50` / `RESPONSE_PREVIEW_LIMIT=120`），必截断；全文读 `events()`，失败退 `page()` | [已验证] 32 轮真实会话 |
| 翻页 | 不能拿 `page.cursor` 当 `beforeSeq`（本次日志切点，会原地打转）；用本页最老事件的 `seq` 前推 | [已验证] history-test |
| 模型目录 | `modelCatalog` 必须带参数，无参返回空对象且不抛错；按 `({sessionId},signal)` → `({sessionId})` → `(sessionId)` → `()` 试，并剥 `value/result/data/catalog` | [已验证] `debug-models.log` 的 `via` 命中第一种 |
| 识图 | wrapper provider id 以 `-vision` 结尾；按 `provider\|model` 配对 | [已验证] 真机切换 |
| 删除 | 无删除接口：会话目录移入 `~/.dsh/dsh-console-oh/trash/`，id 记 `hidden.json`；`purge` 清副本；运行中会话服务端拒绝 | [已验证] host-test + 真机 |
| 思考过程 | 独立 `reasoning` / `reasoning-text` 块（旧格式 `reasoning-delta`）；上限单轮 12 万字、单次 40 万字 | [已验证] history-test；长会话滚动 [未验证] |
| 版本锚点 | 以上均在 DSH **0.2.2-rc.5** 上得出 | [待确认] 升级后需复测 |

证据：`host-test.mjs`、`history-test.mjs`、`debug-models.log`（`via` 字段）、本轮真机截图。

## 5. 安全设计（已实现，勿回退）

- 访问码：24 字节随机，**只存 sha256**，TTL 30 天（`TOKEN_TTL_MS`），恒定时间比较，只认 `x-console-token` 头（不接受 `?token=`）— [已验证] selftest。
- 过期表现：服务端 401 `{"error":"访问码已过期，请重新配对"}`；App 命中「过期」即清 token 回配对页（`Index.ets` `refresh` → `goPair`）— [已验证] 代码路径 + selftest；真机到期 [未验证]。
- 配对码：6 位一次性 15 分钟；二维码票据 2 分钟、一次即焚、不受"异地配对"开关限制 — [已验证] selftest / qr-test。
- 限流：按真实来源分桶（直连用 socket 地址，走隧道取 XFF 最后一段），`FAIL_LIMIT_PER_IP=10` / 15 min；全局硬锁已移除（`FAIL_LIMIT_GLOBAL` 常量残留未使用）— [已验证] selftest 第 12 次 429。
- 监听：默认只绑 `127.0.0.1`；"局域网访问"需显式打开且界面标注明文 — [已验证] selftest。
- 面板路由：`panelGuard` 放行非 http(s) 协议、回环、`dsh.internal`、同源请求，其余 403 并写 `panel-denied.log` — [已验证] host-test；真机 403 的分层判断见 §10 坑 6。
- 只读模式：服务端强制（除"停止生成"外全 403）— [已验证] selftest。
- cloudflared：下载后与启动前各验一次 Authenticode，主体须为 Cloudflare — [已验证] tunnel-test（本轮未复跑）。
- 信任边界（非缺陷）：Cloudflare 可见明文；token 泄露等于电脑上的 agent 可被远程驱动，只读模式是唯一收窄手段。

**接口面（越界即破坏安全边界）**

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /v1/pair` / `/v1/pair/ticket` | 6 位码 / 二维码票据 | 换访问码；受异地配对开关与限流 |
| `GET /v1/info`、`/v1/sessions`、`/v1/sessions/:id/turns`、`/v1/models` | token | 节点状态、列表、轮次全文、模型目录 |
| `POST /v1/cmd` | token | `send / stop / create / archive / unarchive / delete / purge / models / selectModel` |
| `GET /health`、`GET /` | 无 | 仅 `{ok, app, version}` 与"服务在线"，不含主机名/内网 IP |

面板侧另有 8 条 `/api/dsh-console-oh/*`（`state/toggle/qr/tunnel/sessions/turns/send` 等），走 DSH 浏览器认证 + `panelGuard`，不对外暴露。

## 6. 本轮 UI 改动

- **分类页 + 控制台头部**（`HomeView.ets`）：文件夹卡片 22 圆角，图标 + 标题 + 「N 个会话 · 完整路径」+ 折叠箭头，整块可点；会话行左缩进 10 归入其下。
- 移除「刷新」按钮，改 `Refresh` 下拉刷新；`@Watch('onBusyChange')` 在 busy 结束时收圈。
- 右上角 `⌗` → 手绘相机图标（1.4 线宽、`C.sub`、按下底色 `C.card`，与 `⋯`/返回键共用 `stateStyles`）。
- 左上三条杠 → 抽屉：账户（应用 / 本机机型 `deviceInfo.marketName` / 访问码仅存本机）+ 已连接电脑（名字、地址、通道、DSH、会话数、隧道）+ 归档库 + 断开。
- 筛选条：全部 / 今天 / 7 天 / 30 天 / 隐藏归档（可切「含归档」）/ 查看全部；`sections()` 改为消费 `visible()`。
- **对话页**（`ChatView.ets`）：图片/文件/拍照收进发送键旁「+」（`plusOpen`，45° 旋转，展开三个 `AttachChip`）；顶栏 `⋯` → `MoreSheet()`（新建/归档/删除，每行带后果说明）；模型胶囊加大（13 号字、13×7 内边距、按压态）；思考默认展开（`thinkOpen` 改 `thinkClosed`，不设 maxLines）；`@State atBottom` 控制「↓ 回到最新」。

> 分类页与控制台头部按"同一屏的不同区域"实现（分类=列表区，控制台=头部+筛选）。这是实现现状，**是否为所有者本意 [待确认]**。

## 7. 验收清单（本轮未验证项）

前置：DSH 在跑、手机已解锁并与电脑配对。逐条勾选，失败项转缺陷记录（附文案/截图）。

- [ ] **下拉刷新** — 复现：列表顶部下拉过阈值松手。预期：出刷新圈、列表更新、结束自动收。失败：圈不收 / 不更新 / 与左滑抢占手势。
- [ ] **「+」三入口** — 复现：会话页点「+」→ 依次点图片 / 文件 / 拍照。预期：按钮转 45° 成 ×，三个胶囊可点，选完显示「已选 N 张图」。失败：无反应 / 不显示 / 面板打不开（记 `err`）。
- [ ] **更多操作** — 复现：对话页「⋯」→ 三项依次点。预期：新建回列表并建会话；归档、删除各自弹确认框，取消无副作用。失败：不弹框 / 归档后仍在列表 / 删除未进 `trash/`。
- [ ] **↓ 回到最新** — 复现：会话内上翻过一屏。预期：右下出现「↓」，点击回底并消失。失败：不出现 / 点击无位移 / 回底仍显示。
- [ ] **相机图标观感** — 复现：首页右上目视 + 按一次。预期：机身/镜头/顶盖对齐，线宽与 `⋯`、返回键一致，按下变深。失败：错位 / 线宽不一致 / 无反馈。
- [ ] **长会话思考滚动** — 复现：打开轮次最多的会话（**样本 id [待确认]**），展开 1 万字以上思考并滚动。预期：完整、不卡顿、不闪退。失败：卡死 / OOM / 文本被截断（确认是否触发 12 万字兜底）。
- [ ] **系统返回键** — 复现：对话页按返回，再在首页按一次。预期：第一次回首页，第二次才退出。失败：一次就退出；或退出后拉起系统助手（本轮观察 1 次，[未验证] 是否复现）。
- [ ] **5 套测试复跑** — 前置：`tunnel-test` 要下载/校验 cloudflared，依赖 GitHub 或 gh-proxy 外网，网络不通时先判网络再判代码。复现：`cd plugin` 跑 5 套。预期：全过。失败：任一 FAIL。当前：前 4 套本轮通过；`tunnel-test` 未复跑（`tunnel.mjs` 未改动，上次通过）。

## 8. 运行环境与命令

路径：源码（唯一副本）`D:\千问办公\2026-11-18\mwm1li8r4dny42kj\outputs\dsh-console-oh\`；编译副本 `C:\Users\L\DevEcoStudioProjects\DshConsole`；插件数据 `%USERPROFILE%\.dsh\dsh-console-oh\`；归档真源 `%USERPROFILE%\.dsh\storages\workspace.json`。

```powershell
robocopy 'D:\千问办公\2026-11-18\mwm1li8r4dny42kj\outputs\dsh-console-oh\app' `
  'C:\Users\L\DevEcoStudioProjects\DshConsole' /MIR /NFL /NDL /NJH /NJS `
  /XF build-profile.json5 /XD build .hvigor oh_modules
$env:PATH='D:\xiazai\DevEco Studio\jbr\bin;'+$env:PATH
$env:DEVECO_SDK_HOME='D:\xiazai\DevEco Studio\sdk'
& 'D:\xiazai\DevEco Studio\tools\node\node.exe' `
  'D:\xiazai\DevEco Studio\tools\hvigor\bin\hvigorw.js' assembleHap --no-daemon
$hdc='D:\xiazai\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
& $hdc install -r 'C:\Users\L\DevEcoStudioProjects\DshConsole\entry\build\default\outputs\default\entry-default-signed.hap'
```

插件生效/重装：宿主半边只在 DSH 启动时 import 一次 → 必须完全退出（含托盘）再启动，重启会杀掉 cloudflared 并换域名（手机需重扫）。重装：在 profile 目录 `dsh plugin --profile desktop add link:<plugin 绝对路径>`；`dsh` 不在 PATH，需先在 DSH「应用 → 管理 dsh 命令」安装 — [待确认] 该命令在 0.2.2-rc.5 下可用（本轮未执行，历史用图形界面添加）。

真机操作：`aa start` 报锁屏即已锁，`power-shell wakeup` 无效；防熄屏 `power-shell setmode 602` + `power-shell timeout -o 3600000`，结束 `timeout -r` + `setmode 601`；取坐标用 `uitest dumpLayout -p /data/local/tmp/x.json` 解析 `bounds` 再 `uinput -T -c x y`；列表 9 s 轮询（`Index.ets:64`）会冲掉滑开态，"滑动 + 点击"需 <1 s 连做。

**运维与清理**（交接或长期运行都要用）

- **脱敏**：`state.json` 存设备 `at/exp/hash/id/label`（`server.mjs:158`），`debug-history.json` 含会话标题与轮次正文片段，`debug-models.log` 含分组与模型 id。对外交接/截图前删除 `debug-*`，`state.json` 只留必要项；`hash` 虽不可逆，仍属凭据派生数据。
- **8909 被占用**：`Get-NetTCPConnection -LocalPort 8909 -State Listen | Select-Object OwningProcess`，再 `Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object Name,ExecutablePath` 确认是不是残留的 DSH 进程。
- **主动停隧道**：面板「公网访问 → 停止」写 `tunnelAuto=false`（`server.mjs:519-520`，持久化在 `state.json` 的 `tunnelAuto` 键），下次启动不再自动拉起；临时手段 `Stop-Process -Name cloudflared`，但 `tunnelAuto=true` 时下次启动仍会重拉 [已验证] 面板路径 / [待确认] 进程杀掉后的重启行为。
- **`trash/` 保留期**：会话目录移入 `%USERPROFILE%\.dsh\dsh-console-oh\trash\<sessionId>\`（`index.js:311`），代码里没有 TTL 或清理任务 → **永久保留、持续占盘**，需手工清；归档库「彻底删除」走 `fs.rmSync`（`index.js:643-649`），**不可逆**。
- **多设备 / token 上限**：`server.mjs:177-178` 同 `label` 覆盖、并 `slice(-19)` → 设备记录最多保留 20 条；并发连接数无显式限制 [待确认]（未测多台同时连）。
- **`tools/check-migrate.mjs`**：用途是校验"明文 token 迁移为 sha256 后，老配对是否仍可用"。结论：当前 `state.json` 设备字段为 `at/exp/hash/id/label`，无 `token` 字段（`Get-Content state.json | ConvertFrom-Json` 输出），**迁移已完成**；该脚本只读副本，不写状态。

**怎么确认改的代码生效**：插件看 `/health` 的 `version` 是否等于 `server.mjs` 的 `VERSION`（不等=宿主没重启）；`lib/client.js` 改动刷新面板即可；App 看界面特征（筛选条/附件胶囊）或 `hdc shell bm dump -n com.dshconsole.phone | grep updateTime`；隧道是否换域名看 `Get-Process cloudflared` 的 `StartTime`。

## 9. 仓库与回滚

- **无版本控制**：该目录不是 git 仓库，源码仅一份，`tools/`、`test/` 无备份。
- **runbook 风险**：`robocopy /MIR` 会删除目标端多余文件。目标目录里的 `build-profile.json5` 已排除，但若日后有人往目标目录放了别的东西，会被静默删除。
- **回滚方案（[待确认]，本轮未执行）**：① 改动前把 `outputs/dsh-console-oh/` 整目录复制到 `outputs/_backup/<时间戳>/`；② 推荐 `git init` + 首次提交，`.gitignore` 排除 `app/build`、`app/.hvigor`、`app/oh_modules`；③ 插件侧可单独回滚：`git checkout -- plugin/lib/index.js` 后重启 DSH（**须先执行方案②，否则仓库不存在，命令无效**）。
- 判断：无 git + 单一副本 + `robocopy /MIR` 叠加，属于**改坏了无法自证能回到上一版**的状态。

## 10. 已知坑（现象 / 报错原文 / 适用版本）

| # | 现象 | 报错原文 | 适用版本 |
| --- | --- | --- | --- |
| 1 | 中文父目录下直接编译 | `Invalid project path` | hvigor / DevEco 6.0.1；`app/` 本身无问题，是父目录 `D:\千问办公\…` |
| 2 | 在错误目录执行 hvigorw | `00304004 Not Found` + `Hvigor config file …\hvigor\hvigor-config.json5 does not exist` | 同上；必须在编译副本根目录执行 |
| 3 | 锁屏时拉起 App | `10106102 The device screen is locked during the application launch` | HarmonyOS 7 / API 26；装机不受影响 |
| 4 | ArkTS 推断不出类型 | `arkts-no-any-unknown` | DevEco 6.0.1；需显式 `const x: string = …` |
| 5 | 读设备型号用了不存在的字段 | `Property 'model' does not exist on type 'typeof deviceInfo'` | 同上；只有 `marketName` / `productModel` / `brand` |
| 6 | 面板接口被拒 | `403 forbidden`（DSH 自身返回，`panel-denied.log` 无记录） | 插件 0.4.x；具体是哪一层（DSH 鉴权 / 网关 / 插件）[待确认] |
| 7 | 对话页按系统返回，偶发退到桌面并拉起系统助手 | 无报错 | 本轮观察 1 次，[未验证] 是否复现 |

**故障速查**

| 症状 | 先查 | 常见结论 |
| --- | --- | --- |
| 手机一直"连不上" | `8909` 是否监听、cloudflared 是否在跑 | DSH 没起 / 隧道掉了，需重启 DSH 并重扫 |
| 能看码但扫码报"连不上" | 二维码里 `u=` 是 https 还是内网 IP | 隧道没开时只带内网地址，手机走 5G 必然失败 |
| 归档后仍显示 | `workspace.json` 的 `archivedSessionIds` | 未写入=接口失败；写入但列表没变=插件版本旧 |
| 模型只显示"选择模型" | `debug-models.log` 的 `groups` | `modelCatalog` 未命中带参调用，或 DSH 侧模型未就绪 |
| 回答末尾是「…」 | `turns` 响应的 `method` 是否为 `events` | 退回 `page()` 或只读了一页 |
| 面板提示「只允许在本机访问」 | `panel-denied.log` 的 `host` | 宿主内部域名变了，需扩白名单 |
| 改完行为没变 | `/health` 的 `version` | 宿主未重启（最常见） |

## 11. 未解决 / 待确认

| # | 事项 | 影响面 | 阻断 P0 |
| --- | --- | --- | --- |
| R1 | DSH 最终目录未确认；快捷方式仍指向失效的 `D:\dsh\harness` | 下次重启可能"起不来"，全链路不可用 | **是** |
| R2 | 系统返回键异常（坑 7） | 误触即退出应用，核心流程被打断 | **是** |
| R3 | 长会话思考滚动缺可定位样本 | 验收项无法复现 = 不能验收 | **是** |
| R4 | 无 git / 单一副本 / `robocopy /MIR` | 改坏无法回滚，可能丢整份源码 | 否（仅次于 P0） |
| R5 | 无发布证书与 keystore 备份，仅自动调试签名 | 换机/重装需重签，无法分发他人 | 否 |
| R6 | 调试证书 2026-12-02 到期（仅剩约 12 天） | 到期后无法用同一签名重出包，重装可能触发卸载（丢 token → 重扫码） | 否（有明确日期） |
| R7 | `install -r` 遇签名冲突需先卸载 | 卸载清 `Prefs` 的 base/token，必须重扫码 | 否 |
| R8 | 契约未锚定 DSH 版本（现锚 0.2.2-rc.5） | DSH 升级后 `events()`/`modelCatalog`/归档集合可能变，需整套复测 | 否 |
| R9 | trycloudflare 在境内移动网络可达性 | 仅实测过一次 5G 配对成功，长期/跨运营商未验证 | 否 |
| R10 | 轮询有两条：列表 9 s（`Index.ets:64`）+ 对话 2.2 s（`ChatView.ets:120`）；前者与下拉刷新、滑开态打架，后者耗电且与滚动抢帧 | 交互抖动、误触、发热耗电 | 否 |
| R11 | 「分类页」与「控制台」是否应拆两页 | 若本意是两页，本轮方向需返工 | 否（影响返工量） |

> **R6 时限**：须在 2026-12-02 前决策——(a) 申请长期证书（需 AGC 发布证书，通常要企业主体/资质，[待确认] 个人可否）；(b) 接受重签：卸载重装会清 `Prefs` 的 token，必须重扫码；(c) 什么都不做，到期后无法再出包，直到重新生成证书。另：换机后 DevEco 自动签名仍是 14 天短证书，此问题会复发。

## 12. 下一步计划

1. **P0** 确认 DSH 最终目录并重建快捷方式，更新 §0 与 R1。
2. **P0** 复现坑 7：对话页与首页各按返回 3 次记录落点；稳定复现则查 `Index.ets` `onBackPress` 与页面栈。
3. **P0** 向所有者要长会话 id，补进 §7 第 6 条，完成思考滚动验收。
4. **P0** 跑完 §7 剩余 6 项，逐条勾选，失败转缺陷。
5. **P1** 建 git 仓 + 首次提交（§9 方案②），此后每次改前提交。
6. **P1** 隧道固定域名（named tunnel + 自有域名）减少重扫；无域名则先在 App 侧把"地址变了"做成显式引导。
7. **P1** `history-test` 补 12 万字思考边界断言（上限实现在 `plugin/lib/index.js:32,34`；`Select-String -Path plugin\test\history-test.mjs -Pattern thinking` 命中 7 行，`host-test.mjs` 命中 0 行——断言集中在 history-test）；`tunnel-test` 纳入每轮必跑。
8. **P2** 轮询降频并只在前台跑：列表 9 s、对话 2.2 s → 15–20 s 且 App 切入后台即停；README 同步新交互（三条杠、筛选、下拉刷新）。

## 13. 接手第一小时 checklist

```powershell
# 1) DSH 是否在跑、加载的插件版本
Get-NetTCPConnection -LocalPort 8909 -State Listen
(Invoke-WebRequest 'http://127.0.0.1:8909/health' -UseBasicParsing).Content   # 期望 version 0.4.2
Get-Process cloudflared | Select-Object Id,StartTime

# 2) 插件 5 套测试
cd 'D:\千问办公\2026-11-18\mwm1li8r4dny42kj\outputs\dsh-console-oh\plugin'
node test/selftest.mjs; node test/host-test.mjs; node test/qr-test.mjs
node test/history-test.mjs; node test/tunnel-test.mjs

# 3) 手机在线 / 装机 / 拉起（锁屏会失败，先解锁）
$hdc='D:\xiazai\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
& $hdc list targets
& $hdc install -r 'C:\Users\L\DevEcoStudioProjects\DshConsole\entry\build\default\outputs\default\entry-default-signed.hap'
& $hdc shell aa start -b com.dshconsole.phone -a EntryAbility
```

顺序：核对 §0 → 首页（文件夹卡片/筛选/抽屉）→ §7 逐条勾 → 左滑归档 → 归档库恢复。

## 备注（环境相关数值，不作验收标准）

本轮截图：首页标题相对默认位置右移 144 px（三条杠占位）、副标题「46 个会话」、点「今天」后「8 个会话」、抽屉「归档库 3 个」。这些随会话增删而变，只说明当时状态；判据以 §7 的预期结果为准。
