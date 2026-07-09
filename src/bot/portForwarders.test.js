// Port-forwarder completeness (260708). The bot entry (src/bot/index.js)
// dispatches parentPort/initPort messages by calling optional methods on the
// `_running` wrapper that start() returns — `_running?.method?.(...)`. Every
// such method must have a forwarder on that wrapper (delegating to `_brain`),
// because the optional chain makes a MISSING forwarder a silent no-op: the
// message is simply dropped with no error anywhere. This exact trap has now
// shipped twice — deliverSeiChat (260703: in-app chat to an in-game companion
// hung on "typing…" forever) and observeSeiChat (260708: two in-game
// companions on a group call were deaf to each other; the standalone ledger
// recorded every line while the live-brain mirror vanished at the port, which
// made the failure invisible in transcripts and very expensive to find).
//
// Source-level pin: for each `_running?.X?.(` dispatch in src/bot/index.js
// there must be a matching `_brain?.X?.(` forwarding call (the wrapper body).
// `stop` is exempt — it is a real method on the wrapper, not a passthrough.
// Crude by design: it reads the source, so it cannot rot when start() gets
// harder to instantiate in a test.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'),
  'utf8',
)

const EXEMPT = new Set(['stop'])

describe('bot entry port dispatch — every _running method has a _brain forwarder', () => {
  const dispatched = [...new Set([...SRC.matchAll(/_running\?\.(\w+)\?\./g)].map((m) => m[1]))]

  it('finds the dispatch sites (sanity: the pattern still matches the source)', () => {
    expect(dispatched).toContain('deliverSeiChat')
    expect(dispatched).toContain('observeSeiChat')
  })

  it.each(dispatched.filter((m) => !EXEMPT.has(m)))('%s is forwarded to the brain', (method) => {
    expect(
      SRC.includes(`_brain?.${method}?.(`),
      `_running?.${method}?.() is dispatched from a port message but the start() wrapper has no ` +
        `forwarder — the optional chain silently drops the message (see deliverSeiChat 260703 / ` +
        `observeSeiChat 260708). Add:  ${method}(payload) { try { _brain?.${method}?.(payload) } catch {} }`,
    ).toBe(true)
  })
})
