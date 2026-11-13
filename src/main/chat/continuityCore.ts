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
 */
import type { ChatMessage } from '../../shared/ipc';
import { buildFoldSystem, buildFoldUserText, extractRememberTag, extractSummaryTag, type FoldMsg } from './foldPrompt';
import { playStoryText } from './playSummary';
import { parseBondBlock } from '../../bot/brain/memory/bond.js';
import type { Bond } from '../../shared/bondSchema';

/** A parsed `<bond>` block (memory/bond.js parseBondBlock), merged by saveBondUpdate. */
export type BondUpdate = NonNullable<ReturnType<typeof parseBondBlock>['update']>;

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

export interface BridgeState {
  summary: string;
  /** How many user/companion rows the summary covers (the watermark). */
  summarizedCount: number;
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
    } else if (seen >= watermark) {
      // System rows (play sessions, call rows) ride along with the era they
      // belong to; rows older than the watermark are already covered by the fold.
      history.push(m);
    }
  }
  return { summary: bridge.summary, history, base: watermark };
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
    } else if (seen >= watermark && isPlayRow(m)) {
      recent.push({ role: 'session', text: sessionText(m), ts: m.ts });
    }
  }
  if (!recent.length && !bridge.summary) return null;
  return { summary: bridge.summary, recent };
}

/**
 * The batch the next fold takes, or null when none is due: the oldest
 * user/companion rows beyond the recent window (FOLD_BATCH at least, up to
 * FOLD_MAX_MESSAGES), plus the play rows among them. `counted` is how far the
 * watermark moves; play rows never count, like the watermark itself. A play
 * row belongs to the batch when it sits before the batch's last row (its
 * position, the user/companion rows before it, is inside [from, to)), so
 * every play row is folded exactly once and leaves the chat history in the
 * same fold that its neighbours do (chatContextFrom keeps seen >= watermark).
 */
export function selectFold(
  raw: readonly ChatMessage[],
  stored: BridgeState,
): { bridge: BridgeState; msgs: FoldMsg[]; counted: number } | null {
  const total = raw.filter(isCounted).length;
  const bridge = effectiveBridge(total, stored);
  const unsummarized = total - bridge.summarizedCount;
  if (unsummarized < RECENT_WINDOW + FOLD_BATCH) return null;
  const counted = Math.min(unsummarized - RECENT_WINDOW, FOLD_MAX_MESSAGES);
  const from = bridge.summarizedCount;
  const to = from + counted;
  const msgs: FoldMsg[] = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      if (seen >= from && seen < to) msgs.push({ role: m.role as 'user' | 'companion', text: m.text, ts: m.ts });
      seen++;
      if (seen >= to) break;
    } else if (isPlayRow(m) && seen >= from && seen < to) {
      msgs.push({ role: 'session', text: sessionText(m), ts: m.ts });
    }
  }
  return { bridge, msgs, counted };
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
  | { status: 'ok'; summary: string; facts: string[]; raw: string; bond?: BondUpdate | null }
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
  /**
   * 261113 (D3): the current bond (null = none yet). When set (even null) the
   * fold also returns a bond update; undefined leaves the bond out entirely.
   */
  bond?: Bond | null;
  persona?: string;
  model: string;
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  fallbackModel?: () => string;
  isRejection?: (msg: string) => boolean;
  onFallback?: (msg: string) => void;
}): Promise<FoldResult> {
  const withBond = p.bond !== undefined;
  const system = buildFoldSystem(p.persona, { bond: withBond });
  const userText = buildFoldUserText(p.summary, p.msgs, p.memory, withBond ? (p.bond ?? null) : undefined);
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
  // The <bond> block comes out first, so neither the summary nor the facts read it.
  const { update, rest } = withBond ? parseBondBlock(raw) : { update: null, rest: raw };
  const summary = extractSummaryTag(rest);
  return summary
    ? { status: 'ok', summary, facts: extractRememberTag(rest), raw, ...(withBond ? { bond: update } : {}) }
    : { status: 'empty', raw };
}
