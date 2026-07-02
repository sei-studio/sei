// src/bot/adapter/minecraft/registry.vision.test.js
//
// D-10 / VIS-03 — proves `look` is registered in the closed registry ONLY
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
  // registry.js imports visualizeAction; explore.js imports the capture/face
  // helpers from this same module. Mirror the real module's named exports so
  // the (mocked) import graph resolves without pulling the native render chain.
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
  orientationToYawOffset: vi.fn(() => null),
  yawToUnit: vi.fn(() => [0, -1]),
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => ({ ok: true, mediaType: 'image/jpeg', dataBase64: 'AAAA' })),
}))

// Imported AFTER the mock declaration (vi.mock is hoisted, so this is safe and
// the native render chain is never loaded).
const { createDefaultRegistry } = await import('./registry.js')

describe('createDefaultRegistry — look gating (D-10 / VIS-03)', () => {
  it('registers `look` when visionEnabled is true', () => {
    const registry = createDefaultRegistry({ visionEnabled: true })
    expect(registry.list()).toContain('look')
  })

  it('does NOT register `look` when visionEnabled is false', () => {
    const registry = createDefaultRegistry({ visionEnabled: false })
    expect(registry.list()).not.toContain('look')
  })

  it('does NOT register `look` by default (no opts) — fail-closed', () => {
    const registry = createDefaultRegistry()
    expect(registry.list()).not.toContain('look')
  })

  it('registers the full non-vision action set regardless of the gate', () => {
    // The gate must ONLY add/remove look — never disturb the base set.
    const off = createDefaultRegistry({ visionEnabled: false }).list()
    const on = createDefaultRegistry({ visionEnabled: true }).list()
    expect(off).toContain('goTo')
    expect(off).toContain('dig')
    expect(on).toContain('goTo')
    expect(on).toContain('dig')
    // The on-set is exactly the off-set plus look.
    expect(new Set(on)).toEqual(new Set([...off, 'look']))
  })
})
