/**
 * Mic dictation (260705): capture → energy VAD → local Whisper transcription.
 *
 * Design constraints that shaped this:
 *   - Open-source + free + no native modules: Whisper runs locally in a Web
 *     Worker via transformers.js (see whisperWorker.ts); segmentation is a
 *     plain RMS-energy VAD, so the only dependency is the model itself.
 *   - Half-duplex against the companion's own voice: getUserMedia echo
 *     cancellation removes most of the TTS audio from the mic signal, and the
 *     `setHold(true)` gate (set while companion audio plays) discards the rest
 *     so the companion never transcribes itself.
 *   - Mute is renderer-side: the stream keeps running (fast unmute) but frames
 *     are discarded and any in-progress utterance is dropped.
 *
 * VAD: 16kHz mono frames captured by a tiny AudioWorklet (see WORKLET_SRC —
 * inline blob module, so no bundler plumbing); speech opens when frame RMS
 * exceeds an adaptive noise floor, closes after END_SILENCE_MS below it.
 * Utterances shorter than MIN_UTTERANCE_MS are discarded (coughs, clicks);
 * longer than MAX_UTTERANCE_MS are force-flushed so a monologue still lands.
 * The VAD math runs on the main thread off the worklet's posted frames — the
 * worklet only batches samples (128-sample render quanta → 2048-sample frames,
 * ~8 messages/sec).
 */

export type DictationStatus = 'loading-model' | 'ready' | 'error';

/** First-run model download is ~40MB; a stalled CDN must surface as an error
 * instead of an eternal "Connecting…" (260705 field report). */
const MODEL_LOAD_TIMEOUT_MS = 180_000;

export interface Dictation {
  /** Renderer-side mute: discard mic input without stopping the stream. */
  setMuted(muted: boolean): void;
  /** Half-duplex hold — true while companion audio is playing. */
  setHold(hold: boolean): void;
  /** True once the mic level shows live speech (drives the UI level dot). */
  speechActive(): boolean;
  /** Tear down mic, audio graph, and worker. */
  stop(): void;
}

const SAMPLE_RATE = 16_000;
const FRAME_SIZE = 2048; // ~128ms at 16kHz
const START_RMS_FLOOR = 0.012; // absolute minimum to open speech
const NOISE_ADAPT = 0.02; // EMA rate for the noise floor
const START_FACTOR = 3; // open at noiseFloor * factor (≥ START_RMS_FLOOR)
// 700ms (was 900): every ms here is dead air on the player's end of the call —
// the whole reply pipeline (Whisper + LLM + TTS) queues behind utterance-end
// detection. 700 still comfortably clears intra-sentence pauses.
const END_SILENCE_MS = 700;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 15_000;
const PRE_ROLL_FRAMES = 2; // frames kept from before the trigger

/**
 * AudioWorklet processor (issue: ScriptProcessorNode is deprecated). Batches
 * the 128-sample render quanta into FRAME_SIZE frames and posts them to the
 * main thread (transferred, zero-copy). Inlined as a blob module so it needs
 * no bundler/worklet build plumbing; it must stay dependency-free JS.
 */
const WORKLET_SRC = `
class SeiVadCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${FRAME_SIZE});
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this._buf.length - this._n);
        this._buf.set(ch.subarray(i, i + take), this._n);
        this._n += take;
        i += take;
        if (this._n === this._buf.length) {
          const out = this._buf;
          this.port.postMessage(out, [out.buffer]);
          this._buf = new Float32Array(${FRAME_SIZE});
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('sei-vad-capture', SeiVadCapture);
`;

export async function createDictation(opts: {
  onUtterance: (text: string) => void;
  onStatus: (status: DictationStatus, detail?: string) => void;
}): Promise<Dictation> {
  opts.onStatus('loading-model');

  // Worker first — if the model can't load there is no point holding the mic.
  const worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const inflight = new Map<number, (text: string) => void>();
  const ready = new Promise<void>((resolve, reject) => {
    const watchdog = setTimeout(
      () => reject(new Error('voice recognition took too long to download — check your connection and retry')),
      MODEL_LOAD_TIMEOUT_MS,
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; id?: number; text?: string; message?: string; pct?: number };
      if (msg.type === 'ready') {
        clearTimeout(watchdog);
        resolve();
      } else if (msg.type === 'init-error') {
        clearTimeout(watchdog);
        reject(new Error(msg.message ?? 'model load failed'));
      } else if (msg.type === 'progress' && typeof msg.pct === 'number') {
        // First-run download progress — surfaced so "Connecting…" shows a
        // moving percentage instead of looking hung for ~40MB.
        opts.onStatus('loading-model', `${Math.min(99, msg.pct)}`);
      } else if (msg.type === 'transcript' && typeof msg.id === 'number') {
        inflight.get(msg.id)?.(msg.text ?? '');
        inflight.delete(msg.id);
      }
    };
  });
  worker.postMessage({ type: 'init' });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is load-bearing: it subtracts the companion's TTS
        // (played by this same page) from the mic signal.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    worker.terminate();
    opts.onStatus('error', 'microphone permission denied');
    throw err;
  }

  try {
    await ready;
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    worker.terminate();
    opts.onStatus('error', (err as Error).message);
    throw err;
  }
  opts.onStatus('ready');

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // AudioWorklet capture (replaces the deprecated ScriptProcessorNode). The
  // module is a blob URL built from WORKLET_SRC above.
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
  let captureNode: AudioWorkletNode;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    captureNode = new AudioWorkletNode(ctx, 'sei-vad-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
  } catch (err) {
    URL.revokeObjectURL(workletUrl);
    void ctx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
    worker.terminate();
    opts.onStatus('error', 'audio capture failed');
    throw err;
  }
  URL.revokeObjectURL(workletUrl);

  let muted = false;
  let hold = false;
  let noiseFloor = 0.008;
  let inSpeech = false;
  let silenceMs = 0;
  let speechMs = 0;
  const preRoll: Float32Array[] = [];
  let utterance: Float32Array[] = [];

  function resetUtterance(): void {
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
  }

  function flushUtterance(): void {
    const frames = utterance;
    resetUtterance();
    if (speechMsOf(frames) < MIN_UTTERANCE_MS) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      audio.set(f, off);
      off += f.length;
    }
    const id = nextId++;
    inflight.set(id, (text) => {
      if (text) opts.onUtterance(text);
    });
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  }

  function speechMsOf(frames: Float32Array[]): number {
    const samples = frames.reduce((n, f) => n + f.length, 0);
    return (samples / SAMPLE_RATE) * 1000;
  }

  captureNode.port.onmessage = (e: MessageEvent) => {
    const frame = e.data as Float32Array;
    if (!(frame instanceof Float32Array) || frame.length === 0) return;
    if (muted || hold) {
      if (inSpeech) resetUtterance();
      preRoll.length = 0;
      return;
    }
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const frameMs = (frame.length / SAMPLE_RATE) * 1000;

    if (!inSpeech) {
      // Adapt the noise floor only outside speech so talking doesn't raise it.
      noiseFloor = noiseFloor * (1 - NOISE_ADAPT) + rms * NOISE_ADAPT;
      const threshold = Math.max(START_RMS_FLOOR, noiseFloor * START_FACTOR);
      preRoll.push(frame.slice());
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (rms >= threshold) {
        inSpeech = true;
        speechMs = frameMs;
        silenceMs = 0;
        utterance = [...preRoll.map((f) => f)];
        utterance.push(frame.slice());
        preRoll.length = 0;
      }
      return;
    }

    utterance.push(frame.slice());
    speechMs += frameMs;
    const endThreshold = Math.max(START_RMS_FLOOR * 0.7, noiseFloor * 2);
    silenceMs = rms < endThreshold ? silenceMs + frameMs : 0;
    if (silenceMs >= END_SILENCE_MS || speechMs >= MAX_UTTERANCE_MS) {
      flushUtterance();
    }
  };

  source.connect(captureNode);
  // Keep the node pulled by the rendered graph via a zero-gain sink so capture
  // never stalls, and nothing echoes to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  captureNode.connect(sink);
  sink.connect(ctx.destination);

  return {
    setMuted(m) {
      muted = m;
      if (m && inSpeech) resetUtterance();
    },
    setHold(h) {
      hold = h;
      if (h && inSpeech) resetUtterance();
    },
    speechActive: () => inSpeech,
    stop() {
      try { captureNode.port.onmessage = null; } catch { /* torn down */ }
      try { captureNode.disconnect(); source.disconnect(); sink.disconnect(); } catch { /* torn down */ }
      void ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      worker.terminate();
      inflight.clear();
    },
  };
}
