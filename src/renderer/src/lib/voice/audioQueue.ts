/**
 * Sequential companion-speech playback (260705).
 *
 * TTS clips arrive per say()-line / chat bubble; this queue plays them in
 * arrival order through a single HTMLAudioElement so overlapping replies never
 * talk over each other. `onSpeakingChange` drives both the UI (avatar pulse)
 * and the dictation half-duplex gate: while the companion is audible the mic
 * pipeline discards input, which — together with getUserMedia echo
 * cancellation — keeps the companion from transcribing itself.
 */

export interface AudioQueue {
  /** Enqueue an encoded clip (audio/mpeg bytes). Starts playing if idle. */
  enqueue(buf: ArrayBuffer): void;
  /** True while a clip is playing (or queued clips remain). */
  speaking(): boolean;
  /** Stop playback immediately and drop everything queued. */
  stop(): void;
}

export function createAudioQueue(onSpeakingChange: (speaking: boolean) => void): AudioQueue {
  const pending: ArrayBuffer[] = [];
  let current: HTMLAudioElement | null = null;
  let stopped = false;

  function playNext(): void {
    if (stopped) return;
    const buf = pending.shift();
    if (!buf) {
      current = null;
      onSpeakingChange(false);
      return;
    }
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    const el = new Audio(url);
    current = el;
    const done = (): void => {
      URL.revokeObjectURL(url);
      if (current === el) playNext();
    };
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    onSpeakingChange(true);
    void el.play().catch(() => done());
  }

  return {
    enqueue(buf) {
      if (stopped) return;
      pending.push(buf);
      if (!current) playNext();
    },
    speaking() {
      return current !== null;
    },
    stop() {
      stopped = true;
      pending.length = 0;
      if (current) {
        try {
          current.pause();
          current.src = '';
        } catch {
          /* already torn down */
        }
        current = null;
      }
      onSpeakingChange(false);
    },
  };
}
