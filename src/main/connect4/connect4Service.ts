/**
 * Connect 4 minigame service (main process): authoritative game state + the
 * character's turn runner.
 *
 * CLONED from src/main/chess/chessService.ts (260710/260714 revision); the
 * copy/diverge ledger lives in .planning/quick/connect4-reuse-notes.md. One
 * game per character. The player's board lives in the renderer; every intent
 * (drop, resign, rematch) lands here, mutates the session, and a full
 * C4GameState snapshot is pushed back over connect4:state.
 *
 * The character's move is chosen by the LLM from a strength-conditioned
 * candidate set produced by the pure-JS engine (./engine): the engine fixes
 * STRENGTH (depth + noise + blunder layers), the LLM only expresses STYLE.
 *
 * Turn scheduling rides the game-agnostic FSM core from src/bot/brain/fsm.js
 * — one priority queue per session, single-flight:
 *   P1  sei:chat_received  player message(s); consecutive sends coalesce into
 *                          ONE reply turn (chatBuffer drained at dispatch).
 *   P2  sei:your_move      the player's move committed; decide OUR move.
 *   P3  sei:idle           sampled 25-90s of table quiet (silent-streak
 *                          backoff); a line is OPTIONAL, silence is normal.
 *
 * The move decision is atomic and never aborted or re-run. Once play() lands
 * the decision enters a HOLD (s.hold) and the contention moves entirely to
 * presentation:
 *   decide -> prethink (sampled human think time; candidate closeness,
 *   log-normal skew) -> present (commentary bubbles + pendingAiMove push) ->
 *   renderer reveals after its quiet gate -> ack -> commit.
 * A player chat during the hold runs as a normal P1 turn that KNOWS the
 * queued move: it can update it (play() again), or hold it back entirely
 * (wait(), after which only player messages and idle ticks wake the move). A
 * hard cap (reply cycles / wall clock) force-commits so chat spam cannot
 * stall the game; wait() disarms the cap deliberately.
 *
 * Divergences from chess: no draw offers, no engine model download (status
 * 'preparing' does not exist), column drops instead of UCI moves.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type { C4Board, C4Color, C4GameState, C4MoveRecord, C4Result } from '../../shared/connect4Ipc';
import { C4_ERR_MC_ACTIVE } from '../../shared/connect4Ipc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildSystemBlocks, markLastMessageCached, REMEMBER_TOOL } from '../chat/chatPrompts';
import { readChatContext, foldIfDue } from '../chat/continuity';
import { splitReply, toMessages, CHAT_ABORTED } from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { createPriorityQueue, Priority } from '../../bot/brain/fsm.js';
import { isCallActive } from '../voice/callState';
import { clampChatLanguage } from '../../shared/chatLanguage';
import {
  applyMove,
  checkWin,
  createBoard,
  dropRow,
  isDraw,
  legalMoves,
  opponentOf,
  runThrough,
  winningCols,
} from './rules';
import { candidateSet, type C4CandidateOut } from './engine';
import { getOrCreateConnect4Profile, type Connect4Profile } from './connect4Profile';

// ── deps + module state ──────────────────────────────────────────────────────

export interface Connect4Deps {
  pushState: (state: C4GameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

/** Minimal typed view of the fsm.js priority queue. */
interface C4Queue {
  enqueue: (priority: number, event: string, data?: unknown) => void;
  resetIdleTimer: () => void;
  dispose: () => void;
}

type TurnKind = 'move' | 'chat-reply' | 'idle' | 'game-over';

interface ChatBufferEntry {
  voiceCall: boolean;
  resolve: (r: ChatSendResult) => void;
}

/** A decided move waiting out the presentation gate. */
interface HoldState {
  move: { col: number };
  decidedAt: number;
  /** Move-turn table talk, buffered until prethink elapses. */
  commentary: ChatMessage[];
  /** Commentary pushed + pendingAiMove published to the renderer. */
  presented: boolean;
  /** wait(): the move only wakes on player messages or idle ticks. */
  held: boolean;
  replyCycles: number;
  prethinkTimer: NodeJS.Timeout | null;
  capTimer: NodeJS.Timeout | null;
}

interface Session {
  gameId: string;
  characterId: string;
  board: C4Board; // committed moves only
  playerColor: C4Color;
  status: 'active' | 'ended';
  aiThinking: boolean;
  pendingAiMove: { col: number } | null;
  result: C4Result | null;
  profile: Connect4Profile;
  history: C4MoveRecord[];
  startedAt: number;
  turnCtrl: AbortController | null;
  /** Bumps ONLY when the session ends; in-flight turns treat a bump as abort. */
  turnSeq: number;
  candidateCache: { ply: number; out: C4CandidateOut } | null;
  queue: C4Queue | null;
  hold: HoldState | null;
  chatBuffer: ChatBufferEntry[];
  /** Consecutive idle ticks that chose silence (backs off the idle cadence). */
  idleStreak: number;
  /** Last chat line / move / commit, for the idle prompt's elapsed-quiet line. */
  lastActivityAt: number;
  /** Kind of the LLM turn currently running (onPreempt aborts 'idle' only). */
  inFlightKind: TurnKind | null;
}

/**
 * Presentation timing. Exported and mutable for tests only; not user copy.
 * prethink = sampled "human think" delay between the LLM decision returning
 * and the commentary/move presenting. postthink (the quiet gate after the
 * last utterance) lives renderer-side in useAiDropReveal's settle window.
 */
export const C4_TIMING = {
  prethinkFloorMs: 300,
  prethinkCapMs: 8_000,
  /** Obvious move (forced win/block, only column): floor + rand * this. */
  obviousExtraMs: 700,
  /** Force-commit after this many reply cycles during a (non-held) hold. */
  capReplyCycles: 4,
  /** Force-commit wall clock since the decision (disarmed by wait()). */
  capMs: 45_000,
  idleMinMs: 25_000,
  idleMaxMs: 90_000,
  /** Idle cadence multiplier cap from consecutive silent ticks. */
  idleBackoffCap: 4,
};

const sessions = new Map<string, Session>();
let deps: Connect4Deps | null = null;

export function initConnect4Service(d: Connect4Deps): void {
  deps = d;
}

function requireDeps(): Connect4Deps {
  if (!deps) throw new Error('connect4 service not initialized');
  return deps;
}

// ── snapshots ────────────────────────────────────────────────────────────────

function turnOf(s: Session): C4Color {
  return s.history.length % 2 === 0 ? 'r' : 'y';
}

function aiColorOf(s: Session): C4Color {
  return opponentOf(s.playerColor);
}

function snapshot(s: Session): C4GameState {
  // Copies, not live references: over real IPC the structured clone at the
  // boundary hides main-side mutation, but in-process consumers (tests, any
  // future main-side observer) must never see a pushed snapshot's history
  // grow after the fact. (chessService shares the live array; latent only.)
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    board: s.board.map((r) => r.slice()),
    history: s.history.slice(),
    playerColor: s.playerColor,
    turn: turnOf(s),
    aiThinking: s.aiThinking,
    pendingAiMove: s.pendingAiMove,
    result: s.result,
    aiStrength: s.profile.strength,
  };
}

function push(s: Session): C4GameState {
  const state = snapshot(s);
  requireDeps().pushState(state);
  return state;
}

// ── public api (wired to IPC handlers) ──────────────────────────────────────

export function isConnect4Active(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getConnect4State(characterId: string): C4GameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startConnect4(
  characterId: string,
  opts?: { playerColor?: 'r' | 'y' | 'random' },
): Promise<C4GameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${C4_ERR_MC_ACTIVE}: disconnect the Minecraft session to play Connect 4`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') return snapshot(existing);

  const pick = opts?.playerColor ?? 'r';
  const playerColor: C4Color = pick === 'random' ? (Math.random() < 0.5 ? 'r' : 'y') : pick;

  const profile = await getOrCreateConnect4Profile(characterId);
  const s: Session = {
    gameId: randomUUID(),
    characterId,
    board: createBoard(),
    playerColor,
    status: 'active',
    aiThinking: false,
    pendingAiMove: null,
    result: null,
    profile,
    history: [],
    startedAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    candidateCache: null,
    queue: null,
    hold: null,
    chatBuffer: [],
    idleStreak: 0,
    lastActivityAt: Date.now(),
    inFlightKind: null,
  };
  s.queue = createPriorityQueue({
    idleFallbackMs: () => sampleIdleDelayMs(s),
    onDispatch: (event: string, data: unknown, signal: AbortSignal) =>
      dispatchC4(s, event, data as { quietMs?: number } | undefined, signal),
    onPreempt: (event: string) => {
      // A fresh player message may abort an in-flight IDLE turn (cheap
      // chatter, the reply matters more). Never a move decision or a reply.
      if (event === 'sei:chat_received' && s.inFlightKind === 'idle') {
        try { s.turnCtrl?.abort(); } catch { /* already done */ }
      }
      return false; // never claim; the event still queues
    },
    logger: console,
  }) as C4Queue;
  sessions.set(characterId, s);
  push(s);

  // The character moves first when it holds red (no engine warm-up needed —
  // the chess model-download phase does not exist here).
  if (turnOf(s) !== s.playerColor) enqueueYourMove(s);

  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  col: number,
): Promise<{ ok: boolean; error?: string; state: C4GameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error('no active connect4 game');
  }
  if (s.aiThinking || s.pendingAiMove || s.hold || turnOf(s) !== s.playerColor) {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  if (!Number.isInteger(col) || dropRow(s.board, col) === -1) {
    return { ok: false, error: 'column full', state: snapshot(s) };
  }
  const { board, row } = applyMove(s.board, col, s.playerColor);
  s.board = board;
  s.history.push({ col, row, color: s.playerColor });
  s.candidateCache = null;
  s.lastActivityAt = Date.now();
  s.idleStreak = 0;
  const state = push(s);

  if (checkGameOver(s)) return { ok: true, state: snapshot(s) };
  enqueueYourMove(s);
  return { ok: true, state };
}

export async function resign(characterId: string): Promise<C4GameState> {
  const s = requireActive(characterId);
  endSession(s, { winner: aiColorOf(s), reason: 'resign' });
  return snapshot(s);
}

export async function rematch(characterId: string): Promise<C4GameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  sessions.delete(characterId);
  return startConnect4(characterId, {
    playerColor: old.playerColor === 'r' ? 'y' : 'r',
  });
}

export async function endConnect4(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') {
    endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
  }
  sessions.delete(characterId);
}

/**
 * The renderer's quiet gate passed: commentary finished presenting and held
 * quiet with the pending move on deck. Commit it. Stale acks (move revised,
 * wait() retracted it, game over) are ignored; the snapshot reconciles the
 * renderer either way.
 */
export async function ackReveal(characterId: string, col: number): Promise<C4GameState> {
  const s = sessions.get(characterId);
  if (!s) throw new Error('no connect4 game');
  if (
    s.status !== 'active' ||
    !s.hold ||
    s.hold.held ||
    !s.hold.presented ||
    s.pendingAiMove?.col !== col
  ) {
    return snapshot(s);
  }
  commitAiMove(s);
  return snapshot(s);
}

// ── chat routing ─────────────────────────────────────────────────────────────

/**
 * A player chat message while a game is open. Returns null when connect4
 * should NOT handle it (no session / game over) so ipc falls through to the
 * normal chat path. The message lands in the chat log immediately, then rides
 * the session queue at P1: consecutive sends coalesce into one reply turn,
 * and a turn during the presentation hold can update or hold back the queued
 * move (it never re-decides from scratch).
 */
export async function handlePlayerChat(args: {
  characterId: string;
  text: string;
  replyTo?: ChatMessage['replyTo'];
  voiceCall?: boolean;
}): Promise<ChatSendResult | null> {
  const s = sessions.get(args.characterId);
  if (!s || s.status === 'ended') return null;

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
  s.idleStreak = 0;

  return await new Promise<ChatSendResult>((resolve) => {
    s.chatBuffer.push({ voiceCall: args.voiceCall === true, resolve });
    // The session can end between the guard above and here (queue disposed);
    // flush resolves the entry so the renderer's send never hangs.
    if (!s.queue) {
      flushChatBuffer(s);
      return;
    }
    s.queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true });
  });
}

// ── internals ────────────────────────────────────────────────────────────────

function requireActive(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'active') throw new Error('no active connect4 game');
  return s;
}

// ── fsm dispatch ─────────────────────────────────────────────────────────────

function enqueueYourMove(s: Session): void {
  if (s.status !== 'active' || turnOf(s) === s.playerColor) return;
  // Idempotent: one decision only.
  if (s.aiThinking || s.hold) return;
  s.aiThinking = true;
  push(s);
  s.queue?.enqueue(Priority.P2_MOVEMENT, 'sei:your_move', {});
}

async function dispatchC4(
  s: Session,
  event: string,
  data: { quietMs?: number } | undefined,
  _signal: AbortSignal,
): Promise<void> {
  if (s.status === 'ended') {
    flushChatBuffer(s);
    return;
  }
  try {
    if (event === 'sei:your_move') await dispatchYourMove(s);
    else if (event === 'sei:chat_received') await dispatchChat(s);
    else if (event === 'sei:idle') await dispatchIdle(s);
  } finally {
    // Idle re-arms itself (enqueues reset the timer; a dispatch does not).
    if (event === 'sei:idle') s.queue?.resetIdleTimer();
  }
}

async function dispatchYourMove(s: Session): Promise<void> {
  if (s.status !== 'active' || turnOf(s) === s.playerColor) return;
  // A transient transport failure (stale keep-alive socket, network blip)
  // gets one retry after a short pause; anything else, or a second failure,
  // falls back so the game never stalls.
  for (let attempt = 0; ; attempt++) {
    try {
      candidatesFor(s);
      if (s.status !== 'active') return;
      await runC4LlmTurn(s, { kind: 'move', voiceCall: isCallActive(s.characterId) });
      return;
    } catch (err) {
      if (s.status !== 'active') return;
      if ((err as Error).message === CHAT_ABORTED) return;
      console.error(`[sei/connect4] AI turn failed (attempt ${attempt + 1}): ${describeErr(err)}`);
      if (attempt === 0 && isConnectionError(err)) {
        await new Promise((r) => setTimeout(r, 1500));
        if (s.status !== 'active') return;
        continue;
      }
      // The game must never stall: fall back to the first candidate silently.
      try {
        fallbackPlay(s);
      } catch (err2) {
        console.error(`[sei/connect4] fallback move failed: ${describeErr(err2)}`);
        endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
      }
      return;
    }
  }
}

async function dispatchChat(s: Session): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0) return; // coalesced into an earlier dispatch
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  let replies: ChatMessage[] = [];
  try {
    replies = await runC4LlmTurn(s, { kind: 'chat-reply', voiceCall });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/connect4] chat reply failed: ${describeErr(err)}`);
    }
  }
  for (const e of entries) e.resolve({ replies });

  // Conversation cap: chat can delay the queued move only so far, unless the
  // character itself chose to hold (wait() disarms the cap on purpose).
  if (s.status === 'active' && s.hold && !s.hold.held) {
    s.hold.replyCycles++;
    if (s.hold.replyCycles >= C4_TIMING.capReplyCycles) {
      await forceCommit(s);
    }
  }
}

async function dispatchIdle(s: Session): Promise<void> {
  if (s.status !== 'active') return;
  if (s.chatBuffer.length > 0) return; // a reply turn is about to run anyway
  // Never chatter while a decided move is presenting (it would reset the
  // reveal's quiet gate). A held move is the exception: the idle tick is its
  // reminder channel. While deciding, the turn itself is about to speak.
  if (s.aiThinking && !(s.hold && s.hold.held)) return;
  let replies: ChatMessage[] = [];
  try {
    replies = await runC4LlmTurn(s, { kind: 'idle', voiceCall: isCallActive(s.characterId) });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/connect4] idle turn failed: ${describeErr(err)}`);
    }
    return;
  }
  s.idleStreak = replies.length === 0 ? s.idleStreak + 1 : 0;
}

function flushChatBuffer(s: Session): void {
  for (const e of s.chatBuffer.splice(0)) e.resolve({ replies: [] });
}

/** Variable idle cadence, voice-call style: sampled window + silence backoff. */
function sampleIdleDelayMs(s: Session): number {
  const T = C4_TIMING;
  const base = T.idleMinMs + Math.random() * Math.max(0, T.idleMaxMs - T.idleMinMs);
  return base * Math.min(1 + s.idleStreak, T.idleBackoffCap);
}

// ── the presentation hold ────────────────────────────────────────────────────

/**
 * Sampled "human think" delay before the decision presents. Forced moves
 * (a win, a block, the only open column) answer near-instantly; hard choices
 * (close candidate scores) draw from a log-normal so most thinks are quick
 * with the occasional genuine tank.
 */
function samplePrethinkMs(s: Session): number {
  const T = C4_TIMING;
  const t = s.candidateCache?.out.think;
  if (t?.forced) {
    return T.prethinkFloorMs + Math.random() * T.obviousExtraMs;
  }
  const difficulty = t?.closeness ?? 0.5;
  const median = 700 + 3500 * difficulty;
  const sampled = median * Math.exp(0.5 * gaussian());
  return Math.min(T.prethinkCapMs, Math.max(T.prethinkFloorMs, sampled));
}

function gaussian(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Enter the hold for a decided move and schedule its presentation. */
function beginHold(s: Session, move: { col: number }, commentary: ChatMessage[]): void {
  clearHoldTimers(s);
  s.hold = {
    move,
    decidedAt: Date.now(),
    commentary,
    presented: false,
    held: false,
    replyCycles: 0,
    prethinkTimer: null,
    capTimer: null,
  };
  const prethinkMs = samplePrethinkMs(s);
  s.hold.prethinkTimer = setTimeout(() => {
    if (s.hold) s.hold.prethinkTimer = null;
    void presentHold(s);
  }, prethinkMs);
  armCapTimer(s);
}

function armCapTimer(s: Session): void {
  if (!s.hold) return;
  if (s.hold.capTimer) clearTimeout(s.hold.capTimer);
  s.hold.capTimer = setTimeout(() => {
    if (s.status === 'active' && s.hold && !s.hold.held) void forceCommit(s);
  }, C4_TIMING.capMs);
}

function clearHoldTimers(s: Session): void {
  if (!s.hold) return;
  if (s.hold.prethinkTimer) clearTimeout(s.hold.prethinkTimer);
  if (s.hold.capTimer) clearTimeout(s.hold.capTimer);
  s.hold.prethinkTimer = null;
  s.hold.capTimer = null;
}

/** Push the buffered commentary + publish pendingAiMove for the reveal gate. */
async function presentHold(s: Session): Promise<void> {
  const d = requireDeps();
  if (s.status !== 'active' || !s.hold || s.hold.presented || s.hold.held) return;
  s.hold.presented = true;
  const lines = s.hold.commentary.splice(0);
  for (const msg of lines) {
    msg.ts = Date.now();
    await chatStore.appendMessage(s.characterId, msg);
    d.pushChatMessage(s.characterId, msg);
    s.lastActivityAt = Date.now();
  }
  if (s.status !== 'active' || !s.hold || s.hold.held) return;
  s.pendingAiMove = s.hold.move;
  push(s);
}

/** Cap fired (or reply cycles ran out): land the move now, mid-conversation. */
async function forceCommit(s: Session): Promise<void> {
  if (s.status !== 'active' || !s.hold) return;
  if (!s.hold.presented) await presentHold(s);
  if (s.status !== 'active' || !s.hold) return;
  s.pendingAiMove = s.hold.move;
  commitAiMove(s);
}

function commitAiMove(s: Session): void {
  const move = s.pendingAiMove;
  if (!move) return;
  let landed: { board: C4Board; row: number };
  try {
    landed = applyMove(s.board, move.col, aiColorOf(s));
  } catch (err) {
    // Should be impossible (validated at pick time against the same board).
    console.error(
      `[sei/connect4] pending move col=${move.col} failed to commit: ${(err as Error).message}`,
    );
    clearHoldTimers(s);
    s.hold = null;
    s.pendingAiMove = null;
    s.aiThinking = false;
    push(s);
    enqueueYourMove(s);
    return;
  }
  s.board = landed.board;
  s.history.push({ col: move.col, row: landed.row, color: aiColorOf(s) });
  clearHoldTimers(s);
  s.hold = null;
  s.pendingAiMove = null;
  s.aiThinking = false;
  s.candidateCache = null;
  s.lastActivityAt = Date.now();
  s.idleStreak = 0;
  push(s);
  s.queue?.resetIdleTimer();
  checkGameOver(s);
}

/** Natural (board) game-over detection after a committed move. */
function checkGameOver(s: Session): boolean {
  const won = checkWin(s.board);
  if (won) {
    endSession(s, { winner: won.winner, reason: 'connect', line: won.line });
    return true;
  }
  if (isDraw(s.board)) {
    endSession(s, { winner: null, reason: 'draw-full' });
    return true;
  }
  return false;
}

function endSession(s: Session, result: C4Result, opts?: { silent?: boolean }): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  clearHoldTimers(s);
  s.hold = null;
  s.aiThinking = false;
  s.pendingAiMove = null;
  s.status = 'ended';
  s.result = result;
  flushChatBuffer(s);
  s.queue?.dispose();
  s.queue = null;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  // Transcript event ("You and X played Connect 4") — same shape the
  // Minecraft sessions append, rendered with the gamepad icon.
  if (result.reason !== 'abandoned' || s.history.length > 0) {
    const ev: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      text: '',
      ts: Date.now(),
      event: { kind: 'play', game: 'Connect 4', durationMs },
    } as ChatMessage;
    void chatStore.appendMessage(s.characterId, ev).then(() => {
      requireDeps().pushChatMessage(s.characterId, ev);
    }).catch(() => {});
  }

  if (!opts?.silent) {
    // Memory: one line in the character's own ledger about how it went.
    void (async () => {
      try {
        const config = await loadConfig();
        const player = (config.preferred_name ?? '').trim() || 'the player';
        const outcome =
          result.winner === null
            ? `we drew (${result.reason})`
            : result.winner === aiColorOf(s)
              ? `i won (${result.reason})`
              : `i lost (${result.reason})`;
        await appendMemory(
          path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
          `played connect 4 with ${player}: ${outcome} in ${Math.ceil(s.history.length / 2)} moves`,
        );
      } catch {
        /* best-effort */
      }
    })();
    // Let the character react to the result in chat.
    void runC4LlmTurn(s, { kind: 'game-over', voiceCall: isCallActive(s.characterId) }).catch(() => {});
  }
}

/** Log-friendly error description including status and the cause chain. */
function describeErr(err: unknown): string {
  const e = err as Error & { status?: number; cause?: Error & { code?: string; cause?: Error & { code?: string } } };
  let out = `${e.name ?? 'Error'}: ${e.message}`;
  if (e.status !== undefined) out += ` status=${e.status}`;
  for (let c = e.cause; c; c = c.cause as typeof c) {
    out += ` <- ${c.name ?? 'Error'}: ${c.message}${c.code ? ` (${c.code})` : ''}`;
  }
  return out;
}

/** Transport-level failure (never got an HTTP response) — worth one retry. */
function isConnectionError(err: unknown): boolean {
  const e = err as Error & { status?: number };
  return e?.name === 'APIConnectionError' || (e?.status === undefined && /connection error/i.test(e?.message ?? ''));
}

function candidatesFor(s: Session): C4CandidateOut {
  if (s.candidateCache?.ply === s.history.length) return s.candidateCache.out;
  const out = candidateSet(s.board, aiColorOf(s), s.profile.strength);
  s.candidateCache = { ply: s.history.length, out };
  return out;
}

function fallbackPlay(s: Session): void {
  const { candidates } = candidatesFor(s);
  if (s.status !== 'active') return;
  const pick = candidates[0];
  if (!pick) throw new Error('no candidates');
  beginHold(s, { col: pick.col }, []);
}

// ── the LLM turn ─────────────────────────────────────────────────────────────

const PLAY_TOOL = {
  name: 'play',
  description:
    'Drop your Connect 4 disc. Give the column number, 1 to 7, counted from the left. ' +
    'Pick from the candidate columns you are considering; you may try a different open column if your character truly would, ' +
    'but your candidates already reflect how well you see the board. If the column is full you will be told and must try again. ' +
    'If you want to say any table talk, say it BEFORE calling this, in the same turn; staying silent is also fine.',
  input_schema: {
    type: 'object' as const,
    properties: {
      column: { type: 'number', description: 'The column to drop into, 1 to 7 from the left.' },
    },
    required: ['column'],
  },
};

/** The hold-turn variant: same tool name, revision semantics. */
const PLAY_UPDATE_TOOL = {
  name: 'play',
  description:
    'Update your queued Connect 4 drop, or release a held one. You already decided a column this turn; call this with a different open column to change your decision, ' +
    'or with the same column to let a held move finally land. Columns are numbered 1 to 7 from the left.',
  input_schema: PLAY_TOOL.input_schema,
};

const WAIT_TOOL = {
  name: 'wait',
  description:
    'Hold your queued drop back instead of letting it land, for example because the player asked you to wait. ' +
    'Nothing will play until you call play() again in a later turn; new messages and quiet moments will remind you.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const FORFEIT_TOOL = {
  name: 'forfeit',
  description:
    'Forfeit the game. Only when your position is hopeless or your character would genuinely quit. ' +
    'Say your parting line first in the same turn.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const C4_MAX_HOPS = 5;
const TURN_TIMEOUT_MS = 90_000;

function colorName(c: C4Color): string {
  return c === 'r' ? 'Red' : 'Yellow';
}

/**
 * Deterministic plain-sentence description of a committed ply, for the
 * prompt's last-moves delta. Possessives are from the character's viewpoint
 * ("on top of your disc" when the player stacks on the AI). This line is what
 * keeps the model from confabulating what the player just did: it never has
 * to parse a grid.
 */
function describePly(before: C4Board, rec: C4MoveRecord, mine: boolean): string {
  const parts: string[] = [];
  let base = `dropped in column ${rec.col + 1}`;
  if (rec.col === 3) base += ', the center';
  parts.push(base);
  if (rec.row === 0) {
    parts.push('on the floor');
  } else {
    const below = before[rec.row - 1][rec.col];
    const own = below === rec.color;
    if (own) parts.push(mine ? 'stacking on your own disc' : 'stacking on their own disc');
    else parts.push(mine ? 'on top of their disc' : 'on top of your disc');
  }
  const { board: after } = applyMove(before, rec.col, rec.color);
  if (checkWin(after)?.winner === rec.color) {
    parts.push('making four in a row');
  } else {
    const wins = winningCols(after, rec.color);
    if (wins.length >= 2) {
      parts.push(`creating TWO winning spots (columns ${wins.map((c) => c + 1).join(' and ')})`);
    } else if (wins.length === 1) {
      parts.push(`threatening to win in column ${wins[0] + 1}`);
    } else if (runThrough(after, rec.row, rec.col) === 3) {
      parts.push('making three in a row');
    }
  }
  return parts.join(', ');
}

/** The last `n` plies as viewpoint-labeled sentences, oldest first. */
function describeRecentPlies(s: Session, n: number): Array<{ mine: boolean; text: string }> {
  const aiColor = aiColorOf(s);
  const start = Math.max(0, s.history.length - n);
  // Replay to the board state BEFORE the first described ply (history <= 42).
  let board = createBoard();
  for (let i = 0; i < start; i++) {
    board = applyMove(board, s.history[i].col, s.history[i].color).board;
  }
  const out: Array<{ mine: boolean; text: string }> = [];
  for (let i = start; i < s.history.length; i++) {
    const rec = s.history[i];
    const mine = rec.color === aiColor;
    out.push({ mine, text: describePly(board, rec, mine) });
    board = applyMove(board, rec.col, rec.color).board;
  }
  return out;
}

function buildC4Block(s: Session, kind: TurnKind, playerName: string, quietSec?: number): string {
  const aiColor = aiColorOf(s);
  const lines: string[] = [];
  lines.push('# CONNECT 4 GAME');
  lines.push(
    `You are playing a casual, untimed game of Connect 4 against ${playerName} inside the Sei app. ` +
      `You play the ${colorName(aiColor)} discs; they play ${colorName(s.playerColor)}. Red moves first. ` +
      'The chat beside the board is your table talk: stay fully in character, keep lines short like your usual texting, ' +
      'and never dump grids, coordinates, or column lists into chat. Refer to moves naturally (the middle, that stack, your trap).',
  );
  if (s.profile.styleNote) lines.push(`Your Connect 4 personality: ${s.profile.styleNote}`);

  if (kind === 'game-over' && s.result) {
    const r = s.result;
    const outcome =
      r.winner === null
        ? `The game just ended in a draw (${r.reason === 'draw-full' ? 'the board filled up' : r.reason}).`
        : r.winner === aiColor
          ? `You just WON (${r.reason === 'resign' ? `${playerName} resigned` : 'four in a row'}).`
          : `You just LOST (${r.reason === 'forfeit' ? 'you forfeited' : 'they got four in a row'}).`;
    lines.push(outcome);
    lines.push('React to the result in one or two short lines, in character. No tools this turn.');
    return lines.join('\n\n');
  }

  // Ground truth about what just happened on the board. Translated sentences,
  // never a raw grid: the model must not have to parse the board to know what
  // the player did (that is how commentary starts hallucinating moves).
  const moveNo = Math.floor(s.history.length / 2) + 1;
  if (s.history.length === 0) {
    lines.push('Move 1. No discs have been dropped yet.');
  } else {
    const recent = describeRecentPlies(s, 2);
    const recentLines = recent.map((p) =>
      p.mine ? `Your previous move: ${p.text}.` : `${playerName} just played: ${p.text}.`,
    );
    lines.push(`Move ${moveNo}.\n${recentLines.join('\n')}`);
  }

  const holdLines = (): void => {
    if (!s.hold) return;
    if (s.hold.held) {
      lines.push(
        `You decided to drop in column ${s.hold.move.col + 1} this turn but you are HOLDING it back (you called wait()). ` +
          'It will not land until you call play() again, with the same column or a different one. ' +
          'Call play() when you are ready; keep waiting by simply not calling it.',
      );
    } else {
      lines.push(
        `You have already decided your move this turn: column ${s.hold.move.col + 1}. It lands on the board shortly after this conversation goes quiet. ` +
          'To change your decision, call play() again with your new column. ' +
          `If ${playerName} asks you to hold on, or you want to keep it back for now, call wait().`,
      );
    }
  };

  if (kind === 'chat-reply' || kind === 'idle') {
    const playersTurn = turnOf(s) === s.playerColor;
    if (kind === 'chat-reply') {
      if (s.hold) holdLines();
      else {
        lines.push(
          playersTurn
            ? `It is ${playerName}'s move; you are waiting. Reply to their message.`
            : 'It is YOUR move, but first just reply to their message; you will pick your column right after.',
        );
      }
    } else {
      const sec = Math.max(1, Math.round(quietSec ?? 0));
      lines.push(
        `Nothing has happened for about ${sec} seconds. ` +
          (s.hold?.held
            ? 'You are still holding your move back.'
            : `${playerName} is thinking about their move.`),
      );
      if (s.hold) holdLines();
      lines.push(
        'A message is OPTIONAL here. If you have one short in-character line genuinely worth saying (a needle, an observation, a mood), say it. ' +
          'Otherwise reply with nothing at all: silence over a board game is normal.',
      );
    }
    return lines.join('\n\n');
  }

  // kind === 'move': the full candidate view.
  const { macro, candidates } = candidatesFor(s);
  lines.push(
    `It is YOUR move. ${macro.text} ` +
      'When you talk about the position, keep it loose and human; never recite exact disc counts or grid positions unless they appear in the lines above.',
  );
  const candText = candidates
    .map((c, i) => `${i + 1}. Column ${c.col + 1}: ${c.sentence}`)
    .join('\n');
  lines.push(
    'The columns you are considering (these reflect how well you personally see the board right now):\n' + candText,
  );
  lines.push(
    'Table talk is OPTIONAL this turn. If their last move or your reply deserves one short in-character line, say it as plain text BEFORE calling play(). ' +
      'Many moves deserve no comment at all; in that case just call play() with your column and nothing else.',
  );
  return lines.join('\n\n');
}

async function readMemoryTail(id: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(id), 'MEMORY.md'), 'utf8');
    return raw.length <= 6000 ? raw : raw.slice(-6000);
  } catch {
    return '';
  }
}

/**
 * Run one Connect 4 LLM turn. kind:
 *   'move'       — it is the AI's move: optional commentary + the play/forfeit
 *                  loop. Commentary is BUFFERED into the hold and only
 *                  presents after the prethink delay.
 *   'chat-reply' — answer player chat with the game as context. During a hold
 *                  it can revise (play) or hold (wait).
 *   'idle'       — quiet-table tick; a line is optional, silence expected.
 *   'game-over'  — react to the finished game.
 * Returns the persisted commentary messages (for 'move', the buffered ones).
 */
async function runC4LlmTurn(
  s: Session,
  opts: { kind: TurnKind; voiceCall: boolean },
): Promise<ChatMessage[]> {
  const d = requireDeps();
  const character = await getCharacter(s.characterId);
  if (!character) throw new Error('character not found');
  const config = await loadConfig();
  const playerName = (config.preferred_name ?? '').trim() || 'the player';
  const [{ summary, history }, memory] = await Promise.all([
    readChatContext(s.characterId),
    readMemoryTail(s.characterId),
  ]);
  const quietSec = (Date.now() - s.lastActivityAt) / 1000;
  s.inFlightKind = opts.kind;

  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness: 1,
    punctuation: character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual',
    memory,
    summary,
    openWorldDetected: false,
    inGame: false,
    voiceCall: opts.voiceCall,
    language: clampChatLanguage(config.chat_language),
  } as Parameters<typeof buildSystemBlocks>[0]);
  // Appended AFTER the cache-marked persona/status blocks, so the stable
  // prefix stays cached while the per-move game view re-bills (it is small).
  system.push({ type: 'text', text: buildC4Block(s, opts.kind, playerName, quietSec) });

  const messages = toMessages(history.slice(-30));
  if (opts.kind === 'move') {
    messages.push({
      role: 'user',
      content: `(game) It is your move, ${character.name}.`,
    });
  } else if (opts.kind === 'game-over') {
    messages.push({ role: 'user', content: '(game) The game just ended. Say your piece.' });
  } else if (opts.kind === 'idle') {
    messages.push({
      role: 'user',
      content: '(game) (the table is quiet; say something only if it is worth saying)',
    });
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '(game) (go on)' });
  }
  markLastMessageCached(messages);

  const ctrl = new AbortController();
  s.turnCtrl = ctrl;
  const seq = s.turnSeq;
  const stale = (): boolean => s.turnSeq !== seq || ctrl.signal.aborted;
  const timeout = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);

  const holdToolset = (): Anthropic.Messages.Tool[] => {
    const t: Anthropic.Messages.Tool[] = [REMEMBER_TOOL as Anthropic.Messages.Tool];
    if (s.hold) t.push(PLAY_UPDATE_TOOL as Anthropic.Messages.Tool, WAIT_TOOL as Anthropic.Messages.Tool);
    return t;
  };
  const tools: Anthropic.Messages.Tool[] =
    opts.kind === 'move'
      ? ([PLAY_TOOL, FORFEIT_TOOL, REMEMBER_TOOL] as Anthropic.Messages.Tool[])
      : opts.kind === 'game-over'
        ? []
        : holdToolset();

  // Move-turn table talk presents only after the prethink delay; everything
  // else speaks immediately.
  const deferSpeech = opts.kind === 'move';
  const spoken: ChatMessage[] = [];
  const speak = async (text: string): Promise<void> => {
    for (const part of splitReply(text, character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual')) {
      if (!part) continue;
      const msg: ChatMessage = {
        id: randomUUID(),
        role: 'companion',
        text: part,
        ts: Date.now() + spoken.length,
        ...(opts.voiceCall ? { voice: true } : {}),
      };
      spoken.push(msg);
      if (deferSpeech) continue;
      await chatStore.appendMessage(s.characterId, msg);
      d.pushChatMessage(s.characterId, msg);
      s.lastActivityAt = Date.now();
    }
  };

  // Set when a hold-turn released a held move (play() after wait()); the
  // presentation restarts after the reply finishes.
  let presentAfterTurn = false;

  try {
    const { client, model } = await buildChatSdk();
    let played = false;

    for (let hop = 0; hop < C4_MAX_HOPS && !stale(); hop++) {
      const res = await client.messages.create(
        { model, max_tokens: 300, system, tools, messages: messages as never },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const u = res.usage;
      console.log(
        `[sei/connect4] turn char=${s.characterId.slice(0, 8)} kind=${opts.kind} hop=${hop} ` +
          `in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
      );
      if (stale()) break;

      const text = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) await speak(text);

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let note: string;
        if (tu.name === 'play' && opts.kind === 'move') {
          const picked = tryParseCol(s, (tu.input as { column?: unknown })?.column);
          if (picked === null) {
            note = `That is not an open column. Your candidates: ${candidatesFor(s).candidates.map((c) => `column ${c.col + 1}`).join(', ')}. Call play() again with one of them or another open column. Do not mention this correction in chat.`;
          } else if (played) {
            note = 'You already played your move this turn.';
          } else {
            played = true;
            beginHold(s, { col: picked }, []); // commentary attached after the loop
            note = `You drop in column ${picked + 1}. It will land on the board in a moment; do not call play() again this turn.`;
          }
        } else if (tu.name === 'play' && opts.kind !== 'move' && s.hold) {
          const picked = tryParseCol(s, (tu.input as { column?: unknown })?.column);
          if (picked === null) {
            note = `That is not an open column. Your queued move is still column ${s.hold.move.col + 1}. Do not mention this correction in chat.`;
          } else {
            const wasHeld = s.hold.held;
            const changed = s.hold.move.col !== picked;
            s.hold.move = { col: picked };
            if (s.hold.presented) {
              // Re-publish so the renderer re-arms its reveal on the new move.
              s.pendingAiMove = { col: picked };
              push(s);
            } else if (changed) {
              // Unshown commentary was written for the old move; drop it.
              s.hold.commentary = [];
            }
            if (wasHeld) {
              s.hold.held = false;
              s.hold.replyCycles = 0;
              s.hold.decidedAt = Date.now();
              armCapTimer(s);
              presentAfterTurn = true;
              note = `You will drop in column ${picked + 1}. It lands once this exchange goes quiet.`;
            } else {
              note = changed
                ? `Your queued move is now column ${picked + 1}.`
                : `Your queued move stays column ${picked + 1}.`;
            }
          }
        } else if (tu.name === 'wait' && opts.kind !== 'move' && s.hold) {
          s.hold.held = true;
          s.hold.replyCycles = 0;
          clearHoldTimers(s);
          if (s.hold.presented) {
            s.hold.presented = false;
            s.pendingAiMove = null;
            push(s);
          } else {
            s.hold.commentary = [];
          }
          note = `You hold column ${s.hold.move.col + 1} back. Nothing will play until you call play() again in a later turn.`;
        } else if (tu.name === 'forfeit' && opts.kind === 'move') {
          note = 'You forfeit the game. Say your parting line if you have not already.';
          played = true;
          setImmediate(() => {
            if (!stale()) endSession(s, { winner: s.playerColor, reason: 'forfeit' });
          });
        } else if (tu.name === 'remember') {
          const memText = String((tu.input as { text?: string })?.text ?? '').trim();
          if (memText) {
            try {
              await appendMemory(path.join(paths.memoryDir(s.characterId), 'MEMORY.md'), memText);
              note = 'Saved. Continue; do not mention saving it.';
            } catch {
              note = 'Could not save it. Continue.';
            }
          } else {
            note = 'Nothing saved; the text was empty.';
          }
        } else {
          note = `The tool "${tu.name}" is not available right now.`;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: note });
      }
      messages.push({ role: 'user', content: results });

      if (opts.kind !== 'move') continue;
      // Move decided (or the game is ending): the turn is done. Talk was
      // invited BEFORE play(); a silent play is a legitimate outcome.
      if (played) break;
    }

    if (stale()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }

    if (opts.kind === 'move') {
      if (!played) {
        // The model never produced a valid play() — keep the game moving.
        fallbackPlay(s);
      } else if (s.hold) {
        // Attach the buffered table talk to the hold; prethink presents it.
        s.hold.commentary = spoken.slice();
      }
    } else if (presentAfterTurn) {
      await presentHold(s);
    }

    void foldIfDue(s.characterId, character.persona.expanded).catch(() => {});
    return spoken;
  } catch (err) {
    if (ctrl.signal.aborted || s.turnSeq !== seq) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (s.turnCtrl === ctrl) s.turnCtrl = null;
    if (s.inFlightKind === opts.kind) s.inFlightKind = null;
  }
}

/** Parse the LLM's 1-based column input into a legal 0-based column. */
function tryParseCol(s: Session, raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '').replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  const col = Math.round(n) - 1;
  if (col < 0 || col > 6) return null;
  if (!legalMoves(s.board).includes(col)) return null;
  return col;
}

/** Everything down; called from app shutdown. */
export async function shutdownConnect4(): Promise<void> {
  for (const s of sessions.values()) {
    try { s.turnCtrl?.abort(); } catch { /* already down */ }
    clearHoldTimers(s);
    flushChatBuffer(s);
    s.queue?.dispose();
    s.queue = null;
  }
  sessions.clear();
}
