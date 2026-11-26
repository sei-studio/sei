/**
 * Durable facts saved to MEMORY.md at the end of a stretch of conversation
 * (261113, v0.7 consistency D2).
 *
 * The fold compresses old chat rows into a summary of about 150 words, and
 * each later fold compresses it again. A name, a date or a preference that
 * was said once and never saved with remember() lived only in that summary,
 * so it thinned out and was gone. The fold (continuity.ts, foldPrompt.ts) and
 * the game session-end call (playerEndNextStep.ts) now return the durable
 * facts they see, and this file saves the new ones.
 *
 * Dedupe: the prompts are shown the memory notes and asked to leave out what
 * is already there; behind that, a fact whose normalized text (memoryLog
 * normalizeEntry: lowercase, letters and digits) matches ANY entry in the file
 * is not written. appendMemory's own guard only looks back 10 minutes, which
 * is right for remember() but not for a fold restating a weeks-old note.
 *
 * Nothing here imports electron, so the consistency eval saves facts with the
 * checkout it measures.
 */
import { readFile } from 'node:fs/promises';
import { appendMemory, humanizeMemoryStamps, normalizeEntry } from '../../bot/brain/memory/memoryLog.js';

/** The memory the fold is shown: the same 12000-byte tail the chat reads (chatService MEMORY_BUDGET_BYTES). */
export const FOLD_MEMORY_BYTES = 12000;

/** MEMORY.md as the fold reads it: the tail, stamps in local time. */
export function memoryForFold(body: string): string {
  const raw = String(body ?? '');
  return humanizeMemoryStamps(raw.length <= FOLD_MEMORY_BYTES ? raw : raw.slice(-FOLD_MEMORY_BYTES));
}

/** The normalized text of every entry in a MEMORY.md body. */
export function memoryEntryKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const m of String(body ?? '').matchAll(/^- \[[^\]]*\] (.*)$/gm)) {
    const k = normalizeEntry(m[1]);
    if (k) keys.add(k);
  }
  return keys;
}

/** The facts that are not in the body yet (nor repeated in the list), and how many were dropped. */
export function freshFacts(body: string, facts: readonly string[]): { fresh: string[]; dupes: number } {
  const seen = memoryEntryKeys(body);
  const fresh: string[] = [];
  let dupes = 0;
  for (const f of facts) {
    const k = normalizeEntry(f);
    if (!k) continue;
    if (seen.has(k)) {
      dupes++;
      continue;
    }
    seen.add(k);
    fresh.push(f);
  }
  return { fresh, dupes };
}

export interface FactSave {
  /** Lines the model returned. */
  returned: number;
  saved: number;
  /** Lines not written because memory already had them. */
  dupes: number;
}

/**
 * Save the new facts. `section: 'app'` files them under the app section
 * (chat, calls); without it they go where the file's last section is (a game
 * session's world, as the plan line does). `when` stamps every line (the time
 * of the newest message they came from). Never throws.
 */
export async function saveFacts(
  file: string,
  facts: readonly string[],
  opts: { section?: 'app'; when?: number } = {},
): Promise<FactSave> {
  const out: FactSave = { returned: facts.length, saved: 0, dupes: 0 };
  if (!facts.length) return out;
  let body = '';
  try {
    body = await readFile(file, 'utf8');
  } catch {
    /* no memory yet */
  }
  const { fresh, dupes } = freshFacts(body, facts);
  out.dupes = dupes;
  const when = typeof opts.when === 'number' && Number.isFinite(opts.when) ? new Date(opts.when) : undefined;
  for (const f of fresh) {
    try {
      const n = await appendMemory(file, f, when, opts.section ? { section: opts.section } : {});
      if (n > 0) out.saved++;
      else out.dupes++;
    } catch {
      /* best effort: the summary still has it */
    }
  }
  return out;
}
