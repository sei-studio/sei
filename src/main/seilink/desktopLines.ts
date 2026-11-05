/**
 * SeiLink desktop lines (261104, M4): the short things she says on the
 * wallpaper, shown as a speech bubble next to her.
 *
 *  - poke: a double click on her gets a short reply. The player asked for it,
 *    like sending a message, so it runs on every plan that can chat right
 *    now, inside the plan's own limits (a free account's weekly cap is
 *    enforced by the proxy; over the limit, nothing is sent). At most
 *    POKE_PER_HOUR, and not while a reply is on its way.
 *  - idle: now and then she says something unprompted. Free accounts on the
 *    cloud never get these (the free tier must cost about nothing per extra
 *    user, and an unprompted line would spend a free user's cap without them
 *    asking): paid plans under their limit, or the user's own AI (BYOK,
 *    ChatGPT plan, Ollama; ai_backend_kind 'local') only. Rare: a random gap of
 *    IDLE_MIN_GAP_MS..IDLE_MAX_GAP_MS between tries, at most IDLE_PER_HOUR,
 *    and never while the room is covered or paused, the dock has her deafened,
 *    she is busy (a chat with her, a game, a call), or nobody is at the
 *    computer (no input for AWAY_AFTER_S).
 *
 * The turn itself is chatService.sendDesktopLineTurn (her context and room
 * line, the note after the cache breakpoint, saved to her chat). Analytics:
 * seilink_line_shown {kind, chars, character_id}, shape only. 261105:
 * seilink_poke {outcome, latency_ms, budget} per double click (repeats of a
 * refused poke collapse, see pokeEventAllowed), and idle counts on the host
 * session (idle_due / idle_skip_<reason> once per due window / idle_attempted /
 * idle_shown / idle_none_<why>), sent with seilink_health and seilink_ended.
 *
 * 261105 (T335): a third kind, `react`, is her one line after the player
 * changes her room in the editor. roomReaction.ts decides when; it pays like
 * a poke (the player did something) and goes through speakRoomReaction here,
 * so it shares the one-line-at-a-time guard and the plan read.
 */
import { powerMonitor } from 'electron';
import type { ChatMessage } from '../../shared/ipc';
import { loadConfig } from '../configStore';
import { loadAnalytics } from '../lazyAnalytics';
import { noteSeilinkCount, seilinkHostBusy, seilinkHostStatus, seilinkLiveCharacter, sendSeilinkLine } from './host/seilinkHost';
import type { DesktopLineSkip } from '../chat/chatService';

export const IDLE_MIN_GAP_MS = 25 * 60_000;
export const IDLE_MAX_GAP_MS = 50 * 60_000;
export const IDLE_PER_HOUR = 2;
export const POKE_PER_HOUR = 6;
export const POKE_MIN_GAP_MS = 20_000;
/** No keyboard or mouse input for this long: nobody would see an idle line. */
export const AWAY_AFTER_S = 120;
export const TICK_MS = 60_000;
/** How long a plan read is trusted. */
const BUDGET_TTL_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

// ── Pacing (pure) ───────────────────────────────────────────────────────────

/**
 * When the next idle line may come, and how many lines came in the last hour.
 * One per main process (module level below), so the hourly limits hold across
 * host restarts, crashes and companion swaps within an app session: a host
 * that restarts is not a new hour.
 */
export class LinePacer {
  /** Who is on the desktop right now (null while the host is down or restarting). */
  private who: string | null = null;
  /** The last companion seen on the desktop: her gap survives a host restart. */
  private last: string | null = null;
  private nextIdleAt = 0;
  private idleTimes: number[] = [];
  private pokeTimes: number[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Who is on the desktop now. A new companion waits a full gap before her
   * first idle line; the same one coming back (a host restart) keeps hers.
   * The per-hour counts are never reset here.
   */
  follow(characterId: string | null, now: number): void {
    this.who = characterId;
    if (!characterId || characterId === this.last) return;
    this.last = characterId;
    this.nextIdleAt = now + this.gap();
  }

  idleDue(now: number): boolean {
    return this.idleState(now) === 'due';
  }

  /** 'cap': the gap passed but the hourly cap holds the line back (analytics). */
  idleState(now: number): 'not_due' | 'cap' | 'due' {
    if (!this.who || now < this.nextIdleAt) return 'not_due';
    return this.recent(this.idleTimes, now) < IDLE_PER_HOUR ? 'due' : 'cap';
  }

  /** An idle try ran (a line or a silence): the next waits a full gap. */
  noteIdle(now: number, spoke: boolean): void {
    if (spoke) this.idleTimes.push(now);
    this.nextIdleAt = now + this.gap();
  }

  canPoke(now: number): boolean {
    const last = this.pokeTimes[this.pokeTimes.length - 1];
    if (last !== undefined && now - last < POKE_MIN_GAP_MS) return false;
    return this.recent(this.pokeTimes, now) < POKE_PER_HOUR;
  }

  notePoke(now: number): void {
    this.pokeTimes.push(now);
  }

  /** Tests and the dev log. */
  get nextIdle(): number {
    return this.nextIdleAt;
  }

  private gap(): number {
    return IDLE_MIN_GAP_MS + Math.floor(this.random() * (IDLE_MAX_GAP_MS - IDLE_MIN_GAP_MS));
  }

  private recent(times: number[], now: number): number {
    while (times.length && now - times[0] >= HOUR_MS) times.shift();
    return times.length;
  }
}

// ── Gates (pure) ────────────────────────────────────────────────────────────

/** Who pays for her desktop lines. */
export type LineBudget = 'own' | 'paid' | 'free' | 'none';

export function lineBudgetFor(
  backend: 'local' | 'cloud-proxy' | string,
  credits: { plan: string; over_limit: boolean } | null,
): LineBudget {
  if (backend === 'local') return 'own';
  if (!credits || credits.over_limit) return 'none';
  return credits.plan === 'free' ? 'free' : 'paid';
}

export function budgetAllows(kind: 'idle' | 'poke', budget: LineBudget): boolean {
  if (budget === 'own' || budget === 'paid') return true;
  return kind === 'poke' && budget === 'free';
}

export type IdleBlock = 'covered' | 'paused' | 'deafened' | 'away' | 'busy' | 'occupied';

/** Why the budget refused a line: a free account over its weekly cap, a paid one over its limit, no plan read. */
export type BudgetRefusal = 'free_plan' | 'free_cap' | 'over_limit' | 'no_plan';

export function budgetRefusal(kind: 'idle' | 'poke', budget: LineBudget, credits: { plan: string; over_limit: boolean } | null): BudgetRefusal | null {
  if (budgetAllows(kind, budget)) return null;
  if (budget === 'free') return 'free_plan';
  if (!credits) return 'no_plan';
  return credits.plan === 'free' ? 'free_cap' : 'over_limit';
}

/** seilink_poke outcomes. */
export type PokeOutcome =
  | 'ok'
  /** Our own pacing: 20 s apart, POKE_PER_HOUR. */
  | 'limited'
  | 'free_plan'
  | 'free_cap'
  | 'over_limit'
  | 'no_plan'
  | 'rate_limited'
  | 'occupied'
  | 'busy'
  | 'not_live'
  | 'not_shown'
  | DesktopLineSkip;

/**
 * Per-session idle stats: a "due window" opens when her gap has passed and closes at the next
 * try. Each skip reason is counted once per window (the tick re-checks every minute), so the
 * counts read "windows held back by X", not minutes.
 */
export class IdleWindowStats {
  private open = false;
  private seen = new Set<string>();

  constructor(private readonly count: (key: string) => void) {}

  /** A tick found the gap passed. */
  due(): void {
    if (this.open) return;
    this.open = true;
    this.seen.clear();
    this.count('idle_due');
  }

  skip(reason: string): void {
    if (!this.open || this.seen.has(reason)) return;
    this.seen.add(reason);
    this.count(`idle_skip_${reason}`);
  }

  /** A try ran: the window closes. */
  attempted(result: 'shown' | string): void {
    this.open = false;
    this.count('idle_attempted');
    this.count(result === 'shown' ? 'idle_shown' : `idle_none_${result}`);
  }

  /** She left the desktop: a new session starts a new window. */
  reset(): void {
    this.open = false;
    this.seen.clear();
  }
}

/** A refused poke repeated within this long sends no second event (it is still counted). */
export const POKE_REPEAT_QUIET_MS = 60_000;

/** One seilink_poke per refusal outcome per POKE_REPEAT_QUIET_MS; every ok / turn result is sent. */
export function pokeEventAllowed(last: Map<string, number>, outcome: PokeOutcome, now: number): boolean {
  const quiet = outcome === 'limited' || outcome === 'busy' || outcome === 'not_live' || outcome === 'occupied';
  if (!quiet) return true;
  const at = last.get(outcome);
  if (at !== undefined && now - at < POKE_REPEAT_QUIET_MS) return false;
  last.set(outcome, now);
  return true;
}

/** Why no idle line now, or null when nothing blocks it. */
export function idleBlock(s: {
  covered: boolean;
  paused: boolean;
  deafened: boolean;
  idleSeconds: number;
  busy: boolean;
  occupied: boolean;
}): IdleBlock | null {
  if (s.covered) return 'covered';
  if (s.paused) return 'paused';
  if (s.deafened) return 'deafened';
  if (s.idleSeconds >= AWAY_AFTER_S) return 'away';
  if (s.busy) return 'busy';
  if (s.occupied) return 'occupied';
  return null;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export interface DesktopLinesDeps {
  /** She is in a game (bot online) or on a call: the desktop stays quiet. */
  occupied(characterId: string): boolean;
  /** 261105: she is on a voice call (a room reaction goes to the call's next turn instead). */
  onCall?(characterId: string): boolean;
  /** Her saved line, to the main window's chat. */
  pushChatMessage(characterId: string, message: ChatMessage): void;
}

let deps: DesktopLinesDeps | null = null;
const pacer = new LinePacer();
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let budgetCache: { at: number; value: LineBudget; credits: { plan: string; over_limit: boolean } | null } | null = null;
const idleStats = new IdleWindowStats((key) => noteSeilinkCount(key));
const pokeQuiet = new Map<string, number>();
let lastLive: string | null = null;

export function initDesktopLines(d: DesktopLinesDeps): void {
  deps = d;
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
}

/** An account switch or a plan change: read the plan again next time. */
export function resetDesktopLineBudget(): void {
  budgetCache = null;
}

export async function budgetInfo(now: number): Promise<{ value: LineBudget; credits: { plan: string; over_limit: boolean } | null }> {
  if (budgetCache && now - budgetCache.at < BUDGET_TTL_MS) return budgetCache;
  let value: LineBudget = 'none';
  let credits: { plan: string; over_limit: boolean } | null = null;
  try {
    const { getAiBackendKind } = await import('../apiKeyStore');
    const backend = await getAiBackendKind();
    if (backend === 'local') value = 'own';
    else {
      const { creditsGet } = await import('../cloud/proxyClient');
      const c = await creditsGet();
      credits = c ? { plan: c.plan, over_limit: c.over_limit } : null;
      value = lineBudgetFor(backend, c);
    }
  } catch {
    value = 'none';
  }
  budgetCache = { at: now, value, credits };
  return budgetCache;
}

function systemIdleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const id = seilinkLiveCharacter();
  pacer.follow(id, now);
  if (id !== lastLive) {
    lastLive = id;
    idleStats.reset();
  }
  if (!id || running || !deps) return;
  const state = pacer.idleState(now);
  if (state === 'not_due') return;
  idleStats.due();
  if (state === 'cap') {
    idleStats.skip('cap');
    return;
  }
  const st = seilinkHostStatus();
  const cfg = await loadConfig().catch(() => null);
  const block = idleBlock({
    covered: st.covered,
    paused: st.paused,
    deafened: cfg?.seilink_deafened === true,
    idleSeconds: systemIdleSeconds(),
    busy: seilinkHostBusy(),
    occupied: deps.occupied(id),
  });
  // Blocked: try again next tick (the gap already passed, so the line comes once she is free).
  if (block) {
    idleStats.skip(block);
    return;
  }
  const budget = await budgetInfo(now);
  const refusal = budgetRefusal('idle', budget.value, budget.credits);
  if (refusal) {
    idleStats.skip(refusal);
    return;
  }
  const r = await say(id, 'idle');
  idleStats.attempted(r.outcome === 'ok' ? 'shown' : r.outcome);
  pacer.noteIdle(Date.now(), r.outcome === 'ok');
}

/** A double click on her (hostEntry's click classifier, via seilinkHost deps.onDoubleClick). */
export async function onSeilinkPoke(characterId: string): Promise<void> {
  const now = Date.now();
  const outcome = await pokeOutcome(characterId, now);
  noteSeilinkCount(`poke_${outcome.outcome}`);
  if (!pokeEventAllowed(pokeQuiet, outcome.outcome, now)) return;
  capture('seilink_poke', {
    character_id: characterId,
    outcome: outcome.outcome,
    latency_ms: outcome.latencyMs,
    budget: outcome.budget,
  });
}

async function pokeOutcome(characterId: string, now: number): Promise<{ outcome: PokeOutcome; latencyMs: number | null; budget: LineBudget | null }> {
  if (!deps) return { outcome: 'not_live', latencyMs: null, budget: null };
  if (running) return { outcome: 'busy', latencyMs: null, budget: null };
  if (seilinkLiveCharacter() !== characterId) return { outcome: 'not_live', latencyMs: null, budget: null };
  if (!pacer.canPoke(now)) return { outcome: 'limited', latencyMs: null, budget: null };
  if (deps.occupied(characterId)) return { outcome: 'occupied', latencyMs: null, budget: null };
  const budget = await budgetInfo(now);
  const refusal = budgetRefusal('poke', budget.value, budget.credits);
  if (refusal) return { outcome: refusal, latencyMs: null, budget: budget.value };
  pacer.notePoke(now);
  const r = await say(characterId, 'poke');
  return { outcome: r.outcome, latencyMs: Date.now() - now, budget: budget.value };
}

function capture(event: string, props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((a) => a.capture(event, props))
    .catch(() => {});
}

/** 261105: what roomReaction.ts asks before a reaction line. */
export function desktopLineState(characterId: string): { ready: boolean; running: boolean; onCall: boolean; occupied: boolean } {
  if (!deps) return { ready: false, running, onCall: false, occupied: false };
  const onCall = deps.onCall?.(characterId) === true;
  return { ready: true, running, onCall, occupied: onCall || deps.occupied(characterId) };
}

/** 261105: her reaction to room edits (`note`: roomReactionNote), shown as a bubble like a poke reply. */
export async function speakRoomReaction(characterId: string, note: string): Promise<PokeOutcome> {
  if (!deps) return 'not_live';
  if (running) return 'busy';
  if (seilinkLiveCharacter() !== characterId) return 'not_live';
  return (await say(characterId, 'react', note)).outcome;
}

async function say(characterId: string, kind: 'idle' | 'poke' | 'react', note?: string): Promise<{ outcome: PokeOutcome }> {
  running = true;
  try {
    let skipped: DesktopLineSkip = 'error';
    const { sendDesktopLineTurn } = await import('../chat/chatService');
    const line = await sendDesktopLineTurn(
      characterId,
      kind,
      (why) => {
        skipped = why;
      },
      note,
    ).catch(() => null);
    if (!line) return { outcome: skipped };
    // Saved to her chat either way; the bubble only when she is still on the desktop.
    for (const m of line.messages) deps?.pushChatMessage(characterId, m);
    // The host bubble knows idle and poke; a reaction answers the player like a poke.
    const sent = sendSeilinkLine(characterId, line.text, kind === 'react' ? 'poke' : kind, line.face ?? null);
    if (!sent) return { outcome: 'not_shown' };
    capture('seilink_line_shown', { kind, chars: line.text.length, character_id: characterId, expression: sent.expression });
    return { outcome: 'ok' };
  } finally {
    running = false;
  }
}
