/**
 * The WorldLink first-link status lines (261106 v6, product feedback (261106)).
 * Pure: the intro view, the dev preview, the review renders and the tests
 * agree on when each line shows.
 *
 * While the intro plays, her face set is made with Anima (main/anima/: a
 * cloud bake of about 1 to 2 minutes the first time, then a download). Nine
 * status lines run one at a time, each waiting on a real pipeline milestone
 * (LINK_MILESTONES), then the success line, and only after it does she come
 * in. A line shows when its milestone has arrived, but never sooner than the
 * line before's minimum time on screen (its `dwell`, default LINE_DWELL_MS).
 * The first lines dwell longer (product feedback (261106): sending a signal
 * and waiting for a reply should take a while). While a slow stage runs the
 * current line just holds (no filler lines). The proxy only says queued,
 * running and ready, so the lines inside the bake (5 to 7) are spread over an
 * expected-duration curve (`curve`, a fraction of EXPECTED_LINK_MS) that the
 * bake finishing cuts short (`cut`): an early finish plays the rest at the
 * minimum dwell, it never waits for nothing.
 *
 *   line                               shows when                          dwell
 *   1 Initializing WorldLink…          0.7 s after the start               4 s
 *   2 Sending signal to World N…       the request is sent                 6 s
 *   3 Waiting for a reply…             (the request is out)                12 s
 *   4 Signal received.                 the proxy answered                  4 s
 *   5 Syncing world clocks…            answered, and 40% of the expected time
 *   6 Matching physics constants…      the bake runs, and 60%
 *   7 Correcting for time dilation…    the bake runs, and 80%
 *   8 Stabilizing the link…            the bake is done (the pack downloads)
 *   9 Inviting {name}…                 her face set is installed and the host started
 *   WorldLink established between World 0 and World N.   LAST_LINE_MS after line 9
 *   (5 to 9 dwell LINE_DWELL_MS.)
 *
 *   A 75 s bake: 0.7, 4.7, 10.7, 22.7, 30, 45, 60, 72, 75, success 78.2 s.
 *   A 20 s bake: 0.7, 4.7, 10.7, 22.7, 26.7, 29.5, 32.3, 35.1, 37.9, success 41.1 s.
 *   Everything ready at once (a cached look, a replay): the same as 20 s.
 *
 * A failure (no network, an error, the host start failing, or no line 9 by
 * LINK_TIMEOUT_MS) shows "WorldLink failed. Lost contact with World N. Come
 * back later." instead, FAIL_BEAT_MS after the current line came up at the
 * soonest (a short beat, not a long line's whole dwell). "World N" is
 * worldNumber(her id): six digits, the same for her every time.
 */
import {
  LINK_LINE_COUNT,
  LINK_MILESTONES,
  type LinkAnimaStart,
  type LinkFailure,
  type LinkMilestone,
  type LinkOutcome,
} from '@shared/seilinkIntroTelemetry';

/**
 * Her world's number: a stable 32-bit FNV-1a hash of her id (UTF-16 code
 * units), mod 900000, plus 100000, so always six digits. The user's own
 * world is World 0.
 */
export function worldNumber(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 900000) + 100000;
}

export interface StatusLine {
  /** The English text (the i18n key): {world} is her world's number, {name} hers. */
  key: string;
  /** Milestones that must have arrived (all of them). */
  need: readonly LinkMilestone[];
  /** Not before this fraction of EXPECTED_LINK_MS (the lines inside the bake, which says nothing finer). */
  curve?: number;
  /** ...unless this milestone has arrived (the bake finished early). */
  cut?: LinkMilestone;
  /** The least time it stays on screen before the next line, ms (default LINE_DWELL_MS). */
  dwell?: number;
}

/** The approved copy, word for word (product feedback (261106)). */
export const STATUS_LINES: readonly StatusLine[] = [
  { key: 'Initializing WorldLink…', need: [], dwell: 4000 },
  { key: 'Sending signal to World {world}…', need: ['sent'], dwell: 6000 },
  { key: 'Waiting for a reply…', need: ['sent'], dwell: 12_000 },
  { key: 'Signal received.', need: ['answered'], dwell: 4000 },
  { key: 'Syncing world clocks…', need: ['answered'], curve: 0.4, cut: 'baked' },
  { key: 'Matching physics constants…', need: ['running'], curve: 0.6, cut: 'baked' },
  { key: 'Correcting for time dilation…', need: ['running'], curve: 0.8, cut: 'baked' },
  { key: 'Stabilizing the link…', need: ['baked'] },
  { key: 'Inviting {name}…', need: ['installed', 'host'] },
];

export const SUCCESS_LINE = 'WorldLink established between World 0 and World {world}.';
export const FAILURE_LINE = 'WorldLink failed. Lost contact with World {world}. Come back later.';

/** The first line shows this long after the start (the intro opens out of the solid colour). */
export const FIRST_LINE_MS = 700;
/** The shortest time a line is on screen before the next one (readable), unless it has its own `dwell`. */
export const LINE_DWELL_MS = 2800;
/** A failure shows at the soonest this long after the current line came up (never a long line's whole dwell). */
export const FAIL_BEAT_MS = 2800;

/** A line's minimum time on screen. */
export function lineDwell(i: number): number {
  return STATUS_LINES[i]?.dwell ?? LINE_DWELL_MS;
}
/** Line 9 is on screen this long before the success line (the climax and the expand into the solid play under it). */
export const LAST_LINE_MS = 3200;
/** How long a first bake is expected to take (the curve the middle lines are spread over). */
export const EXPECTED_LINK_MS = 75_000;
/** No line 9 by then: the link failed (timeout). The bake goes on in the background for the next try. */
export const LINK_TIMEOUT_MS = 210_000;

/** What has happened so far, ms from the intro's start (a milestone that arrived before it counts as 0). */
export interface LinkLog {
  at: Partial<Record<LinkMilestone, number>>;
  failed: { at: number; failure: LinkFailure } | null;
}

export type LinkEvent = { kind: 'milestone'; milestone: LinkMilestone } | { kind: 'failed'; failure: LinkFailure };

/**
 * Where the milestones come from. A simulation knows them all up front
 * (`fixed`, so the harness can seek any frame); the app's source
 * (animaLinkSource) reports them as they happen.
 */
export interface LinkSource {
  readonly fixed?: LinkLog;
  subscribe?(emit: (e: LinkEvent) => void): () => void;
  /** Analytics: where her bake stood when the intro started. */
  startStage?(): LinkAnimaStart;
}

/** When each line, the success line or the failure line shows (ms from the start). */
export interface LinkPlan {
  /** Starts of the status lines that show (as far as known now; at most 9). */
  lines: number[];
  /** When the success line lands (null: not known yet, or it failed). */
  success: number | null;
  fail: { at: number; failure: LinkFailure } | null;
}

/** The pipeline milestones in order (host is apart). */
const PIPELINE: readonly LinkMilestone[] = ['sent', 'answered', 'running', 'baked', 'installed'];

/** Each milestone's time, counting a later one as having brought every earlier one with it (Infinity: not yet). */
export function effectiveTimes(log: LinkLog): Record<LinkMilestone, number> {
  const out = {} as Record<LinkMilestone, number>;
  let later = Infinity;
  for (let i = PIPELINE.length - 1; i >= 0; i--) {
    const m = PIPELINE[i];
    later = Math.min(later, log.at[m] ?? Infinity);
    out[m] = later;
  }
  out.host = log.at.host ?? Infinity;
  return out;
}

function gateTime(line: StatusLine, T: Record<LinkMilestone, number>): number {
  const need = line.need.reduce((m, k) => Math.max(m, T[k]), 0);
  if (line.curve === undefined) return need;
  const g = Math.max(need, line.curve * EXPECTED_LINK_MS);
  return line.cut ? Math.min(g, T[line.cut]) : g;
}

/**
 * The plan for a log. A start that is in the past never moves when more of
 * the log arrives (every gate depends only on what arrived before it), so a
 * view can recompute it every frame without a jump.
 */
export function planLink(log: LinkLog): LinkPlan {
  const T = effectiveTimes(log);
  const last = gateTime(STATUS_LINES[LINK_LINE_COUNT - 1], T);
  let failAt = log.failed?.at ?? Infinity;
  let failure: LinkFailure = log.failed?.failure ?? 'error';
  if (last > LINK_TIMEOUT_MS && LINK_TIMEOUT_MS < failAt) {
    failAt = LINK_TIMEOUT_MS;
    failure = 'timeout';
  }
  // Everything line 9 waits on came before the failure: the link worked.
  if (failAt >= last) failAt = Infinity;
  const lines: number[] = [];
  for (let i = 0; i < STATUS_LINES.length; i++) {
    const s = i === 0 ? FIRST_LINE_MS : Math.max(lines[i - 1] + lineDwell(i - 1), gateTime(STATUS_LINES[i], T));
    if (!Number.isFinite(s) || (i > 0 && s > failAt)) break;
    lines.push(s);
  }
  if (Number.isFinite(failAt)) {
    return { lines, success: null, fail: { at: Math.max(failAt, lines[lines.length - 1] + FAIL_BEAT_MS), failure } };
  }
  return { lines, success: lines.length === LINK_LINE_COUNT ? lines[LINK_LINE_COUNT - 1] + LAST_LINE_MS : null, fail: null };
}

/** Record an event into a log at `at` ms (the first arrival counts; nothing after a failure). */
export function recordLink(log: LinkLog, e: LinkEvent, at: number): void {
  if (log.failed) return;
  const t = Math.max(0, at);
  if (e.kind === 'milestone') {
    if (log.at[e.milestone] === undefined) log.at[e.milestone] = t;
  } else {
    log.failed = { at: t, failure: e.failure };
  }
}

export function emptyLog(): LinkLog {
  return { at: {}, failed: null };
}

/** Everything ready at once (a replay, a face set already on disk): the lines play at the minimum dwell. */
export function instantLog(): LinkLog {
  return { at: Object.fromEntries(LINK_MILESTONES.map((m) => [m, 0])), failed: null };
}

/**
 * A simulated run for the dev preview and the review renders: the request
 * out and answered within about a second, the bake seen running at the first
 * poll (10 s) when it is that long, done `doneMs` after the start (the pack
 * downloads in the last 3 s), the host up at 2.5 s. `failAtMs` fails it
 * there instead (milestones after it never come).
 */
export function simulatedLog(opts: { doneMs: number; failAtMs?: number; failure?: LinkFailure; hostMs?: number }): LinkLog {
  const done = Math.max(1500, opts.doneMs);
  const at: Partial<Record<LinkMilestone, number>> = {
    sent: 250,
    answered: 1200,
    ...(done > 12_000 ? { running: 10_500 } : {}),
    baked: Math.max(1300, done - 3000),
    installed: done,
    host: opts.hostMs ?? 2500,
  };
  if (opts.failAtMs === undefined) return { at, failed: null };
  const kept: Partial<Record<LinkMilestone, number>> = {};
  for (const [m, t] of Object.entries(at) as Array<[LinkMilestone, number]>) if (t < opts.failAtMs) kept[m] = t;
  return { at: kept, failed: { at: opts.failAtMs, failure: opts.failure ?? 'bake_failed' } };
}

/** A source that knows the whole log up front. */
export function fixedSource(log: LinkLog, start: LinkAnimaStart = 'none'): LinkSource {
  return { fixed: log, startStage: () => start };
}

/**
 * The analytics for one intro (`seilink_intro_link`), shape only: how long
 * each line was on screen, which milestone took longest after the one
 * before it, the total, the outcome and the failure class.
 */
export function linkReport(
  log: LinkLog,
  plan: LinkPlan,
  endedAt: number,
  outcome: LinkOutcome,
): Record<string, string | number> {
  const out: Record<string, string | number> = { outcome, total_ms: Math.max(0, Math.round(endedAt)) };
  const shown = plan.lines.filter((s) => s <= endedAt);
  out.lines_shown = shown.length;
  const after = [...plan.lines, plan.success ?? plan.fail?.at ?? Infinity];
  shown.forEach((s, i) => {
    out[`line_${i + 1}_ms`] = Math.round(Math.min(after[i + 1], endedAt) - s);
  });
  if (outcome === 'failed' && plan.fail) out.failure = plan.fail.failure;
  const a = log.at;
  const waits: Array<[LinkMilestone, number | undefined]> = [
    ['sent', a.sent],
    ['answered', a.answered !== undefined && a.sent !== undefined ? a.answered - a.sent : a.answered],
    ['running', a.running !== undefined && a.answered !== undefined ? a.running - a.answered : undefined],
    ['baked', a.baked !== undefined ? a.baked - (a.running ?? a.answered ?? 0) : undefined],
    ['installed', a.installed !== undefined && a.baked !== undefined ? a.installed - a.baked : undefined],
    ['host', a.host],
  ];
  let slow: [LinkMilestone, number] | null = null;
  for (const [m, w] of waits) if (w !== undefined && (slow === null || w > slow[1])) slow = [m, w];
  if (slow) {
    out.slowest = slow[0];
    out.slowest_ms = Math.max(0, Math.round(slow[1]));
  }
  return out;
}
