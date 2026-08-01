/**
 * Barge-in fade (260708). clear() used to hard-pause the playing clip — an
 * abrupt mid-word glitch. Now the interrupted element fades to silence over a
 * short window and THEN tears down, while the queue itself flips to idle
 * immediately (state, captions, half-duplex hold, and any reply enqueued
 * during the fade behave exactly as with the old instant cut — that is the
 * "must not affect existing voice features" contract). stop() keeps the hard
 * cut: end-of-call teardown must leave nothing playing.
 *
 * Node environment: Audio/URL are stubbed; MediaSource stays undefined so the
 * queue takes the buffer path (the fade code is shared by both paths).
 *
 * 260731 also covers the pitch bus lifecycle — see the second describe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAudioQueue } from './audioQueue';

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  muted = false;
  paused = true;
  preservesPitch = true;
  playbackRate = 1;
  constructor(url?: string) {
    this.src = url ?? '';
    FakeAudio.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function playingQueue() {
  const onSpeak = vi.fn();
  const q = createAudioQueue(onSpeak);
  q.enqueue(new ArrayBuffer(8), 'sui', 'hi there', 1);
  const el = FakeAudio.instances.at(-1)!;
  expect(el.paused).toBe(false);
  return { q, el, onSpeak };
}

describe('audioQueue barge-in fade', () => {
  it('clear() flips the queue idle immediately but fades the clip before pausing it', async () => {
    const { q, el, onSpeak } = playingQueue();

    q.clear();

    // Queue state is instant — same as the old hard cut.
    expect(q.speaking()).toBe(false);
    expect(onSpeak).toHaveBeenLastCalledWith(false, null);
    // ...but the audio is still playing, mid-fade.
    expect(el.paused).toBe(false);

    await vi.advanceTimersByTimeAsync(70);
    expect(el.paused).toBe(false);
    expect(el.volume).toBeLessThan(1);
    expect(el.volume).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(120);
    expect(el.paused).toBe(true); // fade complete → torn down
  });

  it('a reply enqueued during the fade starts immediately (queue stays usable)', async () => {
    const { q, el } = playingQueue();
    q.clear();

    q.enqueue(new ArrayBuffer(8), 'sui', 'oh, go ahead', 1);
    const next = FakeAudio.instances.at(-1)!;
    expect(next).not.toBe(el);
    expect(next.paused).toBe(false); // new clip playing while the old one trails off
    expect(q.speaking()).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(el.paused).toBe(true); // the interrupted clip still tore down
    expect(next.paused).toBe(false); // without touching the new one
  });

  it('deafened output skips the fade (nothing audible to trail off)', () => {
    const { q, el } = playingQueue();
    q.setOutputMuted(true);
    q.clear();
    expect(el.paused).toBe(true); // immediate teardown, no timers pending
  });

  it('stop() remains a hard cut (end-of-call teardown leaves nothing playing)', () => {
    const { q, el } = playingQueue();
    q.stop();
    expect(el.paused).toBe(true);
    expect(q.speaking()).toBe(false);
  });
});

/**
 * The pitch shift moved off playbackRate and into a Web Audio node (260731,
 * see pitchBus.ts), so what the queue owes it is lifecycle: every clip routed
 * through the bus must be routed OUT again when it tears down, or the graph
 * accumulates a dead source node per line the companion speaks. The bus is
 * injected here because jsdom has no AudioContext, and stubbing Web Audio well
 * enough to test the real one would only be testing the stub.
 */
describe('audioQueue pitch shifting', () => {
  /** Mirrors the real bus's contract: no shift at rate 1, a detach otherwise. */
  function fakeBus() {
    const attach = vi.fn((_el: HTMLAudioElement, rate: number) => {
      if (rate === 1) return null;
      const detach = vi.fn();
      detaches.push(detach);
      return detach;
    });
    const detaches: Array<ReturnType<typeof vi.fn>> = [];
    return { bus: { attach }, attach, detaches };
  }

  it('routes a pitched clip through the bus at its rate', () => {
    const { bus, attach } = fakeBus();
    const q = createAudioQueue(vi.fn(), undefined, bus);
    q.enqueue(new ArrayBuffer(8), 'sui', 'hey!', 1.224);
    const el = FakeAudio.instances.at(-1)!;
    expect(attach).toHaveBeenCalledWith(el, 1.224);
    // The old contract set these two; nothing should any more, or the clip
    // would be pitched twice and play fast.
    expect(el.preservesPitch).toBe(true);
    expect(el.playbackRate).toBe(1);
  });

  it('detaches when the clip is torn down, so the graph does not accumulate', async () => {
    const { bus, detaches } = fakeBus();
    const q = createAudioQueue(vi.fn(), undefined, bus);
    q.enqueue(new ArrayBuffer(8), 'sui', 'hey!', 1.224);
    expect(detaches).toHaveLength(1);
    expect(detaches[0]).not.toHaveBeenCalled();

    q.clear();
    // Detach rides the element's cleanup, which runs AFTER the barge-in fade —
    // a clip yanked out of the graph mid-fade would cut instead of trailing off.
    expect(detaches[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(detaches[0]).toHaveBeenCalledTimes(1);
  });

  it('leaves an unpitched clip alone (no graph, straight to the output)', () => {
    const { bus, detaches } = fakeBus();
    const q = createAudioQueue(vi.fn(), undefined, bus);
    q.enqueue(new ArrayBuffer(8), 'marv', 'sure', 1);
    expect(detaches).toHaveLength(0);
    const el = FakeAudio.instances.at(-1)!;
    expect(el.paused).toBe(false);
  });
});
