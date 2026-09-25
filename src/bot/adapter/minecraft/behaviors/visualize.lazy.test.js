// 260926: the POV render stack (native gl + canvas, three, prismarine-viewer)
// must not load when the Minecraft runtime is imported. It used to, through a
// static import in visualize.js, and on Windows that made every cold boot read
// ~20MB of extra files under Defender before createBot (BOT_START_TIMEOUT).
import { describe, it, expect, vi } from 'vitest'

const { loads } = vi.hoisted(() => ({ loads: { count: 0 } }))
vi.mock('../render/povRenderer.js', () => {
  loads.count += 1
  return { renderPov: vi.fn(async () => ({ ok: false, reason: 'cant_see' })) }
})

describe('visualize.js loads the POV renderer lazily', () => {
  it('importing visualize.js does not load the renderer; first use does, once', async () => {
    const mod = await import('./visualize.js')
    expect(loads.count).toBe(0)
    const a = await mod.loadPovRenderer()
    const b = await mod.loadPovRenderer()
    expect(typeof a.renderPov).toBe('function')
    expect(b).toBe(a)
    expect(loads.count).toBe(1)
  })
})
