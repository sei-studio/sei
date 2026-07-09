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
