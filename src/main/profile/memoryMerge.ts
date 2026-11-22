/**
 * Merge one companion's on-disk memory from the `local` (own key) profile into
 * the same companion's memory in a Sei account profile (261023).
 *
 * The rule is "add, never replace": whatever the account already has stays as
 * it is, and the local copy only contributes what the account lacks. Every
 * step is idempotent, so a second run (or a re-run after a crash halfway
 * through) adds nothing.
 *
 * Per file in `memory/<id>/`:
 *   - MEMORY.md, MEMORY.archive.md: line union. Local lines the account
 *     already has are skipped; new ones keep their `## ` section header.
 *     Entries from before any section go before the account's first section.
 *   - worlds.json: worlds are matched by fingerprint. A local world the
 *     account already knows takes the account's number; a new one gets the
 *     next free number, and the local MEMORY.md `## World N` headers are
 *     renumbered to match, so two different worlds never share a number. A
 *     local header with no worlds.json entry gets a fresh number too, held
 *     by a reservation entry in the account's worlds.json.
 *   - chat.jsonl: line union, sorted by `ts` (stable).
 *   - anything else (bridge, HEARTBEAT, PLAYER.md, NEXT_STEP.json, ...):
 *     derived state. Moved when the account has none, otherwise the
 *     account's copy is kept.
 *
 * `knowledge/<id>/` (user-provided files) merges its manifest by entry id.
 */
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';

interface WorldEntry {
  num: number;
  fingerprint: string;
  label?: string;
  firstSeen?: string;
  lastSeen?: string;
  [k: string]: unknown;
}
interface WorldRegistry {
  version: number;
  worlds: WorldEntry[];
}

const WORLD_HEADER_RE = /^## World (\d+)\b/;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function readText(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

/** True when `dir` holds at least one file (at any depth). */
export async function dirHasFiles(dir: string): Promise<boolean> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile()) return true;
    if (e.isDirectory() && (await dirHasFiles(path.join(dir, e.name)))) return true;
  }
  return false;
}

function parseRegistry(raw: string | null): WorldRegistry {
  if (!raw) return { version: 1, worlds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WorldRegistry>;
    if (parsed && Array.isArray(parsed.worlds)) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        worlds: parsed.worlds.filter(
          (w): w is WorldEntry => !!w && typeof w.num === 'number' && typeof w.fingerprint === 'string',
        ),
      };
    }
  } catch { /* corrupt: treat as empty */ }
  return { version: 1, worlds: [] };
}

/** Highest `## World N` number in a memory file. */
export function maxWorldHeaderNum(text: string): number {
  let max = 0;
  for (const line of text.split('\n')) {
    const m = WORLD_HEADER_RE.exec(line);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Fingerprint prefix of a registry entry that only reserves the number given
 * to a local `## World N` header with no worlds.json entry. No spawn ever
 * produces it, so the bot never resolves into one; it only keeps the bot's
 * next new world (max registered number + 1) off that number.
 */
export const UNREGISTERED_WORLD_FP = 'unregistered-local-world:';

/**
 * Merge the local world registry into the account's. Returns the merged
 * registry and the localâ†’account number map. `reservedMax` is the highest
 * world number the account already uses anywhere (its MEMORY.md can name a
 * world its registry lost), so a new world never reuses one.
 *
 * `unregistered` are local `## World N` numbers with no local registry entry
 * (a lost or older worlds.json). Kept as they were, they would be filed under
 * the account's world of the same number. Each gets a fresh number above
 * every one in use, and a reservation entry (UNREGISTERED_WORLD_FP + N) so
 * the bot's next new world does not take it. The fingerprint is derived from
 * N, so a re-run after a crash between two memory files maps N the same way.
 */
export function mergeWorldRegistries(
  target: WorldRegistry,
  local: WorldRegistry,
  reservedMax = 0,
  unregistered: readonly number[] = [],
): { merged: WorldRegistry; map: Map<number, number> } {
  const merged: WorldRegistry = { version: target.version || 1, worlds: target.worlds.map((w) => ({ ...w })) };
  const map = new Map<number, number>();
  let next = Math.max(reservedMax, ...merged.worlds.map((w) => w.num), 0) + 1;
  for (const lw of local.worlds) {
    const hit = merged.worlds.find((w) => w.fingerprint === lw.fingerprint);
    if (hit) {
      map.set(lw.num, hit.num);
      if (lw.firstSeen && (!hit.firstSeen || lw.firstSeen < hit.firstSeen)) hit.firstSeen = lw.firstSeen;
      if (lw.lastSeen && (!hit.lastSeen || lw.lastSeen > hit.lastSeen)) hit.lastSeen = lw.lastSeen;
      if (!hit.label && lw.label) hit.label = lw.label;
    } else {
      const num = next++;
      map.set(lw.num, num);
      merged.worlds.push({ ...lw, num });
    }
  }
  const registered = new Set(local.worlds.map((w) => w.num));
  for (const n of [...new Set(unregistered)].sort((a, b) => a - b)) {
    if (registered.has(n)) continue;
    const fingerprint = `${UNREGISTERED_WORLD_FP}${n}`;
    const hit = merged.worlds.find((w) => w.fingerprint === fingerprint);
    if (hit) {
      map.set(n, hit.num);
      continue;
    }
    const num = next++;
    map.set(n, num);
    merged.worlds.push({ num, fingerprint, label: `World ${num}` });
  }
  return { merged, map };
}

/** Every `## World N` number in a memory file. */
export function worldHeaderNums(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split('\n')) {
    const m = WORLD_HEADER_RE.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** Rewrite `## World N` headers through `map` (numbers not in it are kept). */
export function renumberWorldHeaders(text: string, map: Map<number, number>): string {
  if (map.size === 0) return text;
  return text
    .split('\n')
    .map((line) => {
      const m = WORLD_HEADER_RE.exec(line);
      if (!m) return line;
      const to = map.get(Number(m[1]));
      return to === undefined ? line : `## World ${to}${line.slice(m[0].length)}`;
    })
    .join('\n');
}

interface MemorySection {
  header: string | null;
  lines: string[];
}

/** Split a memory file into its title block and content sections. */
function parseMemory(text: string): { preamble: string[]; sections: MemorySection[] } {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < all.length && !all[i].startsWith('- ') && !all[i].startsWith('## ')) i++;
  const preamble = all.slice(0, i);
  const sections: MemorySection[] = [{ header: null, lines: [] }];
  for (; i < all.length; i++) {
    const line = all[i];
    if (line.startsWith('## ')) sections.push({ header: line, lines: [] });
    else if (line.trim()) sections[sections.length - 1].lines.push(line);
  }
  return { preamble, sections };
}

/**
 * Line-union of two MEMORY.md (or MEMORY.archive.md) bodies. The account's
 * text is kept byte for byte; local lines it lacks are added. Pure.
 */
export function mergeMemoryMarkdown(targetText: string, localText: string): string {
  if (!targetText.trim()) return localText;
  if (!localText.trim()) return targetText;
  const seen = new Set(
    targetText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const { sections } = parseMemory(localText);
  const fresh = (lines: string[]): string[] => {
    const out: string[] = [];
    for (const l of lines) {
      const key = l.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  };

  let result = targetText;
  // Entries from before any section stay outside the account's sections:
  // appended at the end they would read as part of its last world.
  const loose = fresh(sections[0].lines);
  if (loose.length) {
    const lines = result.split('\n');
    const firstSection = lines.findIndex((l) => l.startsWith('## '));
    if (firstSection === -1) {
      result = result.replace(/\n*$/, '\n') + loose.join('\n') + '\n';
    } else {
      lines.splice(firstSection, 0, ...loose, '');
      result = lines.join('\n');
    }
  }
  for (const s of sections.slice(1)) {
    const add = fresh(s.lines);
    if (!add.length) continue;
    result = result.replace(/\n*$/, '\n') + `\n${s.header}\n` + add.join('\n') + '\n';
  }
  return result;
}

/** Line-union of two JSONL transcripts, stable-sorted by numeric `ts`. Pure. */
export function mergeJsonlByTs(targetText: string, localText: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const l of [...targetText.split('\n'), ...localText.split('\n')]) {
    const key = l.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  const tsOf = (l: string): number | null => {
    try {
      const ts = (JSON.parse(l) as { ts?: unknown }).ts;
      return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
    } catch {
      return null;
    }
  };
  // A row without a usable ts sorts with the row before it.
  let last = -Infinity;
  const keyed = lines.map((l, i) => {
    const ts = tsOf(l);
    if (ts !== null) last = ts;
    return { l, i, ts: ts ?? last };
  });
  keyed.sort((a, b) => a.ts - b.ts || a.i - b.i);
  return keyed.map((k) => k.l).join('\n') + (keyed.length ? '\n' : '');
}

async function moveIntoPlace(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
}

/**
 * Read-merge-write `dest` under its file lock, so a writer that appends while
 * the import runs (a chat remember(), a transcript row) is not overwritten by
 * a merge computed from an older read. `merge` gets the current text ('' when
 * missing) and returns the new one; nothing is written when it is unchanged.
 */
async function mergeInto(dest: string, merge: (current: string) => string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await withFileLock(dest, async () => {
    const current = (await readText(dest)) ?? '';
    const next = merge(current);
    if (next !== current) await atomicWrite(dest, next);
  });
}

const MEMORY_TEXT_FILES = new Set(['MEMORY.md', 'MEMORY.archive.md']);

/**
 * Merge `srcDir` (the local profile's memory/<id>) into `destDir` (the
 * account's). The source is removed once everything in it is in the account.
 */
export async function mergeMemoryDir(srcDir: string, destDir: string): Promise<void> {
  if (!(await exists(srcDir))) return;
  if (!(await exists(destDir)) || !(await dirHasFiles(destDir))) {
    // Nothing on the account side: take the whole directory as is.
    await rm(destDir, { recursive: true, force: true });
    await moveIntoPlace(srcDir, destDir);
    return;
  }

  // Worlds first: the number map rewrites the memory files below.
  const srcWorlds = path.join(srcDir, 'worlds.json');
  const destWorlds = path.join(destDir, 'worlds.json');
  let worldMap = new Map<number, number>();
  const localReg = parseRegistry(await readText(srcWorlds));
  // Local headers the local registry does not know (it was lost, or predates
  // them): renumbered too, or they would land in another world's section.
  const unregistered: number[] = [];
  for (const f of MEMORY_TEXT_FILES) {
    for (const n of worldHeaderNums((await readText(path.join(srcDir, f))) ?? '')) {
      if (!localReg.worlds.some((w) => w.num === n)) unregistered.push(n);
    }
  }
  if (localReg.worlds.length || unregistered.length) {
    let reserved = 0;
    for (const f of MEMORY_TEXT_FILES) {
      reserved = Math.max(reserved, maxWorldHeaderNum((await readText(path.join(destDir, f))) ?? ''));
    }
    await mergeInto(destWorlds, (current) => {
      const { merged, map } = mergeWorldRegistries(parseRegistry(current || null), localReg, reserved, unregistered);
      worldMap = map;
      return JSON.stringify(merged, null, 2) + '\n';
    });
  }
  // The local worlds.json is removed LAST (below): it is what maps the local
  // `## World N` headers, and a re-run after a crash before the memory files
  // are merged must still be able to renumber them. Re-merging it is a no-op
  // (every world matches by fingerprint).

  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'worlds.json') continue;
    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);
    if (e.isDirectory()) {
      if (await exists(dest)) {
        await mergeMemoryDir(src, dest);
      } else {
        await moveIntoPlace(src, dest);
      }
      continue;
    }
    if (!e.isFile()) continue;
    if (MEMORY_TEXT_FILES.has(e.name)) {
      const local = renumberWorldHeaders((await readText(src)) ?? '', worldMap);
      await mergeInto(dest, (target) => mergeMemoryMarkdown(target, local));
      await rm(src, { force: true });
    } else if (e.name.endsWith('.jsonl')) {
      const local = (await readText(src)) ?? '';
      await mergeInto(dest, (target) => mergeJsonlByTs(target, local));
      await rm(src, { force: true });
    } else if (!(await exists(dest))) {
      await moveIntoPlace(src, dest);
    } else {
      // Derived state the account already has: the account's copy wins.
      await rm(src, { force: true });
    }
  }
  await rm(srcDir, { recursive: true, force: true });
}

interface KnowledgeManifest {
  version: number;
  entries: Array<{ id: string; [k: string]: unknown }>;
}

function parseManifest(raw: string | null): KnowledgeManifest {
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<KnowledgeManifest>;
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.filter((e): e is { id: string } => !!e && typeof e.id === 'string'),
      };
    }
  } catch { /* missing or corrupt */ }
  return { version: 1, entries: [] };
}

/** Merge the local knowledge/<id> into the account's, by entry id. */
export async function mergeKnowledgeDir(srcDir: string, destDir: string): Promise<void> {
  if (!(await exists(srcDir))) return;
  if (!(await exists(destDir)) || !(await dirHasFiles(destDir))) {
    await rm(destDir, { recursive: true, force: true });
    await moveIntoPlace(srcDir, destDir);
    return;
  }
  const destManifestPath = path.join(destDir, 'index.json');
  const target = parseManifest(await readText(destManifestPath));
  const local = parseManifest(await readText(path.join(srcDir, 'index.json')));
  const have = new Set(target.entries.map((e) => e.id));
  let changed = false;
  for (const entry of local.entries) {
    if (have.has(entry.id)) continue;
    const src = path.join(srcDir, `${entry.id}.md`);
    const dest = path.join(destDir, `${entry.id}.md`);
    // A file already in the account (moved by a run that crashed before the
    // manifest write) is listed too, or it would stay there unseen.
    if (!(await exists(dest))) {
      if (!(await exists(src))) continue;
      await moveIntoPlace(src, dest);
    }
    target.entries.push(entry);
    have.add(entry.id);
    changed = true;
  }
  if (changed) {
    await mergeInto(destManifestPath, (current) => {
      // Entries the account gained since the read above are kept.
      const now = parseManifest(current || null);
      const ids = new Set(now.entries.map((e) => e.id));
      const add = target.entries.filter((e) => !ids.has(e.id));
      return JSON.stringify({ ...now, entries: [...now.entries, ...add] }, null, 2);
    });
  }
  await rm(srcDir, { recursive: true, force: true });
}




