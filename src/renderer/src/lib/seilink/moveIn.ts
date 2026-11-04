/**
 * SeiLink move-in rules for the companion page (261104, M4). Pure, so the
 * page decides without loading the sheet (MoveInSheet is a lazy chunk).
 */
import type { SeilinkHostStatus } from '@shared/seilinkHost';
import type { RoomPresetId } from '@shared/seilinkRoom';

/** Room preset names (the English i18n keys). */
export const ROOM_PRESET_LABEL: Record<RoomPresetId, string> = { cozy: 'Cozy', gamer: 'Gamer', forest: 'Forest' };

/** Does moving her in need the sheet? Her first room, or someone else moves out. */
export function needsMoveInSheet(opts: { saved: boolean; movedInId: string | null; characterId: string }): boolean {
  if (!opts.saved) return true;
  return opts.movedInId !== null && opts.movedInId !== opts.characterId;
}

/** A start that came back without her on the desktop. */
export function moveInFailed(status: SeilinkHostStatus): boolean {
  return status.state === 'failed' || status.state === 'unsupported' || status.state === 'off';
}
