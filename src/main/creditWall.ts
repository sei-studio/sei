/**
 * `credit_wall_hit` (261005): one analytics event per credit-wall occurrence.
 *
 * Why: the 261005 retention analysis found 46% of new cloud users spend the
 * free weekly allowance on day 0, but 46 of the 72 day-0 walls left NO PostHog
 * event at all. The only wall-shaped events were `credit_wall_degraded` (chess,
 * Draw!, Backseat) and the purchase funnel, so a wall hit in chat, on a call or
 * in a Minecraft session was invisible and the wall read about 4x rarer than it
 * is.
 *
 * Every hard stop goes through `emitCreditsHardStop` (ipc.ts), which calls
 * `noteCreditWall` here with the surface that hit it. The voice upstreams (TTS
 * and STT 402s) do not raise the popup, so they call `noteCreditWall` directly.
 *
 * Dedupe: a wall arrives as a burst. A chat retry, a voice greeting plus the
 * companion turn plus every TTS clip, a bot's pre-flight gate on each summon
 * click: each one is a 402 of its own, and a player who walls in chat and then
 * opens a call is still behind the same wall. Occurrences are keyed by
 * `reason` only (the surface of the FIRST hit is the one reported) and
 * collapse while they keep coming less than CREDIT_WALL_QUIET_MS apart (a
 * sliding quiet gap, not a fixed window), so a user retrying every few minutes
 * for an hour is ONE wall, and coming back after a break is a new one. The
 * shipped event carries how many repeats the previous burst swallowed
 * (`repeats_before`).
 *
 * Shape only: enums, counts and durations. No character id, no message text.
 * `allowance_used_micro` is derived from the account snapshot (`usage_pct` of
 * the plan's weekly allowance), so it has 1% resolution and caps at the
 * allowance; the client cannot read the ledger's exact micro-dollar sum.
 */
import type { CreditsHardStopEvent, CreditsStatus } from '../shared/ipc';

/** Which product surface ran into the wall. Bot sessions are 'game' + `game`. */
export type CreditWallSurface = 'chat' | 'voice' | 'chess' | 'draw' | 'backseat' | 'game' | 'unknown';

/** What call hit it: an LLM turn, a voice upstream, the bot's pre-flight
 * summon gate, or a live bot session. */
export type CreditWallTrigger = 'llm' | 'tts' | 'stt' | 'summon_gate' | 'session';

export interface CreditWallContext {
  surface: CreditWallSurface;
  trigger?: CreditWallTrigger;
  /** Bot surfaces: the game id ('minecraft', 'stardew', 'dst'). */
  game?: string;
  /** A voice call was open for the character when the bot hit the wall. */
  inCall?: boolean;
}

/** Repeats closer together than this belong to the same wall occurrence. */
export const CREDIT_WALL_QUIET_MS = 10 * 60_000;

/** Bound on the account read that fills the event. A slow network must not
 * hold the event back long, and a failed read ships the event with nulls. */
export const CREDIT_WALL_SNAPSHOT_TIMEOUT_MS = 5000;

/** µ$ per display credit, same constant as pricingCatalog / the server. */
const MICRO_PER_CREDIT = 5000;

/**
 * Sliding-gap dedupe. `take` answers whether this occurrence starts a new
 * wall (ship it) and, when it does, how many repeats the previous burst on
 * the same key absorbed. Pure apart from its own map; time is passed in.
 */
export class CreditWallDeduper {
  private readonly seen = new Map<string, { lastAt: number; repeats: number }>();
  constructor(private readonly quietMs: number = CREDIT_WALL_QUIET_MS) {}

  take(key: string, now: number): { ship: true; repeatsBefore: number } | { ship: false } {
    const prev = this.seen.get(key);
    if (prev && now - prev.lastAt < this.quietMs) {
      prev.lastAt = now;
      prev.repeats += 1;
      return { ship: false };
    }
    this.seen.set(key, { lastAt: now, repeats: 0 });
    return { ship: true, repeatsBefore: prev?.repeats ?? 0 };
  }

  reset(): void {
    this.seen.clear();
  }
}

export interface CreditWallPropsInput {
  info: CreditsHardStopEvent;
  ctx: CreditWallContext;
  now: number;
  /** First launch of this install (ms epoch); null when unknown. */
  installedAt: number | null;
  /** Account snapshot read right after the wall; null when the read failed. */
  snapshot: CreditsStatus | null;
  /** The plan's weekly allowance in µ$; null when the catalog is unknown. */
  allowanceMicro: number | null;
  repeatsBefore: number;
  /** 1 for the first wall shipped this app run, 2 for the next, ... */
  wallSeq: number;
}

type Scalar = string | number | boolean | null;

/** Pure: the event's properties. */
export function creditWallProps(input: CreditWallPropsInput): Record<string, Scalar> {
  const { info, ctx, now, installedAt, snapshot, allowanceMicro } = input;
  const resetsAt = snapshot?.resets_at ? Date.parse(snapshot.resets_at) : NaN;
  const props: Record<string, Scalar> = {
    reason: info.reason,
    surface: ctx.surface,
    ms_since_install: installedAt !== null && now >= installedAt ? now - installedAt : null,
    allowance_used_micro:
      snapshot && allowanceMicro !== null ? Math.round((snapshot.usage_pct / 100) * allowanceMicro) : null,
    usage_pct: snapshot ? snapshot.usage_pct : null,
    // One decimal: "back in 0.3 h" and "back in 151.2 h" are both answers.
    resets_in_h: Number.isFinite(resetsAt) ? Math.max(0, Math.round((resetsAt - now) / 360_000) / 10) : null,
    plan: snapshot ? snapshot.plan : null,
    extra_credits_left: snapshot ? Math.max(0, snapshot.extra_credits_total - snapshot.extra_credits_used) : null,
    repeats_before: input.repeatsBefore,
    wall_seq: input.wallSeq,
  };
  if (ctx.trigger) props.trigger = ctx.trigger;
  if (ctx.game) props.game = ctx.game;
  if (ctx.inCall !== undefined) props.in_call = ctx.inCall;
  if (info.reason === 'rate_limited' && typeof info.retry_after_seconds === 'number') {
    props.retry_after_s = info.retry_after_seconds;
  }
  return props;
}

export interface CreditWallDeps {
  now: () => number;
  installedAt: () => number | null;
  readSnapshot: () => Promise<CreditsStatus | null>;
  /** Weekly allowance (µ$) for a plan tier, or null when unknown. */
  allowanceMicroFor: (plan: CreditsStatus['plan']) => Promise<number | null>;
  capture: (event: string, props: Record<string, Scalar>) => void | Promise<void>;
}

/**
 * Build a reporter over injectable deps (tests). `note` decides the dedupe
 * synchronously, so a burst that arrives within one tick still ships once,
 * then reads the account snapshot in the background and captures. Never
 * throws; the returned promise is only for tests to await.
 */
export function createCreditWallReporter(deps: CreditWallDeps, quietMs: number = CREDIT_WALL_QUIET_MS) {
  const deduper = new CreditWallDeduper(quietMs);
  let wallSeq = 0;
  function note(info: CreditsHardStopEvent, ctx: CreditWallContext): Promise<void> {
    let decision: ReturnType<CreditWallDeduper['take']>;
    let now: number;
    try {
      now = deps.now();
      decision = deduper.take(info.reason, now);
    } catch {
      return Promise.resolve();
    }
    if (!decision.ship) return Promise.resolve();
    const repeatsBefore = decision.repeatsBefore;
    const seq = ++wallSeq;
    return (async () => {
      try {
        let snapshot: CreditsStatus | null = null;
        try {
          snapshot = await deps.readSnapshot();
        } catch {
          snapshot = null;
        }
        // creditsGet's signed-out placeholder (0%, no reset time) is not a
        // reading of the account: report unknown rather than "0% used".
        if (snapshot && !snapshot.resets_at) snapshot = null;
        let allowanceMicro: number | null = null;
        if (snapshot) {
          try {
            allowanceMicro = await deps.allowanceMicroFor(snapshot.plan);
          } catch {
            allowanceMicro = null;
          }
        }
        await deps.capture(
          'credit_wall_hit',
          creditWallProps({
            info,
            ctx,
            now,
            installedAt: deps.installedAt(),
            snapshot,
            allowanceMicro,
            repeatsBefore,
            wallSeq: seq,
          }),
        );
      } catch {
        /* analytics is never load-bearing */
      }
    })();
  }
  return { note, reset: () => { deduper.reset(); wallSeq = 0; } };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

// ── Process-level wiring ────────────────────────────────────────────────────

/** First launch of this install, set once at boot from the install marker
 * (index.ts → firstLaunch.installedAtMs). Pushed in rather than read here so
 * this module never imports electron. */
let installedAtCache: number | null = null;

const reporter = createCreditWallReporter({
  now: () => Date.now(),
  installedAt: () => installedAtCache,
  readSnapshot: async () => {
    const { creditsGet } = await import('./cloud/proxyClient');
    return withTimeout(creditsGet(), CREDIT_WALL_SNAPSHOT_TIMEOUT_MS);
  },
  allowanceMicroFor: async (plan) => {
    const { pricingCatalogGet } = await import('./cloud/pricingCatalog');
    const catalog = await withTimeout(pricingCatalogGet(), CREDIT_WALL_SNAPSHOT_TIMEOUT_MS);
    const row = catalog?.plans.find((p) => p.tier === plan);
    return row ? row.weekly_credits * MICRO_PER_CREDIT : null;
  },
  capture: async (event, props) => {
    const { loadAnalytics } = await import('./lazyAnalytics');
    const { capture } = await loadAnalytics();
    capture(event, props);
  },
});

/** Called from bootstrap after the install marker is read (firstLaunch.ts). */
export function setInstalledAt(ms: number | null): void {
  installedAtCache = ms;
}

/**
 * Record one credit-wall occurrence. Cheap and synchronous for the caller;
 * the snapshot read and the capture run in the background. Never throws.
 */
export function noteCreditWall(info: CreditsHardStopEvent, ctx: CreditWallContext): void {
  void reporter.note(info, ctx);
}

/** Test seam. */
export function _resetCreditWallForTests(): void {
  reporter.reset();
  installedAtCache = null;
}
