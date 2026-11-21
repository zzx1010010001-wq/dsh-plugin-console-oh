window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致：rc.5 内核按包名建表，
  // 收到的注册 id 不等于包名会被判为「loaded without registering」直接丢弃
  id: "dsh-plugin-console-oh",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const { useState, useEffect, useCallback } = react
    const h = react.createElement

    const inject = ["slots", "locale"]

    const STATE = "/api/dsh-console-oh/state"
    const NEWCODE = "/api/dsh-console-oh/newcode"
    const TOGGLE = "/api/dsh-console-oh/toggle"
    const TUNNEL = "/api/dsh-console-oh/tunnel"
    const QR = "/api/dsh-console-oh/qr"
    const SESSIONS = "/api/dsh-console-oh/sessions"
    const TURNS = "/api/dsh-console-oh/turns"
    const SEND = "/api/dsh-console-oh/send"

    const CSS = `
.dco-wrap{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.6}
.dco-card{border:1px solid rgba(128,128,128,.22);border-radius:16px;padding:14px 14px 12px;background:rgba(128,128,128,.04)}
.dco-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dco-h{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-bottom:6px}
.dco-name{font-size:15px;font-weight:600}
.dco-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px}
.dco-code{font:600 34px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.22em;padding:10px 0 4px}
.dco-sub{opacity:.6;font-size:12px}
.dco-btn{border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;border-radius:10px;
font-size:12px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.dco-btn:hover{background:rgba(128,128,128,.12)}
.dco-btn[disabled]{opacity:.4;cursor:default}
.dco-btn.primary{background:rgba(76,141,255,.16);border-color:rgba(76,141,255,.5);color:#8ab4ff}
.dco-btn.danger{color:#f2635f;border-color:rgba(242,99,95,.35)}
.dco-mono{font:12px/1.5 ui-monospace,Consolas,monospace;word-break:break-all;opacity:.85}
.dco-tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.3)}
.dco-tag.on{border-color:rgba(62,207,142,.55);color:#3ecf8e}
.dco-tag.off{opacity:.6}
.dco-tag.bad{border-color:rgba(242,99,95,.55);color:#f2635f}
.dco-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dco-dev{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px}
.dco-switch{width:38px;height:22px;border-radius:999px;border:1px solid rgba(128,128,128,.35);
background:transparent;position:relative;cursor:pointer;flex:0 0 auto}
.dco-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
background:rgba(128,128,128,.6);transition:transform .16s ease,background .16s ease}
.dco-switch.on{border-color:rgba(76,141,255,.6);background:rgba(76,141,255,.18)}
.dco-switch.on i{transform:translateX(16px);background:#4c8dff}
.dco-note{opacity:.5;font-size:11.5px;line-height:1.6}
.dco-qr{display:flex;gap:14px;align-items:flex-start;margin-top:8px}
.dco-qrimg{width:126px;height:126px;flex:0 0 auto;border-radius:12px;background:#fff;padding:5px;display:block}
.dco-qrside{display:flex;flex-direction:column;gap:6px;min-width:0}
.dco-warnbox{margin-top:6px;padding:7px 9px;border-radius:9px;background:rgba(232,177,76,.12);border:1px solid rgba(232,177,76,.35);color:#e8b14c;font-size:11.5px;line-height:1.5}
.dco-qrfallback{width:126px;flex:0 0 auto;border-radius:12px;border:1px dashed rgba(128,128,128,.4);padding:10px;display:flex;flex-direction:column;gap:6px;justify-content:center}
.dco-hist{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.dco-hrow{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;cursor:pointer;
border:1px solid rgba(128,128,128,.16);background:rgba(128,128,128,.05)}
.dco-hrow:hover{background:rgba(128,128,128,.12)}
.dco-htitle{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dco-hbody{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:10px;
padding:10px;border-radius:10px;border:1px solid rgba(128,128,128,.16);background:rgba(0,0,0,.12)}
.dco-turn{display:flex;flex-direction:column;gap:4px}
.dco-tu{align-self:flex-end;max-width:86%;padding:6px 9px;border-radius:10px;background:rgba(76,141,255,.16);font-size:12.5px;white-space:pre-wrap}
.dco-ta{font-size:12.5px;white-space:pre-wrap;opacity:.92}
.dco-send{display:flex;gap:8px;margin-top:8px}
.dco-input{flex:1;min-height:34px;max-height:90px;resize:vertical;border-radius:10px;padding:7px 10px;
border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font:inherit;font-size:12.5px}
.dco-swrow{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:9px 0}
.dco-swrow+.dco-swrow{border-top:1px solid rgba(128,128,128,.14)}
`

    function useCss(id, text) {
      useEffect(() => {
        try {
          if (typeof document === "undefined" || !document.head) return
          if (document.getElementById(id)) return
          const el = document.createElement("style")
          el.id = id
          el.textContent = text
          document.head.appendChild(el)
        } catch (_) { }
      }, [])
    }

    function call(path, method, body) {
      return fetch(path, {
        method: method || "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      }).then((r) => r.json())
    }

    function fmtLeft(exp) {
      if (!exp) return ""
      const left = Math.max(0, Math.floor((exp - Date.now()) / 1000))
      const m = String(Math.floor(left / 60)).padStart(2, "0")
      const s = String(left % 60).padStart(2, "0")
      return m + ":" + s
    }

    function day(ms) {
      if (!ms) return "—"
      const d = new Date(ms)
      return (d.getMonth() + 1) + "-" + d.getDate()
    }

    function Card(props) {
      return h("div", { className: "dco-card" }, props.children)
    }

    function Switch(props) {
      return h("button", {
        className: "dco-switch" + (props.on ? " on" : ""),
        onClick: props.onClick,
        "aria-pressed": props.on ? "true" : "false"
      }, h("i", null))
    }

    function Panel() {
      useCss("dco-css", CSS)
      const [st, setSt] = useState(null)
      const [err, setErr] = useState("")
      const [busy, setBusy] = useState("")
      const [tick, setTick] = useState(0)
      const [qrKey, setQrKey] = useState(0)
      const [qrErr, setQrErr] = useState(false)
      const [hist, setHist] = useState(null)
      const [openId, setOpenId] = useState("")
      const [detail, setDetail] = useState(null)
      const [draft, setDraft] = useState("")
      const [sending, setSending] = useState(false)

      const load = useCallback(() => {
        call(STATE).then((j) => {
          if (j && j.ok) { setSt(j); setErr("") } else setErr((j && j.error) || "读不到状态")
        }).catch((e) => setErr(String(e && e.message || e)))
      }, [])

      useEffect(() => {
        load()
        loadHist()
        const iv = setInterval(load, 3000)
        const tv = setInterval(() => setTick((n) => n + 1), 1000)
        return () => { clearInterval(iv); clearInterval(tv) }
      }, [load])

      const act = (name, path, body) => {
        setBusy(name)
        call(path, "POST", body || {})
          .then((j) => { if (j && j.ok) setSt(j); else setErr((j && j.error) || "操作失败") })
          .catch((e) => setErr(String(e && e.message || e)))
          .then(() => setBusy(""))
      }

      const loadHist = () => {
        call(SESSIONS).then((j) => { if (j && j.ok) setHist(j.sessions || []) }).catch(() => { })
      }

      const openSession = (id) => {
        setOpenId(id)
        setDetail(null)
        call(TURNS + "?id=" + encodeURIComponent(id))
          .then((j) => setDetail(j && j.ok ? j : { turns: [], error: (j && j.error) || "" }))
          .catch(() => setDetail({ turns: [], error: "读不到会话" }))
      }

      const sendHere = () => {
        const text = String(draft || "").trim()
        if (text === "" || sending) return
        setSending(true)
        call(SEND, "POST", { sessionId: openId, text })
          .then((j) => {
            if (j && j.ok) { setDraft(""); openSession(openId) }
            else setErr((j && j.error) || "发送失败")
          })
          .catch((e) => setErr(String(e && e.message || e)))
          .then(() => setSending(false))
      }

      const copy = (text) => {
        try { navigator.clipboard.writeText(text) } catch (_) { }
      }

      if (!st) {
        return h("div", { className: "dco-wrap" }, h(Card, null, h("div", { className: "dco-sub" }, err || "正在读取…")))
      }

      const tun = st.tunnel || { state: "idle", url: "", error: "" }
      const tunnelUp = !!(tun.state === "up" && tun.url)
      const lanNamed = Array.isArray(st.lanNamed) && st.lanNamed.length ? st.lanNamed : []
      const qrSrc = QR + "?_=" + qrKey + "-" + String(st.publicUrl || "").slice(-6)
      const noAddr = !tunnelUp && !st.lanAccess

      return h("div", { className: "dco-wrap" },

        // 抬头
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", null,
              h("div", { className: "dco-name" }, st.name),
              h("div", { className: "dco-sub" }, "DSH 控制台 · v" + st.version + " · 端口 " + st.port)
            ),
            h("div", { className: "dco-row" },
              h("span", { className: "dco-tag on" }, "服务在线"),
              h("span", { className: "dco-tag " + (tunnelUp ? "on" : "off") }, tunnelUp ? "公网已通" : "公网未开")
            )
          ),
          st.lanAccess
            ? h("div", { className: "dco-list" },
              lanNamed.map((x) => h("div", { key: x.ip, className: "dco-mono" }, (x.iface ? x.iface + " · " : "") + "http://" + x.ip + ":" + st.port)))
            : h("div", { className: "dco-sub", style: { marginTop: 6 } },
              h("span", { className: "dco-mono" }, "127.0.0.1:" + st.port + " · 只监听本机"),
              "　局域网已关闭，手机走隧道即可")
        ),

        // 扫码配对
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", { className: "dco-h" }, "扫码配对"),
            h("button", {
              className: "dco-btn primary",
              onClick: () => { setQrErr(false); setQrKey((n) => n + 1) }
            }, "换一张")
          ),
          h("div", { className: "dco-qr" },
            qrErr || noAddr
              ? h("div", { className: "dco-qrfallback" },
                h("div", { className: "dco-name", style: { fontSize: 13 } }, noAddr ? "还没有可用地址" : "二维码没出来"),
                h("div", { className: "dco-note" }, noAddr ? "先开通下面「公网访问」，再点「换一张」" : "宿主侧还是旧代码 —— 完全退出 DSH 再启动一次"))
              : h("img", {
                className: "dco-qrimg", src: qrSrc, alt: "配对二维码",
                onError: () => setQrErr(true),
                onLoad: () => setQrErr(false)
              }),
            h("div", { className: "dco-qrside" },
              h("div", { className: "dco-name", style: { fontSize: 13 } }, "手机 App → 扫一扫"),
              h("div", { className: "dco-mono" }, st.publicUrl || "—"),
              h("div", { className: "dco-sub" }, "2 分钟过期、扫一次即作废；别截图外传，换地址后点「换一张」。"),
              tunnelUp ? null : h("div", { className: "dco-warnbox" }, "当前不是公网地址，手机用流量连不上。先开通下面的「公网访问」。")
            )
          )
        ),

        // 配对码：公网 / 局域网各一个，互不复用
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", { className: "dco-h" }, "6 位配对码"),
            h("div", { className: "dco-sub" }, "两入口各自独立")
          ),
          (() => {
            const codes = st.codes || {}
            const block = (title, scope) => {
              const rec = codes[scope] || {}
              return h("div", { style: { marginTop: 12 } },
                h("div", { className: "dco-row" },
                  h("div", { className: "dco-sub" }, title),
                  h("button", {
                    className: "dco-btn",
                    disabled: busy === ("code-" + scope),
                    onClick: () => act("code-" + scope, NEWCODE, { scope })
                  }, "换一个")
                ),
                h("div", { className: "dco-code" }, rec.code || "— — — — — —"),
                h("div", { className: "dco-sub" },
                  rec.expiresAt ? "剩余 " + fmtLeft(rec.expiresAt) + "，用掉即作废" : "点「换一个」生成新码")
              )
            }
            return h("div", null, block("公网（走隧道）", "wan"), block("局域网（同一 Wi-Fi）", "lan"))
          })()
        ),

        // 公网隧道
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", { className: "dco-h" }, "公网访问 · cloudflared"),
            h("button", {
              className: tunnelUp ? "dco-btn" : "dco-btn primary",
              disabled: busy === "tunnel" || tun.state === "downloading" || tun.state === "starting",
              onClick: () => act("tunnel", TUNNEL, { action: tunnelUp ? "stop" : "start" })
            }, tunnelUp ? "停止" : tun.state === "downloading" ? "下载中…" : tun.state === "starting" ? "启动中…" : "开通")
          ),
          tunnelUp
            ? h("div", null,
              h("div", { className: "dco-mono", style: { marginTop: 6 } }, tun.url),
              h("div", { className: "dco-row", style: { marginTop: 8 } },
                h("button", { className: "dco-btn", onClick: () => copy(tun.url) }, "复制地址"),
                h("button", { className: "dco-btn", onClick: load }, "刷新")
              ),
              h("div", { className: "dco-note", style: { marginTop: 8 } }, "下次 DSH 启动会自动拉起隧道；不想这样就点「停止」。")
            )
            : h("div", { className: "dco-sub", style: { marginTop: 4 } },
              tun.error ? "失败：" + tun.error : "手机不在同一 WiFi 时用它把服务暴露到公网，地址每次启动都会变。")
        ),

        // 访问控制
        h(Card, null,
          h("div", { className: "dco-h" }, "访问控制"),

          h("div", { className: "dco-swrow" },
            h("div", null,
              h("div", { style: { fontSize: 13 } }, "局域网访问"),
              h("div", { className: "dco-sub" }, st.lanAccess ? "同 WiFi 的手机能直连（这一段是明文 HTTP）" : "只监听 127.0.0.1，流量只走隧道")
            ),
            h(Switch, { on: !!st.lanAccess, onClick: () => act("lan", TOGGLE, { lanAccess: !st.lanAccess }) })
          ),

          h("div", { className: "dco-swrow" },
            h("div", null,
              h("div", { style: { fontSize: 13 } }, "只读模式"),
              h("div", { className: "dco-sub" }, st.readOnly ? "手机只能看会话、停止生成，发不出消息" : "手机可以发消息（等于能驱动这台电脑上的 agent）")
            ),
            h(Switch, { on: !!st.readOnly, onClick: () => act("ro", TOGGLE, { readOnly: !st.readOnly }) })
          ),

          h("div", { className: "dco-swrow" },
            h("div", null,
              h("div", { style: { fontSize: 13 } }, "异地配对"),
              h("div", { className: "dco-sub" }, st.remotePair ? "公网来源也能用 6 位码配对" : "只允许二维码/局域网配对")
            ),
            h(Switch, { on: !!st.remotePair, onClick: () => act("rp", TOGGLE, { remotePair: !st.remotePair }) })
          ),

          h("div", { className: "dco-note", style: { marginTop: 8 } },
            "异地配对打开期间，任何拿到公网地址的人都能试 6 位码（连续输错 5 次会锁 15 分钟）。配完就关。")
        ),

        // 会话记录：列表 → 详情 → 继续对话
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", { className: "dco-h" }, "会话记录"),
            h("div", { className: "dco-row" },
              openId !== "" ? h("button", {
                className: "dco-btn",
                onClick: () => { setOpenId(""); setDetail(null) }
              }, "‹ 列表") : null,
              h("button", { className: "dco-btn", onClick: loadHist }, "刷新")
            )
          ),
          openId === ""
            ? (hist === null
              ? h("div", { className: "dco-sub" }, "点「刷新」载入历史会话")
              : (hist.length === 0
                ? h("div", { className: "dco-sub" }, "还没有会话")
                : h("div", { className: "dco-hist" }, hist.slice(0, 12).map((it) =>
                  h("div", {
                    key: it.id,
                    className: "dco-hrow",
                    onClick: () => openSession(it.id)
                  },
                    h("span", { className: "dco-htitle" }, it.title || "未命名会话"),
                    it.running ? h("span", { className: "dco-tag on" }, "运行中") : null,
                    it.archived ? h("span", { className: "dco-tag off" }, "已归档") : null
                  )))))
            : h("div", null,
              h("div", { className: "dco-sub", style: { margin: "6px 0" } },
                detail === null ? "读取中…" : (detail.title || "会话")),
              h("div", { className: "dco-hbody" },
                detail === null
                  ? h("div", { className: "dco-sub" }, "读取中…")
                  : (detail.error
                    ? h("div", { className: "dco-note", style: { color: "#f2635f" } }, detail.error)
                    : (detail.turns || []).slice(-12).map((t, i) =>
                      h("div", { key: i, className: "dco-turn" },
                        t.prompt ? h("div", { className: "dco-tu" }, t.prompt) : null,
                        t.response ? h("div", { className: "dco-ta" }, t.response) : null
                      )))),
              h("div", { className: "dco-send" },
                h("textarea", {
                  className: "dco-input",
                  placeholder: st.readOnly ? "只读模式下不能发消息" : "继续这个会话…",
                  value: draft,
                  onChange: (e) => setDraft(e.target.value)
                }),
                h("button", {
                  className: "dco-btn primary",
                  disabled: sending || st.readOnly,
                  onClick: sendHere
                }, sending ? "发送中…" : "发送")
              )
            )
        ),

        // 设备
        h(Card, null,
          h("div", { className: "dco-row" },
            h("div", { className: "dco-h" }, "已配对设备"),
            h("span", { className: "dco-tag " + (st.devices && st.devices.length ? "on" : "off") }, String((st.devices || []).length))
          ),
          (st.devices && st.devices.length)
            ? h("div", { className: "dco-list" }, st.devices.map((d) =>
              h("div", { key: d.id, className: "dco-dev" },
                h("div", { style: { minWidth: 0 } },
                  h("div", null, d.label || "手机"),
                  h("div", { className: "dco-sub" }, "配对于 " + day(d.at) + " · 有效至 " + day(d.exp))
                ),
                h("button", {
                  className: "dco-btn danger",
                  disabled: busy === "revoke",
                  onClick: () => act("revoke", TOGGLE, { deviceId: d.id })
                }, "断开")
              )))
            : h("div", { className: "dco-sub" }, "还没有手机连过。"),
          h("div", { className: "dco-note", style: { marginTop: 8 } },
            "访问码只以 sha256 存在本机，30 天过期；手机丢了就在这里断开那一台。")
        ),

        err ? h("div", { className: "dco-note", style: { color: "#f2635f" } }, err) : null
      )
    }

    // rc.5 起内核按 generator 迭代 slot 注册（对照 dsh-vision-router 的写法），
    // 旧式普通回调会被静默跳过——设置页就不出现「DSH 控制台」入口。
    function PanelIcon() {
      return h('div', {
        style: {
          width: '20px', height: '20px', display: 'flex', alignItems: 'center',
          justifyContent: 'center', font: '700 11px ui-monospace, Consolas, monospace',
          letterSpacing: '-1px'
        }
      }, '>_')
    }

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : undefined)
      if (!slots || typeof slots.inject !== "function") return
      slots.inject("settings.section", function* () {
        yield slots.register({
          name: "settings.section",
          id: "dsh-plugin-console-oh",
          order: 36,
          label: () => "DSH 控制台",
          inject: () => ({})
        }, Panel)
      })
      // 侧栏导航图标（旧宿主没有这个 slot，不渲染也无副作用）
      slots.inject("settings.section.icon", function* () {
        yield slots.register({ name: "settings.section.icon", id: "dsh-plugin-console-oh" }, PanelIcon)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})