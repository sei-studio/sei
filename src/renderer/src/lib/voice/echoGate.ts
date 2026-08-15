/**
 * Echo gate (260807) — is this mic "utterance" actually the SPEAKERS?
 *
 * On a call played out loud the microphone hears three voices: the player, the
 * companion's own TTS, and whatever the shared screen is playing. Chromium's
 * echo canceller subtracts only the second — it references Electron's own
 * output (the same self-referenced AEC Discord and Zoom run), and it degrades
 * exactly when it matters most: max speaker volume clips the echo, and AEC
 * models a linear path. Nothing anywhere subtracts the third — another app's
 * audio has no reference signal in Chromium, and the big call apps' answer to
 * it is "wear headphones".
 *
 * Measured 260807, two Instagram sessions on speakers at max volume: reel
 * dialogue was transcribed and dispatched as the player's own words (the
 * companion was told `the player said: "Get ready with us, but Stas is picking
 * my outfit..."` and every wrong conclusion she drew — "is that you on
 * camera?" — was correct reasoning over counterfeit input), and her own leaked
 * TTS kept confirming the word-gated barge-in, cutting her off mid-line.
 *
 * Backseat can go beyond the call apps because it already CAPTURES the system
 * audio they cannot see (the mac SCK tap / Windows loopback that feeds the
 * gain jolt and the screen transcript). This module is the pure half of the
 * fix; the wiring lives in useVoiceStore (mic side) and captureController
 * (reference side). Two independent tests, combined by the caller:
 *
 *   TEXT      the utterance's words against what the reference was saying —
 *             the companion's audible line (known exactly, zero lag) and the
 *             screen transcript ring (high precision, but Whisper chews 3 s
 *             chunks, so at utterance end the overlapping screen text often
 *             is not transcribed yet).
 *   ENVELOPE  the utterance's loudness contour against the screen audio's,
 *             cross-correlated over the speaker-path lag. Real-time (no STT
 *             lag), and the only witness when the reel is music Whisper
 *             won't transcribe — but it cannot separate double-talk, which
 *             is why it never condemns an utterance whose WORDS differ from
 *             the reference's.
 *
 * The asymmetry that shapes every threshold: wrongly dropping the player's
 * real speech is worse than missing an echo (a missed echo is the status
 * quo). Text matches condemn; the envelope alone condemns only when it is
 * strong AND there is no transcript to contradict it; everything in between
 * is 'ambiguous', which the caller resolves by waiting one bounded screen-STT
 * flush and letting the text answer.
 */

export interface EnvSample {
  /** Wall-clock ms (Date.now basis on both sides — same renderer, same clock). */
  t: number;
  /** dBFS of one short RMS window, floored at ENV_FLOOR_DB. */
  db: number;
}

export interface MicEchoInfo {
  text: string;
  /** Wall-clock bounds of the mic utterance's audio. */
  t0: number;
  t1: number;
  /** The mic's own loudness contour over [t0, t1]. */
  envelope: EnvSample[];
  /** 'barge' = the ~400ms stage-two fragment; 'utterance' = a finished line.
   * Barge decisions favor the player harder (see the callers). */
  purpose: 'utterance' | 'barge';
}

/** Envelope resolution. The mic side samples 4 sub-windows per 128 ms frame;
 *  the tap side lands near this naturally (GAIN_WINDOW_SAMPLES = ~32 ms). */
export const ENV_STEP_MS = 32;
export const ENV_FLOOR_DB = -70;

/** Reference "was actually making sound" bar, and how much of the utterance
 *  window must be over it before an echo verdict is even possible. Quiet
 *  reference → nothing to echo → clean, no correlation needed. */
export const REF_ACTIVE_DB = -50;
const REF_ACTIVE_MIN = 0.3;

/** Speaker-path lag search: mic hears the speakers LATER than the tap captures
 *  them (output buffering + air), but both streams are timestamped at arrival
 *  in the same renderer, so a little negative slack covers jitter. */
const LAG_MIN_MS = -128;
const LAG_MAX_MS = 640;
/**
 * Below this window a correlation is noise, not evidence. Calibrated on
 * synthetic burst envelopes (scratch run, 260807): max-over-lags Pearson on
 * two INDEPENDENT talk-cadence contours reads spurious p90/p99 of 0.84/0.93
 * at 1 s, 0.64/0.82 at 2 s, 0.53/0.66 at 3 s — while a true lagged copy with
 * mic jitter+noise sits at 0.86+ regardless of length. The distributions only
 * separate from ~2.5 s up, so shorter utterances get `valid: false` and their
 * verdict comes from the transcript instead.
 */
const MIN_CORR_MS = 2_500;

/** Correlation tiers, against the calibration above. STRONG may condemn on
 *  its own (music, no transcript); ECHO needs the text to at least lean the
 *  same way; SUSPECT only opens the ambiguous path (costing one bounded
 *  screen-STT flush, never a drop). */
const CORR_STRONG = 0.85;
const CORR_ECHO = 0.75;
const CORR_SUSPECT = 0.5;

/** Text-overlap tiers: fraction of the MIC utterance's tokens found in the
 *  reference text. ECHO condemns immediately; CONFIRM is enough alongside a
 *  correlating envelope; FINAL decides the post-flush ambiguous case. */
export const OVERLAP_ECHO = 0.7;
const OVERLAP_CONFIRM = 0.4;
export const OVERLAP_FINAL = 0.55;
/** Companion self-voice bar — her line is known verbatim, so a fragment of it
 *  coming back through the mic overlaps almost completely. */
export const SELF_ECHO_OVERLAP = 0.65;

/** A text-only echo verdict needs at least this many mic tokens: one or two
 *  common words ("yeah", "okay") legitimately collide with anything. Callers
 *  relax this for barge fragments, which are short by construction. */
export const MIN_ECHO_TOKENS = 3;

export function dbOf(rms: number): number {
  return rms > 0 ? Math.max(ENV_FLOOR_DB, 20 * Math.log10(rms)) : ENV_FLOOR_DB;
}

/** Append a sample and prune everything older than keepMs. Mutates `ring`. */
export function pushEnv(ring: EnvSample[], t: number, db: number, keepMs: number): void {
  ring.push({ t, db });
  while (ring.length && t - ring[0].t > keepMs) ring.shift();
}

// CJK ideographs + kana (U+2E80–U+9FFF) and hangul syllables (U+AC00–U+D7AF).
const CJK_RE = /[⺀-鿿가-힯]/;

/**
 * Tokens for overlap matching: lowercase Latin/digit runs, and — because CJK
 * has no spaces to split on — every CJK character on its own, so a fragment
 * of a sentence still overlaps its source. Bracketed/parenthesized engine
 * annotations ("[BLANK_AUDIO]", "(music)") are stripped like hasSpokenWord
 * does.
 */
export function normalizeTokens(text: string): string[] {
  const cleaned = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').toLowerCase();
  const tokens: string[] = [];
  for (const run of cleaned.matchAll(/[\p{L}\p{N}']+/gu)) {
    const w = run[0].replace(/'/g, '');
    if (!w) continue;
    if (!CJK_RE.test(w)) {
      tokens.push(w);
      continue;
    }
    let latin = '';
    for (const ch of w) {
      if (CJK_RE.test(ch)) {
        if (latin) {
          tokens.push(latin);
          latin = '';
        }
        tokens.push(ch);
      } else {
        latin += ch;
      }
    }
    if (latin) tokens.push(latin);
  }
  return tokens;
}

/** Fraction of the mic text's tokens present in the reference text. 0 when
 *  either side has nothing to say. */
export function textOverlap(micText: string, refText: string): number {
  const mic = normalizeTokens(micText);
  if (!mic.length) return 0;
  const ref = new Set(normalizeTokens(refText));
  if (!ref.size) return 0;
  let hit = 0;
  for (const t of mic) if (ref.has(t)) hit += 1;
  return hit / mic.length;
}

/** Nearest-sample lookup onto a uniform grid; gaps read as the floor. Assumes
 *  `samples` is chronological (both producers push in arrival order). */
function sampleGrid(samples: EnvSample[], startT: number, n: number): number[] {
  const out = new Array<number>(n);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const t = startT + (i + 0.5) * ENV_STEP_MS;
    while (j + 1 < samples.length && Math.abs(samples[j + 1].t - t) <= Math.abs(samples[j].t - t)) {
      j += 1;
    }
    const s = samples[j];
    out[i] = s && Math.abs(s.t - t) <= ENV_STEP_MS * 1.5 ? s.db : ENV_FLOOR_DB;
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  // A flat contour (all floor, or one steady level) correlates with nothing.
  if (saa < 1e-6 || sbb < 1e-6) return 0;
  return sab / Math.sqrt(saa * sbb);
}

export interface EnvCorrelation {
  /** Best Pearson r across the lag search (0 when not computable). */
  r: number;
  lagMs: number;
  /** Fraction of the reference window over REF_ACTIVE_DB. */
  refActive: number;
  /** Whether the window was long enough (and the reference dense enough) for
   *  r to mean anything. Invalid + active reference = ambiguous, not clean. */
  valid: boolean;
}

/**
 * Cross-correlate the mic's loudness contour against the reference's over the
 * speaker-path lag range. dB domain with mean removal, so it compares SHAPE
 * (speech cadence, cuts, beats) rather than absolute level — the speakers are
 * loud at the mic and quiet in the tap numbers, and that must not matter.
 */
export function envelopeCorrelation(
  mic: EnvSample[],
  ref: EnvSample[],
  t0: number,
  t1: number,
): EnvCorrelation {
  const inWindow = ref.filter((s) => s.t >= t0 - 200 && s.t <= t1 + 200);
  const refActive = inWindow.length
    ? inWindow.filter((s) => s.db > REF_ACTIVE_DB).length / inWindow.length
    : 0;
  const n = Math.floor((t1 - t0) / ENV_STEP_MS);
  const minSamples = MIN_CORR_MS / ENV_STEP_MS;
  const valid = t1 - t0 >= MIN_CORR_MS && inWindow.length >= minSamples / 2 && mic.length >= minSamples / 2;
  if (!valid) return { r: 0, lagMs: 0, refActive, valid };
  const micG = sampleGrid(mic, t0, n);
  let best = 0;
  let bestLag = 0;
  for (let lag = LAG_MIN_MS; lag <= LAG_MAX_MS; lag += ENV_STEP_MS) {
    const r = pearson(micG, sampleGrid(ref, t0 - lag, n));
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return { r: best, lagMs: bestLag, refActive, valid };
}

export type EchoVerdict = 'echo' | 'clean' | 'ambiguous';

/**
 * First-pass verdict on a mic utterance against the screen reference, with
 * whatever transcript has been chewed so far. 'ambiguous' means: the envelope
 * (or the reference's activity, when the window is too short to correlate)
 * points at the speakers but the words cannot confirm it yet — wait one
 * bounded screen-STT flush and ask finalScreenEcho.
 */
export function classifyScreenEcho(args: {
  corr: EnvCorrelation;
  overlap: number;
  micTokens: number;
  minTokens: number;
  refHasText: boolean;
}): EchoVerdict {
  const { corr, overlap, micTokens, minTokens, refHasText } = args;
  if (micTokens >= minTokens && overlap >= OVERLAP_ECHO) return 'echo';
  if (corr.refActive < REF_ACTIVE_MIN) return 'clean';
  if (corr.valid && corr.r >= CORR_ECHO && overlap >= OVERLAP_CONFIRM) return 'echo';
  // Music, sound effects: the envelope is the only witness there will ever be
  // (Whisper has nothing to transcribe), so a strong track condemns alone.
  if (corr.valid && corr.r >= CORR_STRONG && !refHasText) return 'echo';
  if (!corr.valid || corr.r >= CORR_SUSPECT) return 'ambiguous';
  // The reference was loud but the mic's contour doesn't track it: that is a
  // player talking over the screen (double-talk), and it stays theirs.
  return 'clean';
}

/** The post-flush decision for an 'ambiguous' utterance: the transcript tail
 *  has been pulled, so the words get the last word. */
export function finalScreenEcho(args: {
  corr: EnvCorrelation;
  overlap: number;
  micTokens: number;
  refHasText: boolean;
}): boolean {
  const { corr, overlap, micTokens, refHasText } = args;
  if (micTokens >= 2 && overlap >= OVERLAP_FINAL) return true;
  return corr.valid && corr.r >= CORR_STRONG && !refHasText;
}
