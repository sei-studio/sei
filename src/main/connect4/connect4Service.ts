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
  chatReplyRule,
  TEACHING_LEAD,
  SPOKEN_NOW,
  FACTS_WIN,
  unansweredNote,
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
  /** The game-over reaction's LLM call (aborted when the session goes away). */
  reactionCtrl: AbortController | null;
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
  /** Player lines waiting for ONE coalesced reply (id + text: the reply quotes them). */
  chatBuffer: Array<{ id: string; text: string; voiceCall: boolean; resolve: (r: ChatSendResult) => void }>;
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
  if (existing) dropSession(existing);

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
    reactionCtrl: null,
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
  dropSession(s);
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
    s.chatBuffer.push({ id: userMsg.id, text: args.text, voiceCall: args.voiceCall === true, resolve });
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
        // Inside the attempt: a config read that throws is a failed attempt
        // (retried, then Try again), never a turn stuck on "thinking".
        const contract = await contractBlock(s);
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
      // Aborted while the turn still stands (nothing superseded it): it is
      // the character's turn with no move coming, so offer Try again.
      if (moveTurnLive(s, token, seq)) s.aiTurnFailed = { reason: 'no_move', attempts: 1 };
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
  const config = await loadConfig();
  const player = (config.preferred_name ?? '').trim() || 'the player';
  const me = (await getCharacter(s.characterId))?.name || 'you';
  return {
    note: '',
    moved: true,
    // Put on the board only after the move's say went out (boardTurn.ts).
    apply: () => {
      if (!moveTurnLive(s, token, seq) || dropRow(s.board, col) !== row) return null;
      applyMove(s, col, row, aiColorOf(s), 'ai');
      s.appliedToken = token;
      noteFirstMove(s, 'ai');
      // The piece shows at once, but the turn stays the character's until the
      // runner returns (a reaction line lands first): flipping it here made
      // the runner's own stale check fire, dropping the talk and the move count.
      push(s);
      return {
        note: `You drop your piece in column ${column}. It is on the board now; do not call play() again this turn.`,
        reaction: resultAfter(s) ? undefined : (reactionText(s.board, { ai: aiColorOf(s), player, me }) ?? undefined),
      };
    },
  };
}

/** Columns where `color` makes four with its next piece (playable now). */
export function winningColumns(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  color: CONNECT4Color,
): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) {
    const r = dropRow(board, c);
    if (r === -1) continue;
    const next = board.map((row) => row.slice());
    next[r][c] = color;
    if (isWinningPiece(next, r, c)) out.push(c);
  }
  return out;
}

/**
 * The reaction moment after the character's piece lands (T568): when either
 * side can make four with its next piece, the model is shown that as checked
 * facts and may say one line about it. Null = a quiet position, no extra
 * call. Written after its move is made, so it never helps choose that move;
 * the next move turn does not carry it (the thread is the chat and the move
 * log, not this turn's tool results). In round-1 full games the learners
 * missed winning and must-block squares and the characters rarely pointed
 * them out, and a say written before the piece landed misread the board
 * ("three across the bottom now" with two).
 */
export function reactionText(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  sides: Connect4Sides,
): string | null {
  const playerColor: CONNECT4Color = sides.ai === 'r' ? 'y' : 'r';
  const theirs = winningColumns(board, playerColor);
  const mine = winningColumns(board, sides.ai);
  if (theirs.length === 0 && mine.length === 0) return null;
  const P = sides.player;
  const cols = (cs: number[]): string => cs.map((c) => `column ${c + 1}`).join(' or ');
  const facts: string[] = [];
  if (theirs.length) {
    facts.push(
      `- You, ${P}, can win right now: one more of your own pieces in ${cols(theirs)} makes four. That is your win ` +
        'to take, not a line to block.',
    );
  }
  if (mine.length) {
    facts.push(
      `- I can win next move: one more of my pieces in ${cols(mine)} makes four, so ` +
        (mine.length > 1 ? 'you would have to block both, and you can only block one.' : 'you have to block it now.'),
    );
  }
  return [
    `Your piece is on the board and it is ${P}'s move. Facts the app checked about the board now, written the way ` +
      `you say them to ${P} ("you" is ${P}, "I" and "my" are you; ${P} is ${colorName(playerColor)}, you are ` +
      `${colorName(sides.ai)}):`,
    ...facts,
    'This is a moment you can say one short line about, in your own voice. If they asked you to teach them, ' +
      'showing them the spot that wins or the one they must block is the most useful tip there is; otherwise you ' +
      'play to win and can gloat, worry or stay quiet. Do not repeat what you said with your move. Everything you ' +
      'write now is said out loud exactly as written, so write only the words you say, or nothing at all.',
  ].join('\n');
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
      turnBlock: turnBlock(s, 'chat-reply', null, entries.map((e) => e.text), {
        player: ((await loadConfig()).preferred_name ?? '').trim() || 'the player',
        me: (await getCharacter(s.characterId))?.name || 'you',
      }),
      gameLog: s.gameLog,
      unansweredIds: entries.map((e) => e.id),
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

/**
 * Remove a session from the map (rematch, panel close, account switch, quit)
 * and abort its game-over reaction, which would otherwise keep talking about
 * a game that is gone.
 */
function dropSession(s: Session): void {
  try { s.reactionCtrl?.abort(); } catch { /* already done */ }
  s.reactionCtrl = null;
  if (sessions.get(s.characterId) === s) sessions.delete(s.characterId);
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
    turnBlock: turnBlock(s, 'game-over', null, [], {
      player: ((await loadConfig()).preferred_name ?? '').trim() || 'the player',
      me: (await getCharacter(s.characterId))?.name || 'you',
    }),
    gameLog: s.gameLog,
    clock: s.clock,
    tools: CONNECT4_TOOLS,
    voiceCall: isCallActive(s.characterId),
    maxHops: 2,
    maxTokens: MAX_TOKENS,
    // A new game (rematch) or a closed panel supersedes the reaction.
    isStale: () => sessions.get(s.characterId) !== s,
    onTool: async (tu) => ({ note: `The game is over; "${tu.name}" does nothing now. Say your line, or nothing.`, isError: true }),
    registerAbort: (ctrl, done) => {
      if (!done) s.reactionCtrl = ctrl;
      else if (s.reactionCtrl === ctrl) s.reactionCtrl = null;
    },
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

/** Who is who in the chat facts: the player's name and the character's. */
export interface Connect4Sides {
  ai: CONNECT4Color;
  player: string;
  me: string;
}

/** A side as the character says it to the player: "you (red)" / "I (yellow)". */
function sideName(color: CONNECT4Color, sides: Connect4Sides, cap = false): string {
  const who = color === sides.ai ? 'I' : cap ? 'You' : 'you';
  return `${who} (${colorName(color)})`;
}

/**
 * Chat-reply turns: each side's lines of two or more, in words. With the
 * grid and the column stacks alone Haiku 5.5 misread lines whenever a
 * beginner asked what to watch for (4 of 4 characters, T567 probe: "red has
 * three across the bottom in columns 3 and 4"). Chat only: move turns read
 * the board themselves, so this never plays a move for it.
 */
export function linesText(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  sides: Connect4Sides,
): string {
  const dirs: Array<[number, number]> = [[0, 1], [-1, 0], [-1, 1], [1, 1]];
  const parts: string[] = [];
  for (const color of [sides.ai, sides.ai === 'r' ? 'y' : 'r'] as CONNECT4Color[]) {
    const other: CONNECT4Color = color === 'r' ? 'y' : 'r';
    const found: string[] = [];
    for (const [dr, dc] of dirs) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (board[r][c] !== color) continue;
          // Only from the start of a run.
          const pr = r - dr;
          const pc = c - dc;
          if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS && board[pr][pc] === color) continue;
          let n = 1;
          while (board[r + dr * n]?.[c + dc * n] === color) n++;
          if (n < 2) continue;
          // Room: some four cells along this line hold the run and no
          // piece of the other side.
          let room = false;
          for (let k = n - WIN; k <= 0 && !room; k++) {
            room = Array.from({ length: WIN }, (_, i) => board[r + dr * (k + i)]?.[c + dc * (k + i)]).every(
              (x) => x !== undefined && x !== other,
            );
          }
          const row = (rr: number): string => (rr === ROWS - 1 ? 'the bottom row' : `row ${ROWS - rr} from the bottom`);
          const endCol = c + dc * (n - 1) + 1;
          found.push(
            (dr === -1 && dc === 0
              ? `${n} stacked in column ${c + 1}`
              : dr === 0
                ? `${n} across ${row(r)}, columns ${c + 1} to ${endCol}`
                : `${n} on a diagonal going ${dr === -1 ? 'up' : 'down'} from column ${c + 1} to ${endCol}`) +
              (n >= WIN ? '' : room ? ' (room to make four)' : ' (blocked, cannot become four)'),
          );
        }
      }
    }
    // Labelled by what each side means to the player: asked "what should i
    // watch out for?", replies kept telling the red player to block red's
    // own diagonal when the lines were only labelled by owner (T567 probe).
    // T568: written as the answer to "what should i watch out for?". With
    // only "no two in a line yet" under her own lines, characters reached
    // for the player's lines and called them the threat.
    parts.push(
      color === sides.ai
        ? `- What you have to watch out for, my ${colorName(color)} lines: ` +
            `${found.join('; ') || 'none yet, I have no two in a line, so nothing of mine to block'}.`
        : `- Your own ${colorName(color)} lines, yours to build on and never to block: ${found.join('; ') || 'no two in a line yet'}.`,
    );
  }
  return parts.join('\n');
}

/**
 * Chat-reply turns: every empty space that would complete four for a side,
 * and whether it can be played now (it is the lowest empty space of its
 * column). Chat only, like linesText.
 */
export function fourChancesText(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  sides: Connect4Sides,
): string {
  const parts: string[] = [];
  for (const color of [sides.ai === 'r' ? 'y' : 'r', sides.ai] as CONNECT4Color[]) {
    for (let c = 0; c < COLS; c++) {
      for (let r = ROWS - 1; r >= 0; r--) {
        if (board[r][c] !== null) continue;
        const next = board.map((row) => row.slice());
        next[r][c] = color;
        if (!isWinningPiece(next, r, c)) continue;
        const now = r === ROWS - 1 || board[r + 1][c] !== null;
        parts.push(
          now
            ? `${sideName(color, sides)} can make four right now in column ${c + 1}` +
                (color === sides.ai ? ', so you have to block it there now' : ', your win to take, not a line to block')
            : `${sideName(color, sides)} would make four in column ${c + 1}, row ${ROWS - r} from the bottom, once ` +
                'that column fills up to it' +
                // T568: asked about such a line, Marv said "block column 5
                // now", the move that filled the space under his own four.
                (color === sides.ai
                  ? `; the piece that fills the space just under it gives it to me, so you do not want to be the one who puts it there`
                  : '; the piece that fills the space just under it gives it to you'),
        );
      }
    }
  }
  return parts.length
    ? `- Chances to make four: ${parts.join('; ')}.`
    : '- Chances to make four: none, nobody has three lined up with an open fourth space.';
}

/** The chat-reply facts: who is who, the lines, the chances to make four. */
export function connect4ChatFacts(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  sides: Connect4Sides,
): string {
  const P = sides.player;
  return [
    `Facts the app checked, written the way you say them to ${P} ("you" is ${P}, "I" and "my" are you, ` +
      `${sides.me}). Anything you say about the board has to match them. ${FACTS_WIN}`,
    // Chances first (T568): with the lines first, Eris answered "do you have
    // a win coming?" with "Yes, I have a win coming. Column 7 ... block it"
    // when column 7 was the player's own win.
    fourChancesText(board, sides),
    linesText(board, sides),
    `${P} plays ${colorName(sides.ai === 'r' ? 'y' : 'r')}, so a tip for ${P} never says to block a ` +
      `${colorName(sides.ai === 'r' ? 'y' : 'r')} line.`,
  ].join('\n');
}

/** True when the piece at (row, col) is part of four in a row (any direction). */
/**
 * The line of four (or more) through (row, col), as plain words for the
 * game-over turn ("up column 6", "across the bottom row, columns 3 to 6").
 * Null when there is none. A fact about the finished game, not a move.
 */
export function winningLineText(
  board: ReadonlyArray<ReadonlyArray<CONNECT4Color | null>>,
  row: number,
  col: number,
): string | null {
  const color = board[row]?.[col];
  if (!color) return null;
  const dirs: Array<[number, number]> = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells: Array<[number, number]> = [[row, col]];
    for (const sign of [1, -1]) {
      for (let step = 1; step < COLS; step++) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== color) break;
        cells.push([r, c]);
      }
    }
    if (cells.length < WIN) continue;
    const cols = cells.map(([, c]) => c + 1).sort((a, b) => a - b);
    const from = cols[0];
    const to = cols[cols.length - 1];
    if (dr === 1 && dc === 0) return `${cells.length} stacked up column ${col + 1}`;
    const rowFromBottom = ROWS - row;
    const rowName = rowFromBottom === 1 ? 'the bottom row' : `row ${rowFromBottom} from the bottom`;
    if (dr === 0) return `${cells.length} across ${rowName}, columns ${from} to ${to}`;
    return `${cells.length} on a diagonal, columns ${from} to ${to}`;
  }
  return null;
}

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
      'column you are playing or talk through your analysis: the board shows your move by itself. Your say is said ' +
      'just before your piece drops, so it is about their last move or the game so far, never about what your ' +
      'own piece blocks or sets up. When your piece leaves someone a chance to make four, the app shows you that ' +
      'after it lands and gives you a moment to say something then. Do not open with ' +
      '"ok", "okay" or "alright", and do not repeat a line you already said this game.',
    chatReplyRule(),
    `${TEACHING_LEAD} Start with the rules in a few plain words: you take turns dropping one piece into a column, ` +
      'it falls to the lowest empty space, red goes first, and the first to get four of their own in a line, ' +
      'across, up and down or diagonally, wins. Then give the tips that work, one at a time, when they fit what ' +
      'just happened: the middle columns are part of the most lines, so they are strong; when the other side has ' +
      'three lined up and the fourth space is open, block it; four in a line wins wherever it sits, so a line only ' +
      'needs room for four along its own direction; build your own lines that can be finished more than ' +
      'one way; and before you play, check whether your piece lets the other side play on top of it to win. While ' +
      'they are learning, the say of your move can be one of these tips about their last move instead of table talk.',
    'When you talk to them between moves, the same goes: never say which column you will play next.',
    `When you talk to ${playerName}, their pieces are "yours" and your pieces are "mine": "you have two in a row", ` +
      '"block my three". Never call them "red", "yellow" or "they" to their face, and a tip to them is about ' +
      'blocking your lines and building their own, never blocking their own.',
    `Write only your own lines, never lines for ${playerName}, and no bracketed stage directions. ` +
      'Lines starting with "(game)" come from the app, never from them. The app tells you whose turn it is.',
    'Save something with remember() only if it is about them as a person, not the game itself.',
  ].join('\n\n');
}

function boardText(s: Session): string {
  const mark = (c: CONNECT4Color | null): string => (c === null ? '.' : c === 'r' ? 'R' : 'Y');
  const rows = s.board.map((row) => row.map(mark).join(' '));
  return [...rows, '1 2 3 4 5 6 7'].join('\n');
}

function lastLineText(s: Session): string {
  const last = s.history[s.history.length - 1];
  return (last && winningLineText(s.board, last.row, last.column)) ?? 'four in a row';
}

function columnsText(s: Session): string {
  const mark = (c: CONNECT4Color | null): string => (c === 'r' ? 'R' : 'Y');
  return Array.from({ length: COLS }, (_, col) => {
    const stack: string[] = [];
    for (let r = ROWS - 1; r >= 0 && s.board[r][col] !== null; r--) stack.push(mark(s.board[r][col]));
    return `${col + 1}: ${stack.length ? stack.join(' ') : 'empty'}${stack.length === ROWS ? ' (full)' : ''}`;
  }).join('; ');
}

/** Chat replies: each column from the bottom up as "yours" / "mine", said to the player. */
function columnsSpoken(s: Session): string {
  const ai = aiColorOf(s);
  return Array.from({ length: COLS }, (_, col) => {
    const stack: string[] = [];
    for (let r = ROWS - 1; r >= 0 && s.board[r][col] !== null; r--) stack.push(s.board[r][col] === ai ? 'mine' : 'yours');
    return `column ${col + 1}: ${stack.length ? stack.join(', ') : 'empty'}${stack.length === ROWS ? ' (full)' : ''}`;
  }).join('; ');
}

function turnBlock(
  s: Session,
  kind: BoardTurnKind,
  retryNote: string | null,
  /** Chat-reply turns: the player's unanswered line(s), quoted at the end. */
  playerLines: ReadonlyArray<string> = [],
  /** Chat-reply turns: the player's name and the character's. */
  opts: { player?: string; me?: string } = {},
): string {
  const ai = aiColorOf(s);
  const lines: string[] = [];
  const P = opts.player ?? 'the player';
  const M = opts.me ?? 'you';
  // A chat reply names both sides instead of "you" / "they": asked "what
  // should i watch for?", every character answered from its own seat ("red
  // can extend it, column 5 blocks that line") to the red player (T567 probe).
  if (kind === 'chat-reply') {
    // No grid on a chat reply, the board only in the words she says it to
    // the player (T568). With the R/Y grid, asked "what should i watch out
    // for?", 3 of 4 characters told the red player to block red's own
    // diagonal ("red has room to finish that one, block it"): they read the
    // grid from their own seat. Fleet Battle's chat facts got who-is-who
    // right once its grids went (T567).
    lines.push(
      `${P} is ${colorName(s.playerColor)} and you (${M}) are ${colorName(ai)}. The board column by column, from the ` +
        `bottom up, written the way you say it to ${P} ("yours" = ${P}'s ${colorName(s.playerColor)} pieces, ` +
        `"mine" = your ${colorName(ai)} pieces): ${columnsSpoken(s)}.`,
    );
  } else {
    lines.push(
      'The board now (top row first; pieces fall to the bottom row; R = red, Y = yellow, . = empty). ' +
        `You are ${colorName(ai)} (${ai === 'r' ? 'R' : 'Y'}), they are ${colorName(s.playerColor)} (${s.playerColor === 'r' ? 'R' : 'Y'}):`,
    );
    lines.push(boardText(s));
    // The same board column by column: stacks are what a player reads first,
    // and Haiku 5.5 misread them from the grid alone (claimed wins that were not there).
    lines.push(`Each column from the bottom up: ${columnsText(s)}.`);
  }
  const last = s.history[s.history.length - 1];
  if (last) {
    const who = kind === 'chat-reply' ? (last.color === ai ? M : P) : last.color === ai ? 'you' : 'they';
    lines.push(`Last move: ${who} dropped in column ${last.column + 1}. Pieces played: ${s.moves} of 42.`);
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
    // Whose turn, as a fact: Haiku 5.5 said "my move: i'm stacking up column
    // 4" while it was the player's move (261128 eval).
    lines.push(
      s.turn === ai && s.aiTurnFailed
        ? 'Whose turn: yours, but your last try to move did not work, so no move is coming until they press Try ' +
            'again. If they ask, say your move failed and they can press Try again.'
        : s.turn === ai
          ? 'Whose turn: yours. You move in your own turn right after this reply, so do not say which column.'
          : 'Whose turn: theirs. You do not move until they do.',
    );
    lines.push(connect4ChatFacts(s.board, { ai, player: P, me: M }));
    lines.push(`${unansweredNote(playerLines)} Answer them in text, or say nothing.`);
    lines.push(SPOKEN_NOW);
  } else if (kind === 'game-over' && s.result) {
    const r = s.result;
    // Who won in the names and in the words to say it in (T568), as Fleet
    // Battle does: with "You won with your red pieces" Marv told the player
    // who had just lost "you won. four on the diagonal".
    const line = lastLineText(s);
    const how =
      r.reason === 'connect-four'
        ? r.winner === ai
          ? `${M} (you) won and ${P} lost: your ${colorName(ai)} pieces made four, ${line}. Said to ${P}, that is ` +
            '"I won" and "you lost", never "you won". That is settled; the app checked it.'
          : `${P} won and ${M} (you) lost: their ${colorName(r.winner ?? ai)} pieces made four, ${line}. Said to ${P}, ` +
            'that is "you won" and "I lost". That is settled; the app checked it.'
        : r.reason === 'draw'
          ? 'The board filled up, so it is a draw.'
          : r.reason === 'resign'
            ? `${P} gave up, so ${M} (you) won. Said to ${P}, that is "I won", never "you won".`
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
    dropSession(s);
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
