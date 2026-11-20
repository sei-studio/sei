/**
 * sttStream job pacing (261121). A Whisper slower than real time must never
 * have more than one backseat job in flight: v0.7.0 re-dispatched every 15 s
 * regardless, the worker ran them all concurrently, and the backlog grew
 * until the renderer ran out of memory (backseat renderer_gone 'oom').
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../voice/mirrorPref', () => ({ whisperMirrorFirst: () => false }));

type Msg = { type: string; id?: number; audio?: Float32Array };

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: Msg[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: Msg): void {
    this.posted.push(m);
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
  jobs(): Msg[] {
    return this.posted.filter((m) => m.type === 'transcribe');
  }
}

const RATE = 16_000;
/** 100 ms of audio loud enough to clear the silence floor. */
function chunk(): Float32Array {
  const a = new Float32Array(RATE / 10);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 3) * 0.3;
  return a;
}

describe('createSttStream job pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function feed(stt: { push: (p: Float32Array) => void }, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 100) {
      stt.push(chunk());
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  it('keeps one job in flight while Whisper runs slower than real time', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'en' });
    const w = FakeWorker.last!;
    w.reply({ type: 'ready' });

    await feed(stt, 3_100);
    expect(w.jobs()).toHaveLength(1);

    // A minute of audio, with ticks flushing along the way, and no answer.
    for (let i = 0; i < 6; i++) {
      const tick = stt.tickTranscript();
      await feed(stt, 10_000);
      await expect(tick).resolves.toBe('');
    }
    expect(w.jobs()).toHaveLength(1);

    // The late answer lands, and the next job carries only the newest audio
    // (capped at 10 s), not a backlog.
    w.reply({ type: 'transcript', id: w.jobs()[0].id, text: 'late words' });
    expect(w.jobs()).toHaveLength(2);
    expect(w.jobs()[1].audio!.length).toBeLessThanOrEqual(10.1 * RATE);
    stt.stop();
  });

  it('a slow job still releases the tick that flushed it', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'en' });
    const w = FakeWorker.last!;
    w.reply({ type: 'ready' });
    await feed(stt, 3_100);
    const tick = stt.tickTranscript();
    await vi.advanceTimersByTimeAsync(1_300);
    await expect(tick).resolves.toBe('');
    stt.stop();
  });
});
