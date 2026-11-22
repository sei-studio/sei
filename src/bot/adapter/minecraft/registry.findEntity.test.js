// 261011: find("sheep") answered "no known IDs for sheep" in the quality eval.
// A creature name now finds the nearest loaded entity of that type.
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'

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

function makeBot(entities) {
  const self = { id: 1, name: 'player', position: new Vec3(0, 64, 0) }
  const map = { 1: self }
  entities.forEach((e, i) => { map[i + 2] = { id: i + 2, ...e } })
  return { version: '1.21.1', entity: self, entities: map, findBlocks: () => [], blockAt: () => null }
}

describe('find on a creature name', () => {
  it('returns the nearest entity of that type', async () => {
    const reg = createDefaultRegistry()
    const bot = makeBot([
      { name: 'sheep', position: new Vec3(20, 64, 0) },
      { name: 'sheep', position: new Vec3(5.5, 64, 0) },
      { name: 'cow', position: new Vec3(2, 64, 0) },
    ])
    const r = await reg.execute('find', { name: 'sheep' }, bot, {})
    expect(r).toEqual({ found: true, id: 'sheep', pos: { x: 5, y: 64, z: 0 }, distance: 5.5 })
  })

  it('says none are in range when the creature is not loaded nearby', async () => {
    const reg = createDefaultRegistry()
    const bot = makeBot([{ name: 'sheep', position: new Vec3(100, 64, 0) }])
    const r = await reg.execute('find', { name: 'sheep', maxDistance: 32 }, bot, {})
    expect(r).toEqual({ found: false, reason: 'no sheep within 32m' })
  })
})




