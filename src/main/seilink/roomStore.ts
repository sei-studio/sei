/**
 * SeiLink room store (261104, host pass): one RoomState JSON per companion
 * at <profileRoot>/seilink/rooms/<characterId>.json, a few KB. A companion
 * with no file has the default room (defaultRoomState: cozy, clock time,
 * every slot on its default part, no items).
 *
 * Every read is sanitized against the preset's pack manifest
 * (sanitizeRoomState), so a stale file (a part a newer pack removed) or a
 * hand-edited one can never reach the renderer or the AI with ids that do
 * not exist. A write is sanitized the same way before it lands, and needs
 * the preset's pack installed (a state cannot be checked without it).
 *
 * `roomSource` is the RoomSource the AI side (roomContext.ts) reads.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';
import { defaultRoomState, ROOM_TIMES, type RoomState } from '../../shared/seilinkRoom';
import { isRoomPresetId, sanitizeRoomState } from '../../shared/seilinkValidate';
import type { SeilinkRoomPayload } from '../../shared/seilinkPack';
import { paths } from '../paths';
import { trackScopedWrite } from '../profile/scopeBarrier';
import { loadPack, publicPack } from './packs';
import { seilinkEnabled, seilinkResident } from './gate';
import { reportRoomError } from './seilinkErrors';
import type { RoomContext, RoomSource } from './types';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A room file is a few KB; anything far bigger is not ours. */
const ROOM_FILE_MAX_BYTES = 256 * 1024;

export function isRoomCharacterId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

async function readRaw(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > ROOM_FILE_MAX_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Preset + time only, for a state whose pack is not installed (nothing else can be checked). */
function coarseState(raw: unknown): RoomState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const state = defaultRoomState(isRoomPresetId(r.preset) ? r.preset : 'cozy');
  if (r.time === 'auto' || (typeof r.time === 'string' && (ROOM_TIMES as readonly string[]).includes(r.time))) {
    state.time = r.time as RoomState['time'];
  }
  return state;
}

/** Her room and her preset's pack (null while it is not installed). */
export async function getRoomPayload(characterId: string): Promise<SeilinkRoomPayload> {
  if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
  const raw = await readRaw(paths.seilinkRoomPath(characterId));
  const preset = coarseState(raw).preset;
  const pack = await loadPack(preset);
  // 261105: her preset's pack is not installed (a broken install for the bundled cozy room).
  if (!pack) reportRoomError('read', new Error('SEILINK_PACK_MISSING'));
  const state = pack ? sanitizeRoomState(pack.manifest, raw ?? defaultRoomState(preset)) : coarseState(raw);
  return { characterId, state, pack: pack ? publicPack(pack) : null, saved: raw !== null };
}

export async function getRoomState(characterId: string): Promise<RoomState> {
  return (await getRoomPayload(characterId)).state;
}

const listeners = new Set<(characterId: string) => void>();

export function onRoomChange(cb: (characterId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitChange(characterId: string): void {
  for (const cb of listeners) {
    try {
      cb(characterId);
    } catch (err) {
      console.warn(`[seilink] room change listener: ${(err as Error).message}`);
    }
  }
}

/**
 * Save her room. `raw` is sanitized against its preset's pack; the saved
 * (clean) state is returned. Throws SEILINK_BAD_ID / SEILINK_PACK_MISSING.
 */
export async function setRoomState(characterId: string, raw: unknown): Promise<RoomState> {
  try {
    return await setRoomStateNow(characterId, raw);
  } catch (err) {
    // 261105: seilink_room_error {op: write, error_class} (the class only, never the message).
    reportRoomError('write', err);
    throw err;
  }
}

async function setRoomStateNow(characterId: string, raw: unknown): Promise<RoomState> {
  if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
  // The path is fixed before any await, so an account switch in the gap
  // still lands this write in the account it began in.
  const file = paths.seilinkRoomPath(characterId);
  const preset = coarseState(raw).preset;
  const pack = await loadPack(preset);
  if (!pack) throw new Error(`SEILINK_PACK_MISSING: no pack for preset ${preset}`);
  const state = sanitizeRoomState(pack.manifest, raw);
  await trackScopedWrite(
    withFileLock(file, async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(file, JSON.stringify(state));
    }),
  );
  emitChange(characterId);
  return state;
}

/**
 * What the AI side reads (roomContext.ts). null unless SeiLink is on AND she
 * is the companion who moved in, with her host session open
 * (gate.seilinkResident): the cozy pack ships with the app (M4), so without
 * this gate every companion of every Labs user would get a room line and
 * look() on every turn, for a room they do not live in. Also null when her
 * preset's pack is not installed.
 */
export const roomSource: RoomSource = {
  async getRoom(characterId: string): Promise<RoomContext | null> {
    if (!isRoomCharacterId(characterId)) return null;
    if (!seilinkEnabled() || seilinkResident() !== characterId) return null;
    const raw = await readRaw(paths.seilinkRoomPath(characterId));
    const preset = coarseState(raw).preset;
    const pack = await loadPack(preset);
    if (!pack) return null;
    return { manifest: pack.manifest, state: sanitizeRoomState(pack.manifest, raw ?? defaultRoomState(preset)), packDir: pack.dir };
  },
  onChange: onRoomChange,
};
