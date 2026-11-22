// 261013 (T111): SillyTavern-style {{user}} / {{char}} card placeholders are
// filled before persona text reaches any prompt, deterministically, so the
// cached persona block stays byte-stable across turns.
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fillPersonaPlaceholders, hasPersonaPlaceholders } from './personaPlaceholders.js'
import { renderCore, renderPersona } from './promptLibrary.js'
import { ConfigSchema } from '../config.js'
import { createMinecraftAdapter } from '../adapter/minecraft/index.js'
import { createOrchestrator } from './orchestrator.js'

const CARD =
  'You are {{char}}, a small apprentice.\n' +
  'In your fictional backstory, {{user}} found you alone in Reovano.\n' +
  '{{USER}} is like a big sibling to you. {{ User }} makes you laugh.'

describe('fillPersonaPlaceholders', () => {
  it('substitutes both placeholders case-insensitively with the known names', () => {
    const out = fillPersonaPlaceholders(CARD, { charName: 'Roger', userName: 'Ouen' })
    expect(out).toBe(
      'You are Roger, a small apprentice.\n' +
        'In your fictional backstory, Ouen found you alone in Reovano.\n' +
        'Ouen is like a big sibling to you. Ouen makes you laugh.',
    )
  })

  it('falls back to "the player", capitalized only at a sentence start', () => {
    const out = fillPersonaPlaceholders(CARD, { charName: 'Roger', userName: '  ' })
    expect(out).toContain('backstory, the player found you')
    expect(out).toContain('\nThe player is like a big sibling to you. The player makes you laugh.')
    expect(out).not.toMatch(/\{\{/)
  })

  it('falls back for {{char}} when the name is unknown', () => {
    expect(fillPersonaPlaceholders('Talk like {{char}}.', {})).toBe('Talk like this character.')
    expect(fillPersonaPlaceholders('{{char}} hums.', {})).toBe('This character hums.')
  })

  it('is deterministic and idempotent', () => {
    const a = fillPersonaPlaceholders(CARD, { charName: 'Roger', userName: 'Ouen' })
    const b = fillPersonaPlaceholders(CARD, { charName: 'Roger', userName: 'Ouen' })
    expect(a).toBe(b)
    expect(fillPersonaPlaceholders(a, { charName: 'X', userName: 'Y' })).toBe(a)
  })

  it('leaves text without placeholders, other braces, and non-strings alone', () => {
    expect(fillPersonaPlaceholders('plain text', { userName: 'Ouen' })).toBe('plain text')
    expect(fillPersonaPlaceholders('{{random}} and {user}', { userName: 'Ouen' })).toBe('{{random}} and {user}')
    expect(fillPersonaPlaceholders(undefined, {})).toBe(undefined)
  })

  it('detects placeholders', () => {
    expect(hasPersonaPlaceholders(CARD)).toBe(true)
    expect(hasPersonaPlaceholders('{{ CHAR }}')).toBe(true)
    expect(hasPersonaPlaceholders('{{random}}')).toBe(false)
    expect(hasPersonaPlaceholders('')).toBe(false)
    expect(hasPersonaPlaceholders(null)).toBe(false)
  })
})

describe('renderPersona / renderCore fill placeholders', () => {
  const persona = { name: 'Roger', expanded: `# CORE\nYou adore {{user}}.\n\n# VOICE\n{{char}} speaks softly.` }

  it('renderPersona uses the player display name and the persona name', () => {
    const out = renderPersona(persona, { userName: 'Ouen' })
    expect(out).toBe('You are Roger.\n# CORE\nYou adore Ouen.\n\n# VOICE\nRoger speaks softly.')
  })

  it('renderPersona without a player name says "the player"', () => {
    expect(renderPersona(persona)).toContain('You adore the player.')
  })

  it('renderCore fills the tail core the same way', () => {
    const out = renderCore(persona, { userName: 'Ouen' })
    expect(out).toContain('You adore Ouen.')
    expect(out).not.toMatch(/\{\{/)
    expect(renderCore(persona)).toContain('You adore the player.')
  })

  it('renderCore fallback core (no # CORE) is filled too', () => {
    const out = renderCore({ name: 'Roger', expanded: '{{user}} found you.' }, { userName: 'Ouen' })
    expect(out).toContain('Ouen found you.')
  })
})

describe('Minecraft cached system prefix', () => {
  function cachedBlocks(displayName) {
    const memDir = path.join(os.tmpdir(), 'sei-placeholders-test')
    const config = ConfigSchema.parse({
      chat_mode: 'chat',
      player_username: 'Steve',
      player_display_name: displayName,
      persona: { name: 'Roger', expanded: 'You are {{char}}. {{user}} found you alone.', proactiveness: 2 },
      anthropic: { api_key: 'sk-test' },
      adapter: {
        kind: 'minecraft',
        minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: 'Roger', version: 'auto' },
      },
      memory: {
        player_md_path: `${memDir}/PLAYER.md`,
        memory_md_path: `${memDir}/MEMORY.md`,
        heartbeat_md_path: `${memDir}/HEARTBEAT.md`,
        worlds_json_path: `${memDir}/worlds.json`,
      },
      vision: {},
    })
    const bot = { chat() {}, username: 'Roger', players: {}, on() {}, off() {}, removeListener() {}, once() {} }
    let captured = null
    const provider = {
      buildCachedSystem: (blocks) => { captured = blocks; return blocks },
      setAuthToken() {},
      setBackend() {},
      capabilities: { vision: true },
      async call() { return { text: '', toolUses: [] } },
    }
    const adapter = createMinecraftAdapter({ bot, config, visionEnabled: true })
    const noop = () => {}
    createOrchestrator({ adapter, config, reenqueue: noop, _anthropicOverride: provider, logger: { info: noop, warn: noop, error: noop, debug: noop } })
    return captured
  }

  it('persona block [1] carries the display name, never the literal placeholder', () => {
    expect(cachedBlocks('Ouen')[1]).toBe('You are Roger.\nYou are Roger. Ouen found you alone.')
    expect(cachedBlocks('')[1]).toBe('You are Roger.\nYou are Roger. The player found you alone.')
    expect(cachedBlocks('Ouen').join('\n')).not.toMatch(/\{\{/)
  })
})




