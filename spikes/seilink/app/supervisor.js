// SeiLink spike round 2: main-process supervisor for the room host.
//
// Main spawns the SAME Electron binary with --room-host as a separate OS process (its own
// BrowserWindow, GPU and renderer processes), and talks to it over a named pipe (Windows) or a
// unix socket (macOS) with newline-delimited JSON. Main never parents anything into the shell,
// so an Explorer crash can only take the host down, never main.
//
//   main -> host: show, hide, pause, resume, set-fps {fps}, ping {id,t}, set-hit-rect {rect},
//                 test-hang {ms}, test-exit {code}
//   host -> main: hello {pid}, waiting-shell, ready, attached {layout,method,reattach,reason,...},
//                 covered {covered,reason}, click {x,y,kind}, heartbeat {...}, pong, log, event
//
// Restart policy: on host exit, or on no heartbeat for hbTimeoutMs, kill + respawn with
// exponential backoff (0, 0.5, 1, 2, 4, 8, max 10 s). The streak resets once a host has stayed up
// for STABLE_MS. The first restart is immediate because the commonest cause (Explorer restart on
// Windows) wants the host back as soon as the shell is.
const { EventEmitter } = require('node:events')
const net = require('node:net')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

const STABLE_MS = 20000
const backoffMs = (streak) => (streak <= 0 ? 0 : Math.min(500 * 2 ** (streak - 1), 10000))

class Supervisor extends EventEmitter {
  constructor({ exe, appPath, outDir, log, hbTimeoutMs = 3000, hostArgs = [] }) {
    super()
    Object.assign(this, { exe, appPath, outDir, log, hbTimeoutMs, hostArgs })
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\seilink-${process.pid}` : path.join(os.tmpdir(), `seilink-${process.pid}.sock`)
    this.n = 0
    this.child = null
    this.sock = null
    this.lastHb = 0
    this.streak = 0
    this.stopped = false
    this.restarts = []
    this.nextSpawnArgs = []
    this.crashNext = 0
    this.pendingRestart = null
  }

  start() {
    if (process.platform !== 'win32') try { fs.unlinkSync(this.pipe) } catch {}
    this.server = net.createServer((s) => this._onConn(s))
    this.server.listen(this.pipe)
    this.watchdog = setInterval(() => this._checkHeartbeat(), 250)
    this._spawn('initial')
  }

  _spawn(cause) {
    if (this.stopped) return
    const n = ++this.n
    const out = path.join(this.outDir, `host-${n}`)
    fs.mkdirSync(out, { recursive: true })
    const args = [this.appPath, '--room-host', `--ipc=${this.pipe}`, `--out=${out}`, `--host-n=${n}`, ...this.hostArgs]
    if (this.crashNext > 0) {
      this.crashNext--
      args.push('--crash-on-start')
    }
    const logFd = fs.openSync(path.join(out, 'host-stdio.txt'), 'a')
    const t = Date.now()
    const child = cp.spawn(this.exe, args, { stdio: ['ignore', logFd, logFd], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, windowsHide: false })
    fs.closeSync(logFd)
    const rec = { n, pid: child.pid, cause, spawnedAt: t, helloAt: null, attachedAt: null, exit: null }
    this.child = { proc: child, rec }
    this.lastHb = 0
    this.log('supervisor: spawned host', n, 'pid', child.pid, 'cause', cause)
    this.emit('spawn', rec)
    child.on('exit', (code, sig) => {
      rec.exit = { code, sig, hex: code != null ? '0x' + (code >>> 0).toString(16) : null, at: Date.now() }
      this.log('supervisor: host', n, 'exited', rec.exit)
      this.emit('exit', rec)
      if (this.child && this.child.rec === rec) {
        this.child = null
        this.sock = null
        this._scheduleRestart(`exit ${rec.exit.hex || rec.exit.sig}`, rec)
      }
    })
  }

  _scheduleRestart(reason, rec) {
    if (this.stopped || this.pendingRestart) return
    const lived = rec ? Date.now() - rec.spawnedAt : 0
    if (lived > STABLE_MS) this.streak = 0
    const delay = backoffMs(this.streak)
    this.streak++
    const r = { reason, at: Date.now(), delay, streak: this.streak, prevHost: rec && rec.n, lived }
    this.restarts.push(r)
    this.log('supervisor: restart in', delay, 'ms', r)
    this.emit('restart-scheduled', r)
    this.pendingRestart = setTimeout(() => {
      this.pendingRestart = null
      this._spawn(reason)
    }, delay)
  }

  _checkHeartbeat() {
    if (!this.child || !this.lastHb) return  // not yet connected: exit handler covers crashes
    const gap = Date.now() - this.lastHb
    if (gap > this.hbTimeoutMs) {
      const rec = this.child.rec
      this.log('supervisor: missed heartbeat', gap, 'ms from host', rec.n, '-> kill')
      this.emit('missed-heartbeat', { n: rec.n, gap, at: Date.now() })
      this.lastHb = 0
      this.kill(rec)
    }
  }

  kill(rec = this.child && this.child.rec) {
    if (!rec || rec.exit) return
    try {
      if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(rec.pid, 'SIGKILL')
    } catch (e) {
      this.log('supervisor: kill error', String(e))
    }
  }

  _onConn(s) {
    let buf = ''
    let pid = null
    s.setEncoding('utf8')
    s.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'hello') {
          pid = m.pid
          if (this.child && this.child.rec.pid === pid) {
            this.sock = s
            this.child.rec.helloAt = Date.now()
          }
        }
        // Ignore stragglers from a host we already replaced.
        if (!this.child || pid !== this.child.rec.pid) continue
        m.recvAt = Date.now()
        m.host = this.child.rec.n
        if (m.type === 'heartbeat') this.lastHb = m.recvAt
        if (m.type === 'attached' && !this.child.rec.attachedAt) this.child.rec.attachedAt = m.recvAt
        this.emit('msg', m)
        this.emit(m.type, m)
      }
    })
    s.on('error', () => {})
  }

  send(obj) {
    if (!this.sock) return false
    try {
      this.sock.write(JSON.stringify(obj) + '\n')
      return true
    } catch {
      return false
    }
  }

  // Resolve with the first message of a type (optionally matching pred), or null on timeout.
  waitFor(type, pred = () => true, ms = 10000) {
    return new Promise((resolve) => {
      const on = (m) => {
        if (!pred(m)) return
        clearTimeout(t)
        this.off(type, on)
        resolve(m)
      }
      const t = setTimeout(() => {
        this.off(type, on)
        resolve(null)
      }, ms)
      this.on(type, on)
    })
  }

  stop() {
    this.stopped = true
    clearInterval(this.watchdog)
    if (this.pendingRestart) clearTimeout(this.pendingRestart)
    this.send({ type: 'quit' })
    const rec = this.child && this.child.rec
    setTimeout(() => this.kill(rec), 800)
    try { this.server.close() } catch {}
  }
}

module.exports = { Supervisor, backoffMs }
