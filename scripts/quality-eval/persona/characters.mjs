// scripts/quality-eval/persona/characters.mjs: load the character fixtures the
// persona eval runs (cloud rows saved read-only under ~/suisei/eval/characters,
// never in the repo). A fixture is either the row object or a one-element
// array, as the Supabase query returned it.
import fs from 'node:fs'
import path from 'node:path'
import { foldLatin } from '../../../src/bot/names.js'

export const DEFAULT_CHARS = ['sui', 'lyra', 'marv', 'red', 'roger']

// Signature verbal tics per character, for the tic-frequency metric in
// report.mjs. Each comes from the character's card: a word the card tells the
// character to use (Lyra's nya, Sui's cackle), the pet name its backstory
// gives the player (Roger's big brother), or the subject its identity is built
// around (Red's sun, Marv's universe). The first entry is the signature tic;
// the rest are its smaller habits. A tic in every line reads as a parody over
// a long session, so the healthy range is "now and then", not 0 and not 100%.
export const TICS = {
  sui: [{ name: 'nehehe/ehehe', re: /\b(?:n?e)?he(?:he)+\b/i }],
  lyra: [{ name: 'nya/nyan', re: /\bnya+n?\b/i }, { name: 'stutter (o-oh)', re: /\b(\w)-\1/i }],
  marv: [{ name: 'universe', re: /\buniverse\b/i }, { name: 'of course', re: /\bof course\b/i }, { name: 'heat death/cooling', re: /\b(heat death|entropy|cooling)\b/i }],
  red: [{ name: 'sun', re: /\bsun(?:light|rise|shine|set|s)?\b/i }, { name: 'ocean/sea/salt', re: /\b(ocean|sea|salt)\b/i }],
  roger: [{ name: 'big bro/sis', re: /\bbig (?:bro|brother|sis|sister)\b/i }, { name: 'stutter (w-wait)', re: /\b(\w)-\1/i }],
}

// Mirror of effectiveMcUsername (src/shared/characterSchema.ts): the in-game
// name is character.username, else the display name, accents folded, sanitized
// to MC rules. The eval pads names under 3 characters for its local server.
function mcName(row) {
  if (row.username) return row.username
  const s = foldLatin(row.name ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
  return s.length >= 3 ? s : `${s}_sei`.slice(0, 16)
}

export function loadCharacters(dir, keys = DEFAULT_CHARS) {
  return keys.map((key) => {
    let row = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'))
    if (Array.isArray(row)) row = row[0]
    return {
      key,
      id: row.id,
      name: row.name,
      botName: mcName(row),
      expanded: row.persona_expanded,
      source: row.persona_source,
      description: row.metadata?.description ?? null,
      punctuation: row.metadata?.punctuation === 'deliberate' ? 'deliberate' : null,
      tics: TICS[key] ?? [],
    }
  })
}
