/**
 * Which characters the avatar overlay shows (260804) — the pure half of the
 * AvatarOverlayPusher, split out so the mode semantics are testable without
 * mounting stores.
 *
 * Order contract: call members first (join order, matching the call screen's
 * tiles), then non-call activity characters (stable input order), deduped.
 * 'always' with nothing active falls back to the open chat's character; an
 * app sitting on Home with nothing active shows nothing (there is no
 * defensible "pick one" from a whole roster).
 */
import type { AvatarMode } from '@shared/characterSchema';

export interface AvatarOverlayInputs {
  mode: AvatarMode;
  /** Voice-call members in join order ([] when no call). */
  callParticipants: string[];
  /** Characters with a live non-call surface (chess, Draw!, backseat share,
   * Minecraft summon), in any stable order. */
  activityIds: string[];
  /** Character of the open chat route, if any (the 'always' fallback). */
  openChatId: string | null;
}

export function computeAvatarIds(i: AvatarOverlayInputs): string[] {
  if (i.mode === 'off') return [];
  const out: string[] = [];
  for (const id of [...i.callParticipants, ...i.activityIds]) {
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0 && i.mode === 'always' && i.openChatId) return [i.openChatId];
  return out;
}
