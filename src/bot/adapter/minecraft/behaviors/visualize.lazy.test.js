// 260926: the POV render stack (native gl + canvas, three, prismarine-viewer)
// must not load when the Minecraft runtime is imported. It used to, through a
// static import in visualize.js, and on Windows that made every cold boot read
// ~20MB of extra files under Defender before createBot (BOT_START_TIMEOUT).
// The load now goes through povStackLoader.js (see povStackLoader.test.js for
// how it stays off the event loop).
import { describe, it, expect, vi } from 'vitest'

const { loads } = vi.hoisted(() => ({ loads: { renderer: 0, stack: 0 } }))
vi.mock('../render/povRenderer.js', () => {
  loads.renderer += 1
  return { renderPov: vi.fn(async () => ({ ok: false, reason: 'cant_see' })) }
})
vi.mock('../render/povStackLoader.js', () => {
  let p = null
  return {
    loadPovStack: () => {
      if (!p) { loads.stack += 1; p = import('../render/povRenderer.js') }
      return p
    },
    povStackReady: () => false,
    povStackUnavailable: () => false,
  }
})

describe('visualize.js loads the POV renderer lazily', () => {
  it('importing visualize.js does not load the renderer; first use does, through the stack loader', async () => {
    const mod = await import('./visualize.js')
    expect(loads.renderer).toBe(0)
    expect(loads.stack).toBe(0)
    const a = await mod.loadPovRenderer()
    const b = await mod.loadPovRenderer()
    expect(typeof a.renderPov).toBe('function')
    expect(b).toBe(a)
    expect(loads.renderer).toBe(1)
    expect(loads.stack).toBe(1)
  })
})
