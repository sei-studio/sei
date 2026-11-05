/**
 * Decorating her room together (261105, T336): what main knows about an open
 * companion room editor, for her turns. Free of electron and the host so
 * chatService can import it; the timers and the live line are in
 * decorateTogether.ts.
 *
 * One session per open editor (its token). It keeps:
 *  - `live`: the room as it is in the editor right now, unsaved edits included
 *    (seilink:editor-sync). roomForSurface returns it for her (liveRoomFor),
 *    so a call turn, a typed turn, a live line and look() all see the room
 *    the player is looking at, not the saved file.
 *  - `seen`: the room as it was when she last said something about it (a live
 *    line, a chat or call turn that carried the change list, her own edits).
 *    Live lines and the closing line diff against it, so she never comments
 *    twice on the same change.
 *  - `turnSeen`: what the last turn's change note covered (the per-turn note
 *    lists only what is new since).
 *  - `pictureSeen` / `pictureAt`: the room in the last picture she got on a
 *    call, and when (the call-picture rule: only when changed, at most one per
 *    PICTURE_GAP_MS).
 *
 * The decorate tool (shared/seilinkDecorate.ts) rides her tool list while a
 * session is open, on every turn kind (cache parity, see chatTools), and is
 * run here against `live`. Her ops go to the editor through the sink.
 */
import { randomUUID } from 'node:crypto';
import { loadAnalytics } from '../lazyAnalytics';
import { sameState } from '../../shared/seilinkEdit';
import { roomChangeBucket, roomChangeLine, roomChanges, ROOM_CHANGE_LIST_MAX, type RoomChange } from '../../shared/seilinkRoomDiff';
import {
  DECORATE_MAX_CHANGES,
  DECORATE_TOOL_NAME,
  decorateResultText,
  decorateTool,
  resolveDecorate,
  roomNowLine,
  type DecorateResult,
  type RoomEditOp,
} from '../../shared/seilinkDecorate';
import type { RoomPresetManifest } from '../../shared/seilinkRoom';
import type { SeilinkEditorEvent, SeilinkEditorCount } from '../../shared/seilinkTogether';
import { clearUnseenBaseline, unseenBaseline, type RoomSnapshot } from './roomChangeNote';
import type { RoomContext } from './types';

export { DECORATE_TOOL_NAME };

/** No edits for this long: she may say a live line. */
export const LIVE_PAUSE_MS = 5_000;
/** At least this long between her live lines. */
export const LIVE_GAP_MS = 40_000;
/** Live lines per editor session. */
export const LIVE_MAX_PER_SESSION = 4;
/** At most one call picture this often. */
export const PICTURE_GAP_MS = 20_000;
/** Open sessions kept at most. */
const MAX_SESSIONS = 4;

export interface TogetherSession {
  token: string;
  characterId: string;
  openedAt: number;
  live: RoomContext;
  seen: RoomSnapshot;
  turnSeen: RoomSnapshot;
  pictureSeen: RoomSnapshot;
  pictureAt: number | null;
  lastLiveAt: number | null;
  liveShown: number;
  lastEditAt: number | null;
  /** She was on a call when it opened (analytics). */
  openedOnCall: boolean;
  /** Live-line skip reasons already reported this session (one event each). */
  reportedSkips: Set<string>;
}

const sessions = new Map<string, TogetherSession>();
let sink: ((ev: SeilinkEditorEvent) => void) | null = null;
const toolCache = new Map<RoomPresetManifest, ReturnType<typeof decorateTool>>();

/** decorateTogether.ts: where her edits and the counters go (the editor window). */
export function setTogetherSink(next: ((ev: SeilinkEditorEvent) => void) | null): void {
  sink = next;
}

function emit(ev: SeilinkEditorEvent): void {
  try {
    sink?.(ev);
  } catch (err) {
    console.warn(`[seilink] editor event: ${(err as Error).message}`);
  }
}

/** A session counter for seilink_editor_session (the editor folds them in). */
export function countTogether(s: TogetherSession, key: SeilinkEditorCount): void {
  emit({ token: s.token, kind: 'count', key });
}

function snap(ctx: RoomSnapshot): RoomSnapshot {
  return { manifest: ctx.manifest, state: ctx.state };
}

function changesBetween(a: RoomSnapshot, b: RoomSnapshot): RoomChange[] {
  try {
    return roomChanges(a.manifest, a.state, b.manifest, b.state);
  } catch {
    return [];
  }
}

export function openTogether(token: string, characterId: string, room: RoomContext, opts: { now: number; onCall: boolean }): TogetherSession {
  const prev = sessions.get(token);
  if (prev) return prev;
  // A second editor for her (StrictMode remount, a second window): the newest wins.
  for (const [t, s] of sessions) if (s.characterId === characterId) sessions.delete(t);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  // Changes from earlier sessions she never heard about count as unseen here too.
  const base = unseenBaseline(characterId, opts.now);
  if (base) clearUnseenBaseline(characterId);
  const start = snap(room);
  const s: TogetherSession = {
    token,
    characterId,
    openedAt: opts.now,
    live: room,
    seen: base ?? start,
    turnSeen: base ?? start,
    pictureSeen: start,
    pictureAt: null,
    lastLiveAt: null,
    liveShown: 0,
    lastEditAt: null,
    openedOnCall: opts.onCall,
    reportedSkips: new Set(),
  };
  sessions.set(token, s);
  return s;
}

export function togetherByToken(token: string): TogetherSession | null {
  return sessions.get(token) ?? null;
}

/** Her open editor session, or null. */
export function togetherFor(characterId: string): TogetherSession | null {
  for (const s of sessions.values()) if (s.characterId === characterId) return s;
  return null;
}

/** The editor's room changed (unsaved). Returns the session when the room really changed, else null. */
export function syncTogether(token: string, room: RoomContext, now: number): TogetherSession | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (sameState(s.live.state, room.state)) return null;
  s.live = room;
  s.lastEditAt = now;
  return s;
}

export function closeTogether(token: string): TogetherSession | null {
  const s = sessions.get(token) ?? null;
  sessions.delete(token);
  return s;
}

/** roomForSurface: the room as it is in her open editor, over the saved one. */
export function liveRoomFor(characterId: string, saved: RoomContext): RoomContext {
  const s = togetherFor(characterId);
  return s ? s.live : saved;
}

/** What changed since she last said something about her room. */
export function unseenChanges(s: TogetherSession): RoomChange[] {
  return changesBetween(s.seen, s.live);
}

/**
 * She just said something about the room as it is now (a turn that carried
 * the change list, her own edits). It also counts against the live-line gap:
 * no live line right after her reply.
 */
export function markSeen(s: TogetherSession, now: number): void {
  s.seen = snap(s.live);
  s.turnSeen = snap(s.live);
  s.lastLiveAt = now;
}

// ── live lines ──────────────────────────────────────────────────────────

export type LiveSkip =
  | 'no_change'
  | 'on_call'
  | 'in_game'
  | 'not_resident'
  | 'busy'
  | 'cap'
  | 'cooldown'
  | 'budget'
  | 'silence'
  | 'error';

/** Why no live line now, or null when she may say one. `retryInMs`: try again then. Pure. */
export function liveLineBlock(s: {
  changes: number;
  resident: boolean;
  onCall: boolean;
  inGame: boolean;
  busy: boolean;
  shown: number;
  lastAt: number | null;
  lastEditAt: number | null;
  now: number;
}): { skip: LiveSkip; retryInMs?: number } | null {
  if (s.changes === 0) return { skip: 'no_change' };
  if (!s.resident) return { skip: 'not_resident' };
  if (s.onCall) return { skip: 'on_call' };
  if (s.inGame) return { skip: 'in_game' };
  if (s.shown >= LIVE_MAX_PER_SESSION) return { skip: 'cap' };
  if (s.lastEditAt !== null && s.now - s.lastEditAt < LIVE_PAUSE_MS) return { skip: 'busy', retryInMs: LIVE_PAUSE_MS - (s.now - s.lastEditAt) };
  if (s.lastAt !== null && s.now - s.lastAt < LIVE_GAP_MS) return { skip: 'cooldown', retryInMs: LIVE_GAP_MS - (s.now - s.lastAt) };
  if (s.busy) return { skip: 'busy', retryInMs: 3_000 };
  return null;
}

/** The note for a live line (sendDesktopLineTurn, kind 'react'). */
export function liveLineNote(changes: RoomChange[]): string {
  return (
    '[System note, not the player speaking: the player has your room editor open and is decorating your room while you watch. ' +
    `What they just changed: ${roomChangeLine(changes, ROOM_CHANGE_LIST_MAX)}. ` +
    'You can say one short line about it, under twelve words, in your own voice, as a small speech bubble next to you. ' +
    'Or reply with exactly (silence) if there is nothing worth saying yet. Do not mention this note.]'
  );
}

// ── her turns while the editor is open ──────────────────────────────────

/** Her decorate tool for this turn, or null (no editor open for her). Same object per pack, for the cache prefix. */
export function decorateToolFor(characterId: string, room: RoomContext | null): ReturnType<typeof decorateTool> | null {
  if (!room) return null;
  const s = togetherFor(characterId);
  if (!s) return null;
  const m = s.live.manifest;
  let t = toolCache.get(m);
  if (!t) {
    t = decorateTool(m);
    toolCache.set(m, t);
  }
  return t;
}

/**
 * The note for one of her turns while the editor is open (after the cache
 * breakpoint): that they are decorating together, what changed since her last
 * turn, and what is in the room now. '' when no editor is open for her.
 * Advances what she has seen.
 */
export function editorTurnNote(characterId: string, opts: { now: number; onCall: boolean }): string {
  const s = togetherFor(characterId);
  if (!s) return '';
  const changes = changesBetween(s.turnSeen, s.live);
  const changed = changes.length ? `What they changed since your last turn: ${roomChangeLine(changes, ROOM_CHANGE_LIST_MAX)}. ` : '';
  if (changes.length) markSeen(s, opts.now);
  else s.turnSeen = snap(s.live);
  return (
    `[System note, not the player speaking: the player has your room editor open and you are decorating your room together${opts.onCall ? ' while you talk' : ''}. ` +
    changed +
    `In your room now: ${roomNowLine(s.live.manifest, s.live.state)}. ` +
    'If they ask you to change something or to have a go, use decorate, then say a short line about it. Do not mention this note.]'
  );
}

export type PictureDecision = 'send' | 'skipped_unchanged' | 'rate_limited' | 'none';

/**
 * A call turn while the editor is open: does she get a fresh picture of the
 * room? Only when the room changed since the last picture she saw, and at
 * most one per PICTURE_GAP_MS. 'none' = no editor open, or she cannot see.
 */
export function callPictureDecision(characterId: string, opts: { now: number; vision: 'yes' | 'no' | 'unknown' }): PictureDecision {
  const s = togetherFor(characterId);
  if (!s || opts.vision === 'no') return 'none';
  if (changesBetween(s.pictureSeen, s.live).length === 0) {
    countTogether(s, 'call_picture_skipped_unchanged');
    return 'skipped_unchanged';
  }
  if (s.pictureAt !== null && opts.now - s.pictureAt < PICTURE_GAP_MS) {
    countTogether(s, 'call_picture_rate_limited');
    return 'rate_limited';
  }
  return 'send';
}

/** The picture went out (it showed `room`). */
export function notePictureSent(characterId: string, room: RoomSnapshot, now: number): void {
  const s = togetherFor(characterId);
  if (!s) return;
  s.pictureSeen = snap(room);
  s.pictureAt = now;
  countTogether(s, 'call_pictures');
}

/** Her decorate() call: resolved against the editor's room, applied there (or offered as a suggestion). */
export function runDecorate(
  characterId: string,
  input: unknown,
  opts: { now: number; budgetLeft?: number; surface?: 'chat' | 'call' },
): { result: DecorateResult | null; text: string } {
  const s = togetherFor(characterId);
  if (!s) return { result: null, text: 'Your room editor is closed now, so nothing changed. Tell the player you can do it next time they open it.' };
  const max = Math.max(0, Math.min(DECORATE_MAX_CHANGES, opts.budgetLeft ?? DECORATE_MAX_CHANGES));
  if (max === 0) return { result: null, text: `You already made ${DECORATE_MAX_CHANGES} changes this turn. Say your line now.` };
  const r = resolveDecorate(s.live.manifest, s.live.state, (input ?? {}) as Record<string, unknown>, max);
  reportHerEdit(s, r, opts.surface ?? 'chat');
  if (r.ops.length) {
    const ops: RoomEditOp[] = r.ops;
    emit({ token: s.token, kind: 'edits', id: randomUUID(), mode: r.mode, ops, changes: r.done.length });
    if (r.mode === 'apply') {
      s.live = { ...s.live, state: r.state };
      markSeen(s, opts.now);
    }
  }
  return { result: r, text: decorateResultText(r) };
}

export const SEILINK_HER_EDIT_EVENT = 'seilink_her_edit';

/** seilink_her_edit {outcome applied/suggested/rejected, changes, rejected (buckets), surface}: shape only. */
function reportHerEdit(s: TogetherSession, r: DecorateResult, surface: 'chat' | 'call'): void {
  const outcome = r.ops.length === 0 ? 'rejected' : r.mode === 'suggest' ? 'suggested' : 'applied';
  countTogether(s, outcome === 'applied' ? 'her_edits_applied' : outcome === 'suggested' ? 'her_edits_suggested' : 'her_edits_rejected');
  const props = {
    character_id: s.characterId,
    outcome,
    changes: roomChangeBucket(r.ops.length),
    rejected: roomChangeBucket(r.rejected.length),
    surface,
  };
  void loadAnalytics()
    .then((a) => a.capture(SEILINK_HER_EDIT_EVENT, props))
    .catch(() => {});
}

/** Tests. */
export function __resetTogetherForTest(): void {
  sessions.clear();
  toolCache.clear();
  sink = null;
}
