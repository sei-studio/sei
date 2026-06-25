/**
 * First-launch "Move to Applications" prompt (macOS only).
 *
 * Why this exists: the macOS build ships as a .zip (no .dmg), so people often
 * unzip into ~/Downloads and run the app right there. Gatekeeper then
 * "translocates" it — runs it from a read-only randomized mount — and
 * electron-updater cannot replace the bundle in place, so auto-update silently
 * breaks until the app lives in a normal writable location. Moving it to
 * /Applications fixes that (and clears translocation).
 *
 * Windows ships an NSIS installer that already installs to a permanent per-user
 * location (%LOCALAPPDATA%\Programs\Sei) with shortcuts, so there is nothing to
 * relocate — this function is a deliberate no-op off macOS (and in dev, where
 * the app is unpackaged and lives in the source tree).
 *
 * Returns `true` if a move was initiated — macOS quits + relaunches the app
 * from the new location, so the caller should stop further startup. Returns
 * `false` to continue launching from the current location.
 *
 * ── Self-delete after move ──────────────────────────────────────────────────
 * `app.moveToApplicationsFolder()` *copies* the bundle into /Applications and
 * relaunches from there, but it does NOT remove the source the user launched
 * from. Worse, under App Translocation the running bundle path is a read-only
 * /private/var/folders/.../AppTranslocation/... mount, so the API never even
 * sees the real ~/Downloads/Sei.app — the original is always left behind. To
 * keep things tidy we drop a one-shot sentinel before the move and, on the
 * relaunched /Applications instance, `cleanupRelocationLeftover()` trashes the
 * stray copy (Trash, not unlink — reversible).
 */
import { app, dialog, shell } from 'electron';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
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

export function maybeOfferMoveToApplications(): boolean {
  // Only packaged macOS builds that are not already in /Applications.
  if (process.platform !== 'darwin' || !app.isPackaged) return false;

  let inApplications = false;
  try {
    inApplications = app.isInApplicationsFolder();
  } catch {
    // API unavailable for some reason — never block launch over this.
    return false;
  }
  if (inApplications) return false;

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1,
    title: 'Move Sei to Applications?',
    message: 'Move to Applications folder?',
    detail:
      'Sei will need to move to receive future updates automatically. ' +
      'If you’d like, I can move myself there.',
  });
  if (choice !== 0) return false; // "No" — keep running from the current spot.

  const sentinel = cleanupSentinelPath();
  try {
    // Record where we are launching FROM so the relaunched copy can trash it.
    // Under translocation this is the read-only mount path (ignored later); the
    // post-move sweep finds the real ~/Downloads/Sei.app regardless.
    try {
      writeFileSync(sentinel, currentAppBundle(), 'utf8');
    } catch {
      /* best-effort — a missing sentinel just means no auto-cleanup */
    }

    // Copies the bundle into /Applications (prompting for admin auth if that
    // folder isn't writable), then quits + relaunches from the new location.
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === 'existsAndRunning') {
          // An older Sei is already OPEN from /Applications — can't replace it.
          dialog.showMessageBoxSync({
            type: 'info',
            buttons: ['OK'],
            message: 'Sei is already open from your Applications folder.',
            detail: 'Quit that copy first, then try moving this one again.',
          });
          return false; // abort the move
        }
        return true; // 'exists' but not running → replace the old copy
      },
    });

    // The move was aborted (e.g. conflict handler said no) — drop the sentinel
    // so we don't trash a perfectly good copy on the next ordinary launch.
    if (!moved) {
      try { unlinkSync(sentinel); } catch {}
    }
    return moved;
  } catch (err) {
    try { unlinkSync(sentinel); } catch {}
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Continue'],
      message: 'Couldn’t move Sei automatically.',
      detail:
        'You can move Sei to your Applications folder yourself (drag it there) ' +
        'so it can keep itself up to date.\n\n' +
        (err as Error).message,
    });
    return false; // continue launching from where we are
  }
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
