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

/** Session counters the editor keeps itself. */
export const TOGETHER_RENDERER_COUNTS = ['talk_messages', 'talk_blocked', 'her_edits_undone', 'her_edits_tried'] as const;
export type TogetherRendererCount = (typeof TOGETHER_RENDERER_COUNTS)[number];
export type TogetherCount = SeilinkEditorCount | TogetherRendererCount;
export const ALL_TOGETHER_COUNTS: readonly TogetherCount[] = [...TOGETHER_COUNTS, ...TOGETHER_RENDERER_COUNTS];

/** Renderer events (sanitized in main, shape only). */
export const SEILINK_EDITOR_TALK_EVENT = 'seilink_editor_talk';
export const SEILINK_HER_EDIT_EVENT = 'seilink_her_edit';
export const EDITOR_TALK_OUTCOMES = ['sent', 'limit', 'error'] as const;
/** seilink_her_edit outcomes: main sends applied/suggested/rejected, the editor undone/tried. */
export const HER_EDIT_OUTCOMES = ['applied', 'suggested', 'rejected', 'undone', 'tried'] as const;

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
