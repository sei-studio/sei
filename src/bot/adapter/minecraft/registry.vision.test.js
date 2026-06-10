// src/bot/adapter/minecraft/registry.vision.test.js
//
// D-10 / VIS-03 — proves `visualize` is registered in the closed registry ONLY
// when visionEnabled is true.
//
// Warning 5 (15-04 plan): the repo is ESM AND registry.js statically imports
// the visualize behavior -> ../render/povRenderer.js -> native gl/canvas (built
// for the Electron 42 ABI, NOT loadable under system-Node vitest). So:
//   1. a `node -e "require(...)"` check is doubly invalid (ESM + native), and
//   2. this test MUST mock the visualize behavior module so povRenderer.js (and
//      its native chain) is never imported when registry.js pulls it in.
//
// We mock './behaviors/visualize.js' — the specifier registry.js imports — with
// a trivial fake handler. That keeps the registry's import graph native-free
// while still exercising the real conditional-registration logic.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({
    text: 'x',
    image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' },
  })),
  // registry.js only imports visualizeAction, but mirror the real module's
  // named exports defensively so any future eager import resolves.
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
}))

// Imported AFTER the mock declaration (vi.mock is hoisted, so this is safe and
// the native render chain is never loaded).
const { createDefaultRegistry } = await import('./registry.js')

describe('createDefaultRegistry — visualize gating (D-10 / VIS-03)', () => {
  it('registers `visualize` when visionEnabled is true', () => {
    const registry = createDefaultRegistry({ visionEnabled: true })
    expect(registry.list()).toContain('visualize')
  })

  it('does NOT register `visualize` when visionEnabled is false', () => {
    const registry = createDefaultRegistry({ visionEnabled: false })
    expect(registry.list()).not.toContain('visualize')
  })

  it('does NOT register `visualize` by default (no opts) — fail-closed', () => {
    const registry = createDefaultRegistry()
    expect(registry.list()).not.toContain('visualize')
  })

  it('registers the full non-vision action set regardless of the gate', () => {
    // The gate must ONLY add/remove visualize — never disturb the base set.
    const off = createDefaultRegistry({ visionEnabled: false }).list()
    const on = createDefaultRegistry({ visionEnabled: true }).list()
    expect(off).toContain('goTo')
    expect(off).toContain('lookAt')
    expect(on).toContain('goTo')
    expect(on).toContain('lookAt')
    // The on-set is exactly the off-set plus visualize.
    expect(new Set(on)).toEqual(new Set([...off, 'visualize']))
  })
})
