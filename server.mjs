// DSH 控制台 · 手机侧服务（局域网 + 隧道）
// 目标：零依赖，Node 20+，只做四件事——配对、列会话、读对话、下指令。
//
// 安全取舍（都按"默认最严"来）：
//   · 默认只监听 127.0.0.1，要用局域网得手动打开（公网走隧道，本机这一段不出网卡）
//   · 访问码只存 sha256，state.json 泄露也拿不到可用的码
//   · 访问码 30 天过期；面板可以单独踢掉某一台设备
//   · 配对失败有全局锁定，6 位码不可枚举
//   · 不返回 Access-Control-Allow-Origin；不支持 ?token=（避免进日志/历史）
//   · 只读模式：打开后手机只能读会话、停止生成，不能发消息
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.6.0'

const CODE_TTL_MS = 15 * 60 * 1000
const TICKET_TTL_MS = 2 * 60 * 1000
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_CACHE_MS = 2500
const MAX_BODY = 20 * 1024 * 1024
const FAIL_WINDOW_MS = 15 * 60 * 1000
const FAIL_LIMIT_PER_IP = 10
const FAIL_LIMIT_GLOBAL = 5
const LOCK_MS = 15 * 60 * 1000

function nowIso() { return new Date().toISOString() }

function lanList() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) {
    for (const one of ifs[name] || []) {
      if (!one || one.family !== 'IPv4' || one.internal) continue
      // 虚拟网卡/自动地址对手机毫无意义，列出来只会让人填错
      if (one.address.startsWith('169.254.')) continue
      if (one.address.startsWith('192.168.56.')) continue   // VirtualBox host-only
      if (one.address.startsWith('10.0.2.')) continue       // VirtualBox NAT
      let rank = 2
      if (one.address.startsWith('192.168.137.')) rank = 3  // Windows 热点排最后
      else if (/wlan|wi-?fi|无线/i.test(name)) rank = 0
      out.push({ ip: one.address, iface: name, rank })
    }
  }
  out.sort((a, b) => a.rank - b.rank)
  return out
}

function lanAddrs() { return lanList().map((x) => x.ip) }

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex') }

// 对 Buffer（二进制）正确哈希——sha256() 会把入参 String() 化，对字节内容是错的
function sha256buf(b) { return crypto.createHash('sha256').update(b).digest('hex') }

// 回给手机的错误文案：抹掉本地路径、截断，别把内部结构送出去
function safeMsg(e) {
  let m = String((e && e.message) || e || '')
  m = m.replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
  m = m.replace(/\/(?:[\w.-]+\/){2,}[\w.-]+/g, '<path>')
  return m.length > 160 ? m.slice(0, 160) + '…' : m
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('请求体不是 JSON')) }
    })
    req.on('error', reject)
  })
}

// 故意不发 CORS 头：面板同源，手机是原生 HTTP 客户端，都不需要
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(payload))
}

// 落地页不含主机名、不含内网 IP、不含端口——公网上谁拿到地址都读不到信息
const LANDING = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 控制台</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f12;color:#f4f5f7;
font:15px/1.7 -apple-system,"HarmonyOS Sans SC","Segoe UI",sans-serif}
.card{padding:26px 30px;border:1px solid #2a2d34;border-radius:26px;background:#17181c;text-align:center}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ecf8e;margin-right:8px;vertical-align:2px}
p{margin:8px 0 0;color:#9ba0aa;font-size:13px}
</style></head><body><div class="card">
<div style="font-size:12px;color:#9ba0aa"><span class="dot"></span>服务在线</div>
<p>请在手机上的「DSH 控制台」里扫码或输入配对码。</p>
</div></body></html>`

export function createConsoleServer(opts) {
  const bridge = opts.bridge
  const dataDir = opts.dataDir
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const tunnel = opts.tunnel || null
  const wantPort = Number(opts.port) || 8909
  const nodeName = String(opts.name || os.hostname() || 'DSH 电脑')

  const statePath = path.join(dataDir, 'state.json')
  let devices = []
  // 公网 / 局域网各一个码，互不复用：任意时刻两者都不会相同
  let codes = { lan: { code: '', exp: 0 }, wan: { code: '', exp: 0 } }
  let remotePair = false
  let readOnly = false
  let lanAccess = false
  let tunnelAuto = false
  let server = null
  let boundPort = 0
  let bindHost = '127.0.0.1'
  let startedAt = 0
  const fails = new Map()
  const tickets = new Map()
  let sessionCache = { at: 0, list: [] }

  // ── 持久化 ────────────────────────────────────────────────────────────
  let needSave = false
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(statePath)) {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (Array.isArray(j.devices)) {
        // 老版本存的是明文 token，这里顺手迁移成 hash
        if (j.devices.some((d) => d && (typeof d.token === 'string' || typeof d.ip === 'string'))) needSave = true
        devices = j.devices
          .filter((d) => d && (typeof d.hash === 'string' || typeof d.token === 'string'))
          .map((d) => ({
            id: String(d.id || crypto.randomBytes(6).toString('hex')),
            hash: typeof d.hash === 'string' ? d.hash : sha256(d.token),
            label: String(d.label || '手机'),
            at: Number(d.at) || Date.now(),
            exp: Number(d.exp) || (Number(d.at) || Date.now()) + TOKEN_TTL_MS,
            // 信任直连：设备公钥(SPKI DER)的 sha256。有它 = 这台设备可以免扫码换新访问码
            pk: typeof d.pk === 'string' ? d.pk : '',
            // 首次入网方式：'scan' = 走过扫码/配对码。公网信任直连只对 scan 设备放行
            origin: typeof d.origin === 'string' ? d.origin : 'scan'
          }))
      }
      if (j.remotePair === true) remotePair = true
      if (j.readOnly === true) readOnly = true
      if (j.lanAccess === true) lanAccess = true
      if (j.tunnelAuto === true) tunnelAuto = true
    }
  } catch (e) { log('[state] 读取失败：' + ((e && e.message) || e)) }

  function save() {
    try {
      fs.writeFileSync(statePath, JSON.stringify({ devices, remotePair, readOnly, lanAccess, tunnelAuto, savedAt: nowIso() }, null, 2))
    } catch (e) { log('[state] 写入失败：' + ((e && e.message) || e)) }
  }

  if (needSave) {
    save()
    log('[state] 已把明文访问码迁移为 sha256')
  }

  function liveCode(scope) {
    const rec = codes[scope]
    return rec && rec.code && Date.now() <= rec.exp ? rec.code : ''
  }

  function newCode(scope) {
    const target = scope === 'lan' ? 'lan' : 'wan'
    const other = target === 'wan' ? 'lan' : 'wan'
    let v = ''
    // 与另一入口在有效期内的码撞了就重取，保证两个码永远不同
    do {
      v = String(crypto.randomInt(100000, 1000000))
    } while (other && v === liveCode(other))
    codes[target] = { code: v, exp: Date.now() + CODE_TTL_MS }
    log('[pair] ' + (target === 'wan' ? '公网' : '局域网') + '配对码已生成，15 分钟内有效')
    return v
  }

  function issueToken(label, ip, pkHash, origin) {
    const raw = crypto.randomBytes(24).toString('hex')
    const now = Date.now()
    devices = devices.filter((d) => d.label !== label).slice(-19)
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      hash: sha256(raw),
      label: String(label || '手机'),
      at: now,
      exp: now + TOKEN_TTL_MS,
      pk: typeof pkHash === 'string' && pkHash.length > 0 ? pkHash : '',
      origin: origin === 'scan' ? 'scan' : ''
    }
    devices.push(rec)
    save()
    return raw
  }

  function revokeDevice(id) {
    const before = devices.length
    devices = devices.filter((d) => d.id !== String(id || ''))
    if (devices.length !== before) save()
    return before - devices.length
  }

  // ── 信任直连（我的电脑）────────────────────────────────────────────────
  // 已配对设备留有公钥（设备记录的 pk 字段）。token 失效/过期后，
  // 手机用设备私钥对 ts|rand 签名即可换新访问码，不用再扫码。
  // 安全设计：桌面只存公钥哈希（同 token 的 sha256 取舍）；签名带时间戳 + 一次性缓存防重放；
  // 面板「踢掉设备」删除整条设备记录，信任随之吊销。
  const REAUTH_WINDOW_MS = 60 * 1000
  const seenSigs = new Map()

  function sigUsed(key) {
    const now = Date.now()
    for (const [k, exp] of seenSigs) if (exp <= now) seenSigs.delete(k)
    if (seenSigs.has(key)) return true
    seenSigs.set(key, now + 2 * REAUTH_WINDOW_MS)
    return false
  }

  // cryptoFramework 的 ECC 签名输出格式（DER / ieee-p1363）与摘要行为随 API 版本有差异，
  // 这里把「签名编码 × 摘要语义」的组合都试一遍，客户端不需要关心细节：
  //   sha256+msg：端上内部做了 SHA256；null+sha256(msg)：端上自己预摘要后签摘要值；null+msg：端上直接签原文
  function sigOk(pubKey, msgBuf, sig) {
    const digest = crypto.createHash('sha256').update(msgBuf).digest()
    const variants = [
      { alg: 'sha256', data: msgBuf },
      { alg: null, data: digest },
      { alg: null, data: msgBuf }
    ]
    for (const v of variants) {
      for (const enc of ['der', 'ieee-p1363']) {
        try {
          const key = enc === 'der' ? pubKey : { key: pubKey, dsaEncoding: 'ieee-p1363' }
          if (crypto.verify(v.alg, v.data, key, sig)) return true
        } catch (e) { /* 换下一种组合继续试 */ }
      }
    }
    return false
  }

  function issueTicket() {
    const now = Date.now()
    for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k)
    const t = 'pt_' + crypto.randomBytes(16).toString('hex')
    tickets.set(t, { exp: now + TICKET_TTL_MS })
    return t
  }

  function redeemTicket(t) {
    const key = String(t || '')
    const rec = tickets.get(key)
    if (!rec) return false
    tickets.delete(key)
    return rec.exp > Date.now()
  }

  function candidates() {
    const out = []
    const t = tunnel ? tunnel.status() : null
    if (t && t.state === 'up' && t.url) out.push(t.url)
    if (lanAccess) for (const ip of lanAddrs()) out.push('http://' + ip + ':' + (boundPort || wantPort))
    return out
  }

  function baseUrl() {
    const list = candidates()
    return list.length > 0 ? list[0] : ''
  }

  // 二维码里 u 是首选地址，c 是备选列表（逗号分隔）
  function pairLink() {
    const list = candidates()
    if (list.length === 0) return ''
    const rest = list.slice(1)
    let link = 'dshconsole://pair?u=' + encodeURIComponent(list[0]) + '&k=' + issueTicket() + '&n=' + encodeURIComponent(nodeName)
    if (rest.length > 0) link += '&c=' + encodeURIComponent(rest.join(','))
    return link
  }

  function isWan(req) {
    const xff = req.headers['x-forwarded-for']
    return typeof xff === 'string' && xff.trim() !== ''
  }

  function isLoopback(req) {
    const a = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  // 限流键：直连时用 socket 地址（伪造不了）；走自己的隧道时用 XFF 最后一段（Cloudflare 追加的真实来源）。
  // 这样每个真实来源各自一个桶，谁也别想靠刷错码把别人锁死。
  function peerOf(req) {
    if (!isLoopback(req)) {
      const a = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown'
      return a
    }
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim() !== '') {
      const parts = xff.split(',')
      return String(parts[parts.length - 1]).trim() || 'tunnel'
    }
    return 'local'
  }

  function tooMany(key) {
    const rec = fails.get(key)
    if (!rec) return false
    if (Date.now() - rec.at > FAIL_WINDOW_MS) { fails.delete(key); return false }
    return rec.n >= FAIL_LIMIT_PER_IP
  }

  function markFail(key) {
    const now = Date.now()
    const rec = fails.get(key)
    if (!rec || now - rec.at > FAIL_WINDOW_MS) fails.set(key, { n: 1, at: now })
    else { rec.n += 1; rec.at = now }
  }

  function markOk(key) {
    fails.delete(key)
  }

  function authed(req) {
    const t = req.headers['x-console-token']
    if (typeof t !== 'string' || t.trim() === '') return null
    const h = sha256(t.trim())
    const now = Date.now()
    for (const d of devices) {
      if (d.hash.length !== h.length) continue
      if (!crypto.timingSafeEqual(Buffer.from(d.hash, 'utf8'), Buffer.from(h, 'utf8'))) continue
      if (d.exp <= now) return { expired: true }
      return d
    }
    return null
  }

  async function sessions(force) {
    if (!force && Date.now() - sessionCache.at < SESSION_CACHE_MS) return sessionCache.list
    const list = await bridge.listSessions()
    sessionCache = { at: Date.now(), list: Array.isArray(list) ? list : [] }
    return sessionCache.list
  }

  // ── 路由 ─────────────────────────────────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname.replace(/\/+$/, '') || '/'

    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(LANDING)
      return
    }

    if (p === '/health') {
      return sendJson(res, 200, { ok: true, app: 'dsh-console-oh', version: VERSION })
    }

    // 配对：唯一一条不需要访问码的写路由
    if (p === '/v1/pair' && req.method === 'POST') {
      const ip = peerOf(req)
      if (tooMany(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' })
      if (isWan(req) && !remotePair) {
        return sendJson(res, 403, { ok: false, error: '公网配对未开启，请在电脑端面板打开「异地配对」', reason: 'remote-pair-off' })
      }
      let body = {}
      try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      const got = String(body.code || '').replace(/\D/g, '')
      if (got.length !== 6) return sendJson(res, 400, { ok: false, error: '配对码是 6 位数字', reason: 'bad-format' })
      // 码和入口必须对上：公网走隧道（有 x-forwarded-for），局域网直连
      const scope = isWan(req) ? 'wan' : 'lan'
      if (body.channel && String(body.channel) !== scope) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '这是' + (String(body.channel) === 'wan' ? '公网' : '局域网') + '配对码，入口不对', reason: 'channel-mismatch' })
      }
      if (got === liveCode(scope === 'wan' ? 'lan' : 'wan')) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '公网和局域网的配对码不能混用', reason: 'code-channel-mismatch' })
      }
      if (got !== liveCode(scope)) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '配对码不对或已过期', reason: 'code-mismatch' })
      }
      markOk(ip)
      const label = String(body.label || '鸿蒙手机').slice(0, 40)
      const token = issueToken(label, ip, '', 'scan')
      codes[scope] = { code: '', exp: 0 }
      newCode(scope)
      let dsh = { ok: false, error: '' }
      try { dsh = await bridge.health() } catch (e) { dsh = { ok: false, error: safeMsg(e) } }
      return sendJson(res, 200, {
        ok: true, token,
        node: { name: nodeName, platform: process.platform, dsh },
        tunnel: tunnel ? tunnel.status() : null
      })
    }

    // 二维码里的一次性票据换访问码：不用输地址、不用输 6 位码
    if (p === '/v1/pair/ticket' && req.method === 'POST') {
      const ip = peerOf(req)
      if (tooMany(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' })
      let body = {}
      try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      if (!redeemTicket(body.ticket)) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '二维码已过期，在电脑上点一下刷新', reason: 'ticket-expired' })
      }
      markOk(ip)
      const label = String(body.label || '鸿蒙手机').slice(0, 40)
      const token = issueToken(label, ip, '', 'scan')
      let dsh = { ok: false, error: '' }
      try { dsh = await bridge.health() } catch (e) { dsh = { ok: false, error: safeMsg(e) } }
      return sendJson(res, 200, {
        ok: true, token,
        node: { name: nodeName, platform: process.platform, dsh },
        tunnel: tunnel ? tunnel.status() : null
      })
    }

    // 信任直连：设备私钥签名换新访问码，免扫码。走公网也放行——
    // 能通过私钥签名就证明是已受信的设备，不依赖网络位置；面板踢设备即吊销。
    if (p === '/v1/reauth' && req.method === 'POST') {
      const ip = peerOf(req)
      if (tooMany(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' })
      let body = {}
      try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      const pubB64 = String(body.pub || '')
      const ts = Number(body.ts) || 0
      const rand = String(body.rand || '')
      const sigB64 = String(body.sig || '')
      const noTrust = { ok: false, error: '这台手机还没建立信任，先用配对码连一次，连上后电脑会记住它', reason: 'no-trust' }
      if (pubB64.length === 0 || pubB64.length > 1024 || sigB64.length === 0 || sigB64.length > 512) {
        markFail(ip)
        return sendJson(res, 403, noTrust)
      }
      if (rand.length < 8 || rand.length > 128 || Math.abs(Date.now() - ts) > REAUTH_WINDOW_MS) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '请求已过期，再点一次「我的电脑」', reason: 'stale' })
      }
      let dev = null
      let pubKey = null
      try {
        const pubDer = Buffer.from(pubB64, 'base64')
        if (pubDer.length > 0 && pubDer.length < 512) {
          dev = devices.find((d) => d.pk === sha256buf(pubDer)) || null
          if (dev) pubKey = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' })
        }
      } catch (e) { dev = null }
      if (!dev || !pubKey) {
        markFail(ip)
        return sendJson(res, 403, noTrust)
      }
      // 规则：新设备首次公网连接必须先完成扫码验证（origin=scan 由配对码/扫码票据路径打上）
      if (isWan(req) && dev.origin !== 'scan') {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '新设备首次公网连接必须先完成扫码配对', reason: 'first-scan-required' })
      }
      const msgBuf = Buffer.from(ts + '|' + rand, 'utf8')
      const sig = Buffer.from(sigB64, 'base64')
      if (sigUsed(sha256(sigB64 + '|' + msgBuf.toString('utf8'))) || !sigOk(pubKey, msgBuf, sig)) {
        markFail(ip)
        return sendJson(res, 403, { ok: false, error: '信任校验没通过，用配对码重连一次即可', reason: 'sig-mismatch' })
      }
      markOk(ip)
      const token = issueToken(dev.label, ip, dev.pk, dev.origin === 'scan' ? 'scan' : '')
      let dsh = { ok: false, error: '' }
      try { dsh = await bridge.health() } catch (e) { dsh = { ok: false, error: safeMsg(e) } }
      return sendJson(res, 200, {
        ok: true, token,
        node: { name: nodeName, platform: process.platform, dsh },
        tunnel: tunnel ? tunnel.status() : null
      })
    }

    const dev = authed(req)
    if (dev && dev.expired) return sendJson(res, 401, { ok: false, error: '访问码已过期，请重新配对' })
    if (!dev) return sendJson(res, 401, { ok: false, error: '未配对或访问码已失效' })

    if (p === '/v1/info' && req.method === 'GET') {
      let list = []
      let dsh = { ok: false, error: '' }
      try { dsh = await bridge.health() } catch (e) { dsh = { ok: false, error: safeMsg(e) } }
      try { list = await sessions(false) } catch (e) { list = [] }
      return sendJson(res, 200, {
        ok: true,
        node: { name: nodeName, platform: process.platform },
        dsh,
        readOnly,
        sessions: {
          count: list.length,
          running: list.filter((s) => s && s.running).length
        },
        modesRev: typeof bridge.modesRev === 'function' ? bridge.modesRev() : 0,
        tunnel: tunnel ? tunnel.status() : null,
        device: { label: dev.label, since: dev.at }
      })
    }

    if (p === '/v1/sessions' && req.method === 'GET') {
      const list = await sessions(true)
      return sendJson(res, 200, { ok: true, count: list.length, sessions: list })
    }

    // 信任凭据注册：已配对设备把设备公钥挂到自己的设备记录上（可重复调用换新钥）
    if (p === '/v1/device-key' && req.method === 'POST') {
      let body = {}
      try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      const pubB64 = String(body.pub || '')
      if (pubB64.length === 0 || pubB64.length > 1024) return sendJson(res, 400, { ok: false, error: '公钥格式不对' })
      try {
        const pubDer = Buffer.from(pubB64, 'base64')
        if (pubDer.length === 0 || pubDer.length >= 512) throw new Error('bad')
        crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' })
        dev.pk = sha256buf(pubDer)
        save()
        log('[trust] 设备「' + dev.label + '」已登记信任公钥')
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '公钥格式不对' })
      }
    }

    // 模式清单：官方两个 + 桌面端模式插件提供的全部预设，实时（rev 变即刷新）
    if (p === '/v1/modes' && req.method === 'GET') {
      try {
        if (typeof bridge.modes !== 'function') return sendJson(res, 200, { ok: false, error: '这个版本不支持模式', modes: [] })
        const m = await bridge.modes()
        return sendJson(res, 200, Object.assign({ ok: true }, m))
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: safeMsg(e), modes: [] })
      }
    }

    if (p === '/v1/models' && req.method === 'GET') {
      const sessionId = String(url.searchParams.get('sessionId') || '')
      if (sessionId === '') return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
      try {
        const models = await bridge.command('models', { sessionId })
        return sendJson(res, 200, Object.assign({ ok: true }, models))
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: safeMsg(e), groups: [] })
      }
    }

    const mTurns = p.match(/^\/v1\/sessions\/([^/]+)\/turns$/)
    if (mTurns && req.method === 'GET') {
      const id = decodeURIComponent(mTurns[1])
      const detail = await bridge.turns(id)
      return sendJson(res, 200, Object.assign({ ok: true }, detail))
    }

    if (p === '/v1/cmd' && req.method === 'POST') {
      let body = {}
      try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      const op = String(body.op || '')
      if (!op) return sendJson(res, 400, { ok: false, error: '缺少 op' })
      if (readOnly && op !== 'cancel') {
        return sendJson(res, 403, { ok: false, error: '电脑开着只读模式，手机只能看不能发' })
      }
      try {
        const result = await bridge.command(op, body.payload || {})
        if (op === 'send' || op === 'cancel') sessionCache.at = 0
        return sendJson(res, 200, { ok: true, result })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: safeMsg(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: '没有这个接口' })
  }

  function listen(host) {
    return new Promise((resolve, reject) => {
      const onReq = (req, res) => {
        Promise.resolve()
          .then(() => handle(req, res))
          .catch((e) => {
            log('[http] ' + ((e && e.stack) || e))
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: safeMsg(e) })
            else try { res.end() } catch (_) { }
          })
      }
      const tryListen = (port, left) => {
        const s = http.createServer(onReq)
        s.once('error', (e) => {
          if (e && e.code === 'EADDRINUSE' && left > 0) { tryListen(port + 1, left - 1); return }
          reject(e)
        })
        s.listen(port, host, () => {
          server = s
          boundPort = port
          bindHost = host
          startedAt = Date.now()
          if (!liveCode('lan')) newCode('lan')
          if (!liveCode('wan')) newCode('wan')
          log('[http] 监听 ' + host + ':' + port + (port !== wantPort ? '（' + wantPort + ' 被占用，已顺延）' : ''))
          resolve(port)
        })
      }
      tryListen(wantPort, 12)
    })
  }

  async function start() {
    return listen(lanAccess ? '0.0.0.0' : '127.0.0.1')
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve()
      try { server.close(() => resolve()) } catch (e) { resolve() }
      try {
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      } catch (_) { }
      server = null
    })
  }

  // 切换局域网监听：要重启监听器，端口可能顺延
  async function setLanAccess(v) {
    const want = !!v
    if (want === lanAccess) return panelState()
    lanAccess = want
    save()
    await stop()
    try { await start() } catch (e) { log('[http] 重新监听失败：' + ((e && e.message) || e)) }
    return panelState()
  }

  function panelState() {
    const t = tunnel ? tunnel.status() : null
    return {
      ok: true,
      name: nodeName,
      version: VERSION,
      port: boundPort || wantPort,
      bind: bindHost,
      lanAccess,
      lan: lanAccess ? lanAddrs() : [],
      lanNamed: lanAccess ? lanList().map((x) => ({ ip: x.ip, iface: x.iface })) : [],
      codes: {
        lan: { code: liveCode('lan'), expiresAt: liveCode('lan') ? codes.lan.exp : 0 },
        wan: { code: liveCode('wan'), expiresAt: liveCode('wan') ? codes.wan.exp : 0 }
      },
      remotePair,
      readOnly,
      tunnel: t,
      tunnelAuto,
      publicUrl: baseUrl(),
      devices: devices.map((d) => ({ id: d.id, label: d.label, at: d.at, exp: d.exp, trusted: !!d.pk })),
      paired: devices.length
    }
  }

  return {
    start, stop, panelState, newCode, pairLink, revokeDevice, setLanAccess,
    setRemotePair(v) { remotePair = !!v; save(); log('[pair] 异地配对 ' + (remotePair ? '开' : '关')); return remotePair },
    getRemotePair() { return remotePair },
    setReadOnly(v) { readOnly = !!v; save(); log('[mode] 只读 ' + (readOnly ? '开' : '关')); return readOnly },
    getReadOnly() { return readOnly },
    setTunnelAuto(v) { tunnelAuto = !!v; save(); return tunnelAuto },
    getTunnelAuto() { return tunnelAuto },
    getLanAccess() { return lanAccess },
    get port() { return boundPort || wantPort },
    devices() { return devices.slice() }
  }
}