import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStardewClient, commandTimeouts, COMMAND_TIMEOUT_MS, FARM_COMMAND_TIMEOUT_MS, FARM_COMMAND_IDLE_TIMEOUT_MS } from './client.js'

class FakeWS {
  constructor() { this.listeners = {}; this.sent = []; FakeWS.last = this; queueMicrotask(() => this.fire('open', {})) }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  fire(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev) }
  send(text) { this.sent.push(JSON.parse(text)) }
  close() {}
  push(frame) { this.fire('message', { data: JSON.stringify(frame) }) }
}

async function openClient() {
  const c = createStardewClient({ port: 1, token: 't', WebSocketImpl: FakeWS, logger: { warn() {} } })
  await c.connect()
  return { c, ws: FakeWS.last }
}

afterEach(() => { vi.useRealTimers() })

describe('stardew client command timeouts', () => {
  it('gives farm-wide water / harvest a long cap and a no-progress timeout', () => {
    expect(commandTimeouts('water', { scope: 'farm' })).toEqual({ timeoutMs: FARM_COMMAND_TIMEOUT_MS, idleTimeoutMs: FARM_COMMAND_IDLE_TIMEOUT_MS })
    expect(commandTimeouts('harvest', { scope: 'farm' }).timeoutMs).toBe(FARM_COMMAND_TIMEOUT_MS)
    expect(commandTimeouts('water', {})).toEqual({ timeoutMs: COMMAND_TIMEOUT_MS })
    expect(commandTimeouts('gather', { scope: 'farm' })).toEqual({ timeoutMs: COMMAND_TIMEOUT_MS })
    expect(FARM_COMMAND_TIMEOUT_MS).toBeGreaterThan(COMMAND_TIMEOUT_MS)
  })

  it('cancels the command in the mod when it times out', async () => {
    const { c, ws } = await openClient()
    vi.useFakeTimers()
    const p = c.request({ t: 'cmd', name: 'gather', args: {} }, { timeoutMs: 1000 })
    const id = ws.sent[0].id
    vi.advanceTimersByTime(1001)
    await expect(p).rejects.toThrow(/cmd gather timed out after 1s/)
    expect(ws.sent.at(-1)).toMatchObject({ t: 'cancel', target: id })
    // A late result is ignored.
    ws.push({ t: 'result', id, ok: true, detail: 'late' })
  })

  it('keeps a command alive while it reports progress, and times out when it stops', async () => {
    const { c, ws } = await openClient()
    vi.useFakeTimers()
    const p = c.request({ t: 'cmd', name: 'water', args: { scope: 'farm' } }, { timeoutMs: 10_000, idleTimeoutMs: 1000 })
    const id = ws.sent[0].id
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900)
      ws.push({ t: 'progress', id, text: `watered ${i + 1} crops` })
    }
    vi.advanceTimersByTime(900)
    ws.push({ t: 'result', id, ok: true, detail: 'watered 5 crops on the farm' })
    await expect(p).resolves.toMatchObject({ detail: 'watered 5 crops on the farm' })
    expect(ws.sent.some((f) => f.t === 'cancel')).toBe(false)

    const q = c.request({ t: 'cmd', name: 'water', args: { scope: 'farm' } }, { timeoutMs: 10_000, idleTimeoutMs: 1000 })
    const id2 = ws.sent.at(-1).id
    vi.advanceTimersByTime(1001)
    await expect(q).rejects.toThrow(/made no progress for 1s/)
    expect(ws.sent.at(-1)).toMatchObject({ t: 'cancel', target: id2 })
  })

  it('does not send a cancel for a non-command request that times out', async () => {
    const { c, ws } = await openClient()
    vi.useFakeTimers()
    const p = c.request({ t: 'observe' }, { timeoutMs: 500 })
    vi.advanceTimersByTime(501)
    await expect(p).rejects.toThrow(/observe timed out/)
    expect(ws.sent.filter((f) => f.t === 'cancel')).toHaveLength(0)
  })
})
