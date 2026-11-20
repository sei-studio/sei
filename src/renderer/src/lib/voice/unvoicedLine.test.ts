/**
 * Unvoiced lines (261121, T507): a line whose TTS failed is still shown, and
 * the generic voice-failure notice is shown once, cleared by audio, and not
 * flashed again within the gap. Plus the queue contract the store relies on:
 * a failed slot reports onDone(false) when it reaches the PLAYHEAD, so an
 * unvoiced line is captioned in the order it would have been spoken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createVoiceFailNoticeGate,
  genericTtsFailureKind,
  nextUnvoicedRun,
  UNVOICED_RUN_MAX_LINES,
  UNVOICED_RUN_MS,
  VOICE_FAIL_NOTICE_GAP_MS,
} from './unvoicedLine';
import { createAudioQueue } from './audioQueue';

describe('nextUnvoicedRun', () => {
  it('starts a run with the line itself', () => {
    const run = nextUnvoicedRun(null, '', 'sui', ' wait, really? ', 1000);
    expect(run.caption).toBe('wait, really?');
    expect(run.lines).toEqual(['wait, really?']);
  });

  it('joins lines of one reply so the whole reply stays readable', () => {
    let run = nextUnvoicedRun(null, '', 'sui', 'wait, really?', 1000);
    run = nextUnvoicedRun(run, run.caption, 'sui', 'show me where.', 2000);
    expect(run.caption).toBe('wait, really? show me where.');
  });

  it('joins CJK lines without a space', () => {
    let run = nextUnvoicedRun(null, '', 'sui', '真的吗？', 1000);
    run = nextUnvoicedRun(run, run.caption, 'sui', '带我去看看。', 2000);
    expect(run.caption).toBe('真的吗？带我去看看。');
  });

  it('keeps only the newest lines of a long run', () => {
    let run = nextUnvoicedRun(null, '', 'sui', 'one.', 0);
    for (const [i, l] of ['two.', 'three.', 'four.'].entries()) {
      run = nextUnvoicedRun(run, run.caption, 'sui', l, (i + 1) * 100);
    }
    expect(run.lines).toHaveLength(UNVOICED_RUN_MAX_LINES);
    expect(run.caption).toBe('two. three. four.');
  });

  it('starts over for another speaker, after the window, or when the caption moved on', () => {
    const first = nextUnvoicedRun(null, '', 'sui', 'hi.', 0);
    expect(nextUnvoicedRun(first, first.caption, 'lyra', 'hey.', 100).caption).toBe('hey.');
    expect(nextUnvoicedRun(first, first.caption, 'sui', 'later.', UNVOICED_RUN_MS + 1).caption).toBe('later.');
    // An audible line replaced the caption in between.
    expect(nextUnvoicedRun(first, 'something she said out loud', 'sui', 'next.', 100).caption).toBe('next.');
  });
});

describe('createVoiceFailNoticeGate', () => {
  it('shows once while up, clears on audio, and waits out the gap before showing again', () => {
    const gate = createVoiceFailNoticeGate();
    expect(gate.failed(0)).toBe(true);
    expect(gate.failed(10)).toBe(false); // already up
    expect(gate.audible()).toBe(true); // clear it
    expect(gate.audible()).toBe(false); // nothing up any more
    expect(gate.failed(1000)).toBe(false); // inside the gap
    expect(gate.failed(VOICE_FAIL_NOTICE_GAP_MS)).toBe(true);
  });

  it('reset forgets the gap (a new call)', () => {
    const gate = createVoiceFailNoticeGate();
    gate.failed(0);
    gate.audible();
    gate.reset();
    expect(gate.failed(1)).toBe(true);
  });
});

describe('genericTtsFailureKind', () => {
  it('points cloud and Fish failures at the connection, on-device ones at the line', () => {
    expect(genericTtsFailureKind('VOICE_TTS_FAILED: fetch failed', false)).toBe('connection');
    expect(genericTtsFailureKind('', false)).toBe('connection');
    expect(genericTtsFailureKind('VOICE_TTS_FAILED: Kokoro produced no usable audio', true)).toBe('local');
  });

  it('a companion with no voice, or BYOK with no key, is not a voice failure', () => {
    expect(genericTtsFailureKind('VOICE_DISABLED: this companion has no voice', false)).toBeNull();
    expect(
      genericTtsFailureKind('VOICE_NOT_CONFIGURED: add your ElevenLabs key in Settings to enable voice', false),
    ).toBeNull();
  });
});

describe('a failed slot reports at the playhead (queue contract)', () => {
  class FakeAudio {
    static instances: FakeAudio[] = [];
    src: string;
    volume = 1;
    muted = false;
    paused = true;
    listeners = new Map<string, Array<() => void>>();
    constructor(url?: string) {
      this.src = url ?? '';
      FakeAudio.instances.push(this);
    }
    addEventListener(type: string, fn: () => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(): void {}
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
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a line that fails behind a playing clip reports when that clip ends, not before', () => {
    const q = createAudioQueue(vi.fn());
    const first = q.enqueueStream('sui', 'first line', 1, { blob: true });
    const secondDone = vi.fn();
    const second = q.enqueueStream('sui', 'second line', 1, { blob: true, onDone: secondDone });
    first.push(new ArrayBuffer(8));
    first.end();
    const el = FakeAudio.instances.at(-1)!;
    second.fail(); // its fetch failed while the first line is still playing
    expect(secondDone).not.toHaveBeenCalled();
    el.dispatch('ended');
    expect(secondDone).toHaveBeenCalledWith(false);
  });

  it('a line that fails at the playhead reports at once', () => {
    const q = createAudioQueue(vi.fn());
    const done = vi.fn();
    const slot = q.enqueueStream('sui', 'only line', 1, { blob: true, onDone: done });
    slot.fail();
    expect(done).toHaveBeenCalledWith(false);
  });
});
