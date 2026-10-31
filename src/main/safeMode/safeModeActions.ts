/**
 * What the safe-mode screen's buttons do, minus the window (261031, T277).
 *
 * Safe mode never signs in or loads the auth stack (it may be the part that
 * is broken), so it does not know which profile is the active one. "Reset
 * settings" therefore resets EVERY profile's config.json on this device, each
 * keeping its own identity keys (resetConfigKeepingIdentity), and the page
 * theme comes from whichever profile config was written last.
 */
import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { paths, profileRootFor, SCOPE_LOCAL } from '../paths';
import { resetConfigKeepingIdentity } from '../configStore';
import { safeModeTheme, type SafeModeTheme } from './safeModePage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Profile scopes on disk that have a config.json. */
export async function listConfigScopes(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(paths.userData(), 'profiles'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n !== SCOPE_LOCAL && !UUID_RE.test(n)) continue;
    try {
      await stat(path.join(profileRootFor(n), 'config.json'));
      out.push(n);
    } catch {
      /* no config in this profile */
    }
  }
  return out.sort();
}

/** Reset every profile's settings (identity kept). ok = every reset landed. */
export async function resetSettingsEverywhere(): Promise<{ ok: boolean; profiles: number; failed: number }> {
  const scopes = await listConfigScopes();
  let failed = 0;
  for (const scope of scopes) {
    try {
      await resetConfigKeepingIdentity({ scope });
    } catch (err) {
      failed++;
      console.warn(`[sei] safe mode: settings reset failed for one profile (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
    }
  }
  console.log(`[sei] safe mode: settings reset in ${scopes.length - failed} of ${scopes.length} profile(s)`);
  return { ok: failed === 0, profiles: scopes.length, failed };
}

/** The theme of the most recently written profile config (system when unknown). */
export async function readPageTheme(): Promise<SafeModeTheme> {
  let best: { mtime: number; file: string } | null = null;
  for (const scope of await listConfigScopes()) {
    const file = path.join(profileRootFor(scope), 'config.json');
    try {
      const m = (await stat(file)).mtimeMs;
      if (!best || m > best.mtime) best = { mtime: m, file };
    } catch {
      /* gone */
    }
  }
  if (!best) return 'system';
  try {
    const raw = JSON.parse(await readFile(best.file, 'utf8')) as Record<string, unknown> | null;
    return safeModeTheme(raw && typeof raw === 'object' ? raw.theme_mode : undefined);
  } catch {
    return 'system';
  }
}

/** Open <userData>/logs in the file manager. */
export async function openLogsFolder(openPath: (p: string) => Promise<string>): Promise<boolean> {
  const dir = paths.logsDir();
  try {
    await mkdir(dir, { recursive: true });
    const err = await openPath(dir);
    return err === '';
  } catch {
    return false;
  }
}
