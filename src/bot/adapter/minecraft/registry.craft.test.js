// Proves `craft` is registered in the closed action set with a schema that
// requires `item` and defaults `count`.
//
// registry.js statically imports the visualize behavior → povRenderer → native
// gl/canvas (Electron-ABI, unloadable under system-Node vitest), so we mock that
// module the same way registry.vision.test.js does. craft.js itself pulls only
// pure-JS deps (minecraft-data, prismarine-recipe), so it loads fine.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({ text: 'x', image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' } })),
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
  orientationToYawOffset: vi.fn(() => null),
  yawToUnit: vi.fn(() => [0, -1]),
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => ({ ok: true, mediaType: 'image/jpeg', dataBase64: 'AAAA' })),
}))

const { createDefaultRegistry } = await import('./registry.js')

describe('createDefaultRegistry — craft action', () => {
  it('registers craft in the base action set (no vision needed)', () => {
    expect(createDefaultRegistry().list()).toContain('craft')
    expect(createDefaultRegistry({ visionEnabled: true }).list()).toContain('craft')
  })

  it('schema requires item and defaults count to 1', () => {
    const schema = createDefaultRegistry().schema('craft')
    expect(schema.parse({ item: 'oak_planks' })).toEqual({ item: 'oak_planks', count: 1 })
    expect(() => schema.parse({ count: 2 })).toThrow() // missing item
    expect(() => schema.parse({ item: 'oak_planks', count: 0 })).toThrow() // min 1
  })
})
