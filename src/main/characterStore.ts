/**
 * Per-character JSON CRUD: `<userData>/characters/<id>.json` + index.json manifest.
 *
 * Sources:
 *   - PATTERNS §src/main/characterStore.ts
 *   - CONTEXT D-09 (file layout), D-11 (timestamps)
 *   - Reuse: existing brain atomicWrite + withFileLock helpers
 *
 * 260516-0yw:
 *  - `saveCharacter` is now the "post-expansion" save — it persists the
 *    Character as-is (including persona.expanded as provided).
 *  - `expandAndSaveCharacter` is the IPC entry point: it loads the prior
 *    character (if any) for voice-continuity reference, calls
 *    loadApiKey() + expandPersona(), merges `expanded` into the input,
 *    saves, and returns the persisted Character so the renderer can
 *    update its store with the new long-form prompt.
 *  - `getCharacter` adds an explicit legacy-shape error path: if the raw
 *    JSON has `persona_prompt` (old shape) at the top level instead of
 *    `persona: { source, expanded }`, throw a clear message instead of
 *    surfacing a Zod stack trace.
 */
import { readFile, mkdir, unlink, rm } from 'node:fs/promises';
import { CharacterSchema, CharacterIndexSchema, type Character, type CharacterIndex } from '../shared/characterSchema';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { expandPersona } from './personaExpansion';
import { loadApiKey } from './apiKeyStore';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function readJson<T>(p: string): Promise<T | null> {
  let raw: string;
  try { raw = await readFile(p, 'utf8'); }
  catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

async function loadIndex(): Promise<CharacterIndex> {
  const data = await readJson<unknown>(paths.indexPath());
  if (!data) return CharacterIndexSchema.parse({});
  try { return CharacterIndexSchema.parse(data); }
  catch (err) {
    logger.warn(`characters/index.json invalid; treating as empty: ${(err as Error).message}`);
    return CharacterIndexSchema.parse({});
  }
}

async function writeIndex(idx: CharacterIndex): Promise<void> {
  const target = paths.indexPath();
  await mkdir(paths.charactersDir(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(idx, null, 2) + '\n');
  });
}

export async function listCharacters(): Promise<Character[]> {
  const idx = await loadIndex();
  const out: Character[] = [];
  const legacyToPurge: string[] = [];
  for (const id of idx.order) {
    try {
      const c = await getCharacter(id);
      if (c) out.push(c);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('legacy shape')) {
        // 260516-x62: self-heal. Old persona_prompt/description files are
        // unparseable under the 260516-0yw schema. Rather than nagging the
        // user forever, delete the JSON and drop it from the index. The
        // memory dir is left alone (user may want it back if they re-create
        // a character with the same id). Defaults seeded on next boot.
        legacyToPurge.push(id);
        logger.warn(`characters/${id}.json: legacy shape detected, purging (next boot will reseed defaults if applicable)`);
      } else {
        logger.warn(`characters/${id}.json failed to load: ${msg}`);
      }
    }
  }
  if (legacyToPurge.length > 0) {
    for (const id of legacyToPurge) {
      try { await unlink(paths.characterPath(id)); } catch { /* ignore */ }
    }
    const fresh = await loadIndex();
    const next = fresh.order.filter(x => !legacyToPurge.includes(x));
    if (next.length !== fresh.order.length) {
      fresh.order = next;
      await writeIndex(fresh);
    }
  }
  return out;
}

export async function getCharacter(id: string): Promise<Character | null> {
  const data = await readJson<unknown>(paths.characterPath(id));
  if (!data) return null;
  // 260516-0yw: detect legacy shape (top-level `persona_prompt` / `description`,
  // no `persona` object) BEFORE Zod parsing so we can throw a useful message.
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const hasLegacy =
      typeof obj.persona_prompt !== 'undefined' ||
      (typeof obj.description !== 'undefined' && typeof obj.persona === 'undefined');
    const hasNew = obj.persona && typeof obj.persona === 'object';
    if (hasLegacy && !hasNew) {
      throw new Error(
        `character ${id} has legacy shape (persona_prompt/description); delete characters/${id}.json or re-create via the GUI`,
      );
    }
  }
  return CharacterSchema.parse(data);
}

export async function saveCharacter(character: Character): Promise<void> {
  const validated = CharacterSchema.parse(character);
  const target = paths.characterPath(validated.id);
  await mkdir(paths.charactersDir(), { recursive: true });

  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });

  // Pre-create the per-character memory directory so the bot's atomic-write
  // helper (which assumes the parent dir exists) can write PLAYER.md /
  // MEMORY.md on first run without ENOENT. The bot supervisor injects
  // explicit memory paths under this dir.
  await mkdir(paths.memoryDir(validated.id), { recursive: true });

  // Maintain index ordering — append new ids; leave existing order alone.
  const idx = await loadIndex();
  if (!idx.order.includes(validated.id)) {
    idx.order.push(validated.id);
    await writeIndex(idx);
  }
}

/**
 * 260516-0yw: expand-then-save flow used by the chars.save IPC handler.
 * Loads the prior character (if any) to pull its persona.expanded as
 * voice-continuity reference for regeneration; calls loadApiKey() to get
 * the user's Anthropic key; runs expandPersona; merges the new `expanded`
 * into the input character; persists via raw saveCharacter; returns the
 * persisted Character so the renderer can update its store with the new
 * long-form prompt.
 *
 * Throws on missing API key, expansion failure, or write failure. The
 * IPC handler surfaces the thrown message to the renderer for display.
 */
export async function expandAndSaveCharacter(
  input: { character: Character },
): Promise<Character> {
  const { character } = input;
  const validated = CharacterSchema.parse(character);

  // Pull prior expanded for voice continuity, if any. `getCharacter` may
  // throw on legacy-shape detection (which is fine — the calling renderer
  // will surface the message). When the legacy throw happens, treat it as
  // "no prior" and let the new save overwrite the file.
  let priorExpanded: string | undefined;
  try {
    const prior = await getCharacter(validated.id);
    priorExpanded = prior?.persona.expanded || undefined;
  } catch {
    priorExpanded = undefined;
  }

  const apiKey = await loadApiKey();

  const { expanded } = await expandPersona({
    source: validated.persona.source,
    priorExpanded,
    apiKey,
  });

  const merged: Character = {
    ...validated,
    persona: {
      source: validated.persona.source,
      expanded,
    },
  };
  await saveCharacter(merged);
  return merged;
}

/**
 * Reset a character's memory directory: wipe its contents and recreate it
 * empty. The character JSON, portrait, and index entry are untouched — only
 * PLAYER.md / MEMORY.md (and any other files under the memory dir) are
 * erased. Caller (main/ipc.ts) gates against resetting an actively summoned
 * bot.
 */
export async function resetMemoryForCharacter(id: string): Promise<void> {
  await rm(paths.memoryDir(id), { recursive: true, force: true });
  await mkdir(paths.memoryDir(id), { recursive: true });
}

export async function deleteCharacter(id: string): Promise<void> {
  // Remove JSON
  try { await unlink(paths.characterPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove optional portrait
  try { await unlink(paths.characterPortraitPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove memory dir recursively (idempotent)
  await rm(paths.memoryDir(id), { recursive: true, force: true });

  // Remove from index
  const idx = await loadIndex();
  const next = idx.order.filter((x) => x !== id);
  if (next.length !== idx.order.length) {
    idx.order = next;
    await writeIndex(idx);
  }
}
