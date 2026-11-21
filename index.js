import fs from 'node:fs'
// DSH 控制台 · 宿主半边
// 职责：把 sessionController 包成手机能用的 4 个动作（列会话 / 读轮次 / 发消息 / 停），
// 起局域网服务，按需拉 cloudflared 隧道，并把面板数据注册给 DSH 客户端。
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createConsoleServer, VERSION } from './server.mjs'
import { CloudflaredTunnel } from './tunnel.mjs'

export const name = 'dsh-console-oh'
// connection 是面板用的，拿不到也不该拖垮整个插件，所以只在需要时 ctx.get
export const inject = ['sessionController']

const STATE_PATH = '/api/dsh-console-oh/state'
const NEWCODE_PATH = '/api/dsh-console-oh/newcode'
const TOGGLE_PATH = '/api/dsh-console-oh/toggle'
const TUNNEL_PATH = '/api/dsh-console-oh/tunnel'
const QR_PATH = '/api/dsh-console-oh/qr'
const SESSIONS_PATH = '/api/dsh-console-oh/sessions'
const TURNS_PATH = '/api/dsh-console-oh/turns'
const SEND_PATH = '/api/dsh-console-oh/send'

const log = (...a) => {
  try { console.log('[dsh-console-oh]', ...a) } catch (_) { }
}

function timeout(ms) { return AbortSignal.timeout(ms) }

/** 单轮思考上限：正常轮次全量下发（不再 4000 字就截），只挡 10 万字级的病态长思考 */
const THINKING_MAX = 120000
/** 一次 /v1/turns 里所有思考过程的总预算，按「从新到旧」分配 */
const THINKING_BUDGET = 400000

function clean(s, max) {
  const t = String(s == null ? '' : s)
  return t.length > max ? t.slice(0, max) : t
}

// 二维码用内联的小实现（lib/vendor/qrcode），不依赖 profile 里装没装三方包
const requireFrom = createRequire(import.meta.url)
let qrMod = null
function qrSvg(text) {
  if (!qrMod) qrMod = requireFrom('./vendor/qrcode/index.js')
  return qrMod.toSvg(text, {
    margin: 1,
    width: 260,
    ecc: 'M',
    dark: '#0E0F12ff',
    light: '#ffffffff'
  })
}

function evMs(ev) {
  const raw = ev && (ev.time || ev.ts || ev.createdAt || ev.timestamp)
  const n = Number(raw) || 0
  if (n <= 0) return 0
  return n > 1e12 ? n : n * 1000
}

function contentText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text)
  }
  return parts.join('\n')
}

// 思考过程是单独的 reasoning 内容块（DSH 网页端也是从这里渲染的），
// 不能混进正文，否则手机上会把「想」和「答」揉成一段。
function contentReasoning(content) {
  if (!content || !Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b) continue
    const t = String(b.type || '')
    if (t !== 'reasoning' && t !== 'reasoning-text') continue
    const txt = typeof b.text === 'string' ? b.text : (typeof b.reasoning === 'string' ? b.reasoning : '')
    if (txt) parts.push(txt)
  }
  return parts.join('\n\n')
}

// 有些插件（hindsight / hook / system-reminder）会把上下文塞进用户消息里，
// 手机上会把「你是谁」+ 一大段内部提示渲染成同一句话，看着像发错了。
// 这些块有固定标签，直接在展示层剥掉（电脑端记录不动）。
const INJECT_TAG = /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_pages|hindsight_page_refresh|hindsight_knowledge|hindsight_knowledge_refresh)\b[^>]*>[\s\S]*?<\/\1>/g

function stripInjected(text) {
  let t = String(text == null ? '' : text)
  if (t.indexOf('<') >= 0) t = t.replace(INJECT_TAG, '')
  // 还有一类注入不带标签：直接以「[Plugin context from "xxx"...]」开头追加在用户消息后面
  // （如 batching-guidance）。这类内容一律从标记处截断，只留用户真正打的字。
  const markers = ['[Plugin context from "', '[Plugin context from ', '[System context from "', '[Hook context from "',
    'Time sampled while preparing', 'Browser time zone for this request', 'Elapsed since the preceding',
    '[model changed:', 'model changed: assistant turns above']
  for (const m of markers) {
    const i = t.indexOf(m)
    if (i >= 0) t = t.substring(0, i)
  }
  // 还有一种以裸时间戳开头的旁白（billion-context 追加）：\n\n2026-11-20T21:44:16+08:00[Asia/Shanghai]
  const m2 = t.match(/\n{2,}20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/)
  if (m2 && m2.index !== undefined) t = t.substring(0, m2.index)
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

// 采样用：数一下 assistant/message 里到底有哪些内容块
function blockTypes(content, out) {
  if (!content || !Array.isArray(content)) return
  for (const b of content) {
    const t = String((b && b.type) || '?')
    out[t] = (out[t] || 0) + 1
  }
}

function historyEvents(h) {
  if (!h) return []
  if (Array.isArray(h)) return h
  if (Array.isArray(h.events)) return h.events
  if (h.value && Array.isArray(h.value.events)) return h.value.events
  if (h.history && Array.isArray(h.history.events)) return h.history.events
  if (Array.isArray(h.records)) return h.records
  return []
}

// 从历史事件流里折出「完整正文」。turnOutline 是模型生成的摘要，长回答会被截断；
// 真正逐字的内容在 user/message 与 assistant/message 的 content 块里。
export function foldHistory(h) {
  const out = []
  const byNo = new Map()
  let lastNo = 0

  const note = (no, seq, ev) => {
    let n = Number(no) || 0
    if (n < 1) n = lastNo
    if (n < 1) n = out.length + 1
    let t = byNo.get(n)
    if (!t) {
      t = {
        turn: n,
        seq: Number(seq) || 0,
        prompt: '',
        response: '',
        thinking: '',
        chunk: '',
        thinkingChunk: '',
        startedMs: 0,
        endedMs: 0,
        full: false
      }
      byNo.set(n, t)
      out.push(t)
    }
    if (!t.seq && Number(seq)) t.seq = Number(seq)
    if (!t.startedMs) t.startedMs = evMs(ev)
    return t
  }

  for (const raw of historyEvents(h)) {
    const ev = raw && typeof raw === 'object' && raw.event ? raw.event : raw
    if (!ev || typeof ev.type !== 'string') continue
    const d = ev.data || {}
    const n = Number(d.turn) || 0
    if (n > 0) lastNo = n

    if (ev.type === 'user/message') {
      // 剥掉插件注入的上下文标签，只留用户真正打的那句话
      const txt = stripInjected(contentText(d.content))
      if (!txt) continue
      const t = note(n, ev.seq, ev)
      t.prompt = t.prompt ? t.prompt + '\n\n' + txt : txt
    } else if (ev.type === 'assistant/message') {
      const m = d.message || d
      const txt = contentText(m && m.content)
      const think = contentReasoning(m && m.content)
      const t = note(n, ev.seq, ev)
      if (txt) {
        t.response = t.response ? t.response + '\n\n' + txt : txt
        t.full = true
      }
      if (think) t.thinking = t.thinking ? t.thinking + '\n\n' + think : think
    } else if (ev.type === 'assistant/chunk') {
      const c = d.chunk || {}
      if (c.type === 'text-delta' && typeof c.text === 'string' && c.text) {
        note(n, ev.seq, ev).chunk += c.text
      } else if (c.type === 'reasoning-delta' && typeof c.text === 'string' && c.text) {
        note(n, ev.seq, ev).thinkingChunk += c.text
      }
    } else if (ev.type === 'turn/end') {
      note(n, ev.seq, ev).endedMs = evMs(ev)
    }
  }

  for (const t of out) {
    if (!t.response && t.chunk) t.response = t.chunk
    if (!t.thinking && t.thinkingChunk) t.thinking = t.thinkingChunk
    delete t.chunk
    delete t.thinkingChunk
    delete t.full
    // 思考过程可能几万字（实测单轮最高 57 万），整段下发会把隧道和手机都拖死。
    // 留开头看思路、留结尾看结论，中间省略。
    if (t.thinking && t.thinking.length > THINKING_MAX) {
      const cut = t.thinking.length - THINKING_MAX
      t.thinking = t.thinking.slice(0, THINKING_MAX - 1200)
        + '\n\n…（中间省略 ' + cut + ' 字）…\n\n'
        + t.thinking.slice(-1200)
    }
    if (!t.thinking) delete t.thinking
  }
  return out.filter((t) => t.prompt || t.response)
}

// 读会话的完整历史事件。DSH 新版入口是 events()，page() 只是给旧客户端的别名；
// 一次只返回「消息预算内」的尾部，所以 hasMore 时要按 cursor 继续往前翻，
// 否则早先的轮次会整段缺失（手机上看就是对话只剩最后几条）。
export async function readSessionHistory(c, sessionId, maxPages = 8, firstPageOnly = false) {
  let method = ''
  if (typeof c.events === 'function') method = 'events'
  else if (typeof c.page === 'function') method = 'page'
  if (method === '') return { method, events: [], pages: 0, hasMore: false, fromSeq: 0 }

  const events = []
  const seen = new Set()
  let beforeSeq = 0
  let pages = 0
  let hasMore = false
  for (let i = 0; i < maxPages; i++) {
    const req = { address: { kind: 'session', sessionId }, maxMessages: 200 }
    if (beforeSeq > 0) req.beforeSeq = beforeSeq
    const page = await c[method](req, timeout(20000))
    pages += 1
    let minSeq = Number.POSITIVE_INFINITY
    for (const raw of historyEvents(page)) {
      const ev = raw && typeof raw === 'object' && raw.event ? raw.event : raw
      const seq = Number(ev && ev.seq)
      if (Number.isFinite(seq)) {
        if (seq < minSeq) minSeq = seq
        if (seen.has(seq)) continue
        seen.add(seq)
      }
      events.push(raw)
    }
    hasMore = !!(page && page.hasMore === true)
    if (!hasMore || firstPageOnly) break
    // page.cursor 是「这次读到的日志切点」，不是下一页的游标，拿它当 beforeSeq 会原地打转。
    // 真正的前进量是本页最老那条事件的 seq。
    const next = Number.isFinite(minSeq) && minSeq > 0 ? minSeq : 0
    // 没前进就停，避免死循环
    if (next <= 0) break
    if (beforeSeq > 0 && next >= beforeSeq) break
    beforeSeq = next
  }
  events.sort((a, b) => {
    const ea = a && typeof a === 'object' && a.event ? a.event : a
    const eb = b && typeof b === 'object' && b.event ? b.event : b
    return (Number(ea && ea.seq) || 0) - (Number(eb && eb.seq) || 0)
  })
  const first = events.length > 0 ? events[0] : null
  const fe = first && typeof first === 'object' && first.event ? first.event : first
  return { method, events, pages, hasMore, fromSeq: Number(fe && fe.seq) || 0 }
}

export function mergeTurns(outline, full) {
  if (!full || full.length === 0) return outline
  const byNo = new Map()
  for (const t of outline) byNo.set(Number(t.turn) || 0, t)
  for (const f of full) {
    const n = Number(f.turn) || 0
    const base = byNo.get(n)
    if (!base) {
      byNo.set(n, {
        turn: n,
        seq: f.seq,
        prompt: f.prompt,
        response: f.response,
        thinking: f.thinking,
        startedMs: f.startedMs,
        endedMs: f.endedMs
      })
      continue
    }
    // 摘要可能比全文长（加了「…」），取更长的那个
    if (f.prompt && f.prompt.length > base.prompt.length) base.prompt = f.prompt
    if (f.response && f.response.length > base.response.length) base.response = f.response
    if (f.thinking && (!base.thinking || f.thinking.length > base.thinking.length)) base.thinking = f.thinking
    if (!base.startedMs) base.startedMs = f.startedMs
    if (!base.endedMs) base.endedMs = f.endedMs
  }
  const out = []
  for (const t of byNo.values()) if (t.prompt || t.response) out.push(t)
  out.sort((a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0))
  return out
}

function turnList(values) {
  const raw = values && Array.isArray(values.turnOutline) ? values.turnOutline : []
  const out = []
  for (const t of raw) {
    const prompt = stripInjected(clean(t && t.prompt, 20000))
    const response = clean(t && t.response, 60000)
    if (!prompt && !response) continue
    out.push({
      turn: Number(t && t.turn) || out.length + 1,
      seq: Number(t && t.seq) || 0,
      prompt,
      response,
      startedMs: Number(t && t.startedMs) || 0,
      endedMs: Number(t && t.endedMs) || 0
    })
  }
  return out
}

export function apply(ctx, config = {}) {
  const cfg = config || {}
  const dataDir = path.join(os.homedir(), '.dsh', 'dsh-console-oh')
  const port = Number(cfg.port) || 8909
  const nodeName = String(cfg.name || os.hostname() || 'DSH 电脑')

  const ctl = () => {
    try { return ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null } catch (_) { return null }
  }

  // 会话 → { asOf, at, turns }：完整正文比摘要贵，按 asOfSeq 复用
  const histCache = new Map()

  // ── 已删除会话：DSH 没有删除接口，只能把会话目录挪进回收站 ─────────────
  // 直接 rm 太狠（误删没救），挪到 dataDir/trash/<id> 还能手工捞回来；
  // hidden.json 记住 id，列表里过滤掉（DSH 进程内可能仍持有会话对象）。
  const hiddenPath = path.join(dataDir, 'hidden.json')
  const trashDir = path.join(dataDir, 'trash')
  let hidden = {}
  try {
    const raw = JSON.parse(fs.readFileSync(hiddenPath, 'utf8'))
    hidden = (raw && raw.ids) || {}
  } catch (_) { hidden = {} }

  const saveHidden = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(hiddenPath, JSON.stringify({ ids: hidden }, null, 1))
    } catch (_) { }
  }

  // ── 模式（DSH 的 agent preset）───────────────────────────────────────
  // 官方只有 standard（标准）和 creator（创造）两种固定叫法，其余全部由
  // agent preset 注册表动态给出：用户在 dsh 里装/删模式插件，这里跟着变，
  // 不为某个具体插件（比如 dsh-ops）写死任何判断。
  const presetRoot = path.join(os.homedir(), '.dsh', '.agent-presets')
  const OFFICIAL_MODES = {
    standard: { name: '标准模式', description: '写代码、读文件、查资料，日常任务用它' },
    creator: { name: '创造模式', description: '让 Agent 帮你做预设模式或插件，扩展 DSH 的能力' }
  }
  /** 官方预设在注册表里通常不带 name（靠本地化文案），这里补齐中文名 */
  const KNOWN_NAMES = {
    standard: '标准模式',
    creator: '创造模式',
    ptc: 'PTC 模式',
    minimal: '极简模式',
    cordis: 'Cordis 模式'
  }
  let modesRev = 1
  let modesSnap = { rev: 1, modes: [] }
  let modesWatcher = null

  const bumpModes = () => {
    modesRev = Date.now()
  }

  /** preset.yml 只有 name / description / order 三个字段，手写解析够了，不引 yaml 依赖 */
  function readPresetMeta(dir) {
    const meta = { id: path.basename(dir), name: '', description: '', order: 0 }
    try {
      const txt = fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8')
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        const m = /^(name|description|order)\s*:\s*(.*)$/.exec(line)
        if (!m) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        if (m[1] === 'order') meta.order = Number(v) || 0
        else meta[m[1]] = v
      }
    } catch (_) { }
    return meta
  }

  /** 扫目录而不是只信注册表：插件刚装上、宿主还没重启时也能看到新模式 */
  function scanPresetDirs() {
    const out = []
    let names = []
    try { names = fs.readdirSync(presetRoot) } catch (_) { return out }
    for (const n of names) {
      const dir = path.join(presetRoot, n)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
        if (!fs.existsSync(path.join(dir, 'agent.cordis.yml'))) continue
        const meta = readPresetMeta(dir)
        meta.mtime = fs.statSync(path.join(dir, 'agent.cordis.yml')).mtimeMs || 0
        out.push(meta)
      } catch (_) { }
    }
    return out
  }

  /** 注册表是权威（它会处理重名），目录扫描是兜底（宿主没重启/未激活） */
  async function listModes() {
    const svc = (() => {
      try { return ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null } catch (_) { return null }
    })()
    let roster = []
    if (svc && typeof svc.remoteExportList === 'function') {
      try {
        const r = await svc.remoteExportList()
        roster = Array.isArray(r && r.presets) ? r.presets : []
      } catch (_) { roster = [] }
    }
    const dirs = scanPresetDirs()
    const byId = new Map()
    // 官方两个永远在：注册表没起来时也能看到「标准 / 创造」
    for (const id of ['standard', 'creator']) {
      byId.set(id, {
        id,
        name: OFFICIAL_MODES[id].name,
        description: OFFICIAL_MODES[id].description,
        official: true,
        source: 'official',
        broken: false,
        pending: roster.length === 0,
        isDefault: false
      })
    }
    for (const row of roster) {
      if (!row || !row.id) continue
      const id = String(row.id)
      const off = OFFICIAL_MODES[id]
      const prev = byId.get(id)
      byId.set(id, {
        id,
        name: String(row.name || (off && off.name) || (prev && prev.name) || KNOWN_NAMES[id] || id),
        description: String(row.description || (off && off.description) || (prev && prev.description) || ''),
        official: id === 'standard' || id === 'creator',
        source: 'registry',
        broken: row.broken !== undefined,
        pending: false,
        isDefault: row.isDefault === true
      })
    }
    for (const d of dirs) {
      const hit = byId.get(d.id)
      if (hit) {
        // 注册表给了 id 但没给名字（官方预设），用目录里的名字补
        if (d.name) hit.name = d.name
        if (d.description && !hit.description) hit.description = d.description
        continue
      }
      // 只在目录里存在：说明插件已装但宿主没重启，或注册失败（冲突/报错）
      byId.set(d.id, {
        id: d.id,
        name: d.name || KNOWN_NAMES[d.id] || d.id,
        description: d.description || '',
        official: false,
        source: 'directory',
        broken: false,
        pending: true,
        isDefault: false
      })
    }
    const modes = Array.from(byId.values())
    // 官方两个置顶：标准、创造；其余按 order/名字
    const rank = (id) => (id === 'standard' ? 0 : id === 'creator' ? 1 : 10)
    modes.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    const stamp = modes.map((m) => m.id + ':' + m.name + ':' + (m.pending ? 'p' : '')).join('|')
      + '#' + dirs.map((d) => d.id + d.mtime).join(',')
    if (stamp !== modesSnap.stamp) {
      modesRev = (Number(modesRev) || 1) + 1
      modesSnap = { rev: modesRev, modes, stamp }
    } else {
      modesSnap = { rev: modesRev, modes, stamp }
    }
    return { rev: modesRev, modes }
  }

  // 目录一变就涨版本号，手机端下一次轮询就能看到（新增 / 卸载 / 改名都算）
  try {
    if (fs.existsSync(presetRoot)) {
      modesWatcher = fs.watch(presetRoot, { persistent: false }, () => bumpModes())
      if (modesWatcher && typeof modesWatcher.on === 'function') {
        modesWatcher.on('error', () => { })
      }
    }
  } catch (_) { modesWatcher = null }

  const sessionsRoot = () => path.join(os.homedir(), '.dsh', 'sessions')

  /** 会话目录是 sessions/<工作目录编码>/<session-id>/，按 id 全局找一次 */
  function findSessionDir(sessionId) {
    const root = sessionsRoot()
    let buckets = []
    try { buckets = fs.readdirSync(root) } catch (_) { return '' }
    for (const b of buckets) {
      const p = path.join(root, b, sessionId)
      try {
        if (fs.statSync(p).isDirectory()) return p
      } catch (_) { }
    }
    return ''
  }

  const wsctl = () => {
    try { return ctx && typeof ctx.get === 'function' ? ctx.get('workspaceController') : null } catch (_) { return null }
  }

  // ── 归档集合的真源在 DSH 自己的 workspace 存储里 ─────────────────────
  // sessionController.list() 不过滤归档会话，返回的 summary 也没有 archived 字段，
  // 所以只看 list 会有两个后果：归档过的仍留在手机列表、归档库永远为空。
  // 这里直接读 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds。
  const archivedPath = cfg.archivedFile
    ? String(cfg.archivedFile)
    : path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
  let archivedCache = { at: 0, ids: new Set() }

  /** 归档集合（1s 内复用，避免列表每次刷新都读盘） */
  function archivedIds() {
    const now = Date.now()
    if (now - archivedCache.at < 1000) return archivedCache.ids
    const ids = new Set()
    try {
      const raw = JSON.parse(fs.readFileSync(archivedPath, 'utf8'))
      const arr = (raw && raw.global && raw.global.archivedSessionIds) || []
      for (const x of arr) ids.add(String(x))
    } catch (_) { }
    archivedCache = { at: now, ids }
    return ids
  }

  /** 归档命令返回的是完整归档集合，直接拿它刷新缓存 */
  function setArchivedFrom(list) {
    if (!Array.isArray(list)) return
    const ids = new Set()
    for (const x of list) ids.add(String(x))
    archivedCache = { at: Date.now(), ids }
  }

  const idsOf = (r) => {
    if (!r) return []
    const v = Array.isArray(r) ? r : (Array.isArray(r.archivedSessionIds) ? r.archivedSessionIds : [])
    return v.map((x) => String(x || '')).filter(Boolean)
  }

  // ── 手机侧的窄接口 ───────────────────────────────────────────────────
  const bridge = {
    async health() {
      const c = ctl()
      if (!c) return { ok: false, error: '拿不到 sessionController' }
      return { ok: true, version: VERSION, methods: ['list', 'projections', 'prompt', 'cancel'].filter((k) => typeof c[k] === 'function') }
    },

    async listSessions() {
      const c = ctl()
      if (!c || typeof c.list !== 'function') throw new Error('这个 DSH 版本没有 sessionController.list')
      const r = await c.list({}, timeout(15000))
      const items = Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : [])
      const arch = archivedIds()
      const out = []
      for (const s of items) {
        if (!s) continue
        // DSH 的 id 可能在 id，也可能在 sessionId；标题可能在 title 或 projections.values.title
        const id = String(s.id || s.sessionId || '')
        if (!id) continue
        const origin = String(s.origin || '')
        if (origin === 'subagent') continue
        if (s.__blank === true) continue
        // 已经在手机上删掉的，不要因为 DSH 进程里还留着对象又冒出来
        if (hidden[id]) continue
        const pv = (s.projections && s.projections.values) || {}
        const title = String(s.title || pv.title || s.name || '').trim()
        // 还没有任何一轮对话的会话不进列表（手机端「新建」会先建壳，用户没说话就不该占位）
        const outline = pv.turnOutline
        const empty = s.__blank === true || (Array.isArray(outline) && outline.length === 0)
        out.push({
          id,
          title: title.length > 0 ? title.slice(0, 120) : '未命名会话',
          cwd: String(s.cwd || ''),
          updatedAt: Number(s.updatedAt) || Number(s.lastTurnEndAt) || 0,
          createdAt: Number(s.createdAt) || 0,
          running: s.running === true,
          archived: arch.has(id) || s.archived === true,
          pinned: s.pinned === true,
          empty
        })
      }
      out.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      return out
    },

    /** 模式清单：注册表为准，目录兜底；rev 变化说明桌面端装了/删了模式插件 */
    async modes() {
      const r = await listModes()
      return { rev: r.rev, modes: r.modes }
    },

    /** 只读版本号，给 /v1/info 每 2 秒轮询用，不做完整扫描 */
    modesRev() {
      return modesRev
    },

        async turns(sessionId) {
      const c = ctl()
      if (!c || typeof c.projections !== 'function') throw new Error('这个 DSH 版本没有 sessionController.projections')
      const raw = await c.projections({ sessionId }, timeout(20000))
      const values = (raw && raw.values) || {}

      // 完整正文：turnOutline 是给对话导航栏用的「预览」，上限只有 120 字，
      // 长回答会被截成「…」。真正逐字的内容要从历史事件流折出来。
      let full = []
      try {
        const asOf = Number(raw && raw.asOfSeq) || 0
        const hit = histCache.get(sessionId)
        // 刚读过就复用，避免轮询把同一段历史反复拉一遍
        if (hit && Date.now() - hit.at < 1500) {
          full = hit.turns
        } else {
          // 已经翻到 seq 0 的会话，只需要补尾部；否则从头翻几页
          const hadAll = !!(hit && hit.fromSeq === 0 && Array.isArray(hit.events))
          let got = await readSessionHistory(c, sessionId, hadAll ? 1 : 4)
          let evs = got.events
          let fromSeq = got.fromSeq
          if (hadAll && got.hasMore) {
            // 尾部一页没盖住（隔了很久又长出一大段），退回完整翻页
            got = await readSessionHistory(c, sessionId, 4)
            evs = got.events
            fromSeq = got.fromSeq
          } else if (hadAll) {
            const map = new Map()
            for (const one of hit.events) {
              const ev = one && typeof one === 'object' && one.event ? one.event : one
              map.set(Number(ev && ev.seq) || 0, one)
            }
            for (const one of evs) {
              const ev = one && typeof one === 'object' && one.event ? one.event : one
              map.set(Number(ev && ev.seq) || 0, one)
            }
            evs = [...map.values()].sort((a, b) => {
              const ea = a && typeof a === 'object' && a.event ? a.event : a
              const eb = b && typeof b === 'object' && b.event ? b.event : b
              return (Number(ea && ea.seq) || 0) - (Number(eb && eb.seq) || 0)
            })
            fromSeq = 0
          }
          full = foldHistory({ events: evs })
          histCache.set(sessionId, { asOf, at: Date.now(), turns: full, events: evs, fromSeq })
          if (histCache.size > 24) {
            const oldest = histCache.keys().next()
            if (!oldest.done) histCache.delete(oldest.value)
          }
          // 采样：只写一份紧凑摘要，用来核对「到底读到了什么」
          try {
            const types = {}
            const blocks = {}
            for (const one of evs) {
              const ev = one && typeof one === 'object' && one.event ? one.event : one
              const t = String((ev && ev.type) || '?')
              types[t] = (types[t] || 0) + 1
              if (t === 'assistant/message') {
                const d = (ev && ev.data) || {}
                const m = d.message || d
                blockTypes(m && m.content, blocks)
              }
            }
            fs.writeFileSync(path.join(dataDir, 'debug-history.json'), JSON.stringify({
              at: new Date().toISOString(),
              sessionId,
              method: got.method,
              pages: got.pages,
              hasMore: got.hasMore,
              fromSeq,
              events: evs.length,
              turns: full.length,
              types,
              blocks,
              lengths: full.slice(-5).map((t) => ({
                turn: t.turn,
                prompt: t.prompt.length,
                response: t.response.length,
                thinking: (t.thinking || '').length
              }))
            }, null, 1))
          } catch (_) { }
        }
      } catch (e) {
        log('[turns] 读历史事件失败，退回摘要：' + String((e && e.message) || e))
      }

      const tb = values.turnBoundary
      const running = !!(tb && typeof tb === 'object' && Number(tb.openTurnStartSeq) > 0)
      const stats = values.sessionStats || {}
      const mergedTurns = mergeTurns(turnList(values), full)
      // 思考过程总量控制：从最新一轮往前分预算，太早的长思考就不下发（正文照旧）
      let thinkBudget = THINKING_BUDGET
      for (let i = mergedTurns.length - 1; i >= 0; i--) {
        const th = mergedTurns[i].thinking || ''
        if (!th) continue
        if (th.length > thinkBudget) mergedTurns[i].thinking = ''
        else thinkBudget -= th.length
      }
      return {
        sessionId,
        title: clean(values.title || '', 120),
        running,
        // 当前会话跑的是哪个 agent preset（模式）；空会话才有意义
        preset: String(values.agentPreset || ''),
        asOfSeq: Number(raw && raw.asOfSeq) || 0,
        turns: mergedTurns,
        stats: { turns: Number(stats.turns) || 0, steps: Number(stats.steps) || 0 },
        tokens: (() => {
          const tk = values.tokenUsage || {}
          const cached = Number(tk.cacheReadTokens) || 0
          const uncached = Number(tk.uncachedInputTokens) || 0
          return {
            input: uncached,
            output: Number(tk.outputTokens) || 0,
            cacheRead: cached,
            hitRate: (cached + uncached) > 0 ? Math.round(cached * 100 / (cached + uncached)) : 0
          }
        })(),
        context: (() => {
          const cp = values.contextPressure || {}
          const used = Number(cp.pressureTokens) || 0
          const win = Number(cp.contextWindow) || 0
          return { used, window: win, percent: win ? Math.round(used * 1000 / win) / 10 : 0 }
        })(),
        // 上下文构成：系统提示词 / 工具定义 / 对话消息（DSH 的 contextBreakdown 投影）
        ctxParts: (() => {
          const cb = values.contextBreakdown || {}
          return {
            system: Number(cb.systemTokens) || 0,
            tools: Number(cb.toolsTokens) || 0,
            messages: Number(cb.messageTokens) || 0
          }
        })()
      }
    },

    async command(op, p) {
      const c = ctl()
      if (!c) throw new Error('拿不到 sessionController')
      const payload = p || {}

      if (op === 'send') {
        const sessionId = String(payload.sessionId || '')
        const text = String(payload.text || '').trim()
        if (!sessionId) throw new Error('缺少 sessionId')
        if (typeof c.prompt !== 'function') throw new Error('这个 DSH 版本没有 sessionController.prompt')

        // 只发图、不发字是允许的：内容数组里只要有东西就行
        const content = []
        if (text !== '') content.push({ type: 'text', text: clean(text, 32000) })

        const imgs = Array.isArray(payload.images) ? payload.images : []
        let imgCount = 0
        for (const one of imgs.slice(0, 9)) {
          const mime = String((one && one.mime) || '')
          const data = String((one && one.data) || '')
          if (!mime.startsWith('image/') || data === '') continue
          if (data.length > 12 * 1024 * 1024) throw new Error('单张图片太大（base64 超过 12MB）')
          const name = String((one && one.name) || '')
          content.push(name !== ''
            ? { type: 'image', mediaType: mime, data, name }
            : { type: 'image', mediaType: mime, data })
          imgCount += 1
        }
        if (content.length === 0) throw new Error('消息和图片都是空的')

        await c.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: payload.mode === 'steer' ? 'steer' : 'queue',
          content
        }, timeout(30000))
        return { sent: true, images: imgCount }
      }

      if (op === 'cancel') {
        const sessionId = String(payload.sessionId || '')
        if (!sessionId) throw new Error('缺少 sessionId')
        if (typeof c.cancel !== 'function') throw new Error('这个 DSH 版本没有 sessionController.cancel')
        await c.cancel({ sessionId }, timeout(15000))
        return { cancelled: true }
      }

      if (op === 'create') {
        if (typeof c.create !== 'function') throw new Error('这个 DSH 版本没有 sessionController.create')
        // 不接受客户端指定 cwd：手机端只能建在 DSH 默认位置，避免被拿来在任意目录开工
        // 允许带模式：相当于桌面端新建时先选好 agent preset
        const presetId = String(payload.presetId || '')
        const request = presetId !== '' ? { agentPreset: presetId } : {}
        const r = await c.create(request, timeout(20000))
        const id = String((r && (r.sessionId || r.id)) || (r && r.session && r.session.id) || '')
        return { sessionId: id, agentPreset: String((r && r.agentPreset) || presetId) }
      }

      // 切模式＝给「还没有任何一轮」的会话重新选 agent preset。
      // DSH 的约束是 preset 只能在空白会话上切（否则 agent-preset/locked），
      // 这里提前判断，失败时给一句人话，而不是把系统错误抛给用户。
      if (op === 'selectMode') {
        const sessionId = String(payload.sessionId || '')
        const presetId = String(payload.presetId || '')
        if (!sessionId) throw new Error('缺少 sessionId')
        if (!presetId) throw new Error('缺少预设')
        if (typeof c.create !== 'function') throw new Error('这个 DSH 版本没有 sessionController.create')
        if (typeof c.projections !== 'function') throw new Error('这个 DSH 版本没有 sessionController.projections')

        const known = await listModes()
        if (!known.modes.some((m) => m.id === presetId)) throw new Error('电脑上没有这个模式：' + presetId)

        let outline = []
        try {
          const raw = await c.projections({ sessionId }, timeout(15000))
          const pv = (raw && raw.values) || {}
          outline = Array.isArray(pv.turnOutline) ? pv.turnOutline : []
        } catch (e) {
          throw new Error('读不到这个会话：' + String((e && e.message) || e))
        }
        if (outline.length > 0) throw new Error('这个会话已经聊过了，模式只对还没开始的新会话生效')

        const r = await c.create({ sessionId, agentPreset: presetId }, timeout(20000))
        const gotId = String((r && (r.sessionId || r.id)) || '')
        if (gotId !== '' && gotId !== sessionId) {
          // 没复用说明会话已经不是空白：把刚多出来的空壳藏掉，别让它污染列表
          hidden[gotId] = { at: Date.now(), dir: '' }
          saveHidden()
          throw new Error('会话已经开始对话，模式没切成功；新建一个会话再选模式')
        }
        return { sessionId, agentPreset: String((r && r.agentPreset) || presetId) }
      }

      if (op === 'rename') {
        const sessionId = String(payload.sessionId || '')
        const title = clean(payload.title, 120)
        if (!sessionId) throw new Error('缺少 sessionId')
        if (!title) throw new Error('标题是空的')
        if (typeof c.rename !== 'function') throw new Error('这个 DSH 版本没有 sessionController.rename')
        await c.rename({ sessionId, title }, timeout(15000))
        return { renamed: true }
      }

      // 归档是 DSH 自己的概念（workspace.archiveSession），
      // 用原生实现才能让电脑端和手机端看到一致的归档状态。
      if (op === 'archive' || op === 'unarchive') {
        const sessionId = String(payload.sessionId || '')
        if (!sessionId) throw new Error('缺少 sessionId')
        const w = wsctl()
        if (!w) throw new Error('这个 DSH 版本拿不到 workspaceController')
        if (op === 'archive') {
          if (typeof w.archiveSession !== 'function') throw new Error('这个 DSH 版本没有 archiveSession')
          const r = await w.archiveSession({ sessionId, stopActivity: payload.stopActivity === true || payload.stopActivity === 'true' }, timeout(20000))
          setArchivedFrom(idsOf(r))
          return { archived: true, ids: idsOf(r) }
        }
        if (typeof w.unarchiveSession !== 'function') throw new Error('这个 DSH 版本没有 unarchiveSession')
        const r = await w.unarchiveSession({ sessionId }, timeout(20000))
        setArchivedFrom(idsOf(r))
        return { archived: false, ids: idsOf(r) }
      }

      // 删除：挪进本插件的回收站并记入 hidden，列表立刻消失；
      // 想彻底抹掉再调 purge（归档库里的「彻底删除」）。
      if (op === 'delete' || op === 'purge') {
        const listed = Array.isArray(payload.sessionIds)
          ? payload.sessionIds
          : (payload.sessionId ? [payload.sessionId] : [])
        const ids = [...new Set(listed.map((x) => String(x || '')).filter(Boolean))]
        if (ids.length === 0) throw new Error('没有要删的会话')

        if (op === 'purge') {
          let n = 0
          for (const id of ids) {
            try {
              fs.rmSync(path.join(trashDir, id), { recursive: true, force: true })
              n += 1
            } catch (_) { }
          }
          return { purged: n }
        }

        const all = typeof c.list === 'function' ? await bridge.listSessions() : []
        const byId = new Map(all.map((s) => [s.id, s]))
        const w = wsctl()
        const deleted = []
        const failed = []
        for (const id of ids) {
          const s = byId.get(id)
          if (s && s.running === true) {
            failed.push({ id, error: '会话正在运行，先停止再删' })
            continue
          }
          // 归档集合里不能留一个已经不存在的会话
          if (s && s.archived === true && w && typeof w.unarchiveSession === 'function') {
            try { await w.unarchiveSession({ sessionId: id }, timeout(15000)) } catch (_) { }
          }
          const dir = findSessionDir(id)
          if (dir) {
            try {
              fs.mkdirSync(trashDir, { recursive: true })
              const target = path.join(trashDir, id)
              try { fs.rmSync(target, { recursive: true, force: true }) } catch (_) { }
              fs.renameSync(dir, target)
            } catch (e) {
              failed.push({ id, error: '挪走会话目录失败：' + String((e && e.message) || e) })
              continue
            }
          }
          hidden[id] = { at: Date.now(), dir }
          deleted.push(id)
        }
        saveHidden()
        return { deleted, failed }
      }

      if (op === 'models') {
        const sessionId = String(payload.sessionId || '')
        if (!sessionId) throw new Error('缺少 sessionId')

        const errs = []
        const attempts = []
        if (typeof c.modelCatalog === 'function') {
          // 参考实现按这个顺序调用：带 request 和 signal 的那次才是 RPC 正解。
          // 之前只试无参调用，代理返回空对象也不报错，界面就成了「选择模型」。
          attempts.push(['modelCatalog(request,signal)', () => c.modelCatalog({ sessionId }, timeout(15000))])
          attempts.push(['modelCatalog(request)', () => c.modelCatalog({ sessionId })])
          attempts.push(['modelCatalog()', () => c.modelCatalog()])
        }

        const looksLikeCatalog = (x) => !!x && typeof x === 'object'
          && (Array.isArray(x.groups) || (x.default && typeof x.default === 'object'))

        // RPC 可能把结果包在 value / result / data / catalog 里，逐层剥开
        const unwrap = (raw) => {
          let v = raw
          if (typeof v === 'string') { try { v = JSON.parse(v) } catch (_) { v = null } }
          for (let i = 0; i < 4; i++) {
            if (looksLikeCatalog(v)) return v
            if (v && typeof v === 'object') {
              const inner = v.value || v.result || v.data || v.catalog
              if (inner && typeof inner === 'object') { v = inner; continue }
            }
            break
          }
          return v
        }

        let v = null
        let via = ''
        for (const [label, fn] of attempts) {
          try {
            const got = unwrap(await fn())
            if (looksLikeCatalog(got)) { v = got; via = label; break }
            errs.push(label + ' → 返回形状不对：' + (got === null ? 'null' : typeof got))
          } catch (e) {
            errs.push(label + ' → ' + String((e && e.message) || e))
          }
        }

        // 兜底：直接问 LLM 注册表（桌面端模型列表就是从这里来的）
        if (v === null && ctx && typeof ctx.get === 'function') {
          try {
            const llm = ctx.get('llm')
            if (llm && typeof llm.listProviders === 'function') {
              const provs = await llm.listProviders()
              const groups = []
              const failures = []
              for (const p of (Array.isArray(provs) ? provs : [])) {
                const pid = String((p && p.id) || '')
                if (pid === '') continue
                try {
                  const models = await llm.listModels(pid)
                  const entries = []
                  for (const m of (Array.isArray(models) ? models : [])) {
                    const mid = String((m && m.id) || '')
                    if (mid === '') continue
                    let reasoning = m && m.reasoning
                    if (!reasoning && typeof llm.resolveModelInfo === 'function') {
                      try {
                        const info = await llm.resolveModelInfo(pid, mid)
                        reasoning = info && info.reasoning
                      } catch (_) { }
                    }
                    entries.push({
                      id: mid,
                      name: String((m && m.name) || mid),
                      description: String((m && m.description) || ''),
                      reasoning: reasoning || undefined
                    })
                  }
                  groups.push({ id: pid, name: String((p && p.name) || pid), models: entries })
                } catch (e) {
                  failures.push({ id: pid, name: String((p && p.name) || pid), message: String((e && e.message) || e) })
                }
              }
              if (groups.some((g) => g.models.length > 0)) {
                v = { groups, failures, default: {} }
                via = 'llm registry'
              } else {
                errs.push('llm registry → 没有可用模型')
              }
            }
          } catch (e) {
            errs.push('llm registry → ' + String((e && e.message) || e))
          }
        }

        // 一律留一份体检记录，出问题不用再猜
        try {
          const brief = {
            at: new Date().toISOString(),
            sessionId,
            via: via || 'none',
            groupCount: v === null ? 0 : (v.groups || []).length,
            groups: v === null ? [] : (v.groups || []).map((g) => ({
              id: String(g.id || ''),
              name: String(g.name || ''),
              models: (g.models || []).slice(0, 40).map((m) => String(m.id || ''))
            })),
            failures: v === null ? [] : (v.failures || []).map((f) => String(f.id || '') + ': ' + String(f.message || '')),
            attempts: errs
          }
          fs.writeFileSync(path.join(dataDir, 'debug-models.log'), JSON.stringify(brief, null, 1))
        } catch (_) { }

        if (v === null) throw new Error('模型目录读不了：' + (errs.join(' | ') || '没有可用的读取方式'))

        // DSH 的目录里当前选择在 default（全局默认）；会话自己的选择在投影 modelSelection.next。
        // 只有拿不到投影时才退回 default，否则会显示成「选择模型」。
        let cur = v.current || v.default || {}
        try {
          if (typeof c.projections === 'function') {
            const proj = await c.projections({ sessionId }, timeout(15000))
            const vals = (proj && proj.values) || {}
            const ms = vals.modelSelection || vals.model || null
            const next = ms && (ms.next || ms.current || ms)
            if (next && next.provider && next.model) cur = next
          }
        } catch (e) { log('[models] 读会话模型选择失败：' + String((e && e.message) || e)) }

        return {
          current: {
            provider: String(cur.provider || ''),
            model: String(cur.model || cur.id || ''),
            reasoningEffort: cur.reasoningEffort ? String(cur.reasoningEffort) : ''
          },
          groups: (v.groups || []).map((g) => ({
            id: String(g.id || ''),
            name: String(g.name || g.id || ''),
            models: (g.models || []).map((m) => ({
              id: String(m.id || ''),
              name: String(m.name || m.id || ''),
              provider: String(m.provider || g.id || ''),
              description: String(m.description || ''),
              efforts: ((m.reasoning && m.reasoning.efforts) || []).map((e) => ({
                id: String(e.id || ''), name: String(e.name || e.id || '')
              })),
              defaultEffort: (m.reasoning && m.reasoning.defaultEffort) ? String(m.reasoning.defaultEffort) : ''
            }))
          })),
          failures: (v.failures || []).map((f) => ({ id: String(f.id || ''), name: String(f.name || ''), message: String(f.message || '') }))
        }
      }

      if (op === 'selectModel') {
        const sessionId = String(payload.sessionId || '')
        if (!sessionId) throw new Error('缺少 sessionId')
        if (typeof c.selectModel !== 'function') throw new Error('这个 DSH 版本没有 selectModel')
        const args = {
          sessionId,
          provider: String(payload.provider || ''),
          model: String(payload.model || '')
        }
        if (!args.provider || !args.model) throw new Error('缺少 provider 或 model')
        const effort = String(payload.reasoningEffort || '')
        if (effort) args.reasoningEffort = effort
        const r = await c.selectModel(args)
        return { selected: { provider: args.provider, model: args.model, reasoningEffort: effort } }
      }

      throw new Error('不支持的指令：' + op)
    }
  }

  let panelServer = null
  const tunnel = new CloudflaredTunnel({
    dir: path.join(dataDir, 'bin'),
    port: () => (panelServer ? panelServer.port : port),
    binPath: cfg.cloudflaredPath || '',
    downloadBase: cfg.downloadBase || '',
    log
  })

  panelServer = createConsoleServer({ bridge, dataDir, port, name: nodeName, log, tunnel })

  let disposed = false

  async function boot() {
    try {
      const real = await panelServer.start()
      log('局域网服务已起：0.0.0.0:' + real + ' · 节点「' + nodeName + '」')
      log('配对码在 DSH 设置 → DSH 控制台 里看，或翻上面那行 [pair]。')
    } catch (e) {
      log('服务起不来：' + ((e && e.message) || e))
    }
    if (cfg.tunnel === true || panelServer.getTunnelAuto()) {
      tunnel.start().then((s) => {
        log('隧道状态：' + s.state + (s.url ? ' ' + s.url : ''))
        if (s.state === 'up') log('二维码现在带的是公网地址')
      }).catch(() => { })
    }
  }

  // ── 面板路由（DSH 客户端半边读这个） ──────────────────────────────────
  const routes = []
  function jsonOf(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  }

  // 面板这几条路由只允许回环访问：DSH 的 web 端口一旦被暴露到局域网，
  // 别人直接打开 /api/dsh-console-oh/state 就能看到配对码，等于绕过一切配对。
  // 面板这几条路由的守卫。判定顺序：
  //   1) 非 http(s) 的 URL（Electron 自定义协议）——只可能来自宿主自己，放行
  //   2) 回环主机名——放行
  //   3) 同源请求（浏览器里页面自己发起的 fetch）——放行
  //   4) 其余（别人直接在浏览器里打开这个地址）——403
  // 被拒时把 host 写进日志文件，方便排查到底是谁在调。
  function panelGuard(request) {
    let u = null
    try { u = new URL(String(request.url)) } catch (_) { u = null }
    const host = u ? String(u.hostname || '').toLowerCase() : ''
    const proto = u ? String(u.protocol || '') : ''

    if (proto !== '' && proto !== 'http:' && proto !== 'https:') return null

    const name = host.replace(/^\[/, '').replace(/\]?$/, '')
    // dsh.internal 是宿主自己的内部域名（Electron 内部映射），面板的请求就长这样
    if (name === '' || name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === 'dsh.internal') return null

    // 同源判定：Origin / Referer 任一匹配，或浏览器自己标了 same-origin
    let originHost = ''
    for (const key of ['origin', 'referer']) {
      try {
        const raw = request.headers.get(key) || ''
        if (raw === '' || raw === 'null') continue
        const oh = new URL(raw).host
        if (oh !== '') { originHost = oh; break }
      } catch (_) { }
    }
    let site = ''
    try { site = String(request.headers.get('sec-fetch-site') || '') } catch (_) { site = '' }
    if (site === 'same-origin' || site === 'same-site') return null
    if (originHost !== '' && u && originHost === u.host) return null

    try {
      fs.appendFileSync(path.join(os.homedir(), '.dsh', 'dsh-console-oh', 'panel-denied.log'),
        new Date().toISOString() + ' host=' + host + ' proto=' + proto + ' origin=' + originHost + ' site=' + site + ' url=' + String(request.url) + '\n')
    } catch (_) { }
    log('[panel] 拒绝访问：host=' + host + ' proto=' + proto + ' origin=' + originHost)
    return new Response(JSON.stringify({ ok: false, error: '只允许在本机访问控制台面板' }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  }

  function scrub(m) {
    return String(m == null ? '' : m)
      .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
      .replace(/\/(?:[\w.-]+\/){2,}[\w.-]+/g, '<path>')
      .slice(0, 160)
  }

  function registerRoutes() {
    let conn = null
    try { conn = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : null } catch (_) { conn = null }
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') {
      log('拿不到 connection.fetch，面板没有数据（App 侧不受影响）')
      return false
    }
    const add = (route) => {
      try {
        const inner = route.fetch
        route.fetch = async (request) => {
          const denied = panelGuard(request)
          if (denied) return denied
          return inner(request)
        }
        const off = conn.fetch.register(route)
        if (typeof off === 'function') routes.push(off)
      } catch (e) {
        log('路由注册失败 ' + route.path + '：' + ((e && e.message) || e))
      }
    }

    add({
      path: STATE_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => {
        try { return jsonOf(200, panelServer.panelState()) } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: NEWCODE_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let body = {}
          try { body = await request.json() } catch (_) { }
          panelServer.newCode(body && body.scope === 'lan' ? 'lan' : 'wan')
          return jsonOf(200, panelServer.panelState())
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: TOGGLE_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let body = {}
          try { body = await request.json() } catch (_) { }
          if (typeof body.remotePair === 'boolean') panelServer.setRemotePair(body.remotePair)
          if (typeof body.readOnly === 'boolean') panelServer.setReadOnly(body.readOnly)
          if (typeof body.lanAccess === 'boolean') await panelServer.setLanAccess(body.lanAccess)
          if (typeof body.deviceId === 'string' && body.deviceId !== '') {
            const n = panelServer.revokeDevice(body.deviceId)
            log('[devices] 踢掉 ' + n + ' 台设备')
          }
          return jsonOf(200, panelServer.panelState())
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: TUNNEL_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let body = {}
          try { body = await request.json() } catch (_) { }
          if (String(body.action || '') === 'stop') { tunnel.stop(); panelServer.setTunnelAuto(false) }
          // 起隧道可能要下载几十兆，别让面板请求挂在这儿等
          else {
            panelServer.setTunnelAuto(true)
            tunnel.start().then((s) => log('隧道：' + s.state + (s.url ? ' ' + s.url : ''))).catch(() => { })
          }
          return jsonOf(200, panelServer.panelState())
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: QR_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => {
        try {
          const link = panelServer.pairLink()
          if (!link) return new Response('还没有可用地址', { status: 409, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          const svg = await qrSvg(link)
          return new Response(svg, {
            headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' }
          })
        } catch (e) {
          log('二维码生成失败：' + ((e && e.message) || e))
          return new Response('二维码生成失败', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        }
      }
    })

    add({
      path: SESSIONS_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => {
        try {
          const list = await bridge.listSessions()
          return jsonOf(200, { ok: true, sessions: list })
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: TURNS_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const id = new URL(String(request.url)).searchParams.get('id') || ''
          if (id === '') return jsonOf(400, { ok: false, error: '缺少 id' })
          const detail = await bridge.turns(id)
          return jsonOf(200, Object.assign({ ok: true }, detail))
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    add({
      path: SEND_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let body = {}
          try { body = await request.json() } catch (_) { }
          const sessionId = String(body.sessionId || '')
          const text = String(body.text || '').trim()
          if (sessionId === '' || text === '') return jsonOf(400, { ok: false, error: '缺 sessionId 或内容' })
          await bridge.command('send', { sessionId, text })
          return jsonOf(200, { ok: true })
        } catch (e) { return jsonOf(500, { ok: false, error: scrub(e && e.message || e) }) }
      }
    })

    log('面板路由已注册：' + STATE_PATH)
    return true
  }

  const bootAll = () => {
    if (disposed) return
    boot()
    if (!registerRoutes()) {
      let n = 0
      const iv = setInterval(() => {
        n += 1
        if (disposed || n > 20 || registerRoutes()) clearInterval(iv)
      }, 500)
    }
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        bootAll()
        return () => {
          disposed = true
          for (const off of routes) { try { off() } catch (_) { } }
          try { if (modesWatcher) modesWatcher.close() } catch (_) { }
          modesWatcher = null
          tunnel.stop()
          panelServer.stop()
        }
      }, 'dsh-console-oh: server')
    } else {
      bootAll()
    }
  } catch (e) {
    log('初始化失败：' + ((e && e.stack) || e))
  }

  // 兜底：进程退出时收拾子进程
  try {
    process.once('exit', () => { try { tunnel.stop() } catch (_) { } })
  } catch (_) { }
}