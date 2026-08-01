/**
 * Factory reset (260728): wipe ALL local state back to a fresh install, then
 * relaunch the app.
 *
 * Strategy: enumerate the userData root and delete every entry EXCEPT the
 * anti-abuse trackers (`device-id.json`, `signup-attempts.json` — paths.ts
 * documents that these MUST survive resets, otherwise wiping the app would be
 * a free-trial reset button). Enumerating instead of listing known paths means
 * new caches are covered automatically: profiles/ (configs, characters,
 * memories, knowledge, portraits, skins, clips, encrypted keys), session.bin,
 * logs, chess-models, backseat-debug, voice preview cache, update/notice
 * state, migration markers, and Chromium's own storage (Local Storage,
 * IndexedDB, caches) so the renderer starts clean too.
 *
 * Every deletion is best-effort: on Windows, files the live renderer holds
 * open (Chromium LevelDB) can refuse deletion — those are generic browser
 * caches, and losing the race on them does not compromise the reset. The
 * relaunch happens regardless.
 *
 * Callers stop the bots BEFORE invoking this (a live bot rewrites its memory
 * dir on shutdown, which would resurrect files mid-wipe).
 */
import { app } from 'electron';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** userData entries that survive a factory reset (anti-abuse, see paths.ts). */
const PRESERVED_ENTRIES = new Set(['device-id.json', 'signup-attempts.json']);

export async function runFactoryReset(opts: {
  /** Drain every bot + game session before the wipe. Must not throw. */
  stopEverything: () => Promise<void>;
}): Promise<void> {
  await opts.stopEverything();

  const root = app.getPath('userData');
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (err) {
    console.warn(`[sei] factory reset: cannot read userData: ${(err as Error).message}`);
  }
  for (const entry of entries) {
    if (PRESERVED_ENTRIES.has(entry)) continue;
    try {
      await rm(path.join(root, entry), { recursive: true, force: true });
    } catch (err) {
      // Best-effort (see header) — log and keep going.
      console.warn(`[sei] factory reset: could not remove ${entry}: ${(err as Error).message}`);
    }
  }

  // Relaunch is honored however the current instance exits; app.quit() runs
  // the ordinary before-quit shutdown chain (idempotent for everything the
  // caller already stopped).
  app.relaunch();
  app.quit();
}
