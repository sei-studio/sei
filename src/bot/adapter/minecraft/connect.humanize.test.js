// humanizeReason regression guards (260710). Every vanilla kick key starts
// with "multiplayer.disconnect.", which CONTAINS "connect" — the bare
// substring check used to mislabel every server kick as "Could not reach
// server. Make sure a LAN world is open" (seen live with
// chat_validation_failed, which also gets its own specific copy now).

import { describe, it, expect } from 'vitest'
import { humanizeReason } from './connect.js'

describe('humanizeReason', () => {
  it('names chat-signing kicks instead of calling them connectivity failures', () => {
    const reason = { translate: 'multiplayer.disconnect.chat_validation_failed' }
    expect(humanizeReason(reason)).toMatch(/chat protocol/i)
    expect(humanizeReason(reason)).not.toMatch(/could not reach/i)
  })

  it('does not mislabel other multiplayer.disconnect.* kicks as unreachable-server', () => {
    expect(humanizeReason({ translate: 'multiplayer.disconnect.name_taken' })).not.toMatch(
      /could not reach/i,
    )
  })

  it('still maps real connectivity failures to the LAN hint', () => {
    expect(humanizeReason('connect ECONNREFUSED 127.0.0.1:55555')).toMatch(/could not reach/i)
    expect(humanizeReason('Connection timeout elapsed')).toMatch(/could not reach|timed out/i)
  })
})
