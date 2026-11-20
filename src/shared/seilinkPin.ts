/**
 * WorldLink "pin on top" (261120, product call (261120)): the rules, pure.
 *
 * The always-on-top avatar overlay (main/callOverlay.ts, CallOverlay.tsx)
 * used to be a Settings > Appearance > Avatar choice open to everyone
 * (off / when active / always, `avatar_mode`). It is now part of WorldLink:
 *
 *  - Availability (the "unlock"): WorldLink runs on this install
 *    (`SeilinkAvailability.enabled`, gate.ts) AND a companion has moved in
 *    (her room session is open: `SeilinkHostStatus.characterId` with the
 *    host starting, running, restarting or failed). Nobody else ever sees the
 *    overlay or its control. The control is the pin button on her dock
 *    (HostDock), which only exists while she lives on the desktop.
 *  - Pinned: she leaves her room and floats over every window. The room
 *    stays (the wallpaper draws it without her); the overlay shows her.
 *    Unpinned: she is back in her room and the overlay is closed.
 *  - Never two of her: the overlay shows at most ONE companion, the pinned
 *    WorldLink one, and only while the app is not drawing her in her room
 *    itself (the room editor or the WorldLink intro for her). Calls, games,
 *    shares and summons never add anyone: a call with her shows her where
 *    she is (her room, or the overlay when pinned); any other companion on a
 *    call stays in the app's call screen only.
 *  - Persisted on the move-in (`seilink_moved_in.pinned`, main-owned), so a
 *    restart keeps it and a move-out or a new move-in starts unpinned.
 *  - The retired `avatar_mode` / `call_overlay_enabled` keys are never read:
 *    an old 'activity' or 'always' cannot bring the overlay up.
 */
import type { SeilinkHostStatus } from './seilinkHost';

/** Host states in which she still lives on the desktop (her move-in stands). */
const LIVES_THERE: ReadonlySet<SeilinkHostStatus['state']> = new Set(['starting', 'running', 'restarting', 'failed']);

/** The companion who lives in WorldLink right now (her move-in stands), or null. */
export function worldlinkCompanion(status: Pick<SeilinkHostStatus, 'state' | 'characterId'>): string | null {
  return status.characterId && LIVES_THERE.has(status.state) ? status.characterId : null;
}

/** Can this profile pin anyone? WorldLink runs here and someone lives in it. */
export function pinAvailable(i: { available: boolean; status: Pick<SeilinkHostStatus, 'state' | 'characterId'> }): boolean {
  return i.available && worldlinkCompanion(i.status) !== null;
}

export interface FloatingAvatarInputs {
  /** WorldLink runs on this install (SeilinkAvailability.enabled). Unknown yet = false. */
  available: boolean;
  status: Pick<SeilinkHostStatus, 'state' | 'characterId' | 'pinned'>;
  /** Companions the app is drawing in their room right now (her room editor, the WorldLink intro). */
  inRoomViews: readonly string[];
}

/**
 * Who the always-on-top overlay shows: [] or [the pinned WorldLink companion].
 * The only input the overlay's visibility has (CallOverlayPusher).
 */
export function floatingAvatarIds(i: FloatingAvatarInputs): string[] {
  if (!i.available || i.status.pinned !== true) return [];
  const id = worldlinkCompanion(i.status);
  if (!id || i.inRoomViews.includes(id)) return [];
  return [id];
}

/** The wallpaper draws her only while she is not pinned (the room itself always stays). */
export function roomShowsHer(pinned: boolean | undefined): boolean {
  return pinned !== true;
}

type MovedIn = { character_id: string; moved_in_at: number; pinned?: boolean } | null | undefined;

/**
 * The config write for a pin toggle (main, under updateConfig's lock): only
 * the move-in of THIS companion changes; anyone else's (a swap in the gap) or
 * none at all leaves the config as it is. `false` drops the key.
 */
export function withPinned<C extends { seilink_moved_in?: MovedIn }>(cfg: C, characterId: string, pinned: boolean): C {
  const m = cfg.seilink_moved_in;
  if (!m || m.character_id !== characterId) return cfg;
  if ((m.pinned === true) === pinned) return cfg;
  const { pinned: _drop, ...rest } = m;
  return { ...cfg, seilink_moved_in: pinned ? { ...rest, pinned: true } : rest };
}

/** The saved pin for this companion's move-in (a restore reads it). */
export function savedPinned(cfg: { seilink_moved_in?: MovedIn } | null | undefined, characterId: string): boolean {
  const m = cfg?.seilink_moved_in;
  return !!m && m.character_id === characterId && m.pinned === true;
}

// ── Analytics (shape only) ──────────────────────────────────────────────────

/** Where a pin toggle came from: her dock on the desktop, or the overlay's own unpin button. */
export const PIN_SOURCES = ['dock', 'overlay'] as const;
export type PinSource = (typeof PIN_SOURCES)[number];

export function isPinSource(v: unknown): v is PinSource {
  return typeof v === 'string' && (PIN_SOURCES as readonly string[]).includes(v);
}

/** How long she floated, bucketed (seilink_pin_ended.duration_bucket, avatar_overlay_shown.duration_bucket). */
export const PIN_DURATION_BUCKETS = ['lt1m', '1_5m', '5_30m', '30m_2h', '2_8h', 'gt8h'] as const;
export type PinDurationBucket = (typeof PIN_DURATION_BUCKETS)[number];

export function pinDurationBucket(ms: number): PinDurationBucket {
  const m = Number.isFinite(ms) ? Math.max(0, ms) / 60_000 : 0;
  if (m < 1) return 'lt1m';
  if (m < 5) return '1_5m';
  if (m < 30) return '5_30m';
  if (m < 120) return '30m_2h';
  if (m < 480) return '2_8h';
  return 'gt8h';
}

/**
 * Why a pin toggle did not take (seilink_pin_failed.failure_class): nobody
 * lives in WorldLink now (`not_moved_in`), WorldLink cannot run here
 * (`unavailable`), the config write failed (`config_write`).
 */
export const PIN_FAILURES = ['not_moved_in', 'unavailable', 'config_write'] as const;
export type PinFailure = (typeof PIN_FAILURES)[number];

/**
 * Why the overlay window failed (avatar_overlay_failed.failure_class): it
 * could not be created, its page did not load, its renderer died, or it was
 * only revealed by the wall-clock backstop (neither ready-to-show nor
 * did-finish-load came).
 */
export const OVERLAY_FAILURES = ['create_failed', 'load_failed', 'renderer_gone', 'reveal_backstop'] as const;
export type OverlayFailure = (typeof OVERLAY_FAILURES)[number];
