// src/bot/adapter/minecraft/lanDiscovery.js
//
// One-shot LAN discovery used by the CLI (src/bot/cli/index.js cmdStart) and
// the CLI bot bootstrap path in src/bot/index.js (when process.parentPort is
// undefined). The Electron main process uses src/main/lanWatcher.ts (a
// long-lived watcher); the bot child does NOT call discoverLanPort during
// summon — main hands the cached port over MessagePort (CONTEXT D-25,
// Pitfall 6). Keeping a small dedicated implementation here avoids the bot
// adapter importing from the main-process module tree.
//
// Source: refactored from prior phase per CONTEXT D-20.

import dgram from 'node:dgram'

const MC_LAN_GROUP = '224.0.2.60'
const MC_LAN_PORT = 4445

/**
 * One-shot: resolve on the first multicast packet within timeoutMs, or reject.
 * Used by the CLI only — Electron uses watchLan() in src/main/lanWatcher.ts.
 */
export function discoverLanPort({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      err ? reject(err) : resolve(value)
    }

    const timer = setTimeout(() => {
      finish(new Error(`No Minecraft LAN broadcast received within ${timeoutMs}ms`))
    }, timeoutMs)

    socket.on('error', (err) => finish(err))

    socket.on('message', (msg) => {
      const text = msg.toString('utf-8')
      const motd = text.match(/\[MOTD\](.*?)\[\/MOTD\]/)?.[1] ?? ''
      const portStr = text.match(/\[AD\](\d{1,5})\[\/AD\]/)?.[1]
      if (!portStr) return
      const port = Number(portStr)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return
      finish(null, { port, motd })
    })

    socket.bind(MC_LAN_PORT, () => {
      try {
        socket.addMembership(MC_LAN_GROUP)
      } catch (err) {
        finish(err)
      }
    })
  })
}
