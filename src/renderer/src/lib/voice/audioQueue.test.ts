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
  listeners = new Map<string, Array<() => void>>();
  constructor(url?: string) {
    this.src = url ?? '';
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {}
  /** Fire a registered event by name (the queue registers with {once:true},
   *  which this fake ignores — tests fire each event at most once). */
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
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
 * Turn supersession (260806). Backseat turns land every 10-20 s while TTS
 * playback of a multi-part reply can run longer, so a new turn's lines used to
 * queue behind the old turn's and the spoken commentary drifted a turn behind
 * the screen. A clip tagged with a NEW turn drops the same speaker's QUEUED
 * clips from an older turn; the clip at the playhead always finishes (the
 * "current sentence ends" boundary — parts are sentence-sized).
 */
describe('audioQueue turn supersession', () => {
  /** Enqueue a blob-reserved clip whose bytes have already landed. */
  function ready(q: ReturnType<typeof createAudioQueue>, id: string, text: string, turn?: string) {
    const h = q.enqueueStream(id, text, 1, { blob: true, ...(turn ? { turn } : {}) });
    h.push(new ArrayBuffer(8));
    h.end();
    return h;
  }
  /**
   * The texts onSpeakingChange reported, consecutive repeats collapsed. The
   * FIRST clip of each queue run reports twice by design: once when its
   * reserved slot takes the playhead (bytes not yet landed — the waiting
   * placeholder), once when real playback starts. Only the ORDER is under test
   * here.
   */
  function spokenTexts(onSpeak: ReturnType<typeof vi.fn>): Array<string | undefined> {
    const texts = onSpeak.mock.calls
      .filter((c) => c[0] === true)
      .map((c) => c[2] as string | undefined);
    return texts.filter((t, i) => i === 0 || t !== texts[i - 1]);
  }

  it("a new turn drops the old turn's queued clips but never the playing one", () => {
    const onSpeak = vi.fn();
    const q = createAudioQueue(onSpeak);
    ready(q, 'sui', 'first sentence.', 'A'); // takes the playhead
    const playing = FakeAudio.instances.at(-1)!; // the realized element (index 0 is the placeholder)
    expect(playing.paused).toBe(false);
    const a2 = ready(q, 'sui', 'second sentence.', 'A'); // queued

    // Turn B arrives while A is still speaking: A's queued tail is retired.
    ready(q, 'sui', 'newer thought.', 'B');
    expect(playing.paused).toBe(false); // the current sentence is untouched

    // A2's TTS resolving later must be a no-op on a dropped item.
    a2.push(new ArrayBuffer(8));
    a2.end();

    // The current sentence ends → playback jumps straight to turn B,
    // 'second sentence.' is never spoken.
    playing.dispatch('ended');
    expect(spokenTexts(onSpeak)).toEqual(['first sentence.', 'newer thought.']);
  });

  it('untagged clips are never dropped by a tagged one', () => {
    const onSpeak = vi.fn();
    const q = createAudioQueue(onSpeak);
    ready(q, 'sui', 'greeting'); // playhead, no tag
    ready(q, 'sui', 'held line'); // queued, no tag
    ready(q, 'sui', 'backseat line', 'B');
    FakeAudio.instances.at(-1)!.dispatch('ended');
    FakeAudio.instances.at(-1)!.dispatch('ended');
    // The untagged line survived and played in order.
    expect(spokenTexts(onSpeak)).toEqual(['greeting', 'held line', 'backseat line']);
  });

  it('scopes supersession to the speaker', () => {
    const onSpeak = vi.fn();
    const q = createAudioQueue(onSpeak);
    ready(q, 'sui', 'sui old.', 'A'); // playhead
    ready(q, 'marv', 'marv line.', 'X'); // queued, other speaker
    ready(q, 'sui', 'sui new.', 'B'); // supersedes nothing of marv's
    FakeAudio.instances.at(-1)!.dispatch('ended');
    FakeAudio.instances.at(-1)!.dispatch('ended');
    expect(spokenTexts(onSpeak)).toEqual(['sui old.', 'marv line.', 'sui new.']);
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
