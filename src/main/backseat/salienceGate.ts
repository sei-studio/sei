/**
 * Backseat salience gate (260728) — the second of the three tick triggers.
 *
 * Every GATE_INTERVAL_MS the renderer hands over a fresh image grid and this
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
 * The default small VLM. Cheap, OpenAI-compatible, and carried by DeepInfra;
 * override with SEI_GATE_MODEL when trying alternatives.
 */
const DEFAULT_MODEL = 'Qwen/Qwen2.5-VL-7B-Instruct';
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
 */
const GATE_PROMPT =
  `This image is a ${GRID_ROWS}x${GRID_COLS} grid of ${GRID_FRAMES} frames from six seconds of gameplay, ` +
  'in order: left to right along each row, then down to the next row. ' +
  'Comparing the frames to each other, is there a significant change across them, ' +
  'such as a kill, a death, a revive, a discovery, a completed objective, a dramatic escape, ' +
  'or a major change in location? ' +
  'Ordinary movement, walking, aiming, menus, and looting are NOT significant. ' +
  'Answer with exactly one word: yes or no.';

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
function scoreFromLogprobs(choice: unknown): number | null {
  const c = choice as {
    logprobs?: { content?: Array<{ top_logprobs?: Array<{ token: string; logprob: number }> }> };
    message?: { content?: string };
  };
  const top = c?.logprobs?.content?.[0]?.top_logprobs;
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
  // No logprobs from this provider/model: fall back to the emitted word. The
  // adaptive threshold degenerates to a plain yes/no here, which is worse but
  // still functional.
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
export async function gateGrid(characterId: string, grid: string): Promise<boolean> {
  const key = process.env.SEI_GATE_DEV_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn('[sei] backseat: no SEI_GATE_DEV_KEY — the salience gate is disabled.');
    }
    return false;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATE_TIMEOUT_MS);
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
              { type: 'text', text: GATE_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { choices?: unknown[] };
    const score = scoreFromLogprobs(body.choices?.[0]);
    if (score === null) return false;

    const scores = windows.get(characterId) ?? [];
    const threshold = thresholdFor(scores);
    // The score joins the window whether or not it passed — the window has to
    // describe the whole distribution of this session, not just its top.
    scores.push(score);
    while (scores.length > WINDOW) scores.shift();
    windows.set(characterId, scores);
    return score >= threshold;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
