/**
 * Decorating her room together (261105, T336): what crosses IPC between the
 * companion room editor and main. See src/main/seilink/editorTogether.ts.
 */
import type { RoomEditOp } from './seilinkDecorate';
import type { RoomState } from './seilinkRoom';

/** Session counters main sends to the editor for seilink_editor_session. */
export const TOGETHER_COUNTS = [
  'live_lines',
  'call_pictures',
  'call_picture_skipped_unchanged',
  'call_picture_rate_limited',
  'her_edits_applied',
  'her_edits_suggested',
  'her_edits_rejected',
] as const;
export type SeilinkEditorCount = (typeof TOGETHER_COUNTS)[number];

export function isTogetherCount(k: unknown): k is SeilinkEditorCount {
  return typeof k === 'string' && (TOGETHER_COUNTS as readonly string[]).includes(k);
}

/** Push main -> editor (seilink:editor-event). `token` = the editor session. */
export type SeilinkEditorEvent =
  /** Her decorate() call: apply the ops as ONE undo step, or offer them ('suggest'). */
  | { token: string; kind: 'edits'; id: string; mode: 'apply' | 'suggest'; ops: RoomEditOp[]; changes: number }
  | { token: string; kind: 'count'; key: SeilinkEditorCount };

/** Send editor -> main (seilink:editor-sync): the room as it is in the editor now, unsaved. */
export interface SeilinkEditorSync {
  token: string;
  characterId: string;
  state: RoomState;
}
