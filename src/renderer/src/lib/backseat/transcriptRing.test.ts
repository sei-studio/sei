/**
 * The transcript ring is what turns "we should send the STT transcript with
 * the grid" into something that works at tick time. These pin the behaviors
 * the design leans on: overlap selection (a sentence that started early still
 * rides), oldest-first truncation (the tail is the moment the tick is about),
 * retention, and the single-flight dispatch policy.
 */
import { describe, it, expect } from 'vitest';
import { pushSegment, windowText, wantDispatch, type TranscriptSegment } from './transcriptRing';
import { downmixInterleaved, resampleMono, rmsDb } from './pcm';

const seg = (t0: number, t1: number, text: string): TranscriptSegment => ({ t0, t1, text });

describe('pushSegment', () => {
  it('prunes segments older than keepMs', () => {
    const s: TranscriptSegment[] = [];
    pushSegment(s, seg(0, 3000, 'old'), 3000, 30_000);
    pushSegment(s, seg(40_000, 43_000, 'new'), 43_000, 30_000);
    expect(s.map((x) => x.text)).toEqual(['new']);
  });

  it('keeps everything inside the window', () => {
    const s: TranscriptSegment[] = [];
    for (let i = 0; i < 10; i++) {
      pushSegment(s, seg(i * 3000, i * 3000 + 3000, `c${i}`), i * 3000 + 3000, 30_000);
    }
    expect(s).toHaveLength(10);
  });
});

describe('windowText', () => {
  it('selects by overlap, not containment', () => {
    // A line that STARTED before the window opened but ran into it is what
    // the player is hearing during the grid; it must ride.
    const s = [seg(1000, 5000, 'started early'), seg(5000, 8000, 'inside')];
    expect(windowText(s, 10_000, 6000, 600)).toBe('started early inside');
  });

  it('excludes segments that ended before the window', () => {
    const s = [seg(0, 3000, 'ancient'), seg(9000, 11_000, 'recent')];
    expect(windowText(s, 12_000, 3000, 600)).toBe('recent');
  });

  it('returns empty for a silent window', () => {
    expect(windowText([], 10_000, 6000, 600)).toBe('');
    expect(windowText([seg(0, 1000, 'x')], 60_000, 6000, 600)).toBe('');
  });

  it('drops the OLDEST text when over the char cap', () => {
    const s = [seg(0, 3000, 'opening ' + 'filler '.repeat(40)), seg(3000, 6000, 'the ending words')];
    const out = windowText(s, 6000, 10_000, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain('ending words');
    expect(out).not.toContain('opening');
  });
});

describe('wantDispatch', () => {
  const base = { chunkMs: 3000, minFlushMs: 400 };

  it('waits for a full chunk in steady state', () => {
    expect(wantDispatch({ ...base, pendingMs: 2900, busy: false, flush: false })).toBe(false);
    expect(wantDispatch({ ...base, pendingMs: 3000, busy: false, flush: false })).toBe(true);
  });

  it('a flush takes any tail long enough to hold a word', () => {
    expect(wantDispatch({ ...base, pendingMs: 500, busy: false, flush: true })).toBe(true);
    // Below the floor it would only feed Whisper hallucinations.
    expect(wantDispatch({ ...base, pendingMs: 300, busy: false, flush: true })).toBe(false);
  });

  it('never dispatches over a running job (single flight)', () => {
    expect(wantDispatch({ ...base, pendingMs: 10_000, busy: true, flush: false })).toBe(false);
    expect(wantDispatch({ ...base, pendingMs: 10_000, busy: true, flush: true })).toBe(false);
  });
});

describe('pcm normalization', () => {
  it('downmixes interleaved stereo by averaging', () => {
    const stereo = new Float32Array([1, 0, 0.5, 0.5, -1, 1]);
    expect([...downmixInterleaved(stereo, 2)]).toEqual([0.5, 0.5, 0]);
  });

  it('resamples 48k to 16k at one third the length', () => {
    const input = new Float32Array(4800); // 100ms at 48k
    input.fill(0.25);
    const out = resampleMono(input, 48_000, 16_000);
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(2);
    // A constant signal must survive the boxcar + interpolation untouched.
    expect(out[Math.floor(out.length / 2)]).toBeCloseTo(0.25, 5);
  });

  it('preserves a tone through 48k -> 16k well enough to carry energy', () => {
    // 440 Hz, comfortably under the 8 kHz Nyquist of the target rate.
    const n = 48_000;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5;
    const out = resampleMono(input, 48_000, 16_000);
    // RMS of a 0.5-amplitude sine is 0.5/sqrt(2) ~ -9 dBFS; allow filter loss.
    expect(rmsDb(out)).toBeGreaterThan(-12);
    expect(rmsDb(out)).toBeLessThan(-6);
  });

  it('reports digital silence as the -100 floor', () => {
    expect(rmsDb(new Float32Array(1600))).toBe(-100);
    expect(rmsDb(new Float32Array(0))).toBe(-100);
  });
});
