/**
 * Keep Talking and Nobody Explodes, expert mode (261115). Contract in
 * src/shared/ktaneIpc.ts, design in docs/design/ktane-companion-261115.md.
 *
 * A session is a flag on a character plus the bomb sheet. While it is on,
 * every chat and call turn for that character (chatService) carries:
 *   - the KTANE contract and the compact manual in the cached system prompt
 *     (ktaneStableFor -> buildSystemBlocks extraStable),
 *   - the bomb_notes tool (ktaneToolFor), answered by applyKtaneNotes,
 *   - the sheet as a note after the cache breakpoint (ktaneTurnNote),
 *   - adaptive thinking on Anthropic (ktaneLlmOptions), so the companion
 *     works the manual out silently instead of out loud on the call.
 * So the voice stack, memory, the credit wall and the persona are the call's
 * own; this file adds only the session, its analytics and its play row.
 *
 * Continuity: IN is the normal chat prompt. OUT is remember() (already on
 * every chat and call turn) plus ONE play row at the end choke point
 * (endKtaneSession) and the fold.
 */
import { randomUUID } from 'node:crypto';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { foldIfDue } from '../chat/continuity';
import * as chatStore from '../chat/chatStore';
import { playSummaryText } from '../chat/playSummary';
import { surfaceLanguage } from '../../shared/chatLanguage';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { loadAnalytics } from '../lazyAnalytics';
import { applyBombNotes, emptySheet, renderSheetNote, type BombNotesInput, type KtaneSheet, type KtaneSessionTotals } from '../../shared/ktaneSheet';
import type { KtaneEndReason, KtaneStartSource, KtaneState } from '../../shared/ktaneIpc';
import type { ChatMessage } from '../../shared/ipc';
import type { LlmToolDef } from '../llm/types';
import {
  BOMB_NOTES_RESULT,
  BOMB_NOTES_TOOL,
  KTANE_MAX_TOKENS,
  KTANE_THINKING,
  ktaneStableBlock,
} from './ktanePrompts';

/** The game's name in the play row and the catalog. */
export const KTANE_GAME_NAME = 'Keep Talking and Nobody Explodes';

/**
 * No turn for this long ends the session ('idle'), timed to the last turn, so
 * a panel left open overnight is not an eight-hour bomb.
 */
export const KTANE_IDLE_MS = 20 * 60_000;

export interface KtaneDeps {
  pushState: (state: KtaneState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
}

interface Session {
  characterId: string;
  startedAt: number;
  lastActivityAt: number;
  sheet: KtaneSheet;
  /** When the current bomb started (for ktane_bomb_ended). */
  bombStartedAt: number;
  totals: KtaneSessionTotals;
  source: KtaneStartSource;
  turns: number;
  voiceTurns: number;
  failedTurns: number;
  lastErrorClass: string | null;
  silentTurns: number;
  notesCalls: number;
  /** ms from the player's line to the first spoken/sent line, per answered turn. */
  firstLineMs: number[];
  thinkingTurns: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();
let deps: KtaneDeps | null = null;

export function initKtaneService(d: KtaneDeps): void {
  deps = d;
}

function stateOf(s: Session, active = true): KtaneState {
  return {
    characterId: s.characterId,
    active,
    startedAt: s.startedAt,
    sheet: { ...s.sheet, solved: [...s.sheet.solved], indicators: s.sheet.indicators ? [...s.sheet.indicators] : null },
    totals: { ...s.totals },
  };
}

function push(s: Session, active = true): void {
  try {
    deps?.pushState(stateOf(s, active));
  } catch {
    /* renderer gone */
  }
}

function capture(event: string, props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((a) => a.capture(event, props))
    .catch(() => {
      /* analytics is never load-bearing */
    });
}

function armIdle(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => void endKtaneSession(s.characterId, 'idle'), KTANE_IDLE_MS);
  (s.idleTimer as { unref?: () => void }).unref?.();
}

// ── Queries chatService makes on every turn ─────────────────────────────────

export function isKtaneActive(characterId: string): boolean {
  return sessions.has(characterId);
}

export function getKtaneState(characterId: string): KtaneState | null {
  const s = sessions.get(characterId);
  return s ? stateOf(s) : null;
}

/** The cached-region block (contract + manual), or undefined with no session. */
export function ktaneStableFor(characterId: string): string | undefined {
  return sessions.has(characterId) ? ktaneStableBlock() : undefined;
}

/** The per-turn sheet note (uncached tail), or '' with no session. */
export function ktaneTurnNote(characterId: string): string {
  const s = sessions.get(characterId);
  return s ? renderSheetNote(s.sheet) : '';
}

export function ktaneToolFor(characterId: string): LlmToolDef | null {
  return sessions.has(characterId) ? (BOMB_NOTES_TOOL as unknown as LlmToolDef) : null;
}

/**
 * Options for the player's turn while a session is on: adaptive thinking and
 * room for it, on Anthropic only (other providers keep their usual call).
 * null = no session, or a provider without thinking.
 */
export function ktaneLlmOptions(
  characterId: string,
  llmKind: string,
): { maxTokens: number; anthropicExtra: Record<string, unknown> } | null {
  if (!sessions.has(characterId) || llmKind !== 'anthropic') return null;
  return { maxTokens: KTANE_MAX_TOKENS, anthropicExtra: { ...KTANE_THINKING } };
}

/** Apply one bomb_notes() call; returns the tool_result text. */
export function applyKtaneNotes(characterId: string, input: unknown): string {
  const s = sessions.get(characterId);
  if (!s) return 'There is no bomb session right now; nothing was noted.';
  const r = applyBombNotes(s.sheet, (input ?? {}) as BombNotesInput);
  s.notesCalls += 1;
  s.lastActivityAt = Date.now();
  const prev = s.sheet;
  s.sheet = r.sheet;
  if (r.changed.includes('strikes') && r.sheet.strikes > prev.strikes) s.totals.strikes += r.sheet.strikes - prev.strikes;
  if (r.solvedModule) s.totals.modulesSolved += 1;
  if (r.outcome === 'defused' || r.outcome === 'exploded') {
    if (r.outcome === 'defused') s.totals.defused += 1;
    else s.totals.exploded += 1;
    capture('ktane_bomb_ended', {
      character_id: characterId,
      outcome: r.outcome,
      bomb: prev.bomb,
      modules_solved: r.sheet.solved.length,
      strikes: r.sheet.strikes,
      bomb_ms: Date.now() - s.bombStartedAt,
    });
  } else if (r.outcome === 'new') {
    s.totals.bombs += 1;
    s.bombStartedAt = Date.now();
  }
  push(s);
  return BOMB_NOTES_RESULT;
}

/** Every bomb_notes call in a response (turn kinds that run no tool loop). */
export function applyKtaneNotesFromContent(characterId: string, content: ReadonlyArray<{ type?: string; name?: string; input?: unknown }>): void {
  if (!sessions.has(characterId)) return;
  for (const b of content) if (b.type === 'tool_use' && b.name === BOMB_NOTES_TOOL.name) applyKtaneNotes(characterId, b.input);
}

/**
 * One player turn finished (chatService, player turns only). `firstLineMs` is
 * the player's line to the first companion line; null = nothing was said.
 */
export function noteKtaneTurn(
  characterId: string,
  t: { voice: boolean; firstLineMs: number | null; thinking: boolean; errorClass?: string | null },
): void {
  const s = sessions.get(characterId);
  if (!s) return;
  s.turns += 1;
  if (t.voice) s.voiceTurns += 1;
  if (t.thinking) s.thinkingTurns += 1;
  s.lastActivityAt = Date.now();
  armIdle(s);
  if (t.errorClass) {
    s.failedTurns += 1;
    s.lastErrorClass = t.errorClass;
  } else if (t.firstLineMs === null) {
    s.silentTurns += 1;
  } else {
    s.firstLineMs.push(t.firstLineMs);
    // Funnel: the first answered turn of a session, and how long it took.
    if (s.firstLineMs.length === 1) {
      capture('ktane_first_reply', { character_id: characterId, first_line_ms: t.firstLineMs, voice: t.voice });
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** The panel was opened (funnel step before a start). */
export function noteKtanePanelOpened(characterId: string): void {
  capture('ktane_panel_opened', { character_id: characterId, live: sessions.has(characterId) });
}

export async function startKtaneSession(characterId: string, source: KtaneStartSource, opts: { onCall?: boolean } = {}): Promise<KtaneState> {
  const existing = sessions.get(characterId);
  if (existing) return stateOf(existing);
  // 260926: no session may start across an account switch (scopeBarrier).
  const guard = beginSessionStart();
  const character = await getCharacter(characterId);
  if (!character) throw new Error('Character not found');
  if (!guard.stillValid()) throw accountSwitchingError();
  const now = Date.now();
  const s: Session = {
    characterId,
    startedAt: now,
    lastActivityAt: now,
    sheet: emptySheet(1),
    bombStartedAt: now,
    totals: { bombs: 1, defused: 0, exploded: 0, modulesSolved: 0, strikes: 0 },
    source,
    turns: 0,
    voiceTurns: 0,
    failedTurns: 0,
    lastErrorClass: null,
    silentTurns: 0,
    notesCalls: 0,
    firstLineMs: [],
    thinkingTurns: 0,
    idleTimer: null,
  };
  sessions.set(characterId, s);
  armIdle(s);
  push(s);
  capture('ktane_session_started', { character_id: characterId, source, on_call: opts.onCall === true });
  return stateOf(s);
}

/** The player started another bomb from the panel. */
export function newKtaneBomb(characterId: string): KtaneState | null {
  const s = sessions.get(characterId);
  if (!s) return null;
  applyKtaneNotes(characterId, { bomb: 'new' });
  return stateOf(s);
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** The single end choke point. Idempotent. */
export function endKtaneSession(characterId: string, reason: KtaneEndReason): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return Promise.resolve();
  sessions.delete(characterId);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  // An idle end counts the time actually played, not the idle tail.
  const endAt = reason === 'idle' ? s.lastActivityAt : Date.now();
  const durationMs = Math.max(0, endAt - s.startedAt);
  push(s, false);
  const p50 = percentile(s.firstLineMs, 50);
  const p90 = percentile(s.firstLineMs, 90);
  // duration_ms is the load-bearing key (analytics SESSION_EVENTS). Shape only.
  capture('ktane_session_ended', {
    character_id: characterId,
    duration_ms: durationMs,
    reason,
    source: s.source,
    bombs: s.totals.bombs,
    defused: s.totals.defused,
    exploded: s.totals.exploded,
    modules_solved: s.totals.modulesSolved,
    strikes: s.totals.strikes,
    turns: s.turns,
    voice_turns: s.voiceTurns,
    thinking_turns: s.thinkingTurns,
    notes_calls: s.notesCalls,
    silent_turns: s.silentTurns,
    failed_turns: s.failedTurns,
    ...(s.lastErrorClass ? { last_error_class: s.lastErrorClass } : {}),
    ...(p50 !== null ? { first_line_p50_ms: p50, first_line_p90_ms: p90 } : {}),
  });
  if (!s.turns) return Promise.resolve();
  return trackScopedWrite(writePlayRow(characterId, durationMs));
}

/** Continuity, OUT/short-term: one play row, then the fold. */
async function writePlayRow(characterId: string, durationMs: number): Promise<void> {
  try {
    const character = await getCharacter(characterId);
    const language = surfaceLanguage(character?.metadata, (await loadConfig()).chat_language) === 'zh' ? 'zh' : undefined;
    const row: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      ts: Date.now(),
      text: playSummaryText(character?.name ?? 'your companion', KTANE_GAME_NAME, durationMs, language),
      event: { kind: 'play', game: KTANE_GAME_NAME, durationMs },
    };
    await chatStore.appendMessage(characterId, row);
    deps?.pushChatMessage(characterId, row);
    if (character) void foldIfDue(characterId, character.persona.expanded).catch(() => {});
  } catch (err) {
    console.warn(`[sei/ktane] play row failed: ${(err as Error).message}`);
  }
}

/** Account switch / app quit: end every session through the choke point. */
export function endAllKtane(reason: KtaneEndReason): Promise<void> {
  return Promise.all([...sessions.keys()].map((id) => endKtaneSession(id, reason))).then(() => undefined);
}

/** Tests only. */
export function __resetKtaneForTests(): void {
  for (const s of sessions.values()) if (s.idleTimer) clearTimeout(s.idleTimer);
  sessions.clear();
  deps = null;
}
