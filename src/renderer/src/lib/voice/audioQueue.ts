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
 * plays out in full. Each frame: sync header FF FB 90 00 then zeroed side-info +
 * main-data (silence); length 417 bytes for these params. Built at runtime (no
 * base64 asset); if the decoder ever rejects it, the append simply no-ops and we
 * fall back to today's behavior.
 */
function buildSilenceMp3(frames = 4): ArrayBuffer {
  const FRAME = 417;
  const out = new Uint8Array(FRAME * frames);
  for (let i = 0; i < frames; i++) {
    const off = i * FRAME;
    out[off] = 0xff;
    out[off + 1] = 0xfb;
    out[off + 2] = 0x90;
    out[off + 3] = 0x00;
    // remaining bytes stay 0 → decoded silence
  }
  return out.buffer;
}
const SILENCE_MP3 = buildSilenceMp3();

export function createAudioQueue(
  onSpeakingChange: (speaking: boolean, characterId: string | null, text?: string) => void,
): AudioQueue {
  const pending: Item[] = [];
  let current: HTMLAudioElement | null = null;
  let currentCleanup: (() => void) | null = null;
  /** An item is occupying the playhead (incl. a stream slot still waiting for
   * its first bytes, when no HTMLAudioElement exists yet). */
  let busy = false;
  let stopped = false;
  let outputMuted = false;

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
    applyRate(el, rate);
    current = el;
    currentCleanup = () => URL.revokeObjectURL(url);
    const done = (): void => finishCurrent(el);
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    onSpeakingChange(true, characterId, text);
    void el.play().catch(() => done());
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

  function haltPlayback(): void {
    for (const item of pending) {
      if (item.kind === 'stream') item.dropped = true;
    }
    pending.length = 0;
    if (current) {
      const el = current;
      current = null;
      currentCleanup?.();
      currentCleanup = null;
      try {
        el.pause();
        el.src = '';
      } catch {
        /* already torn down */
      }
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
      haltPlayback();
    },
    setOutputMuted(m) {
      outputMuted = m;
      if (current) current.muted = m;
    },
    stop() {
      stopped = true;
      haltPlayback();
    },
  };
}
