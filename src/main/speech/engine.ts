/**
 * sherpa-onnx runtime host (260816, china-compat W3+W4): local TTS synthesis +
 * SenseVoice STT, in the MAIN process.
 *
 * ── Spike result (260816, spike run on macOS arm64, node 25) ────────────────
 * sherpa-onnx-node and onnxruntime-node COEXIST in one process: sherpa's
 * platform package ships its own libonnxruntime.dylib and its sherpa-onnx.node
 * links it via `@rpath` with an `@loader_path` LC_RPATH, so dyld resolves it
 * from the platform package dir, distinct from onnxruntime-node's
 * libonnxruntime.1.dylib (different install names → no interposition). The
 * spike loaded both, ran a Maia-3 inference through onnxruntime-node and TTS +
 * SenseVoice through sherpa in the same process, then created a second ort
 * session with sherpa live — all clean. So sherpa runs IN MAIN directly, no
 * utilityProcess fork. All heavy calls use the *Async N-API variants, which
 * run on the libuv thread pool and never block the main-process event loop.
 *
 * Library path note: no DYLD_LIBRARY_PATH / LD_LIBRARY_PATH is needed or set.
 * sherpa-onnx-node's addon.js resolves the platform package RELATIVE to its
 * own module dir (`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`), which
 * holds in node_modules and in app.asar.unpacked (node_modules is
 * asarUnpacked). The env-var advice in its README applies only when that
 * relative require fails; if it ever does, the error we throw carries the
 * addon's own message.
 *
 * Engines are cached per pack (the models are small: 78 MB en, 30 MB zh,
 * 155 MB SenseVoice int8) and created lazily on first use.
 * A missing pack surfaces as the typed error `VOICE_PACK_MISSING:<packId>`
 * that the renderer maps to a download prompt — NEVER auto-downloaded
 * mid-call.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { LOCAL_VOICE_SPEC, type LocalVoiceId } from './localVoice';
import { SPEECH_PACKS, type SpeechPackId } from './packs';
import { packModelDir, packReady } from './packStore';
import { sentenceCaseSttText } from './sentenceCase';

/** Renderer-facing sentinel: the voice pack is not downloaded. The suffix is
 * the pack id so the prompt can name the download. */
export function packMissingError(packId: SpeechPackId): Error {
  return new Error(`VOICE_PACK_MISSING:${packId}`);
}

// ── sherpa module loading ───────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type SherpaModule = any;

let sherpa: SherpaModule | null = null;

function loadSherpa(): SherpaModule {
  if (sherpa) return sherpa;
  const req = typeof require === 'function' ? require : createRequire(process.cwd() + '/');
  try {
    sherpa = req('sherpa-onnx-node');
  } catch (err) {
    throw new Error(`SPEECH_RUNTIME_FAILED: sherpa-onnx-node load failed: ${(err as Error).message}`);
  }
  return sherpa;
}

// ── TTS ─────────────────────────────────────────────────────────────────────

type TtsEngine = { generateAsync(req: { text: string; sid: number; speed: number; enableExternalBuffer?: boolean }): Promise<{ samples: Float32Array; sampleRate: number }> ; numSpeakers: number };

const ttsEngines = new Map<SpeechPackId, Promise<TtsEngine>>();

/** Build the per-pack OfflineTts config. The two voice packs have different
 * shapes (icefall lexicon+fsts vs piper espeak-data). */
function ttsConfigFor(packId: SpeechPackId): unknown {
  const dir = packModelDir(packId);
  if (packId === 'tts-zh') {
    // vits-icefall aishell3: lexicon-based, with the number/date/phone rule
    // FSTs the archive ships (they normalize digits into readable Mandarin).
    const fsts = ['phone.fst', 'date.fst', 'number.fst']
      .map((f) => path.join(dir, f))
      .filter((p) => existsSync(p))
      .join(',');
    return {
      model: {
        vits: {
          model: path.join(dir, 'model.onnx'),
          lexicon: path.join(dir, 'lexicon.txt'),
          tokens: path.join(dir, 'tokens.txt'),
        },
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      },
      maxNumSentences: 1,
      ...(fsts ? { ruleFsts: fsts } : {}),
    };
  }
  // tts-en: piper libritts_r medium.
  return {
    model: {
      vits: {
        model: path.join(dir, SPEECH_PACKS['tts-en'].requiredFiles[0]),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
      },
      numThreads: 2,
      debug: false,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  };
}

async function ttsEngineFor(packId: SpeechPackId): Promise<TtsEngine> {
  let engine = ttsEngines.get(packId);
  if (!engine) {
    engine = (async () => {
      if (!(await packReady(packId))) throw packMissingError(packId);
      const s = loadSherpa();
      // createAsync: model load runs off the main thread (a medium VITS model
      // takes ~1s to load; the first spoken line of a call must not stall UI).
      return (await s.OfflineTts.createAsync(ttsConfigFor(packId))) as TtsEngine;
    })();
    engine.catch(() => ttsEngines.delete(packId)); // failed create is retryable
    ttsEngines.set(packId, engine);
  }
  return engine;
}

/**
 * Synthesize one line in a local voice. Returns raw float PCM + rate; the
 * caller encodes WAV (voice/stt.ts encodeWav) for the clip pipeline.
 *
 * Whole-clip v1: sherpa's generateAsync CAN stream chunks through a callback
 * (GenerationConfig.enableExternalBuffer + callback) — the upgrade path if
 * sentence-sized clips ever feel slow — but the existing renderer clip
 * pipeline is whole-clip for short lines anyway, so v1 keeps it simple.
 */
export async function synthesizeLocal(
  text: string,
  voice: LocalVoiceId,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const spec = LOCAL_VOICE_SPEC[voice];
  const engine = await ttsEngineFor(spec.packId);
  const started = Date.now();
  // enableExternalBuffer: false is REQUIRED under Electron: its V8 memory
  // cage forbids Node-API external buffers, and sherpa returns samples as one
  // by default. Sync generate throws "External buffers are not allowed";
  // generateAsync surfaces it as the native "TTS settlement failed". Plain
  // Node allows them, which is why every test passed while the app failed.
  const audio = await engine.generateAsync({
    text,
    sid: spec.sid,
    speed: spec.rate,
    enableExternalBuffer: false,
  });
  const dur = audio.samples.length / audio.sampleRate;
  console.log(
    `[sei/speech] tts ${voice} ${dur.toFixed(2)}s in ${Date.now() - started}ms ` +
      `(rtf ${dur > 0 ? ((Date.now() - started) / 1000 / dur).toFixed(3) : '?'})`,
  );
  if (!audio.samples || audio.samples.length === 0) {
    throw new Error('VOICE_TTS_FAILED: local synthesis produced no audio');
  }
  return { samples: audio.samples, sampleRate: audio.sampleRate };
}

// ── STT (SenseVoice) ────────────────────────────────────────────────────────

type SttStream = { acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void };
type SttEngine = {
  createStream(): SttStream;
  /** Resolves the parsed recognition result (runs on the N-API thread pool). */
  decodeAsync(stream: SttStream): Promise<{ text?: string; lang?: string }>;
};

/**
 * SenseVoice language hints the model actually supports (plus 'auto' for
 * everything else). The hint is a recognizer-construction field in sherpa's
 * OfflineSenseVoiceModelConfig, so engines are cached PER HINT below.
 */
const SENSEVOICE_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue']);

/**
 * Map the app's conversation language (UserConfig.chat_language, see
 * src/shared/chatLanguage.ts) onto a SenseVoice language hint. Constraining
 * the decode language is the fix for full auto-detect drifting into Chinese
 * on English speech (and vice versa) — this build's known failure mode.
 * Languages SenseVoice does not model (fr/es) fall back to 'auto'.
 */
export function senseVoiceLanguage(chatLanguage: string | undefined): string {
  return chatLanguage && SENSEVOICE_LANGS.has(chatLanguage) ? chatLanguage : 'auto';
}

/** One recognizer per language hint (the hint is fixed at create time). The
 * model weights are OS-cached, so a language switch costs one re-create. */
const sttEngines = new Map<string, Promise<SttEngine>>();

async function sttEngineGet(language: string): Promise<SttEngine> {
  let engine = sttEngines.get(language);
  if (!engine) {
    engine = (async () => {
      if (!(await packReady('stt-sensevoice'))) throw packMissingError('stt-sensevoice');
      const s = loadSherpa();
      const dir = packModelDir('stt-sensevoice');
      return (await s.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: path.join(dir, 'model.int8.onnx'),
            // Decode-language hint ('auto' = detect per utterance). Pinned to
            // the conversation language by the caller — see senseVoiceLanguage.
            language,
            // Inverse text normalization ON: spoken numbers come back as
            // digits, matching what Scribe/Whisper produce for the chat log.
            useInverseTextNormalization: 1,
          },
          tokens: path.join(dir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      })) as SttEngine;
    })();
    engine.catch(() => {
      sttEngines.delete(language);
    });
    sttEngines.set(language, engine);
  }
  return engine;
}

/** SenseVoice language tags come back as `<|zh|>`-style markers. */
function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const m = /([a-z]{2,3})/i.exec(lang);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Transcribe one utterance of Float32 mono PCM (any sample rate; SenseVoice
 * consumes 16k and sherpa resamples internally off the declared rate).
 * Returns model text with ONE SenseVoice-specific repair applied — ALL-CAPS
 * English is rewritten to sentence case (sentenceCase.ts) — so every consumer
 * gets readable casing; the caller still applies the same normalizeSttText
 * the cloud path uses.
 *
 * @param chatLanguage the app's conversation language (UserConfig.
 *   chat_language); mapped onto a SenseVoice decode-language hint via
 *   senseVoiceLanguage. Absent → 'auto' (per-utterance detection).
 */
export async function transcribeLocal(
  pcm: Float32Array,
  sampleRate: number,
  chatLanguage?: string,
): Promise<{ text: string; language?: string }> {
  const hint = senseVoiceLanguage(chatLanguage);
  const engine = await sttEngineGet(hint);
  const started = Date.now();
  const stream = engine.createStream();
  stream.acceptWaveform({ samples: pcm, sampleRate });
  const result = await engine.decodeAsync(stream);
  const dur = pcm.length / sampleRate;
  console.log(
    `[sei/speech] sensevoice ${Math.round(Date.now() - started)}ms over ${dur.toFixed(1)}s ` +
      `hint=${hint} lang=${result.lang ?? '?'} "${(result.text ?? '').slice(0, 80)}"`,
  );
  return { text: sentenceCaseSttText(result.text ?? ''), language: normalizeLang(result.lang) };
}
