/**
 * Speech pack registry (260816, china-compat W3+W4) — the closed set of local
 * speech models Sei can download, as pure data.
 *
 * Four packs: three TTS voice packs (en covers both genders via speaker ids;
 * zh needs two models) and the SenseVoice STT model. Archives are the k2-fsa
 * sherpa-onnx GitHub release assets (.tar.bz2), mirrored on dl.sei.gg
 * (mirror-first download — see mirrors.ts). Sizes are the exact byte counts of
 * the published assets (read off the GitHub release API 260816); a mismatched
 * download is discarded rather than extracted.
 *
 * Licenses (verified 260816): libritts_r CC BY 4.0, aishell3 Apache-2.0,
 * chaowen CC0, SenseVoice FunASR model license (commercial OK per
 * maintainers; legal read owed). We ship NONE of these — download on demand.
 */

export type SpeechPackId = 'tts-en' | 'tts-zh-f' | 'tts-zh-m' | 'stt-sensevoice';

export const SPEECH_PACK_IDS: readonly SpeechPackId[] = [
  'tts-en',
  'tts-zh-f',
  'tts-zh-m',
  'stt-sensevoice',
];

export interface SpeechPackDef {
  id: SpeechPackId;
  /** Release asset filename (also the mirror key under /speech/). */
  asset: string;
  /** Canonical GitHub release asset URL (the origin; mirror tried first). */
  originUrl: string;
  /** Exact archive size in bytes; a size-mismatched download is discarded. */
  archiveBytes: number;
  /** Top-level directory name inside the archive. */
  dirName: string;
  /** Files (relative to dirName) whose presence marks the pack usable. */
  requiredFiles: string[];
}

const TTS_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';
const ASR_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export const SPEECH_PACKS: Record<SpeechPackId, SpeechPackDef> = {
  /** en female + male: vits-piper libritts_r medium, 904 speakers (CC BY 4.0). */
  'tts-en': {
    id: 'tts-en',
    asset: 'vits-piper-en_US-libritts_r-medium.tar.bz2',
    originUrl: `${TTS_RELEASE}/vits-piper-en_US-libritts_r-medium.tar.bz2`,
    archiveBytes: 82_038_311,
    dirName: 'vits-piper-en_US-libritts_r-medium',
    requiredFiles: ['en_US-libritts_r-medium.onnx', 'tokens.txt', 'espeak-ng-data/phontab'],
  },
  /** zh female: vits-icefall aishell3, 174 speakers (Apache-2.0). */
  'tts-zh-f': {
    id: 'tts-zh-f',
    asset: 'vits-icefall-zh-aishell3.tar.bz2',
    originUrl: `${TTS_RELEASE}/vits-icefall-zh-aishell3.tar.bz2`,
    archiveBytes: 31_559_701,
    dirName: 'vits-icefall-zh-aishell3',
    requiredFiles: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
  },
  /** zh male: vits-piper chaowen int8 (CC0). Pitch analysis says male
   * (~151 Hz); a human ear-check is owed before ship — the same-runtime
   * fallback is an aishell3 male-register speaker id (see localVoice.ts). */
  'tts-zh-m': {
    id: 'tts-zh-m',
    asset: 'vits-piper-zh_CN-chaowen-medium-int8.tar.bz2',
    originUrl: `${TTS_RELEASE}/vits-piper-zh_CN-chaowen-medium-int8.tar.bz2`,
    archiveBytes: 14_011_298,
    dirName: 'vits-piper-zh_CN-chaowen-medium-int8',
    requiredFiles: ['zh_CN-chaowen-medium.int8.onnx', 'tokens.txt'],
  },
  /** SenseVoice-small int8 STT (zh/en/ja/ko/yue). */
  'stt-sensevoice': {
    id: 'stt-sensevoice',
    asset: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
    originUrl: `${ASR_RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
    archiveBytes: 163_002_883,
    dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
};

export function isSpeechPackId(id: string): id is SpeechPackId {
  return (SPEECH_PACK_IDS as readonly string[]).includes(id);
}
