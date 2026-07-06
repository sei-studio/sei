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
  /** Enqueue a complete encoded clip (audio/mpeg bytes). */
  enqueue(buf: ArrayBuffer): void;
  /** Reserve the next slot for a clip that will stream in. */
  enqueueStream(): TtsStreamHandle;
  /** True while a clip is playing (or queued clips remain). */
  speaking(): boolean;
  /** Barge-in: stop playback and drop everything queued; queue stays usable. */
  clear(): void;
  /** Permanent teardown: stop playback, drop everything, refuse new work. */
  stop(): void;
}

type BufferItem = { kind: 'buffer'; buf: ArrayBuffer };
type StreamItem = {
  kind: 'stream';
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

export function createAudioQueue(onSpeakingChange: (speaking: boolean) => void): AudioQueue {
  const pending: Item[] = [];
  let current: HTMLAudioElement | null = null;
  let currentCleanup: (() => void) | null = null;
  /** An item is occupying the playhead (incl. a stream slot still waiting for
   * its first bytes, when no HTMLAudioElement exists yet). */
  let busy = false;
  let stopped = false;

  function finishCurrent(el: HTMLAudioElement): void {
    if (current !== el) return;
    currentCleanup?.();
    currentCleanup = null;
    playNext();
  }

  function playBuffer(buf: ArrayBuffer): void {
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    const el = new Audio(url);
    current = el;
    currentCleanup = () => URL.revokeObjectURL(url);
    const done = (): void => finishCurrent(el);
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    onSpeakingChange(true);
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
        playBuffer(all.buffer);
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
        onSpeakingChange(true);
      }
      return;
    }

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const el = new Audio(url);
    current = el;
    let sb: SourceBuffer | null = null;
    const backlog: ArrayBuffer[] = [...item.chunks];
    item.chunks = [];
    let srcEnded = false;

    const done = (): void => finishCurrent(el);

    const maybeFinalize = (): void => {
      if (srcEnded || !sb || sb.updating) return;
      if ((item.ended || item.failed) && backlog.length === 0 && ms.readyState === 'open') {
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
    onSpeakingChange(true);
    void el.play().catch(() => done());
  }

  function playNext(): void {
    if (stopped) {
      current = null;
      busy = false;
      onSpeakingChange(false);
      return;
    }
    const item = pending.shift();
    if (!item) {
      current = null;
      busy = false;
      onSpeakingChange(false);
      return;
    }
    busy = true;
    if (item.kind === 'buffer') playBuffer(item.buf);
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
    onSpeakingChange(false);
  }

  return {
    enqueue(buf) {
      if (stopped) return;
      pending.push({ kind: 'buffer', buf });
      if (!busy) playNext();
    },
    enqueueStream() {
      const item: StreamItem = {
        kind: 'stream',
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
    stop() {
      stopped = true;
      haltPlayback();
    },
  };
}
