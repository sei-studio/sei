/**
 * Her face for a SeiLink desktop line (261105, T332).
 *
 * The desktop avatar shows the expression her line already carries, the
 * same way the app's call overlay does, at zero added tokens:
 *  - a face tag the line led with (`[happy] ...`), read by main with her
 *    pack palette. Only the facepack dev flag adds the FACE prompt block,
 *    so production lines carry none;
 *  - otherwise the spoken-line lexicon (classifyEmotion), which is what the
 *    call overlay uses in every build.
 *
 * Two outputs, one per view kind:
 *  - `emotion`: the closed AvatarEmotion set, for her imported Live2D model
 *    (mapped through its manifest's emotion table by Live2DView);
 *  - `face`: a face-vocabulary word for her face set (anima pack or dev
 *    facepack), resolved against the pack by FacepackView (cueExpression).
 * The portrait cutout has no face, so it ignores both.
 */
import type { AvatarEmotion } from './ipc';
import { classifyEmotion } from './avatarEmotion';
import { resolveExpression } from '../bot/brain/faceExpressions.js';

export interface LineFace {
  emotion: AvatarEmotion | null;
  face: string | null;
}

const EMOTIONS: readonly AvatarEmotion[] = ['happy', 'sad', 'shy', 'angry', 'love', 'excited', 'surprised'];

export function isAvatarEmotion(v: unknown): v is AvatarEmotion {
  return typeof v === 'string' && (EMOTIONS as readonly string[]).includes(v);
}

/** Lexicon emotion -> the face set's word (shy, angry and love have no face of their own). */
export const EMOTION_FACE: Readonly<Record<AvatarEmotion, string>> = {
  happy: 'happy',
  sad: 'sad',
  shy: 'embarrassed',
  angry: 'annoyed',
  love: 'happy',
  excited: 'excited',
  surprised: 'surprised',
};

/**
 * Face word -> the Live2D emotion it reads as. Faces with no counterpart
 * (neutral, thinking, sleepy, deadpan) are null: the model keeps its face.
 */
const FACE_EMOTION: Readonly<Record<string, AvatarEmotion>> = {
  happy: 'happy',
  laugh: 'happy',
  smirk: 'happy',
  smug: 'happy',
  excited: 'excited',
  surprised: 'surprised',
  sad: 'sad',
  worried: 'sad',
  resigned: 'sad',
  embarrassed: 'shy',
  pout: 'angry',
  annoyed: 'angry',
};

/** A face word is one plain lowercase word (the shape every vocabulary and pack name has). */
export function isFaceWord(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z]{1,24}$/.test(v);
}

/**
 * The face one desktop line carries. `tag` is the face tag read off the raw
 * line (already mapped onto her palette), or null.
 */
export function desktopLineFace(text: string, tag: string | null = null): LineFace {
  if (isFaceWord(tag)) {
    const base = resolveExpression(tag) ?? tag;
    return { emotion: FACE_EMOTION[base] ?? FACE_EMOTION[tag] ?? null, face: tag };
  }
  const emotion = classifyEmotion(text);
  return { emotion, face: emotion ? EMOTION_FACE[emotion] : null };
}
