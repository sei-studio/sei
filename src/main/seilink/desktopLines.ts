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
 * seilink_line_shown {kind, chars, character_id}, shape only.
 */
import { powerMonitor } from 'electron';
import type { ChatMessage } from '../../shared/ipc';
import { loadConfig } from '../configStore';
import { loadAnalytics } from '../lazyAnalytics';
import { seilinkHostBusy, seilinkHostStatus, seilinkLiveCharacter, sendSeilinkLine } from './host/seilinkHost';

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

/** When the next idle line may come, and how many lines came in the last hour. */
export class LinePacer {
  private who: string | null = null;
  private nextIdleAt = 0;
  private idleTimes: number[] = [];
  private pokeTimes: number[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  /** Who is on the desktop now. A new companion waits a full gap before her first idle line. */
  follow(characterId: string | null, now: number): void {
    if (characterId === this.who) return;
    this.who = characterId;
    this.nextIdleAt = characterId ? now + this.gap() : 0;
    this.idleTimes = [];
    this.pokeTimes = [];
  }

  idleDue(now: number): boolean {
    if (!this.who || now < this.nextIdleAt) return false;
    return this.recent(this.idleTimes, now) < IDLE_PER_HOUR;
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
  /** Her saved line, to the main window's chat. */
  pushChatMessage(characterId: string, message: ChatMessage): void;
}

let deps: DesktopLinesDeps | null = null;
const pacer = new LinePacer();
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let budgetCache: { at: number; value: LineBudget } | null = null;

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

async function currentBudget(now: number): Promise<LineBudget> {
  if (budgetCache && now - budgetCache.at < BUDGET_TTL_MS) return budgetCache.value;
  let value: LineBudget = 'none';
  try {
    const { getAiBackendKind } = await import('../apiKeyStore');
    const backend = await getAiBackendKind();
    if (backend === 'local') value = 'own';
    else {
      const { creditsGet } = await import('../cloud/proxyClient');
      value = lineBudgetFor(backend, await creditsGet());
    }
  } catch {
    value = 'none';
  }
  budgetCache = { at: now, value };
  return value;
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
  if (!id || running || !deps || !pacer.idleDue(now)) return;
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
  if (block) return;
  if (!budgetAllows('idle', await currentBudget(now))) return;
  const spoke = await say(id, 'idle');
  pacer.noteIdle(Date.now(), spoke);
}

/** A double click on her (hostEntry's click classifier, via seilinkHost deps.onDoubleClick). */
export async function onSeilinkPoke(characterId: string): Promise<void> {
  const now = Date.now();
  if (!deps || running || seilinkLiveCharacter() !== characterId) return;
  if (!pacer.canPoke(now) || deps.occupied(characterId)) return;
  if (!budgetAllows('poke', await currentBudget(now))) return;
  pacer.notePoke(now);
  await say(characterId, 'poke');
}

async function say(characterId: string, kind: 'idle' | 'poke'): Promise<boolean> {
  running = true;
  try {
    const { sendDesktopLineTurn } = await import('../chat/chatService');
    const line = await sendDesktopLineTurn(characterId, kind).catch(() => null);
    if (!line) return false;
    // Saved to her chat either way; the bubble only when she is still on the desktop.
    for (const m of line.messages) deps?.pushChatMessage(characterId, m);
    if (!sendSeilinkLine(characterId, line.text, kind)) return false;
    void loadAnalytics()
      .then((a) => a.capture('seilink_line_shown', { kind, chars: line.text.length, character_id: characterId }))
      .catch(() => {});
    return true;
  } finally {
    running = false;
  }
}
