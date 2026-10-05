/**
 * Menu bar / tray setting + refill-notification bookkeeping (261005).
 *
 * One small DEVICE-GLOBAL JSON file, `<userData>/tray-settings.json` (see
 * paths.traySettingsPath for why it is not in the per-profile config.json).
 * Main is the only writer, so an in-memory copy is the source of truth after
 * the first read and every write goes out through one serialized chain
 * (atomicWrite + withFileLock, the updateStateStore discipline).
 *
 * The first read is SYNCHRONOUS on purpose: whenReady has to know, before it
 * opens the splash or the window, whether this is a login launch that should
 * start hidden in the tray.
 *
 * Defensive parsing: a missing or corrupt file is the defaults (everything
 * off), never a boot failure.
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';
import { paths } from '../paths';

/** The credit wall an account hit, waiting for its weekly reset. */
export interface StoredWall {
  user_id: string;
  /** CreditsStatus.resets_at at the time of the wall (ISO). */
  resets_at: string;
  /** Plan at the wall, for the tray's status line wording. */
  plan?: 'free' | 'quest' | 'party';
}

export interface TrayState {
  /** Close-to-tray. Off by default. */
  enabled: boolean;
  /** Start hidden in the tray at login. Only acted on while `enabled`. */
  open_at_login: boolean;
  /** The one-time credit-wall prompt was shown. */
  wall_prompt_seen: boolean;
  /**
   * Sei itself registered the OS login item. Only then does it ever remove
   * one, so a login item the user added by hand survives (macOS 12).
   */
  login_item_registered: boolean;
  /** The wall to notify about when it resets, or null. */
  wall: StoredWall | null;
  /** resets_at of the last reset already notified (or deliberately skipped): once per reset. */
  notified_for: string | null;
}

export const DEFAULT_TRAY_STATE: TrayState = {
  enabled: false,
  open_at_login: false,
  wall_prompt_seen: false,
  login_item_registered: false,
  wall: null,
  notified_for: null,
};

/** Parse whatever is on disk into a TrayState. Unknown keys drop, bad values default. */
export function coerceTrayState(raw: unknown): TrayState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TRAY_STATE };
  const o = raw as Record<string, unknown>;
  const w = o.wall as Record<string, unknown> | null | undefined;
  const wall: StoredWall | null =
    w && typeof w === 'object' && typeof w.user_id === 'string' && w.user_id && typeof w.resets_at === 'string' && w.resets_at
      ? {
          user_id: w.user_id,
          resets_at: w.resets_at,
          ...(w.plan === 'free' || w.plan === 'quest' || w.plan === 'party' ? { plan: w.plan } : {}),
        }
      : null;
  return {
    enabled: o.enabled === true,
    open_at_login: o.open_at_login === true,
    wall_prompt_seen: o.wall_prompt_seen === true,
    login_item_registered: o.login_item_registered === true,
    wall,
    notified_for: typeof o.notified_for === 'string' && o.notified_for ? o.notified_for : null,
  };
}

let cache: TrayState | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Current state. The first call reads the file synchronously. */
export function getTrayState(): TrayState {
  if (cache) return cache;
  try {
    cache = coerceTrayState(JSON.parse(readFileSync(paths.traySettingsPath(), 'utf8')));
  } catch {
    cache = { ...DEFAULT_TRAY_STATE };
  }
  return cache;
}

/**
 * Apply `fn` to the current state, update the cache at once, and queue the
 * write. Resolves when this write is on disk (a failed write is logged and
 * swallowed: the in-memory state still holds for this run).
 */
export function updateTrayState(fn: (s: TrayState) => TrayState): Promise<TrayState> {
  const next = coerceTrayState(fn(getTrayState()));
  cache = next;
  const target = paths.traySettingsPath();
  const body = JSON.stringify(next, null, 2) + '\n';
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await withFileLock(target, async () => {
        await atomicWrite(target, body);
      });
    } catch (err) {
      console.warn(`[sei] tray state write failed: ${(err as Error).message}`);
    }
  });
  return writeChain.then(() => next);
}

/** Tests only: forget the cached copy so the next read hits the file. */
export function _resetTrayStateCacheForTest(): void {
  cache = null;
  writeChain = Promise.resolve();
}
