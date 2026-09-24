import { describe, expect, it } from 'vitest';
import {
  companionAudioGapMs,
  classifyScreenEcho,
  dbOf,
  ENV_FLOOR_DB,
  ENV_STEP_MS,
  envelopeCorrelation,
  finalScreenEcho,
  MIN_ECHO_TOKENS,
  normalizeTokens,
  OVERLAP_ECHO,
  pushEnv,
  textOverlap,
  type EnvSample, shareVoiceDuring, SHARE_VOICE_LEAD_MS } from './echoGate';

/** Deterministic pseudo-random (LCG) — tests must not depend on Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A loudness contour: alternating talk-bursts and dips, 32ms cadence. */
function burstEnvelope(t0: number, ms: number, rnd: () => number): EnvSample[] {
  const out: EnvSample[] = [];
  let loud = true;
  let untilFlip = 200 + rnd() * 400;
  for (let t = 0; t < ms; t += ENV_STEP_MS) {
    untilFlip -= ENV_STEP_MS;
    if (untilFlip <= 0) {
      loud = !loud;
      untilFlip = 150 + rnd() * 450;
    }
    const base = loud ? -22 : -48;
    out.push({ t: t0 + t, db: base + (rnd() - 0.5) * 4 });
  }
  return out;
}

describe('pushEnv', () => {
  it('prunes samples older than keepMs', () => {
    const ring: EnvSample[] = [];
    for (let t = 0; t <= 10_000; t += 100) pushEnv(ring, t, -30, 2_000);
    expect(ring[0].t).toBeGreaterThanOrEqual(8_000);
    expect(ring[ring.length - 1].t).toBe(10_000);
  });
});

describe('dbOf', () => {
  it('floors silence and maps rms to dBFS', () => {
    expect(dbOf(0)).toBe(ENV_FLOOR_DB);
    expect(dbOf(1)).toBe(0);
    expect(dbOf(0.1)).toBeCloseTo(-20, 5);
  });
});

describe('normalizeTokens', () => {
  it('lowercases, strips punctuation and engine annotations', () => {
    expect(normalizeTokens('Wait, WHAT?! [BLANK_AUDIO] (music)')).toEqual(['wait', 'what']);
  });
  it('splits CJK into per-character tokens so fragments overlap', () => {
    expect(normalizeTokens('等等吧')).toEqual(['等', '等', '吧']);
    expect(normalizeTokens('고춧가루요')).toEqual(['고', '춧', '가', '루', '요']);
  });
  it('keeps latin words whole next to CJK', () => {
    expect(normalizeTokens('ok我们go')).toEqual(['ok', '我', '们', 'go']);
  });
});

describe('textOverlap', () => {
  it('is the fraction of mic tokens found in the reference', () => {
    expect(textOverlap('you always pick the shirt dresses', 'haha you always pick the shirt dresses they look good on you')).toBe(1);
    expect(textOverlap('what is this reel about', 'get ready with us')).toBe(0);
  });
  it('handles empty sides', () => {
    expect(textOverlap('', 'anything')).toBe(0);
    expect(textOverlap('anything', '')).toBe(0);
  });
});

describe('envelopeCorrelation', () => {
  it('finds a lagged copy of the reference in the mic', () => {
    const rnd = lcg(7);
    const ref = burstEnvelope(0, 3_000, rnd);
    // Mic = same contour heard ~200ms later (speaker path), a touch quieter.
    const mic = ref.map((s) => ({ t: s.t + 200, db: s.db - 6 }));
    const c = envelopeCorrelation(mic, ref, 200, 3_200);
    expect(c.valid).toBe(true);
    expect(c.r).toBeGreaterThan(0.9);
    expect(Math.abs(c.lagMs - 200)).toBeLessThanOrEqual(ENV_STEP_MS);
  });
  it('keeps independent speech under the condemning tiers over an active reference', () => {
    // Max-over-lags has a real noise floor (see MIN_CORR_MS calibration note):
    // independent contours can read ~0.5-0.7 by coincidence, which is why no
    // tier below CORR_STRONG condemns without matching words. Assert across
    // several seeds that coincidence stays under the condemn-alone bar.
    for (let seed = 0; seed < 8; seed += 1) {
      const ref = burstEnvelope(0, 3_000, lcg(seed * 2 + 7));
      const mic = burstEnvelope(0, 3_000, lcg(seed * 2 + 1_000_000));
      const c = envelopeCorrelation(mic, ref, 0, 3_000);
      expect(c.valid).toBe(true);
      expect(c.r).toBeLessThan(0.85);
    }
  });
  it('marks a short window invalid instead of guessing', () => {
    // 1.5s is a perfectly ordinary utterance and correlation cannot separate
    // echo from coincidence there — the transcript decides those.
    const ref = burstEnvelope(0, 3_000, lcg(7));
    const mic = ref.filter((s) => s.t <= 1_500).map((s) => ({ t: s.t + 200, db: s.db }));
    const c = envelopeCorrelation(mic, ref, 200, 1_700);
    expect(c.valid).toBe(false);
    expect(c.r).toBe(0);
  });
  it('reports a quiet reference as inactive', () => {
    const ref: EnvSample[] = [];
    for (let t = 0; t < 3_000; t += ENV_STEP_MS) ref.push({ t, db: -65 });
    const mic = burstEnvelope(0, 3_000, lcg(9));
    const c = envelopeCorrelation(mic, ref, 0, 3_000);
    expect(c.refActive).toBe(0);
  });
});

const CORR = (over: Partial<ReturnType<typeof envelopeCorrelation>>) => ({
  r: 0,
  lagMs: 0,
  refActive: 0,
  valid: true,
  ...over,
});

describe('classifyScreenEcho', () => {
  it('condemns on text alone with enough tokens', () => {
    const v = classifyScreenEcho({
      corr: CORR({ refActive: 0.8 }),
      overlap: OVERLAP_ECHO,
      micTokens: 5,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: true,
    });
    expect(v).toBe('echo');
  });
  it('never condemns over a quiet reference', () => {
    const v = classifyScreenEcho({
      corr: CORR({ r: 0.99, refActive: 0.1 }),
      overlap: 0,
      micTokens: 5,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: false,
    });
    expect(v).toBe('clean');
  });
  it('condemns a correlating envelope whose words lean the same way', () => {
    const v = classifyScreenEcho({
      corr: CORR({ r: 0.8, refActive: 0.7 }),
      overlap: 0.45,
      micTokens: 6,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: true,
    });
    expect(v).toBe('echo');
  });
  it('lets a strong envelope condemn music with no transcript', () => {
    const v = classifyScreenEcho({
      corr: CORR({ r: 0.9, refActive: 0.9 }),
      overlap: 0,
      micTokens: 4,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: false,
    });
    expect(v).toBe('echo');
  });
  it('keeps double-talk: active reference, non-tracking envelope, different words', () => {
    const v = classifyScreenEcho({
      corr: CORR({ r: 0.2, refActive: 0.9 }),
      overlap: 0.1,
      micTokens: 6,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: true,
    });
    expect(v).toBe('clean');
  });
  it('defers when the window was too short to correlate over an active reference', () => {
    const v = classifyScreenEcho({
      corr: CORR({ valid: false, refActive: 0.9 }),
      overlap: 0,
      micTokens: 2,
      minTokens: MIN_ECHO_TOKENS,
      refHasText: false,
    });
    expect(v).toBe('ambiguous');
  });
});

describe('finalScreenEcho', () => {
  it('lets the flushed transcript condemn', () => {
    expect(
      finalScreenEcho({ corr: CORR({ refActive: 0.9 }), overlap: 0.6, micTokens: 4, refHasText: true }),
    ).toBe(true);
  });
  it('acquits when the flushed words differ', () => {
    expect(
      finalScreenEcho({ corr: CORR({ r: 0.6, refActive: 0.9 }), overlap: 0.2, micTokens: 4, refHasText: true }),
    ).toBe(false);
  });
  it('never condemns a single common word', () => {
    expect(
      finalScreenEcho({ corr: CORR({ refActive: 0.9 }), overlap: 1, micTokens: 1, refHasText: true }),
    ).toBe(false);
  });
});

describe('companionAudioGapMs (260925 act offers)', () => {
  it('is 0 when a companion line overlaps the utterance or is still audible', () => {
    expect(companionAudioGapMs([{ t0: 1000, t1: 2500 }], 2000, 3000)).toBe(0);
    expect(companionAudioGapMs([{ t0: 1000, t1: 0 }], 5000, 6000)).toBe(0);
  });
  it('is the time since the last companion audio ended', () => {
    expect(companionAudioGapMs([{ t0: 0, t1: 1000 }, { t0: 1200, t1: 4200 }], 5000, 5600)).toBe(800);
  });
  it('ignores lines that started after the utterance, and is null with no audio before it', () => {
    expect(companionAudioGapMs([{ t0: 7000, t1: 0 }], 5000, 6000)).toBeNull();
    expect(companionAudioGapMs([], 5000, 6000)).toBeNull();
  });
});

describe('shareVoiceDuring (260925 act)', () => {
  const env = (from: number, to: number, db: number) => {
    const out: Array<{ t: number; db: number }> = [];
    for (let t = from; t <= to; t += 32) out.push({ t, db });
    return out;
  };

  it('is true when the share was audible with words during the utterance', () => {
    expect(shareVoiceDuring({ envelope: env(1_000, 2_000, -30), transcript: 'yes sir right away' }, 1_200, 1_600)).toBe(true);
  });

  it('counts speech just before the utterance started', () => {
    const e = [...env(1_000, 1_000 + 32 * 3, -30), ...env(1_200, 2_000, -80)];
    expect(shareVoiceDuring({ envelope: e, transcript: 'yes' }, 1_000 + SHARE_VOICE_LEAD_MS - 50, 1_700)).toBe(true);
  });

  it('is false for music tags, silence, or words while the window was quiet', () => {
    expect(shareVoiceDuring({ envelope: env(1_000, 2_000, -30), transcript: '[Music] ♪' }, 1_200, 1_600)).toBe(false);
    expect(shareVoiceDuring({ envelope: env(1_000, 2_000, -30), transcript: '' }, 1_200, 1_600)).toBe(false);
    expect(shareVoiceDuring({ envelope: env(1_000, 2_000, -70), transcript: 'hello there' }, 1_200, 1_600)).toBe(false);
  });

  it('is null with no share audio in the window', () => {
    expect(shareVoiceDuring({ envelope: [], transcript: 'hello' }, 1_200, 1_600)).toBeNull();
    expect(shareVoiceDuring({ envelope: env(5_000, 6_000, -30), transcript: 'hello' }, 1_200, 1_600)).toBeNull();
  });
});

