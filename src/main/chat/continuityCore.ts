/**
 * The pure half of continuity.ts (261113): which rows a read shows, which
 * rows a fold takes, the launch handoff, and the fold's one LLM call, over
 * rows and a bridge passed in. continuity.ts does the disk, the scope and the
 * clear-epoch checks around them.
 *
 * Split out so the consistency eval (scripts/quality-eval/consistency) runs
 * the real selection and fold of the checkout it measures. Nothing here may
 * import electron or anything that does (paths, chatStore, sdk, llm/index).
 *
 * Game sessions (261113, v0.7 consistency D1): a play row now carries what
 * happened in the session (playSummary.ts playStory). Before, system rows
 * never reached the fold, so a game session was in the chat history until the
 * watermark passed it and then gone for good; the launch handoff skipped them
 * entirely. Now a play row folds with the conversation around it (a 'session'
 * line in the fold transcript) and rides in the launch handoff's `recent`.
 *
 * Bounded (261123, review): a play row never moves the watermark, so a player
 * who only plays and never texts used to carry every session row in every
 * chat turn and launch (60 sessions came to about 17k tokens a turn). Now:
 *   - a read shows only the newest MAX_SESSION_ROWS play rows;
 *   - PLAY_FOLD_TRIGGER open play rows make a fold due with no chat at all,
 *     and that fold takes all but the newest MAX_SESSION_ROWS of them;
 *   - one fold takes at most FOLD_MAX_PLAY_ROWS play rows (the batch's chat
 *     rows stop before the first one it leaves), so a batch stays bounded;
 *   - the bridge's `playFoldedTs` marks the play rows a fold has taken, so a
 *     play-only fold is remembered without moving the watermark.
 */
import type { ChatMessage } from '../../shared/ipc';
import { buildFoldSystem, buildFoldUserText, extractRememberTag, extractSummaryTag, type FoldMsg } from './foldPrompt';
import { playStoryText } from './playSummary';

/** Verbatim tail preserved after a fold. */
export const RECENT_WINDOW = 50;
/** A fold fires only once this many messages have piled up BEYOND the window. */
export const FOLD_BATCH = 50;
/**
 * Hard ceiling on the verbatim tail a read may ever ship (1.5× the normal max of
 * RECENT_WINDOW + FOLD_BATCH - 1 = 99). Safety valve for the case where folds
 * persistently FAIL: the watermark only advances via foldIntoSummary, so if every
 * fold 400s (e.g. a BYOK key that can call the chat Haiku but not SUMMARY_MODEL)
 * the unsummarized tail would otherwise grow without bound until the chat model's
 * context window overflows → permanent "sorry, i couldn't reply" with no recovery.
 * Clamping the effective watermark from below degrades that failure to "the oldest
 * unsummarized messages fall out of context" instead. foldIfDue reads the bridge
 * directly (not readWindow), so the TRUE backlog still drains fully once folds
 * recover — this clamp only bounds what READS surface, never what the fold covers.
 */
export const MAX_UNSUMMARIZED = 150;
/** Most messages one fold takes (260810: a long backlog drains over several folds, see continuity.ts). */
export const FOLD_MAX_MESSAGES = 300;
export const SUMMARY_MAX_TOKENS = 4000;
/** Most game sessions (play rows) the chat context and the launch handoff show (261123). */
export const MAX_SESSION_ROWS = 4;
/** Open play rows at which a fold is due even with no chat (a player who only plays). */
export const PLAY_FOLD_TRIGGER = 8;
/** Most play rows one fold takes. */
export const FOLD_MAX_PLAY_ROWS = 12;

export interface BridgeState {
  summary: string;
  /** How many user/companion rows the summary covers (the watermark). */
  summarizedCount: number;
  /**
   * 261123: the newest play row a fold has taken (its ts). Play rows at or
   * before it are in the summary, wherever the watermark is. Absent on older
   * bridges and before the first fold that took a play row.
   */
  playFoldedTs?: number;
}

/** A row of the launch handoff. 'session' is a finished game session (its play row). */
export interface LaunchContinuityRow {
  role: 'user' | 'companion' | 'session';
  text: string;
  ts?: number;
}

export interface LaunchContinuity {
  summary: string;
  recent: LaunchContinuityRow[];
}

export const isCounted = (m: ChatMessage): boolean => m.role === 'user' || m.role === 'companion';

/** A play row that a fold or the launch handoff carries (every game surface writes one). */
export const isPlayRow = (m: ChatMessage): boolean => m.role === 'system' && m.event?.kind === 'play';

/** A play row a fold already took (BridgeState.playFoldedTs). */
export function isFoldedPlay(m: ChatMessage, bridge: BridgeState): boolean {
  return typeof bridge.playFoldedTs === 'number' && typeof m.ts === 'number' && m.ts <= bridge.playFoldedTs;
}

/** Keep only the newest `max` items that `isSession` picks; every other item stays. Order is kept. */
export function capSessionRows<T>(items: readonly T[], isSession: (t: T) => boolean, max = MAX_SESSION_ROWS): T[] {
  let left = items.reduce((n, t) => (isSession(t) ? n + 1 : n), 0) - max;
  if (left <= 0) return [...items];
  return items.filter((t) => !(isSession(t) && left-- > 0));
}

/** A play row as one line: its sentence, plus what happened in it when known. */
export function sessionText(m: ChatMessage): string {
  const story = m.event?.kind === 'play' ? playStoryText(m.event) : '';
  return story ? `${m.text} ${story}` : m.text;
}

/**
 * The bridge as reads should use it: a transcript shorter than the
 * watermark was cleared or replaced behind the bridge's back, so its summary
 * describes rows that no longer exist.
 */
export function effectiveBridge(countedRows: number, bridge: BridgeState): BridgeState {
  if (bridge.summarizedCount >= countedRows && bridge.summarizedCount > 0) return { summary: '', summarizedCount: 0 };
  return bridge;
}

/** The read window: the bridge plus the clamped watermark (MAX_UNSUMMARIZED). */
export function windowOf(raw: readonly ChatMessage[], stored: BridgeState): { bridge: BridgeState; watermark: number } {
  const counted = raw.filter(isCounted).length;
  const bridge = effectiveBridge(counted, stored);
  return { bridge, watermark: Math.max(bridge.summarizedCount, counted - MAX_UNSUMMARIZED) };
}

/**
 * Context for a CHAT turn: the summary + every row from the watermark on,
 * system rows included (toMessages renders play and call rows). `base` is
 * the absolute position of the first user/companion row (voiceWindowStart).
 */
export function chatContextFrom(
  raw: readonly ChatMessage[],
  stored: BridgeState,
): { summary: string; history: ChatMessage[]; base: number } {
  const { bridge, watermark } = windowOf(raw, stored);
  const history: ChatMessage[] = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      seen++;
      if (seen > watermark) history.push(m);
    } else if (seen >= watermark && !(isPlayRow(m) && isFoldedPlay(m, bridge))) {
      // System rows (play sessions, call rows) ride along with the era they
      // belong to; rows older than the watermark are already covered by the fold.
      history.push(m);
    }
  }
  // 261123: the newest MAX_SESSION_ROWS game sessions only (see the header).
  return { summary: bridge.summary, history: capSessionRows(history, isPlayRow), base: watermark };
}

/**
 * The MC-launch handoff: the summary plus the whole unsummarized tail,
 * game sessions included. null when there is nothing to hand over.
 */
export function launchContinuityFrom(raw: readonly ChatMessage[], stored: BridgeState): LaunchContinuity | null {
  const { bridge, watermark } = windowOf(raw, stored);
  const recent: LaunchContinuityRow[] = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      seen++;
      if (seen > watermark) recent.push({ role: m.role as 'user' | 'companion', text: m.text, ts: m.ts });
    } else if (seen >= watermark && isPlayRow(m) && !isFoldedPlay(m, bridge)) {
      recent.push({ role: 'session', text: sessionText(m), ts: m.ts });
    }
  }
  if (!recent.length && !bridge.summary) return null;
  return { summary: bridge.summary, recent: capSessionRows(recent, (r) => r.role === 'session') };
}

/**
 * The batch the next fold takes, or null when none is due.
 *
 * Due when the user/companion rows beyond the recent window reach FOLD_BATCH
 * (the chat trigger), or when PLAY_FOLD_TRIGGER play rows are open (261123,
 * the play trigger: a player who only plays). The chat trigger takes the
 * oldest user/companion rows beyond the window (up to FOLD_MAX_MESSAGES);
 * `counted` is how far the watermark moves, and play rows never count.
 *
 * The play rows a batch takes, oldest first, at most FOLD_MAX_PLAY_ROWS:
 *   - every open play row inside the chat rows' range (its position, the
 *     user/companion rows before it, is before the range's end), so it leaves
 *     the chat history in the same fold its neighbours do (chatContextFrom
 *     keeps seen >= watermark);
 *   - on the play trigger, every open play row but the newest MAX_SESSION_ROWS.
 * When the cap leaves a play row inside the range, the range ends before it,
 * so no play row is passed by the watermark unfolded. `playFoldedTs` is the
 * newest taken play row's ts, for the bridge.
 */
export function selectFold(
  raw: readonly ChatMessage[],
  stored: BridgeState,
): { bridge: BridgeState; msgs: FoldMsg[]; counted: number; playFoldedTs?: number } | null {
  const total = raw.filter(isCounted).length;
  const bridge = effectiveBridge(total, stored);
  const from = bridge.summarizedCount;
  const unsummarized = total - from;
  // Open play rows: not passed by the watermark, not taken by a fold yet.
  const open: Array<{ m: ChatMessage; pos: number }> = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) seen++;
    else if (isPlayRow(m) && seen >= from && !isFoldedPlay(m, bridge)) open.push({ m, pos: seen });
  }
  const chatDue = unsummarized >= RECENT_WINDOW + FOLD_BATCH;
  const playDue = open.length >= PLAY_FOLD_TRIGGER;
  if (!chatDue && !playDue) return null;
  let to = from + (chatDue ? Math.min(unsummarized - RECENT_WINDOW, FOLD_MAX_MESSAGES) : 0);
  const newest = new Set(playDue ? open.slice(-MAX_SESSION_ROWS).map((o) => o.m) : []);
  const wanted = open.filter((o) => o.pos < to || (playDue && !newest.has(o.m)));
  const taken = wanted.slice(0, FOLD_MAX_PLAY_ROWS);
  const left = wanted[FOLD_MAX_PLAY_ROWS];
  if (left && left.pos < to) to = left.pos;
  const takenSet = new Set(taken.map((o) => o.m));
  const msgs: FoldMsg[] = [];
  seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      if (seen >= from && seen < to) msgs.push({ role: m.role as 'user' | 'companion', text: m.text, ts: m.ts });
      seen++;
    } else if (takenSet.has(m)) {
      msgs.push({ role: 'session', text: sessionText(m), ts: m.ts });
    }
  }
  if (!msgs.length) return null;
  const playTs = taken.reduce((t, o) => (typeof o.m.ts === 'number' && o.m.ts > t ? o.m.ts : t), -Infinity);
  return {
    bridge,
    msgs,
    counted: to - from,
    ...(Number.isFinite(playTs) ? { playFoldedTs: playTs } : {}),
  };
}

/** The bridge after a fold of `batch` that wrote `summary` (continuity.ts, the eval). */
export function bridgeAfterFold(
  batch: { bridge: BridgeState; counted: number; playFoldedTs?: number },
  summary: string,
): BridgeState {
  const playFoldedTs = Math.max(batch.playFoldedTs ?? -Infinity, batch.bridge.playFoldedTs ?? -Infinity);
  return {
    summary,
    summarizedCount: batch.bridge.summarizedCount + batch.counted,
    ...(Number.isFinite(playFoldedTs) ? { playFoldedTs } : {}),
  };
}

/** The slice of an LLM provider a fold needs (llm/types LlmProvider.call). */
export interface FoldLlm {
  call(p: {
    model?: string;
    maxTokens: number;
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
    timeoutMs?: number;
    anthropicExtra?: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: string }>; stopReason?: string | null }>;
}

export type FoldResult =
  // 261113 (v0.7 D2): `facts`, the <remember> lines, saved by the caller.
  | { status: 'ok'; summary: string; facts: string[]; raw: string }
  | { status: 'max_tokens' | 'empty'; raw: string };

/**
 * The fold's one LLM call over a selected batch. A model the account cannot
 * use (`isRejection`) is retried once with `fallbackModel()` and no extras
 * (a getter: it is only read on that path, like before the split).
 * Throws on any other error; the caller keeps its watermark.
 */
export async function runFold(p: {
  llm: FoldLlm;
  summary: string;
  msgs: FoldMsg[];
  /** The memory notes as the chat reads them, so the facts skip what is saved (D2). */
  memory?: string;
  persona?: string;
  model: string;
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  fallbackModel?: () => string;
  isRejection?: (msg: string) => boolean;
  onFallback?: (msg: string) => void;
}): Promise<FoldResult> {
  const system = buildFoldSystem(p.persona);
  const userText = buildFoldUserText(p.summary, p.msgs, p.memory);
  const once = (model: string, extra?: Record<string, unknown>) =>
    p.llm.call({
      model,
      maxTokens: SUMMARY_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userText }],
      ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      ...(extra ? { anthropicExtra: extra } : {}),
    });
  let res: Awaited<ReturnType<typeof once>>;
  try {
    res = await once(p.model, p.extra);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!p.fallbackModel || !p.isRejection?.(msg)) throw err;
    const fallback = p.fallbackModel();
    p.onFallback?.(msg);
    res = await once(fallback);
  }
  const raw = res.content.map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : '')).join('');
  if (res.stopReason === 'max_tokens') return { status: 'max_tokens', raw };
  const summary = extractSummaryTag(raw);
  return summary ? { status: 'ok', summary, facts: extractRememberTag(raw), raw } : { status: 'empty', raw };
}
