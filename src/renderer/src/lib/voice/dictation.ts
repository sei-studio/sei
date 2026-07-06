/**
 * Mic dictation (260705): capture → energy VAD → local Whisper transcription.
 *
 * Design constraints that shaped this:
 *   - Open-source + free + no native modules: Whisper runs locally in a Web
 *     Worker via transformers.js (see whisperWorker.ts); segmentation is a
 *     plain RMS-energy VAD, so the only dependency is the model itself.
 *   - Against the companion's own voice: getUserMedia echo cancellation
 *     removes most of the TTS audio from the mic signal. 260705 barge-in:
 *     while companion audio plays (`setHold(true)`) the VAD keeps listening
 *     at an ELEVATED threshold (BARGE_RMS_FLOOR/BARGE_FACTOR) — the echo
 *     residue stays below it, real player speech clears it, opens an
 *     utterance, and fires onBargeIn so the owner cuts playback.
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
  /** Half-duplex hold — true while companion audio is playing. 260705: no
   * longer a hard discard — during hold the VAD keeps listening at an
   * ELEVATED threshold so the player can barge in (see onBargeIn). */
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
// 260705 latency: fire a PROVISIONAL Whisper pass this early into a silence
// run. Silence frames add no words, so if the silence holds to END_SILENCE_MS
// the provisional transcript IS the final one — Whisper's ~0.5–1s of work
// overlaps the remaining ~450ms of end-of-utterance wait instead of starting
// after it. If speech resumes, the provisional result is discarded.
const EAGER_SILENCE_MS = 250;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 15_000;
const PRE_ROLL_FRAMES = 2; // frames kept from before the trigger
// Barge-in (260705): while companion audio plays (hold), speech must clear a
// stiffer bar than normal — echo cancellation removes most of the companion's
// own voice from the mic, and the multiplier keeps the residue from
// self-triggering. Tuned above START_FACTOR=3 with margin.
const BARGE_RMS_FLOOR = 0.03;
const BARGE_FACTOR = 7;

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
  /** Player spoke over the companion (speech opened during hold). The owner
   * should stop companion playback — which releases the hold — and this same
   * utterance then flows through onUtterance as usual. */
  onBargeIn?: () => void;
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

  /** Provisional end-of-utterance transcription (EAGER_SILENCE_MS). Identity-
   * free lifecycle: `cancelled` kills it when speech resumes; `wanted` marks
   * that the utterance finalized before the transcript arrived. */
  type Eager = { id: number; cancelled: boolean; wanted: boolean; done: boolean; text: string | null };
  let eager: Eager | null = null;

  function cancelEager(): void {
    if (!eager) return;
    eager.cancelled = true;
    inflight.delete(eager.id);
    eager = null;
  }

  function postTranscribe(frames: Float32Array[], cb: (text: string) => void): number {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      audio.set(f, off);
      off += f.length;
    }
    const id = nextId++;
    inflight.set(id, cb);
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
    return id;
  }

  function resetUtterance(): void {
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
    cancelEager();
  }

  function flushUtterance(): void {
    const frames = utterance;
    const pendingEager = eager;
    eager = null; // ownership transfers below; resetUtterance must not cancel it
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
    if (speechMsOf(frames) < MIN_UTTERANCE_MS) {
      if (pendingEager) {
        pendingEager.cancelled = true;
        inflight.delete(pendingEager.id);
      }
      return;
    }
    if (pendingEager) {
      // The provisional pass already covers this utterance — the frames since
      // it fired are the silence run, which adds no words. Use it instead of
      // re-transcribing (its ~0.5–1s of Whisper work overlapped the wait).
      if (pendingEager.done) {
        if (pendingEager.text) opts.onUtterance(pendingEager.text);
      } else {
        pendingEager.wanted = true;
      }
      return;
    }
    postTranscribe(frames, (text) => {
      if (text) opts.onUtterance(text);
    });
  }

  function speechMsOf(frames: Float32Array[]): number {
    const samples = frames.reduce((n, f) => n + f.length, 0);
    return (samples / SAMPLE_RATE) * 1000;
  }

  function openSpeech(frame: Float32Array, frameMs: number): void {
    inSpeech = true;
    speechMs = frameMs;
    silenceMs = 0;
    utterance = [...preRoll.map((f) => f)];
    utterance.push(frame.slice());
    preRoll.length = 0;
  }

  captureNode.port.onmessage = (e: MessageEvent) => {
    const frame = e.data as Float32Array;
    if (!(frame instanceof Float32Array) || frame.length === 0) return;
    if (muted) {
      if (inSpeech) resetUtterance();
      preRoll.length = 0;
      return;
    }
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const frameMs = (frame.length / SAMPLE_RATE) * 1000;

    // Barge-in (260705): while the companion is audible (hold), keep listening
    // at an ELEVATED threshold — echo cancellation strips most of the
    // companion's own voice, the stiffer bar rejects the residue. Real player
    // speech opens the utterance normally AND asks the owner to cut playback.
    // No noise-floor adaptation here: the echo residue must not poison it.
    if (hold && !inSpeech) {
      preRoll.push(frame.slice());
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (rms >= Math.max(BARGE_RMS_FLOOR, noiseFloor * BARGE_FACTOR)) {
        openSpeech(frame, frameMs);
        opts.onBargeIn?.();
      }
      return;
    }

    if (!inSpeech) {
      // Adapt the noise floor only outside speech so talking doesn't raise it.
      noiseFloor = noiseFloor * (1 - NOISE_ADAPT) + rms * NOISE_ADAPT;
      const threshold = Math.max(START_RMS_FLOOR, noiseFloor * START_FACTOR);
      preRoll.push(frame.slice());
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (rms >= threshold) openSpeech(frame, frameMs);
      return;
    }

    utterance.push(frame.slice());
    speechMs += frameMs;
    const endThreshold = Math.max(START_RMS_FLOOR * 0.7, noiseFloor * 2);
    if (rms < endThreshold) {
      silenceMs += frameMs;
      // Provisional transcription: overlap Whisper with the rest of the
      // silence wait (see EAGER_SILENCE_MS). One per silence run.
      if (silenceMs >= EAGER_SILENCE_MS && !eager && speechMsOf(utterance) >= MIN_UTTERANCE_MS) {
        const e: Eager = { id: 0, cancelled: false, wanted: false, done: false, text: null };
        e.id = postTranscribe(utterance, (text) => {
          if (e.cancelled) return;
          e.done = true;
          e.text = text;
          if (e.wanted && text) opts.onUtterance(text);
        });
        eager = e;
      }
    } else {
      silenceMs = 0;
      cancelEager(); // speech resumed — the provisional pass is stale
    }
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
      // Hold going up mid-speech no longer kills the utterance: with barge-in
      // the common case is the player already talking when the companion's
      // next queued clip starts — their words must survive it.
      hold = h;
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
