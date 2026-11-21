# dsh-console-oh 安全评审报告

- 对象：`D:/千问办公/2026-11-18/mwm1li8r4dny42kj/outputs/dsh-console-oh`（插件 v0.2.0 + 鸿蒙 App）
- 方式：源码逐行审读 + 实跑官方自测 + 自建 4 个对抗脚本（真实起服务、真实打接口）
- 结论：**安全基线扎实，问题集中在两处——"外部二进制零信任校验缺失"和"公网闸门不一致"**。前者可升级为远程代码执行，后者把「异地配对已关闭」这层安全感打了个洞。

---

## 一、风险清单（按可利用性排序）

### P0 · cloudflared 下载与调用链完全不校验，第三方镜像可投毒即 RCE

**位置**：`plugin/lib/tunnel.mjs` → `ensureBinary()` / `binPath()`

**机制**：
1. `MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/']` —— 后两个是第三方转发；
2. 下载后**唯一判据是** `if (buf.length < MIN_BYTES) throw`（8MB），随后 `fs.writeFileSync` + `chmod 0755`；
3. 没有任何 Authenticode / sha256 / 签名主体校验，直接 `spawn(bin, ['tunnel','--url','http://127.0.0.1:'+port, ...])`；
4. `binPath()` 还在 `process.env.PATH` 各目录找 `cloudflared.exe`，**同样不验签**。

**实测**：
- 往 `D:/tmp/dco-audit/fakebin` 放一个假 `cloudflared.exe` 并塞进 PATH：`status().bin` 从 `missing` 变为 `ok`，即被当作可信二进制执行 —— PATH 劫持面成立。
- 本机已落盘的 `C:/Users/L/.dsh/dsh-console-oh/bin/cloudflared.exe`（55,483,112 B）实测签名：`Status=Valid`、`Subject=CN="Cloudflare, Inc.", O="Cloudflare, Inc.", ...`、`Issuer=CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1`、`Thumbprint=0B6C68C4BAD79F9AC39E07FE84223FB796D4D0BC` —— 说明验签依据是现成的，只是没做。

**影响**：任何一个镜像节点被接管、或链路被插桩，替换一个 55MB 的 exe 就会在 DSH 进程权限下执行任意代码（可读全部会话、全部密钥、全部工作目录）。这是全局最严重的一条。

**修复**：见 `security/verify-binary.mjs`（已写好并自测通过：真 exe 放行、9MB 假 exe 被拒、1KB 小文件被拒），接入方式见第四节。

---

### P1 · 二维码票据路径绕过了「异地配对」开关

**位置**：`plugin/lib/server.mjs` → `/v1/pair/ticket` 分支

**机制**：`/v1/pair` 有 `if (isWan(req) && !remotePair) return 403`；**紧挨着的** `/v1/pair/ticket` 分支没有这一行，只有 `tooMany(ip)`。

**实测**（`remotePair=false`，带 `x-forwarded-for: 198.51.100.9` 模拟公网）：

| 请求 | 结果 |
|---|---|
| `POST /v1/pair`（6 位码） | `403 remote-pair-off` ✅ |
| `POST /v1/pair/ticket`（有效票据） | `200`，**直接拿到 token** ❌ |
| 同一票据重放 | `403 二维码已过期`（一次性，符合预期） |
| 用该 token 从「公网」读 `/v1/sessions` | `200` |

**影响**：隧道开着时二维码里的 `u` 就是公网地址、`k` 就是票据。二维码一旦外泄（截图发群、截图工具同步云盘、面板被投屏），拿到图的人即使你关着「异地配对」也能直接配成设备，拿到 30 天全权限。开关给了错误的安全感。

**修复**：在 `/v1/pair/ticket` 里补齐同一行闸门。

---

### P1 · 5 次错码即全局锁 15 分钟，隧道下等于「公网任何人可打断配对」

**位置**：`server.mjs` → `tooMany()` / `markFail()` / `peerOf()`

**机制**：`FAIL_LIMIT_GLOBAL = 5`、`LOCK_MS = 15min`，`tooMany()` 第一句就是 `if (Date.now() < lockedUntil) return true`。而隧道场景下所有请求都来自 cloudflared 的本机回连，`peerOf()` 恒为 `127.0.0.1`，于是「每 IP 10 次」这条线永远用不上，只剩全局 5 次。

**实测**：连续 5 次错码 → `403,403,403,403,403,429`；锁定期内即使输入**正确**的 6 位码也返回 `429 尝试次数过多，请 15 分钟后再试`；同时已配对设备的 `/v1/info` 仍 `200`（已有设备不受影响，这点是对的）。票据兑换失败也会 `markFail`，所以往 `/v1/pair/ticket` 打 5 次垃圾同样锁死。

**影响**：可用性攻击。攻击者每 15 分钟发 5 个请求，你的扫码配对就一直是 429；而 quick tunnel 地址是公网可枚举/可被扫到的（`*.trycloudflare.com` 有公开爬取源）。

**修复**：全局阈值提到 30 以上；把 WAN 流量单独分桶，并优先信任 `x-forwarded-for` 的**最后一个**地址（伪造只会把自己分到别的桶）；锁改为指数退避而非 15 分钟硬锁。

---

### P2 · sessionId 未做任何白名单，原样交给 sessionController

**位置**：`server.mjs` → `const id = decodeURIComponent(mTurns[1]); await bridge.turns(id)`

**实测**：
- `/v1/sessions/..%2F..%2F..%2F..%2Fetc%2Fpasswd/turns` → bridge 收到 `../../../../etc/passwd`；
- `/v1/sessions/a%2Fb%2Fc/turns` → 收到 `a/b/c`。

当前 DSH 侧 `projections({sessionId})` 是按 id 查表，穿越没打穿；但这是一层**完全依赖下游**的防线，DSH 以后把 id 当路径拼一次就是文件读取。

**修复**：`if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return sendJson(res, 400, ...)`。

---

### P2 · 局域网通道是明文 HTTP，token 走 header

**位置**：`app/.../service/Api.ets`（`normalize()` 默认补 `http://` 和 `:8909`）+ `module.json5` 只有 `ohos.permission.INTERNET`，没有 network_config

**影响**：同一 WiFi 下任何人 ARP 欺骗/热点侧信道即可抓到 `x-console-token`，拿到后 30 天全权限（可发消息、可建会话、可读全部对话）。隧道分支是 https，局域网分支不是。

**修复建议**：局域网也自签证书走 https（App 端做指纹 pin），或把 token 换成「每次请求签名」（HMAC + nonce + 时间窗），泄露的 header 不能重放。

---

### P2 · App 无条件信任二维码里的地址

**位置**：`app/entry/src/main/ets/view/PairView.ets`（`Api.normalize(tries[0])`）

扫码即把 `u=` 当地址连。别人给你一张自己生成的二维码（`dshconsole://pair?u=http://attacker:8909&k=...`），你的手机就会把 token 与全部对话发到那台机器。缺少「这个地址像不像内网 / 是不是刚才电脑上显示的那台」的确认。

**修复建议**：配对成功页显示节点名 + 地址尾段让用户核对；对非 `192.168./10./172.16-31./*.trycloudflare.com` 的地址弹二次确认。

---

### P3 · 其余（真实但不紧急）

| # | 位置 | 现象 | 说明 |
|---|---|---|---|
| 1 | `server.mjs` 的 `handle()` | `Host` 头完全不校验（`Host: evil.example.com` 仍 200） | DNS rebinding 面；有 token 才可利用。建议白名单 localhost / 127.0.0.1 / *.trycloudflare.com |
| 2 | 同上 | `content-type: text/plain` 的 JSON body 被接受（200） | 浏览器「简单请求」可打，但无 CORS 头读不到响应，风险低；建议 POST 强制 application/json |
| 3 | `index.js` 的 `boot()` | 日志硬编码 `'局域网服务已起：0.0.0.0:'`，实际 bind 由 `start()` 按 `lanAccess` 决定 | **文案撒谎**，会让人误判监听范围（我第一遍就差点据此下结论）。应打印 `panelState().bind` |
| 4 | `app/.../service/Prefs.ets` | token 存普通 `preferences('dsh_console')`，非加密 | 建议 `@ohos.security.asset` 或 cryptoFramework 加密后存 |
| 5 | `tunnel.mjs` 的 `assetName()` | macOS 下载的是 `cloudflared-darwin-amd64.tgz`，却直接 chmod 0755 后 spawn | 功能 bug（tgz 不能执行），macOS 用户必然失败 |
| 6 | `server.mjs` 的 `issueToken()` | `devices.filter(d => d.label !== label)`：**同名会顶掉旧设备**，上限 20 台 | 手机重装/改 label 会静默踢掉另一台；建议按 id 去重 |
| 7 | `server.mjs` 的 `tickets` | 内存 Map，只在 `issueTicket()` 时清理过期项 | 频繁刷新二维码会缓慢堆积（每条 ~100B，无实际危害） |
| 8 | `/v1/info` | 返回 `os.hostname()` | 只给已配对设备看，泄露很小 |
| 9 | `state.json` | MSYS 显示权限 666 | Windows 由 NTFS ACL 决定，此项**不构成实际风险**，仅记录 |

---

## 二、已验证站得住的设计（不要动）

1. **token 只存 sha256**，`state.json` 里没有任何明文（实测 383B，grep 不到 token）；老版本明文会在启动时自动迁移为 hash。
2. **`timingSafeEqual` 逐设备比较**，先比长度再比内容，无长度侧信道。
3. **token 是 192bit 随机**（`randomBytes(24)`）；6 位码 90 万空间 + 限流，枚举不现实。
4. **一次性票据 128bit**，兑换即删，重放返回 403（实测）。
5. **不发 `Access-Control-Allow-Origin`、不接受 `?token=`** —— 挡住浏览器跨站读取和 token 进日志/历史。
6. **默认只监听 127.0.0.1**，局域网/隧道都要手动开。
7. **指令白名单**（send/cancel/create/rename/models），未知 op 直接抛错；`create` **不接受客户端指定 cwd**，堵死「在任意目录开工」。
8. **只读模式**真的拦住了 create/send（403），只放行 cancel；已配对设备在锁定期不受影响。
9. **client.js 无 innerHTML / dangerouslySetInnerHTML / eval**（grep 为空），面板侧无 XSS 面。
10. **`/v1/cmd` 无 token 一律 401**（实测）；超过 512KB 的请求体直接断开连接（实测 `fetch failed`）。

官方自测实跑：`node test/selftest.mjs` → **exit 0，28 项全部通过**。测试质量不错，但恰好**没覆盖 P0/P1/P2**——问题都发生在「隧道 + 公网 + 外部二进制」这条主线上。

---

## 三、修复优先级

| 优先 | 事项 | 工作量 |
|---|---|---|
| 1 | cloudflared 下载/PATH 命中后验 Authenticode（P0） | 半小时，代码已给 |
| 2 | `/v1/pair/ticket` 补 `isWan && !remotePair` 闸门（P1） | 3 行 |
| 3 | 限流分桶 + 抬高全局阈值 + 指数退避（P1） | 半天 |
| 4 | sessionId 白名单正则（P2） | 2 行 |
| 5 | 局域网走 https 或改请求签名（P2） | 1 天 |
| 6 | 二维码地址二次确认（P2） | 半天 |
| 7 | Host/Content-Type 校验、日志文案、macOS tgz、label 去重（P3） | 各 10 分钟 |

---

## 四、P0 的具体补丁

### 1. `security/verify-binary.mjs`（已写入并通过自测）

核心判据不是大小，是签名：

```js
const EXPECTED_SUBJECT = /CN="Cloudflare,\s*Inc\."/i
const EXPECTED_ISSUER  = /DigiCert Trusted G4 Code Signing/i
// Get-AuthenticodeSignature → Status 必须 Valid，且主体/颁发者匹配
```

实测：

| 输入 | 结果 |
|---|---|
| 真实 cloudflared.exe（55,483,112 B） | Valid / CN="Cloudflare, Inc." / DigiCert Trusted G4 → 放行 |
| 9MB 全 0x4d 假 exe | REJECTED: Authenticode 验签失败：NOCERT |
| 1KB 文件 | REJECTED: 文件太小，疑似下载不完整 |

### 2. `tunnel.mjs` 两处接入

```js
import { assertWindowsBinary, assertExistingBinary } from '../security/verify-binary.mjs'

// ① binPath()：命中手动路径 / 本地缓存 / PATH 时先验签，验不过当不存在
binPath() {
  if (this.manualBin && fs.existsSync(this.manualBin)) {
    try { assertExistingBinary(this.manualBin); return this.manualBin } catch (_) { }
  }
  const local = path.join(this.dir, BIN_NAME)
  if (fs.existsSync(local)) {
    try { assertExistingBinary(local); return local } catch (_) { }
  }
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const p = path.join(d, BIN_NAME)
    try { if (fs.existsSync(p)) { assertExistingBinary(p); return p } } catch (_) { }
  }
  return ''
}

// ② ensureBinary()：写完先验签，失败就删掉
fs.writeFileSync(dest, buf)
try { assertWindowsBinary(dest) } catch (e) {
  try { fs.rmSync(dest, { force: true }) } catch (_) { }
  throw new Error('下载的 cloudflared 验签不通过，已丢弃：' + e.message)
}
try { fs.chmodSync(dest, 0o755) } catch (_) { }
```

### 3. `/v1/pair/ticket` 闸门

```js
if (p === '/v1/pair/ticket' && req.method === 'POST') {
  const ip = peerOf(req)
  if (tooMany(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' })
  if (isWan(req) && !remotePair) {            // ← 补这一行
    return sendJson(res, 403, { ok: false, error: '公网配对未开启，请在电脑端面板打开「异地配对」', reason: 'remote-pair-off' })
  }
  // ...
```

### 4. sessionId 白名单

```js
const id = decodeURIComponent(mTurns[1])
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'sessionId 不合法' })
```

### 5. 限流分桶

```js
const FAIL_LIMIT_GLOBAL = 30          // 5 → 30
const LOCK_MS = 5 * 60 * 1000         // 15min → 5min，首次 1min 起指数退避

function peerOf(req) {
  const direct = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown'
  const xff = req.headers['x-forwarded-for']
  if (typeof xff !== 'string' || xff.trim() === '') return direct
  // cloudflared 把真实来源追加在最后；伪造只会把自己分到别的桶
  const last = xff.split(',').map(s => s.trim()).filter(Boolean).pop()
  return 'wan:' + (last || direct)
}
```

---

## 五、复现方式

```bash
node plugin/test/selftest.mjs                       # 官方 28 项
node D:/tmp/dco-audit/attack.mjs   "<...>/plugin/lib/server.mjs"
node D:/tmp/dco-audit/expiry.mjs   "<...>/plugin/lib/server.mjs"
node D:/tmp/dco-audit/ticket.mjs   "<...>/plugin/lib/server.mjs"
node D:/tmp/dco-audit/pathenv.mjs  "<...>/plugin/lib/tunnel.mjs"
node D:/tmp/dco-audit/verify-test.mjs
```
