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
 */
import { app, dialog } from 'electron';

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

  try {
    // Copies the bundle into /Applications (prompting for admin auth if that
    // folder isn't writable), then quits + relaunches from the new location.
    return app.moveToApplicationsFolder({
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
  } catch (err) {
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
