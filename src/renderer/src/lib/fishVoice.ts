/**
 * Fish Audio (261103), renderer side: the copy for a Fish failure, shared by
 * the Settings Test button and a character's own-voice field.
 */
import type { FishFailureReason } from '@shared/fishVoices';

type T = (en: string, params?: Record<string, string | number>) => string;

export function fishReasonText(reason: FishFailureReason | 'invalid-link', t: T): string {
  switch (reason) {
    case 'no-key':
      return t('Add your Fish Audio key first.');
    case 'key-invalid':
      return t('Fish Audio rejected this key.');
    case 'no-credit':
      return t('Fish Audio refused the free model. It may have ended, or your account needs credit.');
    case 'busy':
      return t('Fish Audio is busy. Try again in a moment.');
    case 'voice-missing':
      return t('That voice was not found on Fish Audio.');
    case 'invalid-link':
      return t('That is not a Fish Audio voice link.');
    case 'failed':
      return t('Could not reach Fish Audio. Check your connection.');
  }
}

/** The audio type of clip bytes: a RIFF header is WAV (the Fast voices),
 * anything else mp3 (Fish Audio, ElevenLabs). */
export function clipMimeType(buf: ArrayBuffer): 'audio/wav' | 'audio/mpeg' {
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const riff = head.length === 4 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
  return riff ? 'audio/wav' : 'audio/mpeg';
}
