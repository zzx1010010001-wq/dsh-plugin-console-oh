// cloudflared 隧道管理：缺失时自动下载，跑起来后从日志里抠公网地址。
// 不依赖 cloudflared 的配置文件，用官方 quick tunnel（trycloudflare.com）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const UPSTREAM = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'
// 校园网/国内网络经常直连不通 GitHub，按顺序换镜像试
const MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/'
]
const MIN_BYTES = 8 * 1024 * 1024

// 各平台校验：Windows 验 Authenticode（签名者 Cloudflare, Inc.），
// macOS 验 Apple Developer ID 签名（codesign，同样认 Cloudflare），
// Linux 没有统一签名机制，只靠 HTTPS 直连官方 release（走镜像时无本地校验，README 有说明）。
// 这是唯一从外部取可执行文件的地方，验不过就删掉、拒绝启动。
export function verifyBin(bin) {
  if (process.platform === 'win32') {
    const script = [
      '$s = Get-AuthenticodeSignature -LiteralPath $env:DCO_BIN',
      "if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Cloudflare') { 'OK' }",
      "else { 'BAD ' + $s.Status + ' | ' + $s.SignerCertificate.Subject }"
    ].join('; ')
    let r
    try {
      r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: Object.assign({}, process.env, { DCO_BIN: bin }),
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true
      })
    } catch (e) {
      return { ok: false, reason: '签名校验没跑起来：' + ((e && e.message) || e) }
    }
    const out = String((r && r.stdout) || '').trim()
    if (out === 'OK') return { ok: true, reason: '' }
    return { ok: false, reason: out || ('校验无输出，退出码 ' + (r && r.status)) }
  }
  if (process.platform === 'darwin') {
    let r
    try {
      r = spawnSync('codesign', ['--verify', '--strict', bin], { timeout: 20000 })
    } catch (e) {
      return { ok: false, reason: 'codesign 没跑起来：' + ((e && e.message) || e) }
    }
    if ((r.status || 0) !== 0) {
      return { ok: false, reason: (r.stderr && String(r.stderr).trim()) || 'codesign 校验失败（exit ' + r.status + '）' }
    }
    const d = spawnSync('codesign', ['--display', '--verbose=2', bin], { timeout: 20000 })
    const info = String((d.stderr || d.stdout) || '')
    if (/Cloudflare/i.test(info)) return { ok: true, reason: '' }
    return { ok: false, reason: '签名授权方不是 Cloudflare' }
  }
  return { ok: true, reason: '' }
}

// 非 Windows 统一叫 cloudflared：与官方 tgz 内文件名、brew/系统安装名一致，PATH 查找也能命中
const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'

export function assetName() {
  // Windows 恒用 amd64（ARM Windows 可跑 x64 模拟）；darwin/linux 按机器架构取官方资产
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe'
  const arm = process.arch === 'arm64'
  if (process.platform === 'darwin') return arm ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  return arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'
}

// darwin 官方资产是 .tgz（内含单个文件 cloudflared）；三大平台都有 tar（macOS/Linux 原生，Windows 10+ 内置）
function extractTgz(tgzPath, destDir) {
  const r = spawnSync('tar', ['-xzf', tgzPath, '-C', destDir], { timeout: 60000, windowsHide: true })
  if (r.error || (r.status !== 0 && r.status !== null)) {
    const detail = (r.stderr && String(r.stderr).trim()) || (r.error && r.error.message) || 'exit ' + r.status
    throw new Error('tgz 解包失败：' + detail)
  }
  const out = path.join(destDir, 'cloudflared')
  if (!fs.existsSync(out)) throw new Error('tgz 解包后没找到 cloudflared')
  return out
}

export class CloudflaredTunnel {
  constructor(opts) {
    this.dir = opts.dir
    this.port = () => opts.port()
    this.log = opts.log || (() => {})
    this.state = 'idle'
    this.url = ''
    this.error = ''
    this.child = null
    this.since = 0
    this.manualBin = opts.binPath ? String(opts.binPath) : ''
    this.verified = false
    this.downloadBase = opts.downloadBase ? String(opts.downloadBase) : ''
  }

  binPath() {
    if (this.manualBin && fs.existsSync(this.manualBin)) return this.manualBin
    const local = path.join(this.dir, BIN_NAME)
    if (fs.existsSync(local)) return local
    // PATH 里已有的直接用
    const dirs = String(process.env.PATH || '').split(path.delimiter)
    for (const d of dirs) {
      if (!d) continue
      const p = path.join(d, BIN_NAME)
      try { if (fs.existsSync(p)) return p } catch (_) { }
    }
    return ''
  }

  status() {
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      since: this.since,
      bin: this.binPath() ? 'ok' : 'missing',
      provider: 'cloudflared'
    }
  }

  async ensureBinary() {
    const have = this.binPath()
    if (have) return have
    fs.mkdirSync(this.dir, { recursive: true })
    const asset = assetName()
    const tgz = asset.endsWith('.tgz')
    const dest = path.join(this.dir, tgz ? BIN_NAME + '.tgz' : BIN_NAME)
    this.state = 'downloading'
    this.error = ''

    const bases = this.downloadBase !== '' ? [this.downloadBase] : MIRRORS
    const errors = []
    for (const base of bases) {
      const url = base === '' ? UPSTREAM + asset : base + UPSTREAM + asset
      try {
        this.log('[tunnel] 下载 cloudflared：' + url)
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < MIN_BYTES) throw new Error('文件不完整（' + buf.length + ' 字节）')
        fs.writeFileSync(dest, buf)
        let bin = dest
        if (tgz) {
          bin = extractTgz(dest, this.dir)
          try { fs.unlinkSync(dest) } catch (_) { }
        }
        try { fs.chmodSync(bin, 0o755) } catch (_) { }
        const sig = verifyBin(bin)
        if (!sig.ok) {
          try { fs.unlinkSync(bin) } catch (_) { }
          throw new Error('签名校验不通过（' + sig.reason + '），已删除这个文件')
        }
        this.verified = true
        this.log('[tunnel] cloudflared 就位（' + Math.round(buf.length / 1048576) + 'MB，签名已校验）')
        return bin
      } catch (e) {
        const msg = String((e && e.message) || e)
        errors.push((base === '' ? 'github' : base.replace(/^https?:\/\//, '').replace(/\/$/, '')) + ': ' + msg)
        this.log('[tunnel] 这一路没成 —— ' + msg)
      }
    }
    throw new Error('自动下载失败。可以手动下载 ' + asset + ' 解压放到 ' + this.dir + '，或装好后在配置里写 cloudflaredPath。（' + errors.join('；') + '）')
  }

  async start() {
    if (this.state === 'up' || this.state === 'starting') return this.status()
    this.error = ''
    this.since = Date.now()
    let bin = ''
    try { bin = await this.ensureBinary() } catch (e) {
      this.state = 'failed'
      this.error = String((e && e.message) || e)
      this.log('[tunnel] ' + this.error)
      return this.status()
    }

    if (!this.verified) {
      const sig = verifyBin(bin)
      if (!sig.ok) {
        this.state = 'failed'
        this.error = '云隧道程序签名校验不通过（' + sig.reason + '），已拒绝启动。删掉 ' + bin + ' 重新下载，或自己从官网放一份。'
        this.log('[tunnel] ' + this.error)
        return this.status()
      }
      this.verified = true
    }

    this.state = 'starting'
    const args = ['tunnel', '--url', 'http://127.0.0.1:' + this.port(), '--no-autoupdate', '--loglevel', 'info']
    this.log('[tunnel] ' + bin + ' ' + args.join(' '))
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.state = 'failed'
      this.error = 'cloudflared 启动失败：' + ((e && e.message) || e)
      return this.status()
    }
    this.child = child
    const onData = (buf) => {
      const text = String(buf)
      const hit = text.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i)
      if (hit && this.url !== hit[0]) {
        this.url = hit[0]
        this.state = 'up'
        this.error = ''
        this.log('[tunnel] 公网地址就绪：' + this.url)
      }
      if (/ERR|error|failed/i.test(text) && this.state === 'starting') {
        const line = text.split('\n').map((s) => s.trim()).filter(Boolean).pop() || ''
        if (line) this.error = line.slice(0, 300)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      this.child = null
      if (this.state !== 'idle') {
        this.state = code === 0 ? 'idle' : 'failed'
        if (code !== 0 && !this.error) this.error = 'cloudflared 退出，代码 ' + code
        this.log('[tunnel] 退出 code=' + code)
      }
    })
    return this.status()
  }

  stop() {
    this.state = 'idle'
    this.url = ''
    if (this.child) {
      try { this.child.kill() } catch (_) { }
      this.child = null
    }
    return this.status()
  }
}