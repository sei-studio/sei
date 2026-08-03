/**
 * Sequential companion-speech playback (260705).
 *
 * TTS clips arrive per say()-line / chat bubble; this queue plays them in
 * arrival order through a single HTMLAudioElement so overlapping replies never
 * talk over each other. `onSpeakingChange` drives both the UI (avatar pulse)
 * and the dictation half-duplex hold (barge-in listening while audible).
 *
 * 260705 streaming: enqueueStream() reserves a queue slot BEFORE the audio
 * exists and plays it through MediaSource as chunks arrive from the proxy's
 * ElevenLabs stream — first audio lands as soon as the first mp3 chunk does,
 * instead of after the whole clip downloads. Slots are reserved at request
 * time, so reply order is preserved even when fetches resolve out of order.
 * When MSE can't take audio/mpeg (never on Chromium in practice) the handle
 * degrades to collect-then-play.
 *
 * clear() (barge-in) drops everything without killing the queue; stop() is
 * the permanent end-of-call teardown.
 */

export interface TtsStreamHandle {
  /** Append encoded audio/mpeg bytes as they arrive. */
  push(chunk: ArrayBuffer): void;
  /** All chunks delivered — the clip may finish playing out. */
  end(): void;
  /** Upstream failed. Whatever already arrived plays out; nothing more comes. */
  fail(): void;
}

export interface AudioQueue {
  /** Enqueue a complete encoded clip (audio/mpeg bytes) spoken by `characterId`.
   * `text` is the line being spoken, reported back via onSpeakingChange when this
   * clip reaches the playhead so captions track the audio (not the enqueue order).
   * `rate` (default 1) plays the clip with preservesPitch OFF, so >1 raises both
   * pitch and pace — the per-character voice-pitch knob (ElevenLabs has no pitch
   * parameter, so the shift happens here at playback). */
  enqueue(buf: ArrayBuffer, characterId: string, text?: string, rate?: number): void;
  /** Reserve the next slot for a clip (spoken by `characterId`) that will stream in.
   * `text` is the line being spoken, `rate` the pitch/pace shift (see enqueue). */
  enqueueStream(characterId: string, text?: string, rate?: number): TtsStreamHandle;
  /** True while a clip is playing (or queued clips remain). */
  speaking(): boolean;
  /** Barge-in: stop playback and drop everything queued; queue stays usable. */
  clear(): void;
  /**
   * Provisional barge-in (260804): duck the current clip almost to silence
   * without stopping it, so it can be brought back if the noise that triggered
   * this turns out not to have been a word.
   *
   * This is what lets the barge-in trigger be a hair-trigger. A false clear()
   * destroys the line; a false duck costs a couple of hundred milliseconds of
   * volume and is inaudible once the clip resumes.
   */
  duck(ducked: boolean): void;
  /** Deafen (260705): silence the output without pausing it — clips keep
   * "playing" (order/timing preserved) so undeafening rejoins live. */
  setOutputMuted(muted: boolean): void;
  /** Permanent teardown: stop playback, drop everything, refuse new work. */
  stop(): void;
}

type BufferItem = { kind: 'buffer'; buf: ArrayBuffer; characterId: string; text?: string; rate: number };
type StreamItem = {
  kind: 'stream';
  /** Which companion is speaking this clip (drives per-companion speaking state). */
  characterId: string;
  /** The line being spoken — surfaced to captions when this clip starts playing. */
  text?: string;
  /** Pitch/pace shift applied at playback (preservesPitch off; 1 = as recorded). */
  rate: number;
  chunks: ArrayBuffer[];
  ended: boolean;
  failed: boolean;
  dropped: boolean;
  /** Set while this item is the one playing — new chunks flow straight in. */
  onChunk: ((c: ArrayBuffer) => void) | null;
  onEnd: (() => void) | null;
};
type Item = BufferItem | StreamItem;

const canStreamMpeg = (): boolean =>
  typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');

/**
 * A short run of silent MPEG-1 Layer III frames (128kbps, 44.1kHz), appended to
 * the END of every TTS clip. Chromium's MP3 decoder needs the NEXT frame header
 * to finalize the previous frame, so the true last frame of a clip gets dropped
 * at end-of-stream — heard as the last word cut off abruptly. A few trailing
 * silent frames (~100ms) give the real final frame something to lean on so it
 * plays out in full. Each frame: sync header FF FB 90 C4 then zeroed side-info +
 * main-data (silence); length 417 bytes for these params. Built at runtime (no
 * base64 asset); if the decoder ever rejects it, the append simply no-ops and we
 * fall back to today's behavior.
 *
 * 260726: the 4th header byte was 0x00, which declares STEREO. Every clip
 * ElevenLabs returns under main's ELEVENLABS_OUTPUT_FORMAT (mp3_44100_128) is
 * MONO (verified against cached clips: their frames are FF FB 90 C4), so the
 * padding forced a channel-mode change at the exact frame boundary the padding
 * exists to protect. 0xC4 matches the stream: mode 11 (single channel),
 * original bit set, no emphasis. Keep this header in sync if the output format
 * constant in src/main/voice/tts.ts ever changes — bitrate and sample rate are
 * baked into both this header and FRAME.
 */
function buildSilenceMp3(frames = 4): ArrayBuffer {
  const FRAME = 417;
  const out = new Uint8Array(FRAME * frames);
  for (let i = 0; i < frames; i++) {
    const off = i * FRAME;
    out[off] = 0xff;
    out[off + 1] = 0xfb;
    out[off + 2] = 0x90;
    out[off + 3] = 0xc4;
    // remaining bytes stay 0 → decoded silence
  }
  return out.buffer;
}
const SILENCE_MP3 = buildSilenceMp3();

export function createAudioQueue(
  onSpeakingChange: (speaking: boolean, characterId: string | null, text?: string) => void,
  /**
   * 260726: a clip just produced its FIRST audible sample. Distinct from
   * onSpeakingChange(true), which fires when the slot reaches the playhead —
   * for a streamed clip that is before the TTS request has even been sent, so
   * the whole synthesis round trip sits between the two. The barge-in grace
   * window (AEC convergence) must be armed from THIS event, not from the slot:
   * on the call's first line the round trip is the coldest of the session and
   * used to consume the entire window in silence, leaving the greeting
   * interruptible from its first spoken word. Fires once per clip.
   */
  onAudible?: () => void,
): AudioQueue {
  const pending: Item[] = [];
  let current: HTMLAudioElement | null = null;
  let currentCleanup: (() => void) | null = null;
  /** An item is occupying the playhead (incl. a stream slot still waiting for
   * its first bytes, when no HTMLAudioElement exists yet). */
  let busy = false;
  let stopped = false;
  let outputMuted = false;
  /** Provisional barge-in: the current clip is playing at DUCK_VOLUME pending a
   *  transcript that says a word was actually spoken. Sticky across clips —
   *  while the player might be talking, the next clip must not start at full
   *  volume either. */
  let ducked = false;

  function finishCurrent(el: HTMLAudioElement): void {
    if (current !== el) return;
    currentCleanup?.();
    currentCleanup = null;
    playNext();
  }

  /** Apply the clip's pitch/pace shift. preservesPitch OFF makes playbackRate a
   * true pitch shift (rate 1.25 ≈ +4 semitones and 25% faster) — the "clearly
   * AI" voice knob; ElevenLabs itself has no pitch parameter. */
  function applyRate(el: HTMLAudioElement, rate: number): void {
    if (rate === 1) return;
    el.preservesPitch = false;
    el.playbackRate = rate;
  }

  function playBuffer(buf: ArrayBuffer, characterId: string, rate: number, text?: string): void {
    // Trailing silence so the decoder plays the real final frame (see SILENCE_MP3).
    const url = URL.createObjectURL(new Blob([buf, SILENCE_MP3], { type: 'audio/mpeg' }));
    const el = new Audio(url);
    el.muted = outputMuted;
    // A clip enqueued while a provisional barge-in is open must not start at
    // full volume: the player may still be mid-sentence.
    el.volume = ducked ? DUCK_VOLUME : 1;
    applyRate(el, rate);
    current = el;
    currentCleanup = () => URL.revokeObjectURL(url);
    const done = (): void => finishCurrent(el);
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    markAudibleOnPlay(el);
    onSpeakingChange(true, characterId, text);
    void el.play().catch(() => done());
  }

  /** Fire onAudible the first time this element actually produces sound. Once
   * only: a streamed clip that stalls waiting for chunks fires 'playing' again
   * on resume, and re-arming the grace there would make a choppy clip
   * progressively harder to interrupt. */
  function markAudibleOnPlay(el: HTMLAudioElement): void {
    if (!onAudible) return;
    el.addEventListener(
      'playing',
      () => {
        if (current === el) onAudible();
      },
      { once: true },
    );
  }

  function playStream(item: StreamItem): void {
    // Degraded path (no MSE for mpeg): collect-then-play.
    if (!canStreamMpeg()) {
      const playCollected = (): void => {
        if (item.dropped) return; // cleared while waiting
        const total = item.chunks.reduce((n, c) => n + c.byteLength, 0);
        if (total === 0) {
          playNext();
          return;
        }
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of item.chunks) {
          all.set(new Uint8Array(c), off);
          off += c.byteLength;
        }
        playBuffer(all.buffer, item.characterId, item.rate, item.text);
      };
      if (item.ended || item.failed) playCollected();
      else {
        // Hold the playhead with a droppable placeholder so clear()/stop()
        // reach this waiting slot and later enqueues don't double-start.
        item.onEnd = playCollected;
        current = new Audio();
        currentCleanup = () => {
          item.dropped = true;
          item.onEnd = null;
        };
        onSpeakingChange(true, item.characterId, item.text);
      }
      return;
    }

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const el = new Audio(url);
    el.muted = outputMuted;
    // A clip enqueued while a provisional barge-in is open must not start at
    // full volume: the player may still be mid-sentence.
    el.volume = ducked ? DUCK_VOLUME : 1;
    applyRate(el, item.rate);
    current = el;
    let sb: SourceBuffer | null = null;
    const backlog: ArrayBuffer[] = [...item.chunks];
    item.chunks = [];
    let srcEnded = false;
    let silencePadded = false;

    const done = (): void => finishCurrent(el);

    const maybeFinalize = (): void => {
      if (srcEnded || !sb || sb.updating) return;
      if ((item.ended || item.failed) && backlog.length === 0 && ms.readyState === 'open') {
        // On a clean end, append a few trailing silent frames BEFORE closing the
        // stream so the decoder emits the true final frame instead of dropping it
        // (the clipped-last-word symptom). One pass; skipped on a failed stream.
        if (item.ended && !item.failed && !silencePadded) {
          silencePadded = true;
          backlog.push(SILENCE_MP3.slice(0));
          pump();
          return;
        }
        srcEnded = true;
        try {
          ms.endOfStream();
        } catch {
          done();
          return;
        }
        // Zero bytes ever appended → no 'ended' event will come; move on.
        if (el.readyState === 0) done();
      }
    };

    const pump = (): void => {
      if (!sb || sb.updating || srcEnded) return;
      const next = backlog.shift();
      if (next) {
        try {
          sb.appendBuffer(next);
        } catch {
          done();
        }
        return;
      }
      maybeFinalize();
    };

    ms.addEventListener(
      'sourceopen',
      () => {
        if (current !== el) return; // cleared/stopped while opening
        try {
          sb = ms.addSourceBuffer('audio/mpeg');
        } catch {
          done();
          return;
        }
        sb.addEventListener('updateend', pump);
        sb.addEventListener('error', done, { once: true });
        pump();
      },
      { once: true },
    );

    item.onChunk = (c) => {
      backlog.push(c);
      pump();
    };
    item.onEnd = () => pump();

    currentCleanup = () => {
      item.onChunk = null;
      item.onEnd = null;
      item.dropped = true;
      URL.revokeObjectURL(url);
    };
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    markAudibleOnPlay(el);
    onSpeakingChange(true, item.characterId, item.text);
    void el.play().catch(() => done());
  }

  function playNext(): void {
    if (stopped) {
      current = null;
      busy = false;
      onSpeakingChange(false, null);
      return;
    }
    const item = pending.shift();
    if (!item) {
      current = null;
      busy = false;
      onSpeakingChange(false, null);
      return;
    }
    busy = true;
    if (item.kind === 'buffer') playBuffer(item.buf, item.characterId, item.rate, item.text);
    else if (item.dropped || (item.failed && item.chunks.length === 0)) playNext();
    else playStream(item);
  }

  /**
   * Barge-in fade (260708): a hard el.pause() cut mid-word sounds like a glitch,
   * not like someone stopping talking. On clear() the interrupted clip instead
   * ramps volume to 0 over this window, then tears down — long enough to read
   * as a natural trail-off, short enough that the companion is effectively
   * silent the moment the player speaks. Queue state flips IMMEDIATELY (the
   * fading element is already detached), so a reply enqueued during the fade
   * starts on time and every other behavior (speaking state, half-duplex hold,
   * remote-end drain) sees the same instant-stop the hard cut gave.
   */
  const BARGE_FADE_MS = 140;
  const FADE_STEP_MS = 16;

  /**
   * Duck level and ramp (260804).
   *
   * Not zero. At exactly 0 an undeafened resume is a hard edge back to full
   * volume, and more importantly a duck that turns out to be wrong should read
   * as the companion briefly dropping her voice, not as a dropout. 0.08 is
   * about -22 dB: unmistakably "she stopped" from across a room, and quiet
   * enough that the echo the mic picks up collapses to near the noise floor,
   * which is what lets the VAD track the player's speech on normal thresholds
   * while she is still technically playing.
   *
   * The ramp is short because the whole point is speed: this is the part of the
   * barge-in the player actually perceives, and it now happens roughly three
   * times sooner than the old hard cut did.
   */
  const DUCK_VOLUME = 0.08;
  const DUCK_RAMP_MS = 60;

  let duckRamp = 0;
  function rampVolume(el: HTMLAudioElement, to: number): void {
    clearTimeout(duckRamp);
    const from = el.volume;
    if (from === to) return;
    const t0 = performance.now();
    const step = (): void => {
      if (current !== el) return;
      const k = Math.min(1, (performance.now() - t0) / DUCK_RAMP_MS);
      try {
        el.volume = from + (to - from) * k;
      } catch {
        return;
      }
      if (k < 1) duckRamp = window.setTimeout(step, FADE_STEP_MS);
    };
    step();
  }

  function fadeThenTeardown(el: HTMLAudioElement, cleanup: (() => void) | null, ms: number): void {
    const teardown = (): void => {
      try {
        el.pause();
        el.src = '';
      } catch {
        /* already torn down */
      }
      cleanup?.();
    };
    // Deafened or already silent → nothing audible to fade.
    if (ms <= 0 || el.muted || el.volume <= 0 || el.paused) {
      teardown();
      return;
    }
    const v0 = el.volume;
    const t0 = performance.now();
    const step = (): void => {
      const k = (performance.now() - t0) / ms;
      if (k >= 1) {
        teardown();
        return;
      }
      try {
        el.volume = v0 * (1 - k);
      } catch {
        teardown();
        return;
      }
      setTimeout(step, FADE_STEP_MS);
    };
    step();
  }

  function haltPlayback(fadeMs = 0): void {
    for (const item of pending) {
      if (item.kind === 'stream') item.dropped = true;
    }
    pending.length = 0;
    if (current) {
      const el = current;
      const cleanup = currentCleanup;
      current = null;
      currentCleanup = null;
      // cleanup (stream handler detach / URL revoke) runs AFTER the fade — a
      // MediaSource clip revoked mid-fade would cut instead of trailing off.
      fadeThenTeardown(el, cleanup, fadeMs);
    }
    busy = false;
    onSpeakingChange(false, null);
  }

  return {
    enqueue(buf, characterId, text, rate = 1) {
      if (stopped) return;
      pending.push({ kind: 'buffer', buf, characterId, text, rate });
      if (!busy) playNext();
    },
    enqueueStream(characterId, text, rate = 1) {
      const item: StreamItem = {
        kind: 'stream',
        characterId,
        text,
        rate,
        chunks: [],
        ended: false,
        failed: false,
        dropped: false,
        onChunk: null,
        onEnd: null,
      };
      const handle: TtsStreamHandle = {
        push(chunk) {
          if (item.dropped || item.ended || item.failed) return;
          if (item.onChunk) item.onChunk(chunk);
          else item.chunks.push(chunk);
        },
        end() {
          if (item.dropped || item.ended || item.failed) return;
          item.ended = true;
          item.onEnd?.();
        },
        fail() {
          if (item.dropped || item.ended || item.failed) return;
          item.failed = true;
          item.onEnd?.();
        },
      };
      if (stopped) {
        item.dropped = true;
        return handle;
      }
      pending.push(item);
      if (!busy) playNext();
      return handle;
    },
    speaking() {
      return busy;
    },
    clear() {
      if (stopped) return;
      // The barge is confirmed, so the duck is spent: whatever is enqueued next
      // is the reply to what the player just said and plays at full volume.
      ducked = false;
      clearTimeout(duckRamp);
      // Barge-in: the short fade reads as a human stopping mid-sentence
      // instead of an audio glitch (see fadeThenTeardown).
      haltPlayback(BARGE_FADE_MS);
    },
    duck(next) {
      if (stopped || next === ducked) return;
      ducked = next;
      if (current) rampVolume(current, next ? DUCK_VOLUME : 1);
    },
    setOutputMuted(m) {
      outputMuted = m;
      if (current) current.muted = m;
    },
    stop() {
      stopped = true;
      clearTimeout(duckRamp);
      // End-of-call teardown stays a hard cut: nothing may keep playing after
      // the call object is gone (HMR / hang-up chime timing rely on this).
      haltPlayback(0);
    },
  };
}
