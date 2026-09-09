/**
 * Speech pack registry (260816, china-compat W3+W4) — the closed set of local
 * speech models Sei can download, as pure data.
 *
 * Three packs: two TTS voice packs (each covers both genders via speaker ids —
 * en through libritts_r's 904 speakers, zh through aishell3's 174) and the
 * SenseVoice STT model. Archives are the k2-fsa sherpa-onnx GitHub release
 * assets (.tar.bz2), mirrored on dl.sei.gg (mirror-first download — see
 * mirrors.ts). Sizes are the exact byte counts of the published assets (read
 * off the GitHub release API 260816); a mismatched download is discarded
 * rather than extracted.
 *
 * Licenses (legal review 260828 — supersedes the 260816 notes):
 *   - libritts_r: CLEAR, CC BY 4.0 (LibriTTS-R dataset,
 *     https://www.openslr.org/141/). Attribution must name the dataset, link
 *     the license, and note modification (Piper training + ONNX conversion).
 *     Credited in Settings > About.
 *   - aishell3: CLEAR, plain Apache License 2.0 (https://www.openslr.org/93/).
 *     An earlier note here said "for academic use" — that is NOT a term of the
 *     actual license; only the usual Apache-2.0 notice/license retention
 *     applies. Credited in Settings > About.
 *   - SenseVoice: CLEAR under the FunASR Model Open Source License v1.1
 *     (https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE).
 *     Commercial use OK; requires attributing source/author and retaining the
 *     model names. Credited in Settings > About. This closes the old
 *     "legal read owed" TODO.
 *
 * There USED to be a fourth pack, 'tts-zh-m' (vits-piper-zh_CN-chaowen int8,
 * the dedicated zh male voice). REMOVED 260908 over its non-commercial weights
 * lineage (DataBaker BZNSYP "Non-commercial use" -> xiao_ya -> chaowen; the
 * "CC0" note applied only to the fine-tuning dataset) — never shipped in a
 * release. zh male now speaks from the aishell3 pack's male-register speaker
 * (localVoice.ts AISHELL3_MALE_REGISTER_SID); packStore heals any dev-machine
 * leftover 'tts-zh-m' dir by deleting it.
 * We ship NONE of these — download on demand.
 */

export type SpeechPackId = 'tts-en' | 'tts-zh' | 'stt-sensevoice';

export const SPEECH_PACK_IDS: readonly SpeechPackId[] = [
  'tts-en',
  'tts-zh',
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
  /** zh female + male: vits-icefall aishell3, 174 speakers (Apache-2.0).
   * Both genders via speaker ids, like the en pack (localVoice.ts). */
  'tts-zh': {
    id: 'tts-zh',
    asset: 'vits-icefall-zh-aishell3.tar.bz2',
    originUrl: `${TTS_RELEASE}/vits-icefall-zh-aishell3.tar.bz2`,
    archiveBytes: 31_559_701,
    dirName: 'vits-icefall-zh-aishell3',
    requiredFiles: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
  },
  /** SenseVoice-small int8 STT (zh/en/ja/ko/yue). The DATED asset name is the
   * real one on the k2-fsa asr-models release (an undated guess 404s). */
  'stt-sensevoice': {
    id: 'stt-sensevoice',
    asset: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
    originUrl: `${ASR_RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2`,
    archiveBytes: 165_783_878,
    dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    requiredFiles: ['model.int8.onnx', 'tokens.txt'],
  },
};

export function isSpeechPackId(id: string): id is SpeechPackId {
  return (SPEECH_PACK_IDS as readonly string[]).includes(id);
}
