/**
 * Backseat salience gate (260728) — PARKED 260801, nothing calls this.
 *
 * It was retired rather than retuned, and the reason is measurement, not taste.
 * Run over 61 real grids from Valorant footage, the small VLM's yes-bias turned
 * out to be intrinsic rather than a prompt problem: the structured variant
 * returned "static" on 0 of 61 grids. The successor idea — have it narrate
 * instead of judge, and wake on narration novelty — was measured against its own
 * resampling ceiling (0.749) and an unrelated-grid floor (0.623) and scored
 * 0.660 for narrations three seconds apart. That is 0.037 of real temporal
 * signal against 0.25 of pure resampling noise. Prose, prose with cell labels,
 * six separate images, and structured JSON were all tried. None separate.
 *
 * A randomised timer (nextIdleDelayMs) does the same job for free and, unlike a
 * gate, cannot be wrong in a way that is invisible. See
 * .planning/backseat-v2-260801.md for the full numbers.
 *
 * The file stays because the measurement apparatus around it (logprob reading
 * on DeepInfra, the quantile window) is the expensive part to rebuild, and
 * salienceGate.test.ts still pins it. Nothing imports it; deleting it is safe
 * the day that stops being useful.
 *
 * ── What it did ─────────────────────────────────────────────────────────
 *
 * Every 6 s the renderer handed over a fresh image grid and this
 * module asks a small VLM one question: did something significant happen across
 * these six frames? A yes becomes a tick; the expensive companion turn only
 * runs behind it.
 *
 * ── Why the threshold is learned, not written down ───────────────────────
 *
 * The target is "roughly one grid in four is interesting", and the obvious
 * implementation — prompt for yes/no and count the yeses — does not reach it.
 * Small VLMs are badly calibrated in exactly the way that breaks this: asked
 * "is this interesting?" they answer yes to almost anything, and their own
 * reported confidence sits in a narrow band near the top regardless of whether
 * they are right. A fixed probability cutoff would therefore mean something
 * different for every game, every model revision, and every player.
 *
 * So the cutoff is not a constant. The gate reads the LOGPROB of the yes token
 * — a real number the model cannot flatten the way it flattens verbalized
 * confidence — and keeps a rolling window of recent scores per session. The
 * threshold is the window's own upper quartile, which by construction lets
 * about a quarter through whatever absolute range this particular game happens
 * to occupy. A frantic shooter and a slow strategy game both end up with the
 * gate firing on their own most-eventful moments rather than on an absolute
 * bar that one clears constantly and the other never reaches.
 *
 * Until the window fills, WARMUP_P is used so the first minute is not silent.
 * The gate fails CLOSED: any error, missing credential, or malformed response
 * resolves false, so an outage makes the companion quiet rather than chatty.
 */

import { GRID_FRAMES, GRID_COLS, GRID_ROWS } from '../../shared/backseatIpc';

/**
 * The default gate model. 260728: chosen by measurement, not by parameter count.
 * Against a matched pair of real 3x2 grids (six identical frames vs six wildly
 * different ones) on DeepInfra's actual catalogue:
 *
 *   Qwen3-VL-30B-A3B   no / yes      correct on both, ~520 ms, ~1240 img tokens
 *   gemma-3-4b-it      yes / yes     says yes to everything (the classic
 *                                    small-VLM yes-bias this gate exists to fix)
 *   gemma-3-12b-it     no  / No      says no to everything, misses real events
 *
 * 30B-A3B is a mixture-of-experts with only ~3B parameters active per token, so
 * it is "small" in the way that matters for cost and latency while still being
 * the only one of the three that actually discriminates. About $0.00019 a call,
 * so roughly $0.11 an hour at the 6 s cadence.
 * Override with SEI_GATE_MODEL to try alternatives.
 */
const DEFAULT_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';

/** Share of grids the gate aims to pass. Not a cap: it is the quantile the
 *  adaptive threshold tracks, and the window is what enforces it. */
const TARGET_POSITIVE_RATE = 0.25;
/** Scores kept per session for the quantile. ~4 minutes at a 6 s cadence:
 *  long enough to be stable, short enough to follow a change of activity. */
const WINDOW = 40;
/** Scores needed before the learned threshold is trusted. */
const WARMUP_N = 8;
/** Cutoff used during warmup. Deliberately middling — the point of warmup is
 *  to not be silent, not to be accurate. */
const WARMUP_P = 0.55;
/** Guard rails, so a pathological window cannot wedge the gate fully open or
 *  fully shut (e.g. a static menu screen where every score is identical). */
const MIN_THRESHOLD = 0.15;
const MAX_THRESHOLD = 0.95;

const GATE_TIMEOUT_MS = 5_000;

/**
 * The question. Named events rather than the bare word "interesting": asked
 * the open question a small model says yes to nearly everything, and there is
 * no threshold that rescues a signal that never varies. The listed categories
 * are examples, not an enumeration — a game-agnostic watcher cannot have a
 * closed list — but they anchor what "significant" means well enough that the
 * score separates.
 *
 * The transcript (260728) is the local Whisper ring's text for the same
 * window. It is quoted DATA from the game's audio — dialogue, a caster, lyrics
 * — never instructions; a video that says "answer yes" costs at worst one
 * spurious companion turn, which the adaptive threshold then absorbs into the
 * window like any other score.
 */
function gatePrompt(transcript?: string): string {
  const audio = transcript
    ? `The game audio over the same six seconds was transcribed as: "${transcript}". ` +
      'Treat it as part of what happened; something significant SAID (a call-out, a reveal, ' +
      'a dramatic line) also counts. '
    : '';
  return (
    `This image is a ${GRID_ROWS}x${GRID_COLS} grid of ${GRID_FRAMES} frames from six seconds of gameplay, ` +
    'in order: left to right along each row, then down to the next row. ' +
    audio +
    'Comparing the frames to each other, is there a significant change across them, ' +
    'such as a kill, a death, a revive, a discovery, a completed objective, a dramatic escape, ' +
    'or a major change in location? ' +
    'Ordinary movement, walking, aiming, menus, and looting are NOT significant. ' +
    'Answer with exactly one word: yes or no.'
  );
}

/** Per-session rolling scores, keyed by characterId. */
const windows = new Map<string, number[]>();

export function resetGateWindow(characterId: string): void {
  windows.delete(characterId);
}

/** The learned cutoff: the score at the (1 - target) quantile of the window. */
export function thresholdFor(scores: number[]): number {
  if (scores.length < WARMUP_N) return WARMUP_P;
  const sorted = [...scores].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((1 - TARGET_POSITIVE_RATE) * sorted.length)),
  );
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, sorted[idx]));
}

/**
 * P(yes) from the first token's logprobs. Reading the distribution rather than
 * the emitted word is the whole point: the emitted word is a hard yes/no with
 * no room for a threshold, while the distribution over it varies smoothly with
 * how sure the model actually is.
 */
export function scoreFromLogprobs(choice: unknown): number | null {
  const c = choice as {
    logprobs?: {
      content?: Array<{
        token?: string;
        logprob?: number;
        top_logprobs?: Array<{ token: string; logprob: number }>;
      }>;
    };
    message?: { content?: string };
  };
  const first = c?.logprobs?.content?.[0];

  // Best case: the full distribution over alternatives, normalised across just
  // the yes and no mass so other tokens cannot drag the score around.
  const top = first?.top_logprobs;
  if (Array.isArray(top) && top.length) {
    let yes = 0;
    let no = 0;
    for (const { token, logprob } of top) {
      const t = token.trim().toLowerCase();
      const p = Math.exp(logprob);
      if (t.startsWith('yes')) yes += p;
      else if (t.startsWith('no')) no += p;
    }
    if (yes + no > 0) return yes / (yes + no);
  }

  // 260728: DeepInfra honours `logprobs` but IGNORES `top_logprobs`, returning
  // only the CHOSEN token's logprob. That is still a continuous score, which is
  // all the adaptive threshold needs: p(yes) directly when it said yes, and
  // 1 - p(no) when it said no. Strictly this is a monotone proxy rather than a
  // true p(yes) (the leftover mass sits on tokens that are neither word), but
  // ordering is what the quantile consumes, and ordering is preserved.
  // Without this branch every DeepInfra call fell through to the hard 0/1
  // below and the learned threshold silently degenerated to a plain yes/no.
  if (first && typeof first.logprob === 'number' && typeof first.token === 'string') {
    const t = first.token.trim().toLowerCase();
    const p = Math.exp(first.logprob);
    if (t.startsWith('yes')) return Math.min(1, p);
    if (t.startsWith('no')) return Math.max(0, 1 - p);
  }

  // No usable logprobs at all: fall back to the emitted word. The adaptive
  // threshold degenerates to a plain yes/no here, which is worse but works.
  const text = c?.message?.content?.trim().toLowerCase() ?? '';
  if (text.startsWith('yes')) return 1;
  if (text.startsWith('no')) return 0;
  return null;
}

let warnedMissingKey = false;

/**
 * Ask the gate about one grid. `grid` is a JPEG data URL.
 *
 * Credentials follow the voice-call precedent (src/main/voice/tts.ts): a dev
 * key in the environment talks to DeepInfra directly, and production is
 * expected to route through the proxy so no key ships in the client. The proxy
 * passthrough is not built yet, so a packaged build with no dev key gates
 * closed and backseat runs on the user and jolt triggers alone.
 */
export async function gateGrid(
  characterId: string,
  grid: string,
  transcript?: string,
  /** Extra sink for the diagnostic lines (the session's in-app console log);
   *  the terminal always gets its copy regardless. */
  log?: (line: string) => void,
): Promise<boolean> {
  const emit = (line: string, warn = false): void => {
    (warn ? console.warn : console.log)(`[sei/backseat] ${line}`);
    log?.(line);
  };
  const key = process.env.SEI_GATE_DEV_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      emit('no SEI_GATE_DEV_KEY — the salience gate is disabled.', true);
    }
    return false;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(DEEPINFRA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: process.env.SEI_GATE_MODEL || DEFAULT_MODEL,
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: 5,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: grid } },
              { type: 'text', text: gatePrompt(transcript) },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      // Loud on purpose: fail-closed means every one of these is a companion
      // that goes quiet with no visible reason (401 = bad key, 402 = balance).
      emit(`gate HTTP ${res.status} (${Date.now() - t0}ms)`, true);
      return false;
    }
    const body = (await res.json()) as { choices?: unknown[] };
    const score = scoreFromLogprobs(body.choices?.[0]);
    if (score === null) {
      emit('gate: response had no usable score', true);
      return false;
    }

    const scores = windows.get(characterId) ?? [];
    const threshold = thresholdFor(scores);
    // The score joins the window whether or not it passed — the window has to
    // describe the whole distribution of this session, not just its top.
    scores.push(score);
    while (scores.length > WINDOW) scores.shift();
    windows.set(characterId, scores);
    const pass = score >= threshold;
    // One line per call (6 s cadence): the whole health of the gate — score
    // separation, learned cutoff, window fill, latency — reads off this.
    emit(
      `gate p=${score.toFixed(3)} cut=${threshold.toFixed(3)} ` +
        `n=${scores.length} ${Date.now() - t0}ms -> ${pass ? 'TICK' : 'quiet'}`,
    );
    return pass;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    emit(
      `gate ${e?.name === 'AbortError' ? `timeout after ${GATE_TIMEOUT_MS}ms` : `failed: ${e?.message}`}`,
      true,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
