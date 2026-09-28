// humanizeReason regression guards (260710). Every vanilla kick key starts
// with "multiplayer.disconnect.", which CONTAINS "connect" — the bare
// substring check used to mislabel every server kick as "Could not reach
// server. Make sure a LAN world is open" (seen live with
// chat_validation_failed, which also gets its own specific copy now).

import { describe, it, expect } from 'vitest'
import { humanizeReason, isModdedHostRejection, kickReasonCode } from './connect.js'

// 260806. A NeoForge 1.20.1 world kicked one user's summon five times in four
// minutes; every attempt surfaced as LAN_NOT_OPEN ("we can't see an open LAN
// world"), and they re-opened the world to LAN four times while it was open and
// answering status pings the whole time. The kick text names the real problem
// and nothing was reading it.
describe('isModdedHostRejection', () => {
  // THE case that was missed: names neither FML nor Forge as a bare word.
  it('catches the NeoForge kick verbatim', () => {
    expect(
      isModdedHostRejection({
        text: 'This server has mods that require NeoForge to be installed on the client.',
      }),
    ).toBe(true)
  })

  it('catches Forge and FML wordings', () => {
    expect(isModdedHostRejection('Incompatible FML modded server')).toBe(true)
    expect(isModdedHostRejection('Please install Forge to connect')).toBe(true)
  })

  it('catches the Fabric registry-sync wording', () => {
    expect(isModdedHostRejection('This server requires the following mods: create, jei')).toBe(true)
  })

  // Superset guard: the 260709 check was `fml || (fabric && (mod || require))`.
  // This wording says neither "mods" nor a loader we match by name, so it only
  // survives because that clause was carried over verbatim.
  it('still catches the pre-260806 fabric wordings', () => {
    expect(isModdedHostRejection('This server requires Fabric')).toBe(true)
    expect(isModdedHostRejection('Fabric mod mismatch')).toBe(true)
  })

  it('catches Quilt', () => {
    expect(isModdedHostRejection('This server requires Quilt to be installed')).toBe(true)
  })

  it('does not fire on unrelated kicks', () => {
    expect(isModdedHostRejection({ translate: 'multiplayer.disconnect.name_taken' })).toBe(false)
    expect(isModdedHostRejection({ translate: 'multiplayer.disconnect.chat_validation_failed' })).toBe(false)
    expect(isModdedHostRejection('connect ECONNREFUSED 127.0.0.1:55555')).toBe(false)
    expect(isModdedHostRejection('socketClosed')).toBe(false)
    expect(isModdedHostRejection(null)).toBe(false)
  })

  // "mods" on its own shows up in benign text; the predicate needs the pair.
  it('does not fire on a bare mention of mods', () => {
    expect(isModdedHostRejection('Server is running with 3 mods loaded')).toBe(false)
  })
})

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

  // The NeoForge text contains neither "fml" nor "fabric", so the 260709 branch
  // did not match it, and "installed on the client" fell through to the raw
  // text. It must not reach the connectivity branch either.
  it('names modded-host rejections and never calls them unreachable', () => {
    const reason = {
      text: 'This server has mods that require NeoForge to be installed on the client.',
    }
    expect(humanizeReason(reason)).toMatch(/forge or neoforge/i)
    expect(humanizeReason(reason)).not.toMatch(/could not reach/i)
    expect(humanizeReason('Please install Forge to connect')).not.toMatch(/could not reach/i)
  })
})

// 260929: the PII-free kick code on bot_session_ended.kick_code.
describe('kickReasonCode', () => {
  it('uses the vanilla translation key, minus its prefix', () => {
    expect(kickReasonCode({ translate: 'multiplayer.disconnect.kicked' })).toBe('kicked')
    expect(kickReasonCode({ translate: 'multiplayer.disconnect.name_taken' })).toBe('name_taken')
    expect(kickReasonCode({ translate: 'disconnect.timeout' })).toBe('timeout')
    expect(kickReasonCode('multiplayer.disconnect.chat_validation_failed')).toBe('chat_validation_failed')
    expect(kickReasonCode(JSON.stringify({ translate: 'multiplayer.disconnect.idling', with: ['Steve'] }))).toBe('idling')
  })

  it('maps modded rejections to modded', () => {
    expect(kickReasonCode('This server has mods that require NeoForge to be installed on the client.')).toBe('modded')
  })

  it('maps well-known plain-text wordings to fixed codes', () => {
    expect(kickReasonCode('You logged in from another location')).toBe('name_taken')
    expect(kickReasonCode('You are not white-listed on this server!')).toBe('not_whitelisted')
    expect(kickReasonCode('Server closed')).toBe('server_shutdown')
    expect(kickReasonCode('Timed out')).toBe('timeout')
    expect(kickReasonCode('Outdated client! Please use 1.21.4')).toBe('version_mismatch')
    expect(kickReasonCode('Kicked by an operator')).toBe('kicked')
  })

  it('never leaks free-form host text', () => {
    expect(kickReasonCode('bye jenny.smith, go do homework')).toBe('other')
    expect(kickReasonCode('jenny.smith')).toBe('other')
    expect(kickReasonCode({ text: 'get out Bob' })).toBe('other')
    expect(kickReasonCode(null)).toBe('other')
  })

  it('never copies a typed key-shaped kick text', () => {
    // /kick <bot> <reason> arrives as literal text, so a host can type
    // something shaped like a translation key. Only vanilla keys get through.
    expect(kickReasonCode('disconnect.jenny_smith_go_home')).toBe('other')
    expect(kickReasonCode('bye multiplayer.disconnect.jenny_smith')).toBe('other')
    expect(kickReasonCode({ text: 'disconnect.bob_lives_at_12' })).toBe('other')
    expect(kickReasonCode(JSON.stringify({ text: 'multiplayer.disconnect.jenny' }))).toBe('other')
    expect(kickReasonCode(JSON.stringify({ text: 'multiplayer.disconnect.kicked' }))).toBe('kicked')
  })

  it('reads the key from a JSON-string or NBT kick reason', () => {
    expect(kickReasonCode(JSON.stringify({ translate: 'multiplayer.disconnect.server_shutdown' }))).toBe('server_shutdown')
    expect(
      kickReasonCode({ type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.name_taken' } } }),
    ).toBe('name_taken')
  })
})
