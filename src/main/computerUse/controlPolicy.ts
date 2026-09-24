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
 *      shares a content word with the goal. Quoting "what's this?" to justify
 *      "click buy now" does not pass.
 *   2. Otherwise PROPOSE: nothing runs. The companion asks "want me to
 *      <goal>?" (the literal goal, composed here, so the player confirms what
 *      will actually run and not the model's paraphrase of it), and the goal
 *      is held as pending for PENDING_CONTROL_TTL_MS.
 *   3. The player's NEXT line settles a pending goal: a plain yes runs it,
 *      anything else drops it. Only that one line counts, and only in time.
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

export type PendingResolution = 'affirmed' | 'declined' | 'expired' | 'none';

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

/** Words that carry no task content: asking, politeness, pronouns. */
const FILLER = new Set(
  (
    'the a an and or to of in on at for with from into onto by is are be it its this that these those there here ' +
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
    if (w.length >= 3 && !FILLER.has(w)) out.push(w);
  }
  return out;
}

function tokensOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      // Light stemming: "settings" / "setting", "opened" / "open".
      if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
    }
  }
  return false;
}

/**
 * The model's `request` quote is a real ask from this line: it appears in
 * what the player said (word-aligned, case and punctuation ignored), it is
 * more than a single word, and it shares a content word with the goal.
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
  return tokensOverlap(contentTokens(r), contentTokens(goal));
}

export function decideControl(o: { tickKind: string; userText?: string; call: ControlCall }): ControlDecision {
  const goal = o.call.goal.trim();
  if (o.tickKind !== 'user') return { kind: 'propose', goal, why: 'not_user_tick' };
  if (!requestMatches(o.call.request, o.userText, goal)) return { kind: 'propose', goal, why: 'not_asked' };
  return { kind: 'run', goal, origin: 'asked', request: o.call.request!.trim() };
}

// ── The player's answer to a proposal ────────────────────────────────────

const YES_WORDS = new Set(
  'yes yeah yea yep yup ya yah yass sure ok okay okey kk alright aight absolutely definitely certainly affirmative'.split(' '),
);
const YES_PHRASES = ['go ahead', 'go for it', 'go on', 'do it', 'do that', 'please do', 'sounds good', 'of course', 'why not', 'lets do it'];
/** Words allowed around a yes ("yeah go ahead thanks"). Anything else means the line says more than yes. */
const YES_FILLER = new Set(
  'please pls plz thanks thank thx ty you do it that go ahead for on sounds good of course why not lets sure thing cool great nice fine lol haha haha man dude bro now then just'.split(' '),
);
const NO_WORDS = new Set(
  'no nope nah not dont never stop wait cancel later hold but instead nvm nevermind rather actually hmm'.split(' '),
);
const CJK_YES = ['好', '可以', '行', '是的', '对', '嗯', '要', 'はい', 'うん', 'いいよ', 'お願い', 'おねがい', '네', '응', '좋아'];
const CJK_NO = ['不', '别', '没', '等', '算了', 'いいえ', 'いや', 'だめ', 'ダメ', 'やめ', '待', '아니', '싫', '잠깐'];

/** A plain yes: an affirmative, no negation, and nothing else of substance. */
export function isAffirmation(text: string): boolean {
  const n = normalizeWords(text);
  if (!n) return false;
  if (CJK.test(n)) {
    const compact = n.replace(/\s/g, '');
    if (CJK_NO.some((w) => compact.includes(w))) return false;
    if (compact.length > 6) return false;
    return CJK_YES.some((w) => compact.includes(w));
  }
  const words = n.split(' ');
  if (words.length > 8) return false;
  if (words.some((w) => NO_WORDS.has(w))) return false;
  const padded = ` ${n} `;
  const yes = words.some((w) => YES_WORDS.has(w)) || YES_PHRASES.some((p) => padded.includes(` ${p} `));
  if (!yes) return false;
  // At most one word outside the yes vocabulary (their companion's name, say):
  // "ok open safari" asks for something else and is not a yes to the offer.
  const other = words.filter((w) => !YES_WORDS.has(w) && !YES_FILLER.has(w));
  return other.length <= 1;
}

/** Settle a pending proposal with the player's next line. */
export function resolvePending(p: PendingControl | null, userText: string | undefined, now: number): PendingResolution {
  if (!p) return 'none';
  if (now - p.at > PENDING_CONTROL_TTL_MS) return 'expired';
  return isAffirmation(userText ?? '') ? 'affirmed' : 'declined';
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
  | { kind: 'affirmed' | 'declined' | 'expired'; goal: string };

export type CallOutcome =
  | { kind: 'run'; goal: string; origin: 'asked'; request: string }
  /** `line` is the offer to speak, or null when the same goal is already on offer. */
  | { kind: 'propose'; goal: string; why: 'not_user_tick' | 'not_asked'; line: string | null }
  | { kind: 'ignored'; goal: string; why: 'confirmed_this_turn' };

/**
 * One backseat session's control state: at most one offer pending, settled by
 * the player's next line. backseatService calls onUserLine for every player
 * line BEFORE the turn runs, and onCall for a control() call in the reply.
 */
export class ControlGate {
  pending: PendingControl | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The player's next line settles any pending offer, whatever it says. */
  onUserLine(text: string | undefined): LineOutcome {
    const p = this.pending;
    this.pending = null;
    const r = resolvePending(p, text, this.now());
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
      return d;
    }
    const now = this.now();
    const same =
      this.pending &&
      now - this.pending.at <= PENDING_CONTROL_TTL_MS &&
      normalizeWords(this.pending.goal) === normalizeWords(d.goal);
    if (same) return { ...d, line: null };
    this.pending = { goal: d.goal, at: now };
    return { ...d, line: proposalLine(d.goal) };
  }

  clear(): void {
    this.pending = null;
  }
}
