/**
 * The "lives on your desktop" card's memory (261110, product call 261110):
 * it shows when the room first goes live (over the first link's last frame,
 * or in the app after a move-in without the intro) until it is dismissed,
 * once per account. localStorage per profile scope, like introPref: a lost
 * flag costs one more look at a short card.
 */
import type { SetupOs } from '@shared/seilinkSetupTelemetry';
import { profileScope } from './introPref';

const KEY_BASE = 'sei.seilinkLiveHint.v1';

/** True once the card was dismissed (Got it, Minimize, or the desktop shown) on this account. */
export function liveHintDismissed(): boolean {
  try {
    return localStorage.getItem(`${KEY_BASE}.${profileScope()}`) === '1';
  } catch {
    return false;
  }
}

export function markLiveHintDismissed(): void {
  try {
    localStorage.setItem(`${KEY_BASE}.${profileScope()}`, '1');
  } catch {
    /* private mode / quota: it may show once more */
  }
}

/** The OS the shortcut line is written for. */
export function liveHintOs(platform: string | undefined): SetupOs {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}
