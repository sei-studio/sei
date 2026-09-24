/**
 * 260925 backseat act: WHEN a control() call may drive. Pure, no Electron.
 *
 * The threat is the screen: a page, a document or a chat on the shared window
 * can say "click Buy" and a model that reads it can call control() on its own.
 * So whether a call runs is decided here, mechanically, from things the screen
 * cannot write: the tick kind and the player's own words.
 *
 *   1. RUN at once: a USER tick, and the call's `request` (the player's words
 *      the model says asked for it) is really in what the player just said AND
 *      every content word of the goal is in it. Quoting "this game is so hard"
 *      to justify "uninstall the game", or "open settings" to justify "open
 *      settings and turn off the firewall", does not pass.
 *   2. Otherwise OFFER: nothing runs. The companion asks "want me to
 *      <goal>?" (the literal goal, composed here, so the player confirms what
 *      will actually run and not the model's paraphrase of it). The offer is
 *      a DRAFT until the player has heard it: on a call, until the renderer
 *      reports the line played to its end (a barge-in or a newer turn cutting
 *      it off drops it); in text, once it is shown. Only then is it pending,
 *      for PENDING_CONTROL_TTL_MS.
 *   3. The player's NEXT line settles a pending offer: a bare yes runs it,
 *      anything else drops it. A spoken yes within a second of any
 *      companion's voice may be that voice, so it is re-asked instead.
 *
 * Every mistake here is on the safe side: a real request that fails the check
 * costs one "want me to ...?" round trip.
 */
import type { ControlCall } from './controlTool';

export const PENDING_CONTROL_TTL_MS = 30_000;

/** How a run came about, for the act loop's prompt. */
export type ControlOrigin = 'asked' | 'confirmed';

export interface PendingControl {
  goal: string;
  /** When it was proposed (ms). */
  at: number;
}

export type ControlDecision =
  | { kind: 'run'; goal: string; origin: 'asked'; request: string }
  | { kind: 'propose'; goal: string; why: 'not_user_tick' | 'not_asked' };

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯]+/g;

/** Lowercase, apostrophes dropped, everything that is not a letter or digit to one space. */
export function normalizeWords(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Words that carry no task content: asking, politeness, pronouns. Direction
 * and state words (on, off, in, out, up, down) are NOT here: "turn on" and
 * "turn off" must not match each other.
 */
const FILLER = new Set(
  (
    'the a an and or to of at for with from into onto by is are be it its this that these those there here ' +
    'you your me my i we our us can could would will should shall do does did please pls plz just now then also too ' +
    'want wanna need help let lets get make go some any thing stuff like really so ok okay yes yeah hey hi ' +
    'what how why when where which who something'
  ).split(' '),
);

function contentTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of normalizeWords(s).split(' ')) {
    if (!w) continue;
    if (CJK.test(w)) {
      for (const run of w.match(CJK_RUN) ?? []) {
        if (run.length === 1) out.push(run);
        for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
      }
      continue;
    }
    if (w.length >= 2 && !FILLER.has(w)) out.push(w);
  }
  return out;
}

function sameWord(x: string, y: string): boolean {
  if (x === y) return true;
  // Light stemming: "settings" / "setting", "opened" / "open".
  return x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x));
}

/** Every content word of `goal` is among `said`'s. */
function coversGoal(said: string[], goal: string[]): boolean {
  return goal.length > 0 && goal.every((g) => said.some((w) => sameWord(w, g)));
}

/**
 * The model's `request` quote is a real ask from this line for THIS goal: it
 * appears in what the player said (word-aligned, case and punctuation
 * ignored), it is more than a single word, and EVERY content word of the goal
 * is in it. Anything the goal adds beyond the player's words ("and turn off
 * the firewall") makes it an offer instead.
 */
export function requestMatches(request: string | undefined, userText: string | undefined, goal: string): boolean {
  if (!request || !userText) return false;
  const r = normalizeWords(request);
  const u = normalizeWords(userText);
  if (!r || !u) return false;
  const cjk = CJK.test(r);
  if (cjk ? r.replace(/\s/g, '').length < 2 : r.split(' ').length < 2) return false;
  const inLine = cjk ? u.replace(/\s/g, '').includes(r.replace(/\s/g, '')) : ` ${u} `.includes(` ${r} `);
  if (!inLine) return false;
  return coversGoal(contentTokens(r), contentTokens(goal));
}

export function decideControl(o: { tickKind: string; userText?: string; call: ControlCall }): ControlDecision {
  const goal = o.call.goal.trim();
  if (o.tickKind !== 'user') return { kind: 'propose', goal, why: 'not_user_tick' };
  if (!requestMatches(o.call.request, o.userText, goal)) return { kind: 'propose', goal, why: 'not_asked' };
  return { kind: 'run', goal, origin: 'asked', request: o.call.request!.trim() };
}

// ── The player's answer to an offer ──────────────────────────────────────

/** The yes itself. */
const YES_CORE = ['yes', 'yeah', 'yea', 'yep', 'yup', 'sure', 'do it', 'go ahead'];
/** Allowed around it, and nothing else. */
const YES_EXTRA = ['please', 'pls', 'plz', 'ok', 'okay'];
/** CJK yes pieces; an answer must be made only of these. */
const CJK_YES = ['好的', '好啊', '好吧', '好', '可以', '行', '是的', '要', '麻烦了', 'はい', 'うん', 'いいよ', 'お願いします', 'お願い', 'おねがい', '네', '응', '좋아', '그래'];

/**
 * A bare yes: yes / yeah / sure / do it / go ahead, optionally with please
 * or ok, and NOTHING else ("yeah totally", "yes but later" and "ok open
 * safari" are not a yes to the offer). A plain "ok" alone is not a yes
 * either: it is as often "ok, I heard you".
 */
export function isAffirmation(text: string): boolean {
  const n = normalizeWords(text);
  if (!n) return false;
  if (CJK.test(n)) {
    let rest = n.replace(/\s/g, '');
    if (rest.length > 8) return false;
    while (rest) {
      const hit = CJK_YES.find((w) => rest.startsWith(w));
      if (!hit) return false;
      rest = rest.slice(hit.length);
    }
    return true;
  }
  let rest = ` ${n} `;
  let core = 0;
  for (const phrase of [...YES_CORE, ...YES_EXTRA]) {
    const pat = ` ${phrase} `;
    while (rest.includes(pat)) {
      rest = rest.replace(pat, ' ');
      if (YES_CORE.includes(phrase)) core += 1;
    }
  }
  return core > 0 && rest.trim() === '' && n.split(' ').length <= 5;
}

/** A spoken answer this close to companion audio may be that audio. */
export const TTS_GUARD_MS = 1_000;

export type PendingResolution = 'affirmed' | 'unsure' | 'declined' | 'expired' | 'none';

/**
 * Settle a pending offer with the player's next line. `ttsGapMs` is set for
 * a line that came from the microphone (BackseatTick.mic): a yes within
 * TTS_GUARD_MS of companion audio is 'unsure' and gets re-asked.
 */
export function resolvePending(
  p: PendingControl | null,
  userText: string | undefined,
  now: number,
  mic?: { ttsGapMs: number | null },
): PendingResolution {
  if (!p) return 'none';
  if (now - p.at > PENDING_CONTROL_TTL_MS) return 'expired';
  if (!isAffirmation(userText ?? '')) return 'declined';
  if (mic && mic.ttsGapMs !== null && mic.ttsGapMs < TTS_GUARD_MS) return 'unsure';
  return 'affirmed';
}

/** The one-line offer, built from the literal goal. */
export function proposalLine(goal: string): string {
  let g = goal.trim().replace(/[.!?\s]+$/, '');
  // "Turn on dark mode" -> "turn on dark mode", but keep "I", "VPN", "Safari".
  if (/^[A-Z][a-z]/.test(g)) g = g[0]!.toLowerCase() + g.slice(1);
  g = g.replace(/^to\s+/i, '');
  if (g.length > 140) {
    const cut = g.slice(0, 140);
    g = cut.slice(0, Math.max(cut.lastIndexOf(' '), 100)).trim();
  }
  return `want me to ${g}?`;
}

// ── Per-session state ─────────────────────────────────────────────────────

export type LineOutcome =
  | { kind: 'none' }
  | { kind: 'affirmed' | 'unsure' | 'declined' | 'expired'; goal: string };

export type CallOutcome =
  | { kind: 'run'; goal: string; origin: 'asked'; request: string }
  /**
   * `offer` is the line to speak and the id to confirm it with once heard
   * (heard()), or null when the same goal is already on offer.
   */
  | { kind: 'propose'; goal: string; why: 'not_user_tick' | 'not_asked'; offer: { line: string; id: string } | null }
  | { kind: 'ignored'; goal: string; why: 'confirmed_this_turn' };

/** A draft never heard back from (dropped TTS, a closed overlay) stops counting after this. */
const DRAFT_MAX_AGE_MS = 60_000;
/** A draft younger than this may still be queued for playback, so the same goal is not re-offered. */
const DRAFT_DEDUPE_MS = 15_000;

/**
 * One backseat session's control state: at most one offer, first a DRAFT
 * (spoken but not yet heard), then PENDING (heard, answerable), settled by
 * the player's next line. backseatService calls onUserLine for every player
 * line BEFORE the turn runs, onCall for a control() call in the reply,
 * heard() when the renderer reports the offer line's playback, and
 * dropOffer() on a barge-in.
 */
export class ControlGate {
  pending: PendingControl | null = null;
  draft: { goal: string; id: string; at: number } | null = null;
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The player's next line settles any pending offer, whatever it says. A draft they never heard is not theirs to answer. */
  onUserLine(text: string | undefined, mic?: { ttsGapMs: number | null }): LineOutcome {
    const p = this.pending;
    this.pending = null;
    const r = resolvePending(p, text, this.now(), mic);
    return r === 'none' || !p ? { kind: 'none' } : { kind: r, goal: p.goal };
  }

  /**
   * A control() call in a reply. `confirmedThisTurn`: this turn's player line
   * already started a confirmed run, so a call in the same reply (usually the
   * model restating the goal) is not a second one.
   */
  onCall(o: { tickKind: string; userText?: string; call: ControlCall; confirmedThisTurn?: boolean }): CallOutcome {
    const d = decideControl(o);
    if (o.confirmedThisTurn) return { kind: 'ignored', goal: d.goal, why: 'confirmed_this_turn' };
    if (d.kind === 'run') {
      this.pending = null;
      this.draft = null;
      return d;
    }
    const now = this.now();
    // The same goal already on offer is not offered twice in a row. A draft
    // counts only while it could still be playing: one whose line was dropped
    // unheard must not block the offer from being made again.
    const onOffer =
      this.pending && now - this.pending.at <= PENDING_CONTROL_TTL_MS
        ? this.pending.goal
        : this.draft && now - this.draft.at <= DRAFT_DEDUPE_MS
          ? this.draft.goal
          : undefined;
    if (onOffer !== undefined && normalizeWords(onOffer) === normalizeWords(d.goal)) return { ...d, offer: null };
    return { ...d, offer: this.offer(d.goal) };
  }

  /** Draft a (re-)offer of `goal`; it becomes answerable once heard(). */
  offer(goal: string): { line: string; id: string } {
    const id = `offer-${++this.seq}-${this.now()}`;
    this.pending = null;
    this.draft = { goal, id, at: this.now() };
    return { line: proposalLine(goal), id };
  }

  /**
   * The renderer's report on the offer line: played to its end (`completed`)
   * or cut off. Only a completed, current draft becomes pending. Returns what
   * happened, for the log.
   */
  heard(id: string, completed: boolean): 'armed' | 'dropped' | 'stale' {
    const d = this.draft;
    if (!d || d.id !== id) return 'stale';
    this.draft = null;
    if (!completed || this.now() - d.at > DRAFT_MAX_AGE_MS) return 'dropped';
    this.pending = { goal: d.goal, at: this.now() };
    return 'armed';
  }

  /** A barge-in: the player talked over the companion, so an offer in flight was not (fully) heard. */
  dropOffer(): boolean {
    const had = this.draft !== null || this.pending !== null;
    this.draft = null;
    this.pending = null;
    return had;
  }

  clear(): void {
    this.draft = null;
    this.pending = null;
  }
}
