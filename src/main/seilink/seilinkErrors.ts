/**
 * SeiLink error analytics (261105), shape only: an error CLASS from a closed
 * set, never the message, a path or a pack-relative file name.
 *
 *  - seilink_pack_error {pack_id, source, error_class}: a pack folder exists
 *    but cannot be used (manifest missing / too big / unreadable / invalid,
 *    id mismatch, a referenced file missing or outside the pack). Once per
 *    pack, source and class per app run. A preset with no folder at all is
 *    normal (not every room ships) and sends nothing.
 *  - seilink_room_error {op, error_class}: the room store could not save
 *    (or read for the editor) her room. Once per op and class per 10 min.
 */
import { loadAnalytics } from '../lazyAnalytics';

export type PackErrorClass =
  | 'manifest_missing'
  | 'manifest_too_big'
  | 'manifest_unreadable'
  | 'manifest_invalid'
  | 'id_mismatch'
  | 'file_missing';

export type SeilinkErrorClass =
  | 'bad_id'
  | 'pack_missing'
  | 'account_switching'
  | 'permission'
  | 'disk_full'
  | 'busy'
  | 'not_found'
  | 'read_only'
  | 'invalid'
  | 'other';

/** The class of an error from the room store or the fs under it. */
export function seilinkErrorClass(err: unknown): SeilinkErrorClass {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const msg = typeof e?.message === 'string' ? e.message : '';
  if (msg.startsWith('SEILINK_BAD_ID')) return 'bad_id';
  if (msg.startsWith('SEILINK_PACK_MISSING')) return 'pack_missing';
  if (code === 'ACCOUNT_SWITCHING' || msg.startsWith('ACCOUNT_SWITCHING')) return 'account_switching';
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk_full';
  if (code === 'EBUSY' || code === 'EAGAIN' || code === 'ETIMEDOUT') return 'busy';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  if (code === 'EROFS') return 'read_only';
  if (err instanceof SyntaxError || (e && (e as { name?: unknown }).name === 'ZodError')) return 'invalid';
  return 'other';
}

function capture(event: string, props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((a) => a.capture(event, props))
    .catch(() => {
      /* analytics is optional */
    });
}

const packSent = new Set<string>();

export function reportPackError(packId: string, source: string, errorClass: PackErrorClass): void {
  const key = `${source}:${packId}:${errorClass}`;
  if (packSent.has(key)) return;
  packSent.add(key);
  capture('seilink_pack_error', { pack_id: packId, source, error_class: errorClass });
}

export const ROOM_ERROR_QUIET_MS = 10 * 60_000;
const roomSent = new Map<string, number>();

export function reportRoomError(op: 'write' | 'read', err: unknown, now: number = Date.now()): SeilinkErrorClass {
  const errorClass = seilinkErrorClass(err);
  const key = `${op}:${errorClass}`;
  const at = roomSent.get(key);
  if (at === undefined || now - at >= ROOM_ERROR_QUIET_MS) {
    roomSent.set(key, now);
    capture('seilink_room_error', { op, error_class: errorClass });
  }
  return errorClass;
}

/** Tests. */
export function _resetSeilinkErrorsForTests(): void {
  packSent.clear();
  roomSent.clear();
}
