/**
 * Fish Audio voices (261103): the automatic voice table and the parsing of a
 * user's own pick. Fish runs with the USER's own Fish API key, called from
 * main (main/voice/fishTts.ts); it never goes through the Sei proxy.
 *
 * Automatic mode maps a character's ElevenLabs voice (its gender, from the
 * pool metadata, see speech/localVoice.ts voiceGenderFor) plus the line's
 * language to one curated voice below. Only voices whose rights are secured
 * (`licensed: true` on GET /model/{id}) go in this table: 'fish-official' is
 * Fish's own licensed set, 'pvc' a professional clone its owner licensed
 * (those carry a 12-36 month retirement notice on Fish's side).
 *
 * Picked 261103 from GET /model?licensed=true sorted by use count, with a
 * duration/words-per-second check of each candidate on companion lines:
 *   en female  Akari (ja voice, Fish Official). No licensed young, bright
 *              native-English female exists yet; the T302 listening test
 *              found Akari good in English. OLAJUMOKE is the calmer runner-up.
 *   en male    ivish (young, conversational).
 *   ja female  Akari.            ja male  Satoru (young, Fish Official).
 *   zh female  桃桃 (young, playful; written for daily companionship).
 *   zh male    温柔沉稳男声 (young, warm).
 * Other chat languages (ko, fr, es) use the English voice of that gender: the
 * model is multilingual and the line's language is pinned in the request.
 *
 * `speed` is prosody.speed. Fish voices speak slowly (about 2.6 words/s at
 * 1.0 against ElevenLabs' ~3.9 on the same lines), so most need 1.2-1.5 for
 * a companion's pace. `volume` is prosody.volume, a per-voice loudness trim
 * toward the ElevenLabs level (~-20 LUFS): the playback path has no gain
 * stage, so the trim happens at synthesis. Fish's volume steps are not plain
 * dB (one step moved Akari ~3-4 dB) and loudness varies about 2 dB run to
 * run, so the trims are small and rounded.
 */
import type { ChatLanguage } from './chatLanguage';

/** The free model. ALWAYS sent as the `model` header: a missing or unknown
 * value falls back to the PAID s2.1-pro, which bills an account with credit. */
export const FISH_TTS_MODEL = 's2.1-pro-free';
export const FISH_API_BASE = 'https://api.fish.audio';
/** Where a user creates a free key. */
export const FISH_API_KEYS_URL = 'https://fish.audio/app/api-keys/';

export type FishVoiceGender = 'female' | 'male';

/** Why a Fish request did not produce audio (main/voice/fishTts.ts sentinels). */
export type FishFailureReason = 'no-key' | 'key-invalid' | 'no-credit' | 'busy' | 'voice-missing' | 'failed';

/** Result of the Fish IPC calls that return audio or a reason. */
export type FishAudioResult = { ok: true; audio: ArrayBuffer } | { ok: false; reason: FishFailureReason };

/** Result of setting a character's own Fish voice. `voice: null` = cleared. */
export type FishOverrideResult =
  | { ok: true; voice: { id: string; name: string } | null }
  | { ok: false; reason: FishFailureReason | 'invalid-link' };
type TableLanguage = 'en' | 'ja' | 'zh';

export interface FishVoice {
  id: string;
  name: string;
  /** The voice's own language on Fish. */
  language: TableLanguage;
  gender: FishVoiceGender;
  source: 'fish-official' | 'pvc';
  speed: number;
  volume: number;
}

const AKARI = '97eda32449cf443bbc4b8782853ca554';

export const FISH_VOICES: Record<TableLanguage, Record<FishVoiceGender, FishVoice>> = {
  en: {
    female: { id: AKARI, name: 'Akari', language: 'ja', gender: 'female', source: 'fish-official', speed: 1.45, volume: -1 },
    male: { id: '45e74f1d840842afaf3e0f50006fc9e7', name: 'ivish', language: 'en', gender: 'male', source: 'pvc', speed: 1.25, volume: 2 },
  },
  ja: {
    female: { id: AKARI, name: 'Akari', language: 'ja', gender: 'female', source: 'fish-official', speed: 1.25, volume: -1 },
    male: { id: '297a6fd278df47c3b9da9bfdf55ac89a', name: 'Satoru', language: 'ja', gender: 'male', source: 'fish-official', speed: 1.15, volume: -1 },
  },
  zh: {
    female: { id: 'c45cfee333d140189cdc36e36d241c5e', name: '桃桃', language: 'zh', gender: 'female', source: 'pvc', speed: 1.3, volume: 0 },
    male: { id: 'd9956cb243a34292afc9b42ad3964f73', name: '温柔沉稳男声', language: 'zh', gender: 'male', source: 'pvc', speed: 1.05, volume: 0 },
  },
};

/** The automatic voice for (gender, line language). Languages without their
 * own row use the English voice; the language still rides the request. */
export function pickFishVoice(gender: FishVoiceGender, language: ChatLanguage | string): FishVoice {
  const base = String(language).toLowerCase().split(/[-_]/)[0];
  const row = base === 'ja' || base === 'zh' ? FISH_VOICES[base] : FISH_VOICES.en;
  return row[gender];
}

/** Speed for a voice the user picked themselves when none is saved with it:
 * most Fish voices need a lift to sound conversational. */
export const FISH_OVERRIDE_DEFAULT_SPEED = 1.3;
export const FISH_SPEED_MIN = 0.5;
export const FISH_SPEED_MAX = 2;

export function clampFishSpeed(speed: unknown, fallback = FISH_OVERRIDE_DEFAULT_SPEED): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return fallback;
  return Math.min(FISH_SPEED_MAX, Math.max(FISH_SPEED_MIN, speed));
}

const FISH_ID_RE = /^[0-9a-f]{32}$/;

/**
 * A fish.audio voice id from what a user pasted: a raw 32-hex id, or a voice
 * link (fish.audio/m/<id>, with or without https, a locale or app prefix, a
 * trailing slash, query or hash). Anything else, including links to other
 * sites, is null.
 */
export function parseFishVoiceRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  const lower = raw.toLowerCase();
  if (FISH_ID_RE.test(lower)) return lower;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'fish.audio' && !host.endsWith('.fish.audio')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const m = parts.indexOf('m');
  const id = m >= 0 ? parts[m + 1]?.toLowerCase() : undefined;
  return id && FISH_ID_RE.test(id) ? id : null;
}
