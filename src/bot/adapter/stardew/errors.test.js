import { describe, it, expect } from 'vitest'
import { classifyConnectError, stripClassPrefix } from './errors.js'

describe('stardew classifyConnectError', () => {
  it('reads the class prefix and falls back to BOT_START_TIMEOUT', () => {
    expect(classifyConnectError('GAME_WORLD_NOT_OPEN: no save')).toBe('GAME_WORLD_NOT_OPEN')
    expect(classifyConnectError('GAME_NOT_ANSWERING: port dead')).toBe('GAME_NOT_ANSWERING')
    expect(classifyConnectError('STARDEW_FARMHAND_NO_MOD: x')).toBe('STARDEW_FARMHAND_NO_MOD')
    expect(classifyConnectError('GAME_VERSION_UNSUPPORTED: x')).toBe('GAME_VERSION_UNSUPPORTED')
    expect(classifyConnectError('spawn stalled')).toBe('BOT_START_TIMEOUT')
    expect(classifyConnectError(undefined)).toBe('BOT_START_TIMEOUT')
    expect(stripClassPrefix('GAME_NOT_ANSWERING: port dead')).toBe('port dead')
  })
})
