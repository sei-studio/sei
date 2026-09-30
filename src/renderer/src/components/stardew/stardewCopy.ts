/**
 * Shared copy helpers for the Stardew surfaces: the install progress line
 * and the ErrorClass lookup for a failed install. Pure; tested.
 */
import type { StardewInstallProgressEvent } from '@shared/stardewIpc';
import type { ErrorClass } from '@shared/errorClasses';
import { ERROR_COPY } from '../../lib/errors';

/** English key for the progress stage (translated by the caller's t()). */
export function progressLine(ev: StardewInstallProgressEvent | null): { key: string; pct: number | null } {
  if (!ev) return { key: 'Preparing...', pct: null };
  switch (ev.stage) {
    case 'queued':
    case 'detecting':
      return { key: 'Looking for Stardew Valley...', pct: null };
    case 'smapi-downloading':
      return { key: 'Downloading SMAPI... {pct}%', pct: ev.pct };
    case 'smapi-installing':
      return { key: 'Installing SMAPI...', pct: null };
    case 'mod-placing':
      return { key: 'Adding the Sei companion mod...', pct: null };
    case 'config-writing':
      return { key: 'Writing the companion settings...', pct: null };
    case 'done':
      return { key: 'Setup complete', pct: 100 };
    case 'failed':
      return { key: 'Setup failed', pct: null };
  }
}

/** "SMAPI_INSTALL_FAILED: detail" -> the ERROR_COPY line for that class, plus the detail. */
export function installErrorCopy(message: string | null): { copy: string; detail: string } | null {
  if (!message) return null;
  const m = /^([A-Z_]+):\s*(.*)$/s.exec(message);
  const cls = (m?.[1] ?? '') as ErrorClass;
  const detail = m ? m[2] : message;
  const copy = (ERROR_COPY as Record<string, string>)[cls] ?? ERROR_COPY.GAME_INSTALL_FAILED;
  return { copy, detail };
}

/** The one-time Steam achievements note is per install, not per account. */
export const ACHIEVEMENTS_NOTE_KEY = 'sei:stardew-achievements-note:v1';

export function achievementsNoteSeen(): boolean {
  try {
    return localStorage.getItem(ACHIEVEMENTS_NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markAchievementsNoteSeen(): void {
  try {
    localStorage.setItem(ACHIEVEMENTS_NOTE_KEY, '1');
  } catch {
    /* storage unavailable: show it again next time, which is harmless */
  }
}
