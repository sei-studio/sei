import { describe, it, expect, vi, afterEach } from 'vitest'
import { frames, parseFrame, createFactorioClient } from './client.js'
import { createFakeMod, createScriptedMod } from './fixtures/fakeMod.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const clients = []
function make(fake) {
  const c = createFactorioClient({ gamePort: 34990, logger: quiet, dgramImpl: fake.dgram })
  clients.push(c)
  return c
}
afterEach(() => { while (clients.length) clients.pop().close() })

describe('framing', () => {
  it('round-trips a small body', () => {
    const [dg] = frames('abc', '{"op":"hello"}')
    const f = parseFrame(dg)
    expect(f).toMatchObject({ id: 'abc', part: 1, parts: 1 })
    expect(f.body.toString('utf8')).toBe('{"op":"hello"}')
  })

  it('splits a large body without cutting a UTF-8 character', () => {
    const body = JSON.stringify({ text: 'é'.repeat(70_000) })
    const dgs = frames('big', body)
    expect(dgs.length).toBe(3)
    const joined = Buffer.concat(dgs.map((d) => parseFrame(d).body)).toString('utf8')
    expect(joined).toBe(body)
    for (const d of dgs) expect(() => parseFrame(d).body.toString('utf8')).not.toThrow()
    for (const d of dgs) expect(parseFrame(d).body.toString('utf8')).not.toContain('�')
  })

  it('rejects garbage and bad part numbers', () => {
    expect(parseFrame(Buffer.from('hello'))).toBeNull()
    expect(parseFrame(Buffer.from('SEI1 x 3 2\n{}'))).toBeNull()
    expect(parseFrame(Buffer.from('SEI2 x 1 1\n{}'))).toBeNull()
  })
})

describe('createFactorioClient', () => {
  it('resends a dropped request with the same id until it is answered', async () => {
    const fake = createFakeMod({ handle: (req, { n }) => (n < 2 ? null : { ok: true, echo: req.op }) })
    const c = make(fake)
    await c.open()
    const r = await c.request({ op: 'hello' }, { timeoutMs: 3_000 })
    expect(r).toMatchObject({ ok: true, echo: 'hello' })
    expect(fake.sent.length).toBe(2)
    expect(c.lastReplyAt).toBeGreaterThan(0)
  })

  it('times out with a plain message when the game never answers', async () => {
    const fake = createFakeMod({ handle: () => null })
    const c = make(fake)
    await c.open()
    await expect(c.request({ op: 'hello' }, { timeoutMs: 300 })).rejects.toThrow(/no answer from Factorio/)
  })

  it('reports a closed game port as unreachable', async () => {
    const fake = createFakeMod({ handle: () => null })
    fake.refuse(true)
    const c = make(fake)
    await c.open()
    const seen = vi.fn()
    c.on('unreachable', seen)
    await expect(c.request({ op: 'hello' }, { timeoutMs: 300 })).rejects.toThrow()
    expect(seen).toHaveBeenCalled()
    expect(c.lastRefusedAt).toBeGreaterThan(0)
  })

  it('runs an instant verb from the reply', async () => {
    const { fake } = createScriptedMod()
    const c = make(fake)
    await c.open()
    expect(await c.command('1:sui', 'follow', {})).toEqual({ success: true, msg: 'follow done' })
  })

  it('runs a job verb to its result event through the poll', async () => {
    const { fake, state } = createScriptedMod()
    state.verbs.gather = { job: true }
    const c = make(fake)
    await c.open()
    await c.request({ op: 'spawn', name: 'Sui' })
    c.startPolling('1:sui', { intervalMs: 20 })
    const p = c.command('1:sui', 'gather', { resource: 'wood', count: 5 })
    await vi.waitFor(() => expect(state.jobs.size).toBe(1))
    const [jid] = state.jobs.keys()
    state.finish(jid, true, 'gathered 5 wood')
    expect(await p).toEqual({ success: true, msg: 'gathered 5 wood' })
  })

  it('keeps a result that arrives before its waiter', async () => {
    const { fake, state } = createScriptedMod()
    state.verbs.craft = { job: true }
    const c = make(fake)
    await c.open()
    await c.request({ op: 'spawn', name: 'Sui' })
    // Finish the job inside the same reply, so the poll can see it first.
    const origSend = fake.sockets[0].send
    fake.sockets[0].send = (buf) => {
      origSend(buf)
      const [jid] = state.jobs.keys()
      if (jid) { state.jobs.delete(jid); state.finish(jid, true, 'crafted 1 lab') }
    }
    c.startPolling('1:sui', { intervalMs: 5 })
    const r = await c.command('1:sui', 'craft', { item: 'lab' })
    expect(r).toEqual({ success: true, msg: 'crafted 1 lab' })
  })

  it('cancels the job in the mod when the call is aborted', async () => {
    const { fake, state } = createScriptedMod()
    state.verbs.gather = { job: true }
    const c = make(fake)
    await c.open()
    await c.request({ op: 'spawn', name: 'Sui' })
    c.startPolling('1:sui', { intervalMs: 20 })
    const ac = new AbortController()
    const p = c.command('1:sui', 'gather', { resource: 'stone' }, { signal: ac.signal })
    await vi.waitFor(() => expect(state.jobs.size).toBe(1))
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    await vi.waitFor(() => expect(fake.sent.some((r) => r.op === 'cancel')).toBe(true))
  })

  it('emits feed events by type and moves the cursor', async () => {
    const { fake, state } = createScriptedMod()
    const c = make(fake)
    await c.open()
    await c.request({ op: 'spawn', name: 'Sui' })
    const chats = []
    c.on('chat', (ev) => chats.push(ev.text))
    state.pushed({ t: 'chat', from: 'Tester', text: 'hi' })
    state.pushed({ t: 'chat', from: 'Tester', text: 'again' })
    c.startPolling('1:sui', { intervalMs: 20 })
    await vi.waitFor(() => expect(chats).toEqual(['hi', 'again']))
    expect(c.cursor).toBe(2)
  })

  it('reports a poll error when the mod forgot the companion', async () => {
    const { fake } = createScriptedMod()
    const c = make(fake)
    await c.open()
    const errs = []
    c.on('poll-error', (e) => errs.push(e.message))
    c.startPolling('1:sui', { intervalMs: 20 })
    await vi.waitFor(() => expect(errs[0]).toMatch(/no companion/))
  })
})
