/**
 * Her face on the desktop for one line (261105, T332). Main sets `emotion`
 * (Live2D) and `face` (her face set's word) on each desktop line from the
 * face tag it led with or its words (shared/seilinkExpression.ts); the page
 * holds them for the line:
 *  - `emotion` only while she says it (speakMs). Live2DView then lingers on
 *    it for half the line and decays to neutral itself, as on a call.
 *  - `face` until lineFaceHoldMs, then 'neutral'. FacepackView's own
 *    timeline may decay a strong face (laugh, surprised...) sooner, as in
 *    the app.
 * The portrait cutout has no face and ignores both.
 */
import type { AvatarEmotion } from '@shared/ipc';
import { bubbleMs, speakMs } from './HostDock';

export interface HostAvatarLook {
  emotion: AvatarEmotion | null;
  /** A face-set word, or null before her first line (the pack's default face). */
  face: string | null;
  /** Bumped on each new look, so the same face twice re-arms the view's timing. */
  seq: number;
}

export const NEUTRAL_LOOK: HostAvatarLook = { emotion: null, face: null, seq: 0 };

/** How long her face holds for a line: while the bubble is up, and at least half the line past its end. */
export function lineFaceHoldMs(text: string): number {
  return Math.max(bubbleMs(text), Math.round(speakMs(text) * 1.5));
}

/** Back to her resting face (a no-op when nothing is showing). */
export function toNeutral(l: HostAvatarLook): HostAvatarLook {
  if (!l.emotion && (l.face === null || l.face === 'neutral')) return l;
  return { emotion: null, face: l.face === null ? null : 'neutral', seq: l.seq + 1 };
}

// ── her voice from a call (261110) ──────────────────────────────────────────

/** A call audio level relayed from the main window, and its performance.now() time. */
export interface VoiceLevel {
  level: number;
  at: number;
}

/** A call level older than this no longer moves her mouth (levels arrive every ~50 ms while audio plays). */
export const VOICE_LEVEL_FRESH_MS = 250;

/** The mouth level: a fresh call level wins, else the syllable envelope. */
export function mouthLevel(voice: VoiceLevel | undefined, syllable: number, now: number): number {
  if (voice && voice.at > 0 && now - voice.at < VOICE_LEVEL_FRESH_MS) return Math.max(0, Math.min(1, voice.level));
  return syllable;
}
