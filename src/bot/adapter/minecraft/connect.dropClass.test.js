// 261111: the allowlisted class of a connection drop for session telemetry.
import { describe, it, expect } from 'vitest'
import { dropClassFor } from './connect.js'

describe('dropClassFor', () => {
  it('names the transport reason, and a kick wins', () => {
    expect(dropClassFor('socketClosed', null)).toBe('socket')
    expect(dropClassFor('keepAliveError', null)).toBe('keepalive')
    expect(dropClassFor('read ECONNRESET', null)).toBe('reset')
    expect(dropClassFor('something else', null)).toBe('other')
    expect(dropClassFor(undefined, null)).toBe('other')
    expect(dropClassFor('socketClosed', 'timeout')).toBe('kick')
  })
})
