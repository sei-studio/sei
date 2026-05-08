/**
 * Per-character JSON CRUD: `<userData>/characters/<id>.json` + index.json manifest.
 *
 * Sources:
 *   - PATTERNS §src/main/characterStore.ts
 *   - CONTEXT D-09 (file layout), D-11 (timestamps)
 *   - Reuse: existing brain atomicWrite + withFileLock helpers
 */
import { readFile, mkdir, unlink, rm } from 'node:fs/promises';
import { CharacterSchema, CharacterIndexSchema, type Character, type CharacterIndex } from '../shared/characterSchema';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';

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
  for (const id of idx.order) {
    try {
      const c = await getCharacter(id);
      if (c) out.push(c);
    } catch (err) {
      logger.warn(`characters/${id}.json failed to load: ${(err as Error).message}`);
    }
  }
  return out;
}

export async function getCharacter(id: string): Promise<Character | null> {
  const data = await readJson<unknown>(paths.characterPath(id));
  if (!data) return null;
  return CharacterSchema.parse(data);
}

export async function saveCharacter(character: Character): Promise<void> {
  const validated = CharacterSchema.parse(character);
  const target = paths.characterPath(validated.id);
  await mkdir(paths.charactersDir(), { recursive: true });

  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });

  // BLOCKER-3 fix: pre-create the per-character memory directory so the
  // bot's atomic-write helper (which assumes the parent dir exists) can
  // write OWNER.md / DIARY.md / AFFECT.md on first run without ENOENT.
  // The bot supervisor injects explicit memory paths under this dir
  // (per BLOCKER-2 fix in plan 04 task 2).
  await mkdir(paths.memoryDir(validated.id), { recursive: true });

  // Maintain index ordering — append new ids; leave existing order alone.
  const idx = await loadIndex();
  if (!idx.order.includes(validated.id)) {
    idx.order.push(validated.id);
    await writeIndex(idx);
  }
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
