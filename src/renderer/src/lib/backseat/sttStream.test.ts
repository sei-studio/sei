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
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: Msg[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
    FakeWorker.all.push(this);
  }
  postMessage(m: Msg): void {
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
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
    FakeWorker.all = [];
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

  it('a job past the ceiling replaces the wedged worker, and the stream carries on', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'ja' });
    const first = FakeWorker.last!;
    first.reply({ type: 'ready' });
    await feed(stt, 3_100);
    expect(first.jobs()).toHaveLength(1);

    // Never answers. Past 90 s the worker is terminated and replaced.
    await feed(stt, 88_000);
    expect(FakeWorker.all).toHaveLength(1);
    await feed(stt, 2_100);
    expect(first.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
    const second = FakeWorker.last!;
    expect(second.posted[0]).toMatchObject({ type: 'init', language: 'ja' });

    // Once the replacement's model is up, new audio is transcribed again.
    second.reply({ type: 'ready' });
    await feed(stt, 3_100);
    expect(second.jobs()).toHaveLength(1);
    // A late answer from the dead worker changes nothing.
    first.reply({ type: 'transcript', id: first.jobs()[0].id, text: 'ghost' });
    second.reply({ type: 'transcript', id: second.jobs()[0].id, text: 'hello there' });
    expect(stt.textAround(0, Date.now() + 1)).toBe('hello there');
    stt.stop();
  });

  it('gives up cleanly after the respawn budget: dead, no new workers, ticks still resolve', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'en' });
    for (let round = 0; round < 3; round++) {
      FakeWorker.last!.reply({ type: 'ready' });
      await feed(stt, 3_100);
      expect(FakeWorker.last!.jobs()).toHaveLength(1);
      await feed(stt, 90_100);
    }
    // One original + two replacements, all terminated; no fourth.
    expect(FakeWorker.all).toHaveLength(3);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    await feed(stt, 5_000);
    expect(FakeWorker.all).toHaveLength(3);
    const tick = stt.tickTranscript();
    await vi.advanceTimersByTimeAsync(10);
    await expect(tick).resolves.toBe('');
    stt.stop();
  });

  it('a worker crash fails the in-flight job and frees the stream', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'en' });
    const first = FakeWorker.last!;
    first.reply({ type: 'ready' });
    await feed(stt, 3_100);
    expect(first.jobs()).toHaveLength(1);
    const tick = stt.tickTranscript();

    first.onerror!({ message: 'RuntimeError: memory access out of bounds', preventDefault: () => {} });
    // The waiting tick is released at once, not at its own 1.2 s timer.
    await vi.advanceTimersByTimeAsync(0);
    await expect(tick).resolves.toBe('');
    expect(first.terminated).toBe(true);
    const second = FakeWorker.last!;
    expect(second).not.toBe(first);
    second.reply({ type: 'ready' });
    await feed(stt, 3_100);
    expect(second.jobs()).toHaveLength(1);
    stt.stop();
  });

  it('a messageerror is treated like a crash', async () => {
    const { createSttStream } = await import('./sttStream');
    const stt = createSttStream({ language: 'en' });
    const first = FakeWorker.last!;
    first.reply({ type: 'ready' });
    await feed(stt, 3_100);
    first.onmessageerror!();
    expect(first.terminated).toBe(true);
    FakeWorker.last!.reply({ type: 'ready' });
    await feed(stt, 3_100);
    expect(FakeWorker.last!.jobs()).toHaveLength(1);
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
