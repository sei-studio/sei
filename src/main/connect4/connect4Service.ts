/**
 * Four in a Row minigame service (main process, internal id CONNECT4):
 * authoritative game state + the character's own turns.
 *
 * One game per character. Every intent (drop, resign, rematch, retry, end)
 * lands here, mutates the session, and a full CONNECT4GameState snapshot is
 * pushed back over CONNECT4:state.
 *
 * The character plays for real (261127 rewrite, docs/agents/connect4.md):
 *   - every column it drops is its own `play(column)` tool call, made through
 *     the shared board-game turn runner (src/main/minigames/boardTurn.ts),
 *     with its persona, memory and the chat history in the prompt like chess;
 *   - the engine only enforces the rules. It never picks a column: a column
 *     the rules reject goes back to the model as a tool error, a failed turn
 *     is retried (MOVE_ATTEMPTS), and when every attempt fails the board
 *     stops in `aiTurnFailed` until the player presses Try again;
 *   - plain text it writes is table talk, spoken like chess (on a move turn
 *     it lands together with the move);
 *   - chat sent while the game is open is answered here, with the board in
 *     view (handlePlayerChat, routed from chat:send).
 *
 * Turns run on one fsm.js priority queue per session, single-flight like
 * chess: P1 player chat, P2 the character's move. No idle chatter.
 * Each move turn carries a token; a move is applied only while the game is
 * active, it is the character's turn and the token is still current.
 *
 * Mutually exclusive with chess / Draw! / Minecraft summon via the
 * gameLaunch cross-launch gate and deps.isSummoned.
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type {
  CONNECT4Color,
  CONNECT4GameState,
  CONNECT4GameStatus,
  CONNECT4MoveRecord,
  CONNECT4Result,
} from '../../shared/connect4Ipc';
import { CONNECT4_ERR_MC_ACTIVE } from '../../shared/connect4Ipc';
import type { MinigameTurnFailure } from '../../shared/minigameTurn';
import { loadAnalytics } from '../lazyAnalytics';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { isCallActive } from '../voice/callState';
import { REMEMBER_TOOL, clockNow } from '../chat/chatPrompts';
import { CHAT_ABORTED } from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { raiseUsageLimitPopup } from '../chat/usageLimit';
import { companionLanguageFor } from '../companionLanguage';
import { foldIfDue } from '../chat/continuity';
import { playSummaryText } from '../chat/playSummary';
import { createPriorityQueue, Priority } from '../../bot/brain/fsm.js';
import {
  runBoardTurn,
  runWithAttempts,
  alreadyMovedResult,
  SAY_PROPERTY,
  type BoardToolUse,
  type BoardTurnKind,
  type BoardTurnArgs,
  type ToolOutcome,
} from '../minigames/boardTurn';

const ROWS = 6;
const COLS = 7;
const WIN = 4;

/** User-facing and model-facing name (never the trademarked one). */
export const CONNECT4_GAME_NAME = 'Four in a Row';
const CONNECT4_GAME_NAME_ZH = '四子棋';

const MAX_HOPS = 4;
/** Room for a little private working-out, one line of talk and the tool call. */
const MAX_TOKENS = 700;
/** No idle chatter: the queue's idle tick is pushed out of reach. */
const NO_IDLE_MS = 2_000_000_000;
/** How many of its own recent move lines the turn block shows it. */
const RECENT_LINES = 4;

const sessions = new Map<string, Session>();
let deps: Connect4Deps | null = null;
/** Test seam: provider used by every turn (undefined = buildLlmProvider()). */
let providerOverride: BoardTurnArgs['provider'];
/** Test seam: retry backoff sleep. */
let sleepOverride: ((ms: number) => Promise<void>) | undefined;

export interface Connect4Deps {
  pushState: (state: CONNECT4GameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}
/** Old name, kept for callers. */
export type ForzaDeps = Connect4Deps;

export interface CONNECT4StartOpts {
  playerColor?: 'r' | 'y' | 'random';
}

interface Queue {
  enqueue: (priority: number, event: string, data?: unknown) => void;
  dispose: () => void;
}

interface Session {
  gameId: string;
  characterId: string;
  board: Array<Array<CONNECT4Color | null>>;
  turn: CONNECT4Color;
  playerColor: CONNECT4Color;
  status: CONNECT4GameStatus;
  aiThinking: boolean;
  result: CONNECT4Result | null;
  history: CONNECT4MoveRecord[];
  moves: number;
  startedAt: number;
  lastActivityAt: number;
  turnCtrl: AbortController | null;
  /** Bumped when the game ends: every turn begun before is stale. */
  turnSeq: number;
  /** Bumped per character move turn: a move applies only on the current one. */
  moveToken: number;
  /** The moveToken whose move is on the board (a retry never moves twice). */
  appliedToken: number;
  /** The character said a line with its previous move (turn-block nudge toward quiet moves). */
  talkedLastMove: boolean;
  /** The last few lines said with its moves, shown back to it so it does not repeat them. */
  recentLines: string[];
  aiTurnFailed: MinigameTurnFailure | null;
  /** The cloud allowance ran out this game: no reaction turn, no fold. */
  creditQuiet: boolean;
  /** Any chat rows (either side) landed during this game. */
  spoke: boolean;
  /** Pinned for the game so the system prefix stays cacheable. */
  clock: string;
  /** Append-only move record the character reads, merged into the thread. */
  gameLog: Array<{ ts: number; text: string }>;
  queue: Queue | null;
  chatBuffer: Array<{ voiceCall: boolean; resolve: (r: ChatSendResult) => void }>;
  firstMoveSent: boolean;
  stats: {
    llmMoves: number;
    retries: number;
    illegal: number;
    failedTurns: number;
    retryClicks: number;
    chatReplies: number;
  };
}

export function initCONNECT4Service(d: Connect4Deps): void {
  deps = d;
}

function requireDeps(): Connect4Deps {
  if (!deps) throw new Error('Four in a Row service not initialized');
  return deps;
}

function emptyBoard(): Array<Array<CONNECT4Color | null>> {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function aiColorOf(s: Session): CONNECT4Color {
  return s.playerColor === 'r' ? 'y' : 'r';
}

// ── snapshots ────────────────────────────────────────────────────────────────

function snapshot(s: Session): CONNECT4GameState {
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    board: s.board.map((row) => row.slice()),
    turn: s.turn,
    playerColor: s.playerColor,
    aiThinking: s.aiThinking,
    pendingAiMove: null,
    result: s.result,
    history: s.history.slice(),
    moves: s.moves,
    aiTurnFailed: s.aiTurnFailed,
  };
}

function push(s: Session): CONNECT4GameState {
  const state = snapshot(s);
  // A dead window must never be able to throw into a turn.
  try {
    requireDeps().pushState(state);
  } catch (err) {
    console.warn(`[sei/connect4] state push failed: ${(err as Error)?.message ?? err}`);
  }
  return state;
}

function capture(event: string, props: Record<string, unknown>): void {
  void (async () => {
    try {
      const { capture: cap } = await loadAnalytics();
      cap(event, props);
    } catch { /* analytics is never load-bearing */ }
  })();
}

function captureError(characterId: string, cls: string): void {
  void (async () => {
    try {
      const { captureSurfaceError } = await loadAnalytics();
      captureSurfaceError('connect4', cls, characterId);
    } catch { /* analytics is never load-bearing */ }
  })();
}

// ── public api (wired to IPC handlers) ───────────────────────────────────────

export function isCONNECT4Active(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getCONNECT4State(characterId: string): CONNECT4GameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startCONNECT4(
  characterId: string,
  opts?: CONNECT4StartOpts & { rematch?: boolean },
): Promise<CONNECT4GameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${CONNECT4_ERR_MC_ACTIVE}: disconnect the Minecraft session to play ${CONNECT4_GAME_NAME}`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') {
    return snapshot(existing);
  }
  const startGuard = beginSessionStart();
  // A new game over a finished one is a rematch, whichever button started it.
  const isRematch = opts?.rematch === true || !!existing;
  if (existing) sessions.delete(characterId);

  const pick = opts?.playerColor ?? 'random';
  const playerColor: CONNECT4Color =
    pick === 'random' ? (Math.random() < 0.5 ? 'r' : 'y') : pick;

  const s: Session = {
    gameId: randomUUID(),
    characterId,
    board: emptyBoard(),
    turn: 'r', // red always starts
    playerColor,
    status: 'active',
    aiThinking: false,
    result: null,
    history: [],
    moves: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    moveToken: 0,
    appliedToken: 0,
    talkedLastMove: false,
    recentLines: [],
    aiTurnFailed: null,
    creditQuiet: false,
    spoke: false,
    clock: clockNow(),
    gameLog: [],
    queue: null,
    chatBuffer: [],
    firstMoveSent: false,
    stats: { llmMoves: 0, retries: 0, illegal: 0, failedTurns: 0, retryClicks: 0, chatReplies: 0 },
  };
  s.queue = createPriorityQueue({
    idleFallbackMs: NO_IDLE_MS,
    onDispatch: (event: string, data: unknown) => dispatch(s, event, data as { token?: number } | undefined),
    logger: console,
  }) as unknown as Queue;

  if (!startGuard.stillValid()) {
    s.queue.dispose();
    throw accountSwitchingError();
  }
  sessions.set(characterId, s);
  push(s);

  capture('connect4_game_started', {
    character_id: characterId,
    player_color: playerColor,
    ai_color: aiColorOf(s),
    player_choice: pick,
    rematch: isRematch,
  });

  // Red opens: the character moves first when the player took yellow.
  if (s.turn !== s.playerColor) enqueueAiMove(s);
  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  column: number,
): Promise<{ ok: boolean; error?: string; state: CONNECT4GameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error(`no active ${CONNECT4_GAME_NAME} game`);
  }
  if (s.aiThinking || s.turn !== s.playerColor) {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  if (!Number.isInteger(column) || column < 0 || column >= COLS) {
    return { ok: false, error: 'out of bounds', state: snapshot(s) };
  }
  const row = dropRow(s.board, column);
  if (row === -1) {
    return { ok: false, error: 'column full', state: snapshot(s) };
  }
  applyMove(s, column, row, s.playerColor, 'player');
  noteFirstMove(s, 'player');
  const result = resultAfter(s);
  if (result) {
    endSession(s, result);
    return { ok: true, state: snapshot(s) };
  }
  s.turn = aiColorOf(s);
  enqueueAiMove(s);
  return { ok: true, state: snapshot(s) };
}

export async function resign(characterId: string): Promise<CONNECT4GameState> {
  const s = requireActive(characterId);
  endSession(s, { winner: aiColorOf(s), reason: 'resign' });
  return snapshot(s);
}

/** New game against the same character. The player keeps their colour. */
export async function rematch(characterId: string): Promise<CONNECT4GameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  return startCONNECT4(characterId, { playerColor: old.playerColor, rematch: true });
}

/** Try again after a failed character turn (the panel's button). */
export async function retryAiTurn(characterId: string): Promise<CONNECT4GameState> {
  const s = requireActive(characterId);
  if (!s.aiTurnFailed || s.aiThinking || s.turn === s.playerColor) return snapshot(s);
  s.stats.retryClicks++;
  capture('connect4_turn_retry', {
    character_id: s.characterId,
    reason: s.aiTurnFailed.reason,
    move_number: s.moves + 1,
  });
  s.creditQuiet = false;
  enqueueAiMove(s);
  return snapshot(s);
}

export async function endCONNECT4(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') {
    endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
  }
  sessions.delete(characterId);
}

/**
 * Chat while a game is open (routed from chat:send). Persists the player's
 * line, queues ONE reply turn (consecutive sends coalesce) and resolves once
 * it ran. Null when there is no live game, so normal chat takes it.
 */
export async function handlePlayerChat(args: {
  characterId: string;
  text: string;
  replyTo?: ChatMessage['replyTo'];
  voiceCall?: boolean;
}): Promise<ChatSendResult | null> {
  const s = sessions.get(args.characterId);
  if (!s || s.status === 'ended' || !s.queue) return null;
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: args.text,
    ts: Date.now(),
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    ...(args.voiceCall ? { voice: true } : {}),
  };
  await chatStore.appendMessage(s.characterId, userMsg);
  s.lastActivityAt = Date.now();
  s.spoke = true;
  return await new Promise<ChatSendResult>((resolve) => {
    s.chatBuffer.push({ voiceCall: args.voiceCall === true, resolve });
    if (!s.queue) {
      flushChatBuffer(s);
      return;
    }
    s.queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true });
  });
}

// ── turn dispatch ────────────────────────────────────────────────────────────

function enqueueAiMove(s: Session): void {
  if (s.status !== 'active' || s.turn === s.playerColor || s.aiThinking) return;
  s.aiThinking = true;
  s.aiTurnFailed = null;
  const token = ++s.moveToken;
  push(s);
  s.queue?.enqueue(Priority.P2_MOVEMENT, 'sei:your_move', { token });
}

async function dispatch(s: Session, event: string, data: { token?: number } | undefined): Promise<void> {
  if (s.status === 'ended') {
    flushChatBuffer(s);
    return;
  }
  if (event === 'sei:your_move') await dispatchMove(s, data?.token ?? -1);
  else if (event === 'sei:chat_received') await dispatchChat(s);
  // sei:idle never does anything here: no idle chatter at the board.
}

function moveTurnLive(s: Session, token: number, seq: number): boolean {
  return (
    sessions.get(s.characterId) === s &&
    s.status === 'active' &&
    s.turnSeq === seq &&
    s.moveToken === token &&
    s.turn === aiColorOf(s)
  );
}

async function dispatchMove(s: Session, token: number): Promise<void> {
  const seq = s.turnSeq;
  if (!moveTurnLive(s, token, seq)) return;
  const voiceCall = isCallActive(s.characterId);
  const contract = await contractBlock(s);
  const outcome = await runWithAttempts({
    isLive: () => moveTurnLive(s, token, seq),
    onUsageLimit: (err) => raiseUsageLimitPopup(err, 'connect4'),
    onAttemptError: (i, err, cls) => {
      console.error(`[sei/connect4] move turn failed (attempt ${i + 1}, ${cls}): ${describeErr(err)}`);
      captureError(s.characterId, `move_turn_${cls}`);
    },
    sleep: sleepOverride,
    attempt: async (_i, retryNote) => {
      if (s.appliedToken === token) return alreadyMovedResult();
      try {
        const r = await runBoardTurn({
          surface: 'connect4',
          characterId: s.characterId,
          kind: 'move',
          contract,
          turnBlock: turnBlock(s, 'move', retryNote),
          gameLog: s.gameLog,
          clock: s.clock,
          tools: CONNECT4_TOOLS,
          voiceCall,
          maxHops: MAX_HOPS,
          maxTokens: MAX_TOKENS,
          isStale: () => !moveTurnLive(s, token, seq),
          onTool: (tu) => onMoveTool(s, tu, token, seq),
          noMoveNudge: 'You have not dropped your piece yet. Call play() with the column number now.',
          registerAbort: (ctrl, done) => registerAbort(s, ctrl, done),
          pushChatMessage: requireDeps().pushChatMessage,
          provider: providerOverride,
        });
        if (r.spoken.length) s.spoke = true;
        return r;
      } catch (err) {
        // The move landed and something after it threw: the turn is done.
        if (s.appliedToken === token && moveTurnLive(s, token, seq)) return alreadyMovedResult();
        throw err;
      }
    },
  });

  if (outcome.kind === 'aborted') {
    if (s.moveToken === token && s.status === 'active' && s.aiThinking) {
      s.aiThinking = false;
      push(s);
    }
    return;
  }
  s.stats.illegal += outcome.illegal;
  if (outcome.kind === 'moved') {
    s.stats.llmMoves++;
    s.stats.retries += outcome.attempts - 1;
    s.talkedLastMove = outcome.result.spoken.length > 0;
    for (const m of outcome.result.spoken) s.recentLines.push(m.text);
    s.recentLines = s.recentLines.slice(-RECENT_LINES);
    // The move was applied inside the tool call; the turn passes (or the
    // game ends) only now, after its table talk landed.
    s.aiThinking = false;
    const result = resultAfter(s);
    if (result) endSession(s, result);
    else {
      s.turn = s.playerColor;
      push(s);
    }
    return;
  }
  // Every attempt failed: stop in a clear state. Never an engine move.
  s.stats.retries += outcome.failure.attempts - 1;
  s.stats.failedTurns++;
  if (outcome.failure.reason === 'credit_wall') s.creditQuiet = true;
  s.aiThinking = false;
  s.aiTurnFailed = outcome.failure;
  push(s);
  console.error(
    `[sei/connect4] character could not move: ${outcome.failure.reason} after ${outcome.failure.attempts} attempt(s)`,
  );
  capture('connect4_turn_failed', {
    character_id: s.characterId,
    reason: outcome.failure.reason,
    attempts: outcome.failure.attempts,
    error_class: outcome.errorClass ?? 'none',
    move_number: s.moves + 1,
  });
}

/** The character's play() call: rules only, never a substitute column. */
async function onMoveTool(s: Session, tu: BoardToolUse, token: number, seq: number): Promise<ToolOutcome> {
  if (tu.name !== 'play') {
    return { note: `The tool "${tu.name}" does nothing in this game. Use play() to drop your piece.`, isError: true };
  }
  const raw = (tu.input as { column?: unknown } | undefined)?.column;
  const column = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  const legal = legalColumns(s).map((c) => c + 1).join(', ');
  if (typeof column !== 'number' || !Number.isInteger(column) || column < 1 || column > COLS) {
    return {
      note: `"${String(raw)}" is not a column. Columns are numbered 1 to 7 from the left. Open columns: ${legal}. Call play() again.`,
      isError: true,
      illegal: true,
    };
  }
  if (!moveTurnLive(s, token, seq)) {
    return { note: 'It is not your turn any more; this does nothing.', isError: true };
  }
  const col = column - 1;
  const row = dropRow(s.board, col);
  if (row === -1) {
    return {
      note: `Column ${column} is full. Open columns: ${legal}. Call play() again with one of them.`,
      isError: true,
      illegal: true,
    };
  }
  applyMove(s, col, row, aiColorOf(s), 'ai');
  s.appliedToken = token;
  noteFirstMove(s, 'ai');
  // The piece shows at once, but the turn stays the character's until the
  // runner returns (its table talk lands first): flipping it here made the
  // runner's own stale check fire, dropping the talk and the move count.
  push(s);
  return {
    note: `You drop your piece in column ${column}. It is on the board now; do not call play() again this turn.`,
    moved: true,
  };
}

async function dispatchChat(s: Session): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0) return;
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  let replies: ChatMessage[] = [];
  const seq = s.turnSeq;
  try {
    const r = await runBoardTurn({
      surface: 'connect4',
      characterId: s.characterId,
      kind: 'chat-reply',
      contract: await contractBlock(s),
      turnBlock: turnBlock(s, 'chat-reply', null),
      gameLog: s.gameLog,
      clock: s.clock,
      tools: CONNECT4_TOOLS,
      voiceCall,
      maxHops: 2,
      maxTokens: MAX_TOKENS,
      isStale: () => s.turnSeq !== seq || sessions.get(s.characterId) !== s,
      onTool: async (tu) => ({
        note:
          tu.name === 'play'
            ? 'play() does nothing on a chat reply; your move is asked for in its own turn. Reply in text, or say nothing.'
            : `The tool "${tu.name}" does nothing on this turn. Reply in text, or say nothing.`,
        isError: true,
      }),
      registerAbort: (ctrl, done) => registerAbort(s, ctrl, done),
      pushChatMessage: requireDeps().pushChatMessage,
      provider: providerOverride,
    });
    replies = r.spoken;
    if (replies.length) {
      s.spoke = true;
      s.stats.chatReplies++;
    }
  } catch (err) {
    if ((err as Error)?.message !== CHAT_ABORTED) {
      if ((await raiseUsageLimitPopup(err, 'connect4')) === 'depleted') s.creditQuiet = true;
      console.warn(`[sei/connect4] chat reply failed: ${describeErr(err)}`);
      void (async () => {
        try {
          const { surfaceErrorClass } = await loadAnalytics();
          captureError(s.characterId, `chat_turn_${surfaceErrorClass(err)}`);
        } catch { /* analytics is never load-bearing */ }
      })();
    }
  }
  // streamed: every line was already persisted and pushed by the runner.
  for (const e of entries) e.resolve({ replies, streamed: true });
}

function registerAbort(s: Session, ctrl: AbortController, done: boolean): void {
  if (!done) s.turnCtrl = ctrl;
  else if (s.turnCtrl === ctrl) s.turnCtrl = null;
}

function flushChatBuffer(s: Session): void {
  for (const e of s.chatBuffer.splice(0)) e.resolve({ replies: [], streamed: true });
}

function noteFirstMove(s: Session, by: 'player' | 'ai'): void {
  if (s.firstMoveSent) return;
  s.firstMoveSent = true;
  capture('connect4_first_move', {
    character_id: s.characterId,
    by,
    ms_since_start: Date.now() - s.startedAt,
  });
}

// ── analytics + continuity OUT ───────────────────────────────────────────────

function endSession(
  s: Session,
  result: CONNECT4Result,
  // `reason` overrides the analytics reason only ('account_switch', 'app_quit').
  opts?: { silent?: boolean; reason?: string },
): void {
  if (s.status === 'ended') return;
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  s.aiThinking = false;
  s.status = 'ended';
  s.result = result;
  s.queue?.dispose();
  s.queue = null;
  flushChatBuffer(s);
  push(s);

  const durationMs = Date.now() - s.startedAt;
  const outcome =
    result.reason === 'abandoned'
      ? 'abandoned'
      : result.winner === null ? 'draw' : result.winner === s.playerColor ? 'player' : 'ai';
  capture('connect4_game_ended', {
    character_id: s.characterId,
    duration_ms: durationMs,
    plies: s.moves,
    player_moves: s.history.filter((h) => h.color === s.playerColor).length,
    llm_moves: s.stats.llmMoves,
    // Always 0, kept so a dashboard can assert it: the engine never moves.
    engine_moves: 0,
    retries: s.stats.retries,
    illegal_moves: s.stats.illegal,
    failed_turns: s.stats.failedTurns,
    retry_clicks: s.stats.retryClicks,
    chat_replies: s.stats.chatReplies,
    spoke: s.spoke,
    reason: opts?.reason ?? result.reason,
    outcome,
  });

  // Continuity OUT: one play row (when anything happened), then the fold.
  if (result.reason !== 'abandoned' || s.history.length > 0 || s.spoke) {
    void trackScopedWrite((async () => {
      let name = 'your companion';
      let personaExpanded: string | undefined;
      let zh = false;
      try {
        const c = await getCharacter(s.characterId);
        if (c?.name) name = c.name;
        personaExpanded = c?.persona?.expanded;
        if (c && companionLanguageFor(c, await loadConfig()).language === 'zh') zh = true;
      } catch { /* generic name */ }
      const ev: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        text: playSummaryText(name, zh ? CONNECT4_GAME_NAME_ZH : CONNECT4_GAME_NAME, durationMs, zh ? 'zh' : undefined),
        ts: Date.now(),
        event: { kind: 'play', game: CONNECT4_GAME_NAME, durationMs },
      };
      try {
        await chatStore.appendMessage(s.characterId, ev);
        requireDeps().pushChatMessage(s.characterId, ev);
      } catch { /* best-effort */ }
      // Not on the credit wall: the fold is an LLM call and would only 402.
      if (!s.creditQuiet) void foldIfDue(s.characterId, personaExpanded).catch(() => {});
    })());
  }

  // The character reacts to the result in chat (chess does the same).
  if (!opts?.silent && !s.creditQuiet && result.reason !== 'abandoned') {
    void runGameOverTurn(s).catch(() => {});
  }
}

async function runGameOverTurn(s: Session): Promise<void> {
  const r = await runBoardTurn({
    surface: 'connect4',
    characterId: s.characterId,
    kind: 'game-over',
    contract: await contractBlock(s),
    turnBlock: turnBlock(s, 'game-over', null),
    gameLog: s.gameLog,
    clock: s.clock,
    tools: CONNECT4_TOOLS,
    voiceCall: isCallActive(s.characterId),
    maxHops: 2,
    maxTokens: MAX_TOKENS,
    // A new game (rematch) or a closed panel supersedes the reaction.
    isStale: () => sessions.get(s.characterId) !== s,
    onTool: async (tu) => ({ note: `The game is over; "${tu.name}" does nothing now. Say your line, or nothing.`, isError: true }),
    registerAbort: () => {},
    pushChatMessage: requireDeps().pushChatMessage,
    provider: providerOverride,
  });
  if (r.spoken.length) s.spoke = true;
}

// ── rules ────────────────────────────────────────────────────────────────────

function requireActive(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'active') throw new Error(`no active ${CONNECT4_GAME_NAME} game`);
  return s;
}

/** First empty row from the bottom in `column`, or -1 when full. */
export function dropRow(board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>, column: number): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][column] === null) return r;
  }
  return -1;
}

function legalColumns(s: Session): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (dropRow(s.board, c) !== -1) out.push(c);
  return out;
}

function applyMove(
  s: Session,
  column: number,
  row: number,
  color: CONNECT4Color,
  by: 'player' | 'ai',
): void {
  s.board[row][column] = color;
  s.history.push({ column, row, color });
  s.moves++;
  s.lastActivityAt = Date.now();
  s.gameLog.push({
    ts: Date.now(),
    text:
      by === 'ai'
        ? `(game) Move ${s.moves}: you dropped a ${colorName(color)} piece in column ${column + 1}.`
        : `(game) Move ${s.moves}: they dropped a ${colorName(color)} piece in column ${column + 1}.`,
  });
}

/** True when the piece at (row, col) is part of four in a row (any direction). */
export function isWinningPiece(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  row: number,
  col: number,
): boolean {
  const color = board[row]?.[col];
  if (!color) return false;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let step = 1; step < WIN; step++) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== color) break;
        count++;
      }
    }
    if (count >= WIN) return true;
  }
  return false;
}

/** The game's result after the last move, or null while it goes on. */
function resultAfter(s: Session): CONNECT4Result | null {
  const last = s.history[s.history.length - 1];
  if (!last) return null;
  if (isWinningPiece(s.board, last.row, last.column)) return { winner: last.color, reason: 'connect-four' };
  if (s.moves >= ROWS * COLS) return { winner: null, reason: 'draw' };
  return null;
}

function colorName(c: CONNECT4Color): string {
  return c === 'r' ? 'red' : 'yellow';
}

// ── prompts ──────────────────────────────────────────────────────────────────

const PLAY_TOOL = {
  name: 'play',
  description:
    'Drop your piece into a column on your turn. Columns are numbered 1 to 7 from the left, ' +
    'as the board shows them. A full column is not allowed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      column: { type: 'integer', minimum: 1, maximum: 7, description: 'Column 1 to 7, counting from the left.' },
      say: SAY_PROPERTY,
    },
    required: ['column'],
  },
};

/** One fixed array for every turn kind (tools lead the cache prefix). */
const CONNECT4_TOOLS = [PLAY_TOOL, REMEMBER_TOOL];

async function contractBlock(s: Session): Promise<string> {
  const config = await loadConfig();
  const playerName = (config.preferred_name ?? '').trim() || 'the player';
  const ai = colorName(aiColorOf(s));
  const player = colorName(s.playerColor);
  return [
    '# FOUR IN A ROW',
    `You are playing a casual game of Four in a Row against ${playerName} inside the Sei app. ` +
      `You are ${ai}; they are ${player}. Red moves first.`,
    'The rules: the board has 7 columns and 6 rows. On your turn you drop one piece into a column and it falls to ' +
      'the lowest empty space. The first to line up four of their own pieces in a row, across, up and down or ' +
      'diagonally, wins. If the board fills up with no four in a row, it is a draw.',
    'You choose your own moves and you play to win: look for your own lines of three, and block theirs. ' +
      'On your turn, call play() with the column. That is how your move happens; describing it does nothing.',
    'On your move, plain text is private: it is your own space to work out the board, nobody sees it, and it ' +
      'does not need to be tidy. Keep it short. Anything you want to say out loud goes in the say field of play().',
    'Table talk: talk like yourself. React to their move, gloat, worry, needle them. One short line, the length of ' +
      'a text message. Most moves deserve none, so leave say out unless you have something to say. Never say which ' +
      'column you are playing or talk through your analysis: the board shows your move by itself. Do not open with ' +
      '"ok", "okay" or "alright", and do not repeat a line you already said this game.',
    'When they talk to you, or when the game is over, there is no move to make and your plain text is said out ' +
      'loud, exactly as written. One short line, or nothing.',
    `Write only your own lines, never lines for ${playerName}, and no bracketed stage directions. ` +
      'The app tells you whose turn it is.',
    'Save something with remember() only if it is about them as a person, not the game itself.',
  ].join('\n\n');
}

function boardText(s: Session): string {
  const mark = (c: CONNECT4Color | null): string => (c === null ? '.' : c === 'r' ? 'R' : 'Y');
  const rows = s.board.map((row) => row.map(mark).join(' '));
  return [...rows, '1 2 3 4 5 6 7'].join('\n');
}

function columnsText(s: Session): string {
  const mark = (c: CONNECT4Color | null): string => (c === 'r' ? 'R' : 'Y');
  return Array.from({ length: COLS }, (_, col) => {
    const stack: string[] = [];
    for (let r = ROWS - 1; r >= 0 && s.board[r][col] !== null; r--) stack.push(mark(s.board[r][col]));
    return `${col + 1}: ${stack.length ? stack.join(' ') : 'empty'}${stack.length === ROWS ? ' (full)' : ''}`;
  }).join('; ');
}

function turnBlock(s: Session, kind: BoardTurnKind, retryNote: string | null): string {
  const ai = aiColorOf(s);
  const lines: string[] = [];
  lines.push(
    'The board now (top row first; pieces fall to the bottom row; R = red, Y = yellow, . = empty). ' +
      `You are ${colorName(ai)} (${ai === 'r' ? 'R' : 'Y'}), they are ${colorName(s.playerColor)} (${s.playerColor === 'r' ? 'R' : 'Y'}):`,
  );
  lines.push(boardText(s));
  // The same board column by column: stacks are what a player reads first,
  // and Haiku 5.5 misread them from the grid alone (claimed wins that were not there).
  lines.push(`Each column from the bottom up: ${columnsText(s)}.`);
  const last = s.history[s.history.length - 1];
  if (last) {
    lines.push(
      `Last move: ${last.color === ai ? 'you' : 'they'} dropped in column ${last.column + 1}. Pieces played: ${s.moves} of 42.`,
    );
  }
  if (kind === 'move') {
    const open = legalColumns(s).map((c) => c + 1);
    lines.push(`It is YOUR move. Open columns: ${open.join(', ')}.`);
    if (retryNote) lines.push(retryNote);
    if (s.recentLines.length) {
      lines.push(`Your recent lines: ${s.recentLines.map((l) => `"${l}"`).join(' / ')}. Do not say these again or anything close to them.`);
    }
    if (s.talkedLastMove) {
      lines.push('You said something with your last move, so this one can go by without a word unless their move really calls for one.');
    }
    lines.push('Work it out in plain text if you need to, then call play() with your column, and say only if you have something to say.');
  } else if (kind === 'chat-reply') {
    lines.push(
      s.turn === ai
        ? 'They just said something. Your move comes in its own turn right after this reply. Answer them in text, or say nothing.'
        : 'They just said something. It is their move. Answer them in text, or say nothing.',
    );
  } else if (kind === 'game-over' && s.result) {
    const r = s.result;
    const how =
      r.reason === 'connect-four'
        ? r.winner === ai ? 'You won with four in a row.' : 'They won with four in a row.'
        : r.reason === 'draw'
          ? 'The board filled up, so it is a draw.'
          : r.reason === 'resign'
            ? 'They resigned, so you won.'
            : 'The game ended.';
    lines.push(`The game is over. ${how} There is nothing to call now. Write only the line you say to them, in your own voice, or nothing.`);
  }
  return lines.join('\n');
}

function describeErr(err: unknown): string {
  const e = err as Error & { status?: number; cause?: Error };
  let out = `${e?.name ?? 'Error'}: ${e?.message}`;
  if (e?.status !== undefined) out += ` status=${e.status}`;
  for (let c = e?.cause; c; c = c.cause as Error | undefined) {
    out += ` <- ${c.name ?? 'Error'}: ${c.message}`;
  }
  return out;
}

// ── account switch + shutdown ────────────────────────────────────────────────

export function endAllCONNECT4(reason: string): void {
  for (const s of [...sessions.values()]) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true, reason });
    }
    sessions.delete(s.characterId);
  }
}

export async function shutdownCONNECT4(): Promise<void> {
  endAllCONNECT4('app_quit');
  sessions.clear();
}

/** Test seams: the provider every turn uses, and the retry backoff sleep. */
export function __setConnect4TestHooks(h: {
  provider?: BoardTurnArgs['provider'];
  sleep?: (ms: number) => Promise<void>;
}): void {
  providerOverride = h.provider;
  sleepOverride = h.sleep;
}

/** Test-only: drop every session without analytics. */
export function __resetConnect4ForTests(): void {
  for (const s of sessions.values()) {
    try { s.turnCtrl?.abort(); } catch { /* ignore */ }
    s.queue?.dispose();
  }
  sessions.clear();
}
