import path from 'node:path';
import type { VoiceGender } from './localVoice';

/** Speaker order is specific to sherpa's v1.0 voices.bin, not the HF listing:
 * https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/kokoro/v1.0/generate_voices_bin.py
 * Heart keeps the 0.8 speed used in issue #47's earlier experiment. */
export const KOKORO_VOICES = {
  af_heart: { sid: 3, lang: 'en-us', rate: 0.8 },
  am_michael: { sid: 16, lang: 'en-us', rate: 1.0 },
  ef_dora: { sid: 28, lang: 'es', rate: 1.0 },
  em_alex: { sid: 29, lang: 'es', rate: 1.0 },
  ff_siwis: { sid: 30, lang: 'fr', rate: 1.0 },
  if_sara: { sid: 35, lang: 'it', rate: 1.0 },
  im_nicola: { sid: 36, lang: 'it', rate: 1.0 },
} as const;
export type KokoroVoice = keyof typeof KOKORO_VOICES;

/** Only language/gender pairs supported by this espeak pack. No cross-gender
 * substitution: a missing pair goes through SEI's standard local fallback. */
const VOICE_BY_LANGUAGE: Record<string, Partial<Record<VoiceGender, KokoroVoice>>> = {
  en: { female: 'af_heart', male: 'am_michael' },
  es: { female: 'ef_dora', male: 'em_alex' },
  fr: { female: 'ff_siwis' },
  it: { female: 'if_sara', male: 'im_nicola' },
};

export function pickKokoroVoice(gender: VoiceGender, language: string): KokoroVoice | null {
  const base = language.toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(VOICE_BY_LANGUAGE, base) ? VOICE_BY_LANGUAGE[base][gender] ?? null : null;
}

export function kokoroConfig(dir: string, voice: KokoroVoice) {
  return {
    model: {
      kokoro: {
        model: path.join(dir, 'model.int8.onnx'),
        voices: path.join(dir, 'voices.bin'),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lang: KOKORO_VOICES[voice].lang,
      },
      numThreads: 2,
      debug: false,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  };
}
