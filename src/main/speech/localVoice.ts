/**
 * ElevenLabs voiceId → local speech voice mapping (260816, china-compat W3+W4).
 *
 * Every character KEEPS `metadata.voiceId` as an ElevenLabs pool id — it is
 * the persisted, cloud-synced identity of the voice. Local TTS derives from it
 * only what a local voice can express: GENDER. The pool metadata (soulcaster
 * VOICES) carries gender for current voices; the 260707-curated legacy ids get
 * a static gender table here (transcribed from the section comments in
 * voice/voiceAssign.ts LEGACY_VOICE_IDS — that set is closed history, so a
 * table cannot drift).
 *
 * (gender, conversation language) → one of four local voice slots:
 *   en-f / en-m   vits-piper-en_US-libritts_r-medium (904 speakers, one pack)
 *   zh-f          vits-icefall-zh-aishell3
 *   zh-m          vits-piper-zh_CN-chaowen-medium int8
 *
 * Speaker id curation (260816, this machine, measured): median F0 estimated
 * by autocorrelation over synthesized samples of the same line.
 *   en-f  sid 90   (~186 Hz, clean female register in the sweep)
 *   en-m  sid 921  (~112 Hz, clean male register in the sweep)
 *   zh-f  sid 66   (~223 Hz; also the sherpa-onnx docs' demo speaker)
 *   zh-m  chaowen sid 0 (~150 Hz — pitch says male; HUMAN EAR-CHECK OWED
 *         before ship). Fallback: AISHELL3_MALE_REGISTER_SID below is the
 *         lowest-pitch aishell3 speaker, usable from the zh-f pack if chaowen
 *         fails the ear-check.
 * To change a speaker: edit LOCAL_VOICE_SPEC below (sid), nothing else — the
 * pack stays the same, no re-download.
 *
 * Only en and zh have local voices. Any other conversation language falls back
 * to the ENGLISH voice (it will read non-Latin text poorly; local TTS scope is
 * en+zh by decision — see .planning/china-compat-v07-260816.md W3+W4).
 */
import { VOICES } from 'soulcaster';
import type { SpeechPackId } from './packs';

export type LocalVoiceId = 'en-f' | 'en-m' | 'zh-f' | 'zh-m';

export type VoiceGender = 'female' | 'male';

export interface LocalVoiceSpec {
  packId: SpeechPackId;
  /** Speaker id inside the pack's model. */
  sid: number;
  /** Base speaking-rate nudge (sherpa `speed`; 1 = the model's natural pace).
   * Per-voice so a pack that reads unnaturally fast/slow at 1.0 can be
   * corrected here without touching the renderer's pitch path (pitchBus
   * playbackRate applies ON TOP of this, unchanged). */
  rate: number;
}

export const LOCAL_VOICE_SPEC: Record<LocalVoiceId, LocalVoiceSpec> = {
  'en-f': { packId: 'tts-en', sid: 90, rate: 1.0 },
  'en-m': { packId: 'tts-en', sid: 921, rate: 1.0 },
  'zh-f': { packId: 'tts-zh-f', sid: 66, rate: 1.0 },
  'zh-m': { packId: 'tts-zh-m', sid: 0, rate: 1.0 },
};

/** Same-runtime fallback if chaowen fails the human ear-check: the deepest
 * aishell3 register measured in the 260816 sweep (sid 40, ~168 Hz median F0).
 * To use it: point LOCAL_VOICE_SPEC['zh-m'] at
 * { packId: 'tts-zh-f', sid: AISHELL3_MALE_REGISTER_SID, rate: 1.0 }. */
export const AISHELL3_MALE_REGISTER_SID = 40;

/**
 * Gender of the 260707-curated legacy pool ids (voiceAssign LEGACY_VOICE_IDS).
 * Closed set; transcribed from that module's section comments.
 */
const LEGACY_VOICE_GENDER: Record<string, VoiceGender> = {
  // female
  EXAVITQu4vr4xnSDxMaL: 'female', // Sarah
  FGY2WhTYpPnrIDTdsKH5: 'female', // Laura
  cgSgspJ2msm6clMCkdW9: 'female', // Jessica
  tpS5zOAgWUiQMhzYbG2h: 'female', // Sapphire
  m0MqfGOWTAfVVEaz4KxX: 'female', // Alexandra
  MJqcNjMbvfGUxatGjPcI: 'female', // Daisy
  Y0G5nEDw2qHnUHGmtoM9: 'female', // Boo
  Xb7hH8MSUJpSbSDYk0k2: 'female', // Alice
  XrExE9yKIg1WjnnlVkGX: 'female', // Matilda
  hpp4J3VqNfWAUOO0d1Us: 'female', // Bella
  pFZP5JQG7iQjIQuC4Bku: 'female', // Lily
  FF59babHL8N8gfTgtBMT: 'female', // Jodi
  DIS307HFaAvJZzq496qM: 'female', // Cecilia
  vHMylH8q68M5Wk9WkVr1: 'female', // Claudia
  u6a6bRv82Zfi9NzoIqvt: 'female', // Lia
  xIzR6egd3S3LJZbVW0c1: 'female', // Margaret
  '2qQJWjw5XdG80GreshqG': 'female', // Eleanor
  wGcFBfKz5yUQqhqr0mVy: 'female', // Maria
  // male
  IKne3meq5aSn9XLyUdCD: 'male', // Charlie
  TX3LPaxmHKxFdv7VOQHJ: 'male', // Liam
  bIHbv24MWmeRgasZH58o: 'male', // Will
  CwhRBWXzGAHq8TQ4Fs17: 'male', // Roger
  JBFqnCBsd6RMkjVDRZzb: 'male', // George
  cjVigY5qzO86Huf0OWal: 'male', // Eric
  iP95p4xoKVk53GoZ742B: 'male', // Chris
  nPczCjzI2devNBz1zQrb: 'male', // Brian
  onwK4e9ZLuTAKqWW03F9: 'male', // Daniel
  pNInz6obpgDQGcFmaJgB: 'male', // Adam
  enzbGixeo55iqn1QxbbC: 'male', // Jon
  pCL8Ua4MoAGISUaDmw69: 'male', // Miller
  pqHfZKP75CvOlQylNhV4: 'male', // Bill
  PerZoH0r6nxBZXCoIPpv: 'male', // Michael
  UzI1NsMEV3ni5JRkRSls: 'male', // Alistair
  RcEmXcISaHUgHOU4uNTz: 'male', // Hansi
};

type PoolVoice = { id: string; gender: string };

const POOL_GENDER: Map<string, string> = new Map(
  (VOICES as PoolVoice[]).map((v) => [v.id, v.gender]),
);

/**
 * The gender the local voice should take for an ElevenLabs voice id.
 * 'neutral' pool voices (and unknown ids — a voice we cannot classify) map to
 * 'female': an arbitrary but stable default, chosen over guessing from the
 * persona because a wrong-but-consistent voice beats one that flips.
 */
export function voiceGenderFor(voiceId: string | undefined | null): VoiceGender {
  if (!voiceId) return 'female';
  const pool = POOL_GENDER.get(voiceId);
  if (pool === 'male') return 'male';
  if (pool === 'female') return 'female';
  if (pool === 'neutral') return 'female';
  return LEGACY_VOICE_GENDER[voiceId] ?? 'female';
}

/** Pick the local voice slot for (gender, conversation language). Only zh has
 * its own local voices; every other language uses the English pack. */
export function localVoiceFor(gender: VoiceGender, language: string): LocalVoiceId {
  if (language === 'zh') return gender === 'male' ? 'zh-m' : 'zh-f';
  return gender === 'male' ? 'en-m' : 'en-f';
}

/** Full resolution: ElevenLabs voiceId + language → local voice slot. */
export function resolveLocalVoice(
  voiceId: string | undefined | null,
  language: string,
): LocalVoiceId {
  return localVoiceFor(voiceGenderFor(voiceId), language);
}
