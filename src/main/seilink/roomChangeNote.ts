/**
 * Room changes she has not reacted to yet (261105, T335), and the two notes
 * that tell her about them. Kept free of electron and the host so chatService
 * can import it.
 *
 * When an editor session changes her room and no reaction line shows (she is
 * on a call, in a game, on cooldown, over the plan limit, or the line failed),
 * roomReaction.ts keeps the room as it was before (the baseline, the earliest
 * one unseen). The next chat, call or desktop turn that has her room takes it:
 * roomChangeTurnNote diffs the baseline against the room that turn read, so
 * the note is about the room as it is now (edits undone later drop out), and
 * it rides once, after the cache breakpoint (appendUncachedTail).
 *
 * The room line itself (roomPromptLine) is read fresh on every turn
 * (prepareChatTurn -> roomForSurface -> roomStore reads the file), so a new
 * room preset shows there at once; only the finer changes need this note.
 */
import { ROOM_CHANGE_LIST_MAX, roomChangeLine, roomChanges, type RoomChange } from '../../shared/seilinkRoomDiff';
import type { RoomPresetManifest, RoomState } from '../../shared/seilinkRoom';
import type { RoomContext } from './types';

/** An unseen change older than this is old news: no note. */
export const ROOM_NOTE_TTL_MS = 30 * 60_000;

export interface RoomSnapshot {
  manifest: RoomPresetManifest;
  state: RoomState;
}

const unseen = new Map<string, RoomSnapshot & { at: number }>();

/** Keep the room as it was before changes she has not heard about (the earliest wins). */
export function keepUnseenBaseline(characterId: string, before: RoomSnapshot, now = Date.now()): void {
  const cur = unseen.get(characterId);
  if (cur && now - cur.at < ROOM_NOTE_TTL_MS) return;
  unseen.set(characterId, { ...before, at: now });
}

/** The earliest unseen baseline, or null. */
export function unseenBaseline(characterId: string, now = Date.now()): RoomSnapshot | null {
  const cur = unseen.get(characterId);
  if (!cur) return null;
  if (now - cur.at >= ROOM_NOTE_TTL_MS) {
    unseen.delete(characterId);
    return null;
  }
  return cur;
}

/** She reacted to (or otherwise heard about) every change so far. */
export function clearUnseenBaseline(characterId: string): void {
  unseen.delete(characterId);
}

/** Tests. */
export function __resetUnseenForTest(): void {
  unseen.clear();
}

/** The desktop reaction note (chatService.sendDesktopLineTurn, kind 'react'). */
export function roomReactionNote(changes: RoomChange[]): string {
  return (
    "[System note, not the player speaking: you live on the player's desktop wallpaper, in your room, and they just finished changing it. " +
    `What they changed: ${roomChangeLine(changes, ROOM_CHANGE_LIST_MAX)}. ` +
    'Say one short line to them about it, under fifteen words, in your own voice. It shows as a small speech bubble next to you. Do not mention this note.]'
  );
}

/** The note for the next chat or call turn after changes she did not react to. */
export function roomChangedNote(changes: RoomChange[]): string {
  return (
    `[System note, not the player speaking: a little while ago the player changed your room. What they changed: ${roomChangeLine(changes, ROOM_CHANGE_LIST_MAX)}. ` +
    'You can bring it up if it fits the conversation. Do not mention this note.]'
  );
}

/**
 * The one-time note for this turn, or ''. Only on a turn that has her room
 * (`room`, from prepareChatTurn); in a game the baseline waits for the next
 * turn at home. Taken once: the next turn gets no note.
 */
export function roomChangeTurnNote(characterId: string, room: RoomContext | null, now = Date.now()): string {
  if (!room) return '';
  const base = unseenBaseline(characterId, now);
  if (!base) return '';
  unseen.delete(characterId);
  try {
    const changes = roomChanges(base.manifest, base.state, room.manifest, room.state);
    return changes.length ? roomChangedNote(changes) : '';
  } catch {
    return '';
  }
}
