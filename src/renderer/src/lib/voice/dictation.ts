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
// 450ms (was 700 → 550 → 450): every ms here is dead air on the player's end of
// the call — the whole reply pipeline (Whisper + LLM + TTS) queues behind
// utterance-end detection. The eager provisional Whisper pass (EAGER_SILENCE_MS)
// already fires at 250ms and usually has the final transcript ready by here, so
// trimming this window shaves ~100ms off perceived response time with little
// risk of clipping a natural pause.
const END_SILENCE_MS = 450;
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
// self-triggering. Tuned above START_FACTOR=3 with margin. 260706: raised
// 0.03 → 0.05 — 0.03 sat only ~3-5x post-AEC residue, low enough that a clip's
// own loud onset transient could self-trigger a barge-in.
// Raised again 0.05 -> 0.065 (260706): on laptop SPEAKERS (no headphones) the
// companion's own voice leaks past AEC well above 0.05 and kept cutting itself
// off; ~0.065 clears typical speaker-echo residue while an intentional
// interruption (which is louder still) lands normally.
const BARGE_RMS_FLOOR = 0.065;
const BARGE_FACTOR = 7;
// 260706: barge-in grace window. AEC needs time to converge on each NEW clip's
// audio; during that window the companion's own onset echoes into the mic above
// the barge bar and self-triggers a barge-in that cuts the clip off after a
// split second (the "I only heard 'hey'" bug). Ignore barge-in for this long
// after each clip starts playing (setHold(true)); genuine barge-in over a
// longer clip still lands once the window passes.
const BARGE_GRACE_MS = 600;
// 260706: barge-in must be SUSTAINED, not a single frame. Playing the call out
// loud (speakers, not headphones) leaks the companion's own voice past echo
// cancellation; a lone loud frame of that residue used to trip a barge-in and
// clear the queue, cutting the companion off mid-sentence (the "lines get cut
// off" bug). Real player speech holds above the barge bar for a beat, so we
// require this much CONTINUOUS elevated energy before it counts — brief echo
// peaks reset the run and never fire. ~3 frames at ~128ms each.
// Raised 320 -> 480 (260706): a longer continuous run is needed to count as a
// barge-in, so a burst of speaker-echo residue can't trip it — only sustained
// real speech does. ~3-4 frames at ~128ms each.
// Lowered 480 -> 300 (260708, "interrupt faster"): frames land every ~128ms,
// so the confirm quantizes to whole frames — 480 fired on the 4th consecutive
// over-bar frame (~512ms of the player talking over the companion), 300 fires
// on the 3rd (~384ms). The single-frame echo peaks the sustained-run gate
// exists for still reset the run and never reach 3 frames; the residual risk
// (a 3-frame speaker-echo burst) is also softer now that a barge-in FADES the
// clip out (audioQueue clear) instead of hard-cutting it. If speaker users
// report self-interruptions again, this is the knob to raise (4 frames = 400+).
const BARGE_CONFIRM_MS = 300;

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
  /** Fires true when the player's live mic speech opens and false when it ends —
   * drives the "you're talking" ring on the caller's own avatar (same lit ring
   * the companions get while speaking). Edge-emitted, so it only fires on change. */
  onSpeechActive?: (active: boolean) => void;
}): Promise<Dictation> {
  opts.onStatus('loading-model');

  // Worker first — if the model can't load there is no point holding the mic.
  const worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const inflight = new Map<number, (text: string) => void>();
  const ready = new Promise<void>((resolve, reject) => {
    const watchdog = setTimeout(
      () => reject(new Error('voice recognition took too long to download, check your connection and retry')),
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
        // autoGainControl OFF (260706): AGC dynamically boosts a quiet mic, which
        // makes our absolute-RMS energy VAD read "hotter" (ambient noise + speaker
        // echo cross the thresholds) and fights AEC's convergence — the "mic feels
        // too sensitive" report. Off gives a stable signal the fixed thresholds
        // can trust, which is the standard choice for energy-based VAD pipelines.
        autoGainControl: false,
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
  /** When the current companion clip started playing (setHold(true)); basis for
   * the barge-in grace window that stops a clip's own onset from self-barging. */
  let holdSince = 0;
  /** Running length of continuous over-the-barge-bar energy during hold; a real
   * barge-in only fires once this clears BARGE_CONFIRM_MS (see there). */
  let bargeRunMs = 0;
  let noiseFloor = 0.008;
  let inSpeech = false;
  let silenceMs = 0;
  let speechMs = 0;
  const preRoll: Float32Array[] = [];
  let utterance: Float32Array[] = [];

  /** Edge-emit the player's live speaking state (for the caller's own avatar
   * ring). Deduped so it only fires on a genuine transition. */
  let speechEmitted = false;
  function emitSpeech(active: boolean): void {
    if (active === speechEmitted) return;
    speechEmitted = active;
    opts.onSpeechActive?.(active);
  }

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
    emitSpeech(false);
  }

  function flushUtterance(): void {
    const frames = utterance;
    const pendingEager = eager;
    eager = null; // ownership transfers below; resetUtterance must not cancel it
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
    emitSpeech(false);
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
    emitSpeech(true);
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
      // Grace window: for the first BARGE_GRACE_MS of a clip, ignore threshold
      // crossings — that early audio is almost always the clip's own onset
      // echoing back before AEC converges, not the player barging in. After the
      // window, a genuine barge-in over a longer clip still opens normally.
      const overBar =
        rms >= Math.max(BARGE_RMS_FLOOR, noiseFloor * BARGE_FACTOR) &&
        performance.now() - holdSince >= BARGE_GRACE_MS;
      if (overBar) {
        // Sustained-energy gate: only a CONTINUOUS run past the bar is a real
        // barge-in. A single echo peak from the companion's own clip (common on
        // speakers) bumps the run but falls back below the bar next frame,
        // resetting it — so it never cuts the clip off. Genuine speech holds.
        bargeRunMs += frameMs;
        if (bargeRunMs >= BARGE_CONFIRM_MS) {
          bargeRunMs = 0;
          openSpeech(frame, frameMs);
          opts.onBargeIn?.();
        }
      } else {
        bargeRunMs = 0;
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
      // next queued clip starts — their words must survive it. Re-arm the
      // barge-in grace window on each clip start so its onset can't self-barge.
      if (h) holdSince = performance.now();
      bargeRunMs = 0; // any hold transition restarts the sustained-barge count
      hold = h;
    },
    speechActive: () => inSpeech,
    stop() {
      emitSpeech(false);
      try { captureNode.port.onmessage = null; } catch { /* torn down */ }
      try { captureNode.disconnect(); source.disconnect(); sink.disconnect(); } catch { /* torn down */ }
      void ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      worker.terminate();
      inflight.clear();
    },
  };
}
