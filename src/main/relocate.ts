/**
 * Relocation leftover cleanup (macOS only).
 *
 * History: while the macOS build shipped as a .zip (no .dmg), people often
 * unzipped into ~/Downloads and ran the app right there. Gatekeeper then
 * "translocates" it — runs it from a read-only randomized mount — and
 * electron-updater cannot replace the bundle in place, so first launch showed
 * a "Move to Applications?" prompt (`maybeOfferMoveToApplications`). The dmg
 * download made drag-to-Applications the install itself, so the prompt was
 * retired (260728). What remains is the post-move sweep:
 *
 * `app.moveToApplicationsFolder()` *copied* the bundle into /Applications and
 * relaunched from there, but it did NOT remove the source the user launched
 * from (under App Translocation it never even saw the real ~/Downloads copy).
 * The prompt dropped a one-shot sentinel before the move; on the relaunched
 * /Applications instance, `cleanupRelocationLeftover()` trashes the stray copy
 * (Trash, not unlink — reversible). It stays wired for one more release cycle
 * so a user whose LAST pre-dmg launch accepted the move still gets the
 * leftover cleaned after updating. With no prompt writing sentinels, it is a
 * no-op for everyone else and can be deleted once pre-dmg installs are gone.
 */
import { app, shell } from 'electron';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** One-shot marker written just before a move, consumed on the next launch. */
function cleanupSentinelPath(): string {
  return path.join(app.getPath('userData'), '.relocation-cleanup-pending');
}

/** The running app's `.app` bundle root, e.g. `/Applications/Sei.app`. */
function currentAppBundle(): string {
  // exe = <bundle>/Contents/MacOS/<name>  →  up three levels is the .app root.
  return path.resolve(app.getPath('exe'), '../../..');
}

/**
 * Trash the leftover copy the app was moved FROM, once it is safely running
 * from /Applications. Runs only when the one-shot sentinel from a prior
 * `maybeOfferMoveToApplications()` move is present, so an ordinary launch never
 * touches anything. Best-effort and fully guarded — it must never block or
 * crash startup.
 *
 * Safety rules for what may be trashed:
 *   - basename must equal OUR bundle name (`Sei.app`) — never `Sei Launcher.app`
 *     or any other bundle that happens to share the `com.sei.app` id.
 *   - never the running /Applications copy, and never anything under
 *     /Applications at all (those are real installs, not leftovers).
 *   - never a translocation mount (read-only; macOS reaps it on unmount).
 *   - only copies under the user's home dir (the unzip-to-Downloads case).
 * Items go to the Trash (reversible), not unlink.
 */
export function cleanupRelocationLeftover(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return;

  const sentinel = cleanupSentinelPath();
  let recordedSource = '';
  try {
    if (!existsSync(sentinel)) return;
    recordedSource = readFileSync(sentinel, 'utf8').trim();
  } catch {
    return;
  }
  // One-shot: consume the sentinel up front no matter how the rest goes.
  try { unlinkSync(sentinel); } catch {}

  // Only clean up once we are actually in /Applications (the move succeeded).
  try {
    if (!app.isInApplicationsFolder()) return;
  } catch {
    return;
  }

  const appBundle = currentAppBundle();          // /Applications/Sei.app
  const bundleName = path.basename(appBundle);   // 'Sei.app'
  const home = os.homedir();

  const isStrayLeftover = (candidate: string): boolean => {
    const resolved = path.resolve(candidate);
    if (resolved === appBundle) return false;                    // our canonical copy
    if (path.basename(resolved) !== bundleName) return false;    // a different bundle (e.g. Sei Launcher.app)
    if (resolved.includes('/AppTranslocation/')) return false;   // read-only, auto-reaped
    if (resolved.startsWith('/Applications/')) return false;     // a real install — leave it
    if (!resolved.startsWith(home + path.sep)) return false;     // only clean leftovers under the user's home
    return existsSync(resolved);
  };

  const trash = (candidate: string): void => {
    if (!isStrayLeftover(candidate)) return;
    const resolved = path.resolve(candidate);
    shell
      .trashItem(resolved)
      .then(() => console.log(`relocate: trashed leftover copy at ${resolved}`))
      .catch((e: unknown) => console.warn(`relocate: could not trash ${resolved}: ${(e as Error).message}`));
  };

  // 1) The exact path we recorded before the move (covers the non-translocated
  //    case directly), and the overwhelmingly common unzip target.
  trash(recordedSource);
  trash(path.join(home, 'Downloads', bundleName));

  // 2) Spotlight sweep for any other stray Sei.app under the home dir (handles
  //    copies the user unzipped somewhere other than Downloads). Best-effort:
  //    if Spotlight is disabled or slow this simply finds nothing.
  execFile('mdfind', [`kMDItemFSName == "${bundleName}"`], { timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return;
    for (const line of stdout.split('\n')) {
      const p = line.trim();
      if (p) trash(p);
    }
  });
}
