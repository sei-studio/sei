// humanizeReason regression guards (260710). Every vanilla kick key starts
// with "multiplayer.disconnect.", which CONTAINS "connect" — the bare
// substring check used to mislabel every server kick as "Could not reach
// server. Make sure a LAN world is open" (seen live with
// chat_validation_failed, which also gets its own specific copy now).

import { describe, it, expect } from 'vitest'
import {
  humanizeReason,
  isModdedHostRejection,
  kickReasonCode,
  kickPlainText,
  fabricKickNamespaces,
  isOnlineModeRejection,
} from './connect.js'

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

// 261007: the Fabric API registry-sync kick exactly as a 0.6.7 user's bot
// logged it (1.21.11, NBT-tagged chat component; the mods it names are Xaero's
// Minimap and World Map). The old copy called this world "Forge or NeoForge".
const FABRIC_KICK_NBT = {"type":"compound","value":{"extra":{"type":"list","value":{"type":"compound","value":[{"color":{"type":"string","value":"green"},"text":{"type":"string","value":"Fabric Loader and Fabric API"}},{"":{"type":"string","value":" installed on your client!"}},{"":{"type":"string","value":"\n"}},{"extra":{"type":"list","value":{"type":"compound","value":[{"color":{"type":"string","value":"yellow"},"text":{"type":"string","value":"xaerominimap"}},{"":{"type":"string","value":"\n"}},{"color":{"type":"string","value":"yellow"},"text":{"type":"string","value":"xaeroworldmap"}},{"":{"type":"string","value":"\n"}}]}},"text":{"type":"string","value":"The following registry entry namespaces may be related:\n\n"}},{"":{"type":"string","value":"\n"}},{"":{"type":"string","value":"\n"}},{"color":{"type":"string","value":"gold"},"text":{"type":"string","value":"Contact the server's administrator for more information!"}}]}},"text":{"type":"string","value":"This server requires "}}}

describe('Fabric registry-sync kick (261007)', () => {
  it('flattens the NBT component in reading order', () => {
    const text = kickPlainText(FABRIC_KICK_NBT)
    expect(text.startsWith('This server requires Fabric Loader and Fabric API installed on your client!')).toBe(true)
    expect(text).toContain('xaerominimap')
    expect(text).toContain("Contact the server's administrator")
  })

  it('reads the named mod namespaces, from the object or its JSON string', () => {
    expect(fabricKickNamespaces(FABRIC_KICK_NBT)).toEqual(['xaerominimap', 'xaeroworldmap'])
    expect(fabricKickNamespaces(JSON.stringify(FABRIC_KICK_NBT))).toEqual(['xaerominimap', 'xaeroworldmap'])
    expect(fabricKickNamespaces('You are banned')).toEqual([])
  })

  it('says Fabric (not Forge) and names the mods', () => {
    const h = humanizeReason(FABRIC_KICK_NBT)
    expect(h).toMatch(/runs Fabric/)
    expect(h).not.toMatch(/forge/i)
    expect(h).toContain('The mods it names: xaerominimap, xaeroworldmap')
    expect(isModdedHostRejection(FABRIC_KICK_NBT)).toBe(true)
    expect(kickReasonCode(FABRIC_KICK_NBT)).toBe('modded')
  })

  it('keeps the Forge copy for a Forge kick', () => {
    expect(humanizeReason('This server has mods that require Forge to be installed on the client.')).toMatch(/forge or neoforge/i)
  })
})

// 261007: vanilla Open to LAN lets an offline client in ("Failed to verify
// username but will let them in anyway"), so this kick means a server with
// online-mode on. It used to retry three times and end as LAN_NOT_OPEN, with
// the raw translate key in the message.
describe('isOnlineModeRejection (261007)', () => {
  const KEY = 'multiplayer.disconnect.unverified_username'
  it('catches the vanilla key as a JSON string, an object and plain text', () => {
    expect(isOnlineModeRejection(JSON.stringify({ translate: KEY }))).toBe(true)
    expect(isOnlineModeRejection({ translate: KEY })).toBe(true)
    expect(isOnlineModeRejection('Failed to verify username!')).toBe(true)
  })

  it('does not fire on other kicks', () => {
    expect(isOnlineModeRejection(JSON.stringify({ translate: 'multiplayer.disconnect.name_taken' }))).toBe(false)
    expect(isOnlineModeRejection('You are banned')).toBe(false)
    expect(isOnlineModeRejection(FABRIC_KICK_NBT)).toBe(false)
  })

  it('humanizes to the online-mode copy, never the LAN hint or the raw key', () => {
    const h = humanizeReason(JSON.stringify({ translate: KEY }))
    expect(h).toMatch(/online mode/)
    expect(h).not.toMatch(/could not reach/i)
    expect(h).not.toContain('multiplayer.disconnect')
    expect(kickReasonCode({ translate: KEY })).toBe('unverified_username')
  })
})
