/**
 * The "next time" check for text chat (261107, O2 retention).
 *
 * Text chat was the one conversation surface with no next step: the check in
 * playerEndNextStep.ts is a small LLM call, and on the free cloud plan that
 * call is a cost to Sei for every chat that goes quiet. So the chat end runs
 * the SAME check (same prompt, gates, ledger tag and Home card) only when it
 * costs Sei nothing: BYOK, Ollama and other local models, the ChatGPT plan,
 * or a paid plan (which spends its own allowance, as a call does). A free
 * cloud account is reported as `not_covered` with `skip_reason: 'free_cloud'`
 * (the gate is `skipOnFreeCloud`, checked inside the run).
 *
 * How a chat ends decides when the check runs (chatEndRoute):
 *   - idle (5 min quiet): now, in the background. endChatSession never waits.
 *   - quit: written to PENDING_NEXT_STEP.json and checked on the next launch
 *     (quitNextStep.ts), since quit has no time for an LLM call. The lines are
 *     already in the chat transcript, so only the window is kept.
 *   - account_switch: not covered, like a call lost to a switch.
 * A chat with fewer than CHAT_MIN_PLAYER_MESSAGES player messages is trivial
 * and never reaches the plan read or the model. The run's own gates still
 * apply on top: 2 min floor, offline, over limit, dedupe, time box.
 *
 * Analytics: the check's `next_step_checked {source, surface:'chat', saved,
 * outcome, reached_model, duration_s}` and `next_step_saved` on a save.
 * Shape only.
 */
import type { ChatMessage } from '../shared/ipc';
import {
  reportNextStepNotRun,
  startPlayerEndNextStep,
  type DigestLine,
  type PlayerEndInput,
  type PlayerEndOutcome,
} from './playerEndNextStep';

/** Player messages a chat needs before a check is worth it. */
export const CHAT_MIN_PLAYER_MESSAGES = 4;
/** The prompt's "Session: a text chat, about N minutes." */
export const CHAT_ACTIVITY = 'a text chat';
/** Rows this long before the first message still belong to the window. */
const WINDOW_LEAD_MS = 5_000;
/** The companion's reply to the last message lands after it. */
export const WINDOW_TAIL_MS = 5 * 60_000;

export type ChatEndReason = 'idle' | 'quit' | 'account_switch';

/** What a chat end does about its next step. Pure. */
export function chatEndRoute(p: { reason: ChatEndReason; messages: number }): 'check' | 'persist' | 'trivial' | 'not_covered' {
  if (p.reason === 'account_switch') return 'not_covered';
  if (p.messages < CHAT_MIN_PLAYER_MESSAGES) return 'trivial';
  return p.reason === 'quit' ? 'persist' : 'check';
}

/**
 * A text chat's conversation from the transcript: typed (not voice) player
 * and companion rows from `since` to `until`, last 16, plus how many the
 * player wrote. Pure.
 */
export function chatDigestFromRows(
  rows: ChatMessage[],
  since: number,
  until = Number.POSITIVE_INFINITY,
): { lines: DigestLine[]; playerLines: number } {
  const typed = rows.filter(
    (r) => r.voice !== true && r.ts >= since && r.ts <= until && (r.role === 'user' || r.role === 'companion'),
  );
  return {
    lines: typed.slice(-16).map((r) => ({ who: r.role === 'user' ? 'player' : 'you', text: r.text })),
    playerLines: typed.filter((r) => r.role === 'user').length,
  };
}

/** The check input for a chat, from its window [startedAt, lastAt]. Pure. */
export function chatCheckInput(p: {
  characterId: string;
  startedAt: number;
  lastAt: number;
  rows: ChatMessage[];
  /** Player messages over the whole session (chatSession's count). */
  messages?: number;
  source?: PlayerEndInput['source'];
  eventProps?: PlayerEndInput['eventProps'];
}): PlayerEndInput {
  const chat = chatDigestFromRows(p.rows, p.startedAt - WINDOW_LEAD_MS, p.lastAt + WINDOW_TAIL_MS);
  return {
    characterId: p.characterId,
    surface: 'chat',
    activity: CHAT_ACTIVITY,
    durationMs: Math.max(0, p.lastAt - p.startedAt),
    lines: chat.lines,
    playerLines: Math.max(chat.playerLines, p.messages ?? 0),
    minPlayerLines: CHAT_MIN_PLAYER_MESSAGES,
    skipOnFreeCloud: true,
    ...(p.source ? { source: p.source } : {}),
    ...(p.eventProps ? { eventProps: p.eventProps } : {}),
  };
}

export interface ChatEndSession {
  characterId: string;
  startedAt: number;
  lastAt: number;
  messages: number;
}

export interface ChatNextStepDeps {
  recentRows(characterId: string): Promise<ChatMessage[]>;
  start(input: PlayerEndInput): Promise<PlayerEndOutcome>;
  /** quitNextStep.persistQuitSession. */
  persist(record: { characterId: string; surface: 'chat'; durationMs: number; endedAt: number }): boolean;
}

/**
 * One chat session ended. Never throws, never rejects. The idle check is
 * started and NOT awaited (the returned promise settles once it is
 * started), so closing the chat never waits on the model.
 */
export async function chatSessionNextStep(
  s: ChatEndSession,
  reason: ChatEndReason,
  capture: (event: string, props: Record<string, unknown>) => void,
  deps?: ChatNextStepDeps,
): Promise<void> {
  try {
    const durationMs = Math.max(0, s.lastAt - s.startedAt);
    const notRun = { characterId: s.characterId, surface: 'chat' as const, endReason: reason, durationMs };
    const route = chatEndRoute({ reason, messages: s.messages });
    if (route === 'not_covered' || route === 'trivial') {
      reportNextStepNotRun({ ...notRun, outcome: route }, capture);
      return;
    }
    const d = deps ?? (await defaultDeps());
    if (route === 'persist') {
      const kept = d.persist({ characterId: s.characterId, surface: 'chat', durationMs, endedAt: s.lastAt });
      reportNextStepNotRun({ ...notRun, outcome: kept ? 'deferred' : 'trivial' }, capture);
      return;
    }
    void (async () => {
      let rows: ChatMessage[] = [];
      try {
        rows = await d.recentRows(s.characterId);
      } catch {
        /* no transcript: the check reports trivial */
      }
      await d.start(chatCheckInput({ ...s, rows }));
    })().catch(() => {});
  } catch {
    /* best-effort, never surfaces */
  }
}

async function defaultDeps(): Promise<ChatNextStepDeps> {
  const { persistQuitSession } = await import('./quitNextStep');
  return {
    async recentRows(characterId) {
      const { readRecent } = await import('./chat/chatStore');
      return readRecent(characterId, 80);
    },
    start: (input) => startPlayerEndNextStep(input),
    persist: (record) => persistQuitSession(record),
  };
}
