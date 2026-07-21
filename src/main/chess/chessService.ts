/**
 * Chess minigame service (main process): authoritative game state + the
 * character's turn runner.
 *
 * One game per character. The player's board lives in the renderer; every
 * intent (move, resign, draw, rematch) lands here, mutates the session, and a
 * full ChessGameState snapshot is pushed back over chess:state.
 *
 * The character's move is chosen by the LLM from a skill-conditioned
 * candidate set produced by the CCE engine (vendor/cce-1): the engine fixes
 * STRENGTH (Elo-conditioned Maia sampling + blunder/blinder layers), the LLM
 * only expresses STYLE.
 *
 * Turn scheduling (260714) rides the game-agnostic FSM core from
 * src/bot/brain/fsm.js — one priority queue per session, single-flight:
 *   P1  sei:chat_received  player message(s); consecutive sends coalesce into
 *                          ONE reply turn (chatBuffer drained at dispatch).
 *   P2  sei:your_move      the player's move committed; decide OUR move.
 *   P3  sei:idle           sampled 25-90s of table quiet (silent-streak
 *                          backoff); a line is OPTIONAL, silence is normal.
 *
 * The move decision is atomic and never aborted or re-run. Once play() lands
 * the decision enters a HOLD (s.hold) and the contention moves entirely to
 * presentation:
 *   decide -> prethink (sampled human think time; Maia entropy + eval
 *   closeness, log-normal skew) -> present (commentary bubbles +
 *   pendingAiMove push) -> renderer reveals after its quiet gate (2s after
 *   the last utterance finishes printing/speaking) -> ack -> commit.
 * A player chat during the hold runs as a normal P1 turn that KNOWS the
 * queued move: it can update it (play() again), or hold it back entirely
 * (wait(), after which only player messages and idle ticks wake the move). A
 * hard cap (reply cycles / wall clock) force-commits so chat spam cannot
 * stall the game; wait() disarms the cap deliberately.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { Chess } from 'chess.js';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type {
  ChessColor,
  ChessDownloadProgress,
  ChessGameState,
  ChessMoveRecord,
  ChessResult,
} from '../../shared/chessIpc';
import { CHESS_ERR_MC_ACTIVE } from '../../shared/chessIpc';
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
import { ensureModel, modelReady } from './modelStore';
import { getOrCreateChessProfile, type ChessProfile } from './chessProfile';

// ── deps + module state ──────────────────────────────────────────────────────

export interface ChessDeps {
  pushState: (state: ChessGameState) => void;
  pushDownload: (p: ChessDownloadProgress) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

interface CandidateOut {
  macro: { text: string };
  candidates: Array<{
    uci: string;
    san: string;
    sentence: string;
    tags: string[];
    line: { sans: string[]; sentence: string } | null;
  }>;
  /** Human-difficulty signals for the prethink sampler (cce-1 `think`). */
  think?: { top1P: number; entropy: number; evalGapCp: number | null };
}

/** Minimal typed view of the fsm.js priority queue. */
interface ChessQueue {
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
  move: { uci: string; san: string };
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
  chess: InstanceType<typeof Chess>; // committed moves only
  playerColor: ChessColor;
  status: 'preparing' | 'active' | 'ended';
  aiThinking: boolean;
  pendingAiMove: { uci: string; san: string } | null;
  drawOffer: 'player' | 'ai' | null;
  /** Set when the player's standing draw offer was declined (context note). */
  drawDeclinedNote: boolean;
  result: ChessResult | null;
  profile: ChessProfile;
  history: ChessMoveRecord[];
  startedAt: number;
  turnCtrl: AbortController | null;
  /** Bumps ONLY when the session ends; in-flight turns treat a bump as abort. */
  turnSeq: number;
  candidateCache: { fen: string; out: CandidateOut } | null;
  queue: ChessQueue | null;
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
 * and the commentary/move presenting. postthink (the 2s quiet gate after the
 * last utterance) lives renderer-side in useAiMoveReveal's settle window.
 */
export const CHESS_TIMING = {
  prethinkFloorMs: 300,
  prethinkCapMs: 10_000,
  /** Obvious move (recapture / dominant Maia top-1): floor + rand * this. */
  obviousExtraMs: 900,
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
let deps: ChessDeps | null = null;

/** One CCE engine per app (its Stockfish serializes internally). */
let enginePromise: Promise<{
  candidateSet: (fen: string, profile: { elo: number }) => Promise<CandidateOut>;
}> | null = null;

export function initChessService(d: ChessDeps): void {
  deps = d;
}

function requireDeps(): ChessDeps {
  if (!deps) throw new Error('chess service not initialized');
  return deps;
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const modelPath = await ensureModel();
      const { CharacterChessEngine } = await import('cce-1');
      return await CharacterChessEngine.create({ maiaModelPath: modelPath });
    })().catch((err) => {
      enginePromise = null; // allow retry on next game
      throw err;
    });
  }
  return enginePromise;
}

// ── snapshots ────────────────────────────────────────────────────────────────

function snapshot(s: Session): ChessGameState {
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    fen: s.chess.fen(),
    history: s.history,
    playerColor: s.playerColor,
    turn: s.chess.turn(),
    aiThinking: s.aiThinking,
    pendingAiMove: s.pendingAiMove,
    drawOffer: s.drawOffer,
    result: s.result,
    aiElo: s.profile.elo,
  };
}

function push(s: Session): ChessGameState {
  const state = snapshot(s);
  requireDeps().pushState(state);
  return state;
}

// ── public api (wired to IPC handlers) ──────────────────────────────────────

export function isChessActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getChessState(characterId: string): ChessGameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startChess(
  characterId: string,
  opts?: { playerColor?: 'w' | 'b' | 'random' },
): Promise<ChessGameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${CHESS_ERR_MC_ACTIVE}: disconnect the Minecraft session to play chess`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') return snapshot(existing);

  const pick = opts?.playerColor ?? 'w';
  const playerColor: ChessColor =
    pick === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;

  const profile = await getOrCreateChessProfile(characterId);
  const s: Session = {
    gameId: randomUUID(),
    characterId,
    chess: new Chess(),
    playerColor,
    status: (await modelReady()) ? 'active' : 'preparing',
    aiThinking: false,
    pendingAiMove: null,
    drawOffer: null,
    drawDeclinedNote: false,
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
      dispatchChess(s, event, data as { quietMs?: number; nudge?: boolean } | undefined, signal),
    onPreempt: (event: string) => {
      // A fresh player message may abort an in-flight IDLE turn (cheap
      // chatter, the reply matters more). Never a move decision or a reply.
      if (event === 'sei:chat_received' && s.inFlightKind === 'idle') {
        try { s.turnCtrl?.abort(); } catch { /* already done */ }
      }
      return false; // never claim; the event still queues
    },
    logger: console,
  }) as ChessQueue;
  sessions.set(characterId, s);
  push(s);

  // Warm the engine (first run downloads the model with progress pushes).
  void (async () => {
    try {
      await ensureModel((pct) => d.pushDownload({ characterId, pct }));
      await getEngine();
      if (sessions.get(characterId) !== s || s.status === 'ended') return;
      if (s.status === 'preparing') {
        s.status = 'active';
        push(s);
      }
      if (s.chess.turn() !== s.playerColor) enqueueYourMove(s);
    } catch (err) {
      console.error(`[sei/chess] engine warm-up failed: ${(err as Error).message}`);
      d.pushDownload({ characterId, pct: -1, error: (err as Error).message });
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    }
  })();

  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  uci: string,
): Promise<{ ok: boolean; error?: string; state: ChessGameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error('no active chess game');
  }
  if (s.aiThinking || s.pendingAiMove || s.hold || s.chess.turn() !== s.playerColor) {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  let san: string;
  try {
    const move = s.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    san = move.san;
  } catch {
    return { ok: false, error: 'illegal move', state: snapshot(s) };
  }
  s.history.push({ san, uci, fen: s.chess.fen() });
  s.candidateCache = null;
  s.lastActivityAt = Date.now();
  s.idleStreak = 0;
  // Moving instead of answering the AI's draw offer declines it implicitly
  // (lichess semantics); make sure the character hears about it next turn.
  if (s.drawOffer === 'ai') {
    s.drawOffer = null;
    s.drawDeclinedNote = true;
  }
  const state = push(s);

  if (checkGameOver(s)) return { ok: true, state: snapshot(s) };
  enqueueYourMove(s);
  return { ok: true, state };
}

export async function resign(characterId: string): Promise<ChessGameState> {
  const s = requireActive(characterId);
  const aiColor: ChessColor = s.playerColor === 'w' ? 'b' : 'w';
  endSession(s, { winner: aiColor, reason: 'resign' });
  return snapshot(s);
}

export async function offerDraw(characterId: string): Promise<ChessGameState> {
  const s = requireActive(characterId);
  if (s.drawOffer !== 'player') {
    s.drawOffer = 'player';
    s.drawDeclinedNote = false;
    push(s);
    // If the character is mid-turn (deciding or holding a decided move), give
    // it a conversation-tier turn so the offer is heard without re-deciding.
    if (s.chess.turn() !== s.playerColor && s.status === 'active') {
      s.queue?.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true, nudge: true });
    }
  }
  return snapshot(s);
}

export async function respondDraw(characterId: string, accept: boolean): Promise<ChessGameState> {
  const s = requireActive(characterId);
  if (s.drawOffer !== 'ai') return snapshot(s);
  s.drawOffer = null;
  if (accept) {
    endSession(s, { winner: null, reason: 'draw-agreed' });
  } else {
    s.drawDeclinedNote = true;
    push(s);
  }
  return snapshot(s);
}

export async function rematch(characterId: string): Promise<ChessGameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  sessions.delete(characterId);
  return startChess(characterId, {
    playerColor: old.playerColor === 'w' ? 'b' : 'w',
  });
}

export async function endChess(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') {
    endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
  }
  sessions.delete(characterId);
}

/**
 * The renderer's quiet gate passed: commentary finished presenting and held
 * 2s of table silence with the pending move on deck. Commit it. Stale acks
 * (move revised, wait() retracted it, game over) are ignored; the snapshot
 * reconciles the renderer either way.
 */
export async function ackReveal(characterId: string, uci: string): Promise<ChessGameState> {
  const s = sessions.get(characterId);
  if (!s) throw new Error('no chess game');
  if (
    s.status !== 'active' ||
    !s.hold ||
    s.hold.held ||
    !s.hold.presented ||
    s.pendingAiMove?.uci !== uci
  ) {
    return snapshot(s);
  }
  commitAiMove(s);
  return snapshot(s);
}

// ── chat routing ─────────────────────────────────────────────────────────────

/**
 * A player chat message while a game is open. Returns null when chess should
 * NOT handle it (no session / game over) so ipc falls through to the normal
 * chat path. The message lands in the chat log immediately, then rides the
 * session queue at P1: consecutive sends coalesce into one reply turn, and a
 * turn during the presentation hold can update or hold back the queued move
 * (it never re-decides from scratch).
 */
export async function handlePlayerChat(args: {
  characterId: string;
  text: string;
  replyTo?: ChatMessage['replyTo'];
  voiceCall?: boolean;
}): Promise<ChatSendResult | null> {
  const s = sessions.get(characterId(args));
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

function characterId(args: { characterId: string }): string {
  return args.characterId;
}

// ── internals ────────────────────────────────────────────────────────────────

function requireActive(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'active') throw new Error('no active chess game');
  return s;
}

// ── fsm dispatch ─────────────────────────────────────────────────────────────

function enqueueYourMove(s: Session): void {
  if (s.status !== 'active' || s.chess.turn() === s.playerColor) return;
  // Idempotent: the engine warm-up and playerMove can both conclude it is the
  // AI's turn (the warm-up block resolves asynchronously); one decision only.
  if (s.aiThinking || s.hold) return;
  s.aiThinking = true;
  push(s);
  s.queue?.enqueue(Priority.P2_MOVEMENT, 'sei:your_move', {});
}

async function dispatchChess(
  s: Session,
  event: string,
  data: { quietMs?: number; nudge?: boolean } | undefined,
  _signal: AbortSignal,
): Promise<void> {
  if (s.status === 'ended') {
    flushChatBuffer(s);
    return;
  }
  try {
    if (event === 'sei:your_move') await dispatchYourMove(s);
    else if (event === 'sei:chat_received') await dispatchChat(s, data?.nudge === true);
    else if (event === 'sei:idle') await dispatchIdle(s);
  } finally {
    // Idle re-arms itself (enqueues reset the timer; a dispatch does not).
    if (event === 'sei:idle') s.queue?.resetIdleTimer();
  }
}

async function dispatchYourMove(s: Session): Promise<void> {
  if (s.status !== 'active' || s.chess.turn() === s.playerColor) return;
  // A transient transport failure (stale keep-alive socket, network blip)
  // gets one retry after a short pause; anything else, or a second failure,
  // falls back so the game never stalls.
  for (let attempt = 0; ; attempt++) {
    try {
      // Candidate generation happens up front so its latency reads as part of
      // the character thinking (the shimmer is already on).
      await candidatesFor(s);
      if (s.status !== 'active') return;
      await runChessLlmTurn(s, { kind: 'move', voiceCall: isCallActive(s.characterId) });
      return;
    } catch (err) {
      if (s.status !== 'active') return;
      if ((err as Error).message === CHAT_ABORTED) return;
      console.error(`[sei/chess] AI turn failed (attempt ${attempt + 1}): ${describeErr(err)}`);
      if (attempt === 0 && isConnectionError(err)) {
        await new Promise((r) => setTimeout(r, 1500));
        if (s.status !== 'active') return;
        continue;
      }
      // The game must never stall: fall back to the first candidate silently.
      try {
        await fallbackPlay(s);
      } catch (err2) {
        console.error(`[sei/chess] fallback move failed: ${describeErr(err2)}`);
        endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
      }
      return;
    }
  }
}

async function dispatchChat(s: Session, nudge: boolean): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0 && !nudge) return; // coalesced into an earlier dispatch
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  let replies: ChatMessage[] = [];
  try {
    replies = await runChessLlmTurn(s, { kind: 'chat-reply', voiceCall });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/chess] chat reply failed: ${describeErr(err)}`);
    }
  }
  for (const e of entries) e.resolve({ replies });

  // Conversation cap: chat can delay the queued move only so far, unless the
  // character itself chose to hold (wait() disarms the cap on purpose).
  if (s.status === 'active' && s.hold && !s.hold.held) {
    s.hold.replyCycles++;
    if (s.hold.replyCycles >= CHESS_TIMING.capReplyCycles) {
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
    replies = await runChessLlmTurn(s, { kind: 'idle', voiceCall: isCallActive(s.characterId) });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/chess] idle turn failed: ${describeErr(err)}`);
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
  const T = CHESS_TIMING;
  const base = T.idleMinMs + Math.random() * Math.max(0, T.idleMaxMs - T.idleMinMs);
  return base * Math.min(1 + s.idleStreak, T.idleBackoffCap);
}

// ── the presentation hold ────────────────────────────────────────────────────

/**
 * Sampled "human think" delay before the decision presents. Obvious moves
 * (recaptures, a dominant Maia top-1) answer near-instantly; hard choices
 * (high human-policy entropy, close candidate evals) draw from a log-normal
 * so most thinks are quick with the occasional genuine tank — the skew Allie
 * (arXiv 2410.03893) observed in real human clocks.
 */
function samplePrethinkMs(s: Session): number {
  const T = CHESS_TIMING;
  const t = s.candidateCache?.out.think;
  if (isRecapture(s) || (t?.top1P ?? 0) > 0.7) {
    return T.prethinkFloorMs + Math.random() * T.obviousExtraMs;
  }
  const closeness = t?.evalGapCp == null ? 0.5 : 1 - Math.min(t.evalGapCp / 200, 1);
  const difficulty = 0.6 * (t?.entropy ?? 0.5) + 0.4 * closeness;
  const median = 1000 + 6000 * difficulty;
  const sampled = median * Math.exp(0.5 * gaussian());
  return Math.min(T.prethinkCapMs, Math.max(T.prethinkFloorMs, sampled));
}

function gaussian(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The decided move recaptures on the square the player just captured on. */
function isRecapture(s: Session): boolean {
  const last = s.history[s.history.length - 1];
  if (!last || !last.san.includes('x') || !s.hold) return false;
  return s.hold.move.uci.slice(2, 4) === last.uci.slice(2, 4);
}

/** Enter the hold for a decided move and schedule its presentation. */
function beginHold(s: Session, move: { uci: string; san: string }, commentary: ChatMessage[]): void {
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
  }, CHESS_TIMING.capMs);
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
  try {
    s.chess.move({
      from: move.uci.slice(0, 2),
      to: move.uci.slice(2, 4),
      promotion: move.uci.length > 4 ? move.uci[4] : undefined,
    });
  } catch (err) {
    // Should be impossible (validated at pick time against the same position).
    console.error(`[sei/chess] pending move ${move.uci} failed to commit: ${(err as Error).message}`);
    clearHoldTimers(s);
    s.hold = null;
    s.pendingAiMove = null;
    s.aiThinking = false;
    push(s);
    enqueueYourMove(s);
    return;
  }
  s.history.push({ san: move.san, uci: move.uci, fen: s.chess.fen() });
  clearHoldTimers(s);
  s.hold = null;
  s.pendingAiMove = null;
  s.aiThinking = false;
  s.candidateCache = null;
  s.lastActivityAt = Date.now();
  s.idleStreak = 0;
  // Playing a move instead of accepting the player's draw offer declines it.
  if (s.drawOffer === 'player') s.drawOffer = null;
  push(s);
  s.queue?.resetIdleTimer();
  checkGameOver(s);
}

/** Natural (board) game-over detection after a committed move. */
function checkGameOver(s: Session): boolean {
  const c = s.chess;
  if (!c.isGameOver()) return false;
  let result: ChessResult;
  if (c.isCheckmate()) {
    // The side to move is checkmated; the mover (previous turn) wins.
    result = { winner: c.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
  } else if (c.isStalemate()) {
    result = { winner: null, reason: 'stalemate' };
  } else if (c.isThreefoldRepetition()) {
    result = { winner: null, reason: 'draw-repetition' };
  } else if (c.isInsufficientMaterial()) {
    result = { winner: null, reason: 'draw-material' };
  } else {
    result = { winner: null, reason: 'draw-fifty' };
  }
  endSession(s, result);
  return true;
}

function endSession(s: Session, result: ChessResult, opts?: { silent?: boolean }): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  clearHoldTimers(s);
  s.hold = null;
  s.aiThinking = false;
  s.pendingAiMove = null;
  s.drawOffer = null;
  s.status = 'ended';
  s.result = result;
  flushChatBuffer(s);
  s.queue?.dispose();
  s.queue = null;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  // Transcript event ("You and X played Chess") — same shape the Minecraft
  // sessions append, rendered with the gamepad icon.
  if (result.reason !== 'abandoned' || s.history.length > 0) {
    const ev: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      text: '',
      ts: Date.now(),
      event: { kind: 'play', game: 'Chess', durationMs },
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
        const aiColor = s.playerColor === 'w' ? 'b' : 'w';
        const outcome =
          result.winner === null
            ? `we drew (${result.reason.replace('draw-', '')})`
            : result.winner === aiColor
              ? `i won (${result.reason})`
              : `i lost (${result.reason})`;
        await appendMemory(
          path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
          `played chess with ${player}: ${outcome} in ${Math.ceil(s.history.length / 2)} moves`,
        );
      } catch {
        /* best-effort */
      }
    })();
    // Let the character react to the result in chat.
    void runChessLlmTurn(s, { kind: 'game-over', voiceCall: isCallActive(s.characterId) }).catch(() => {});
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

async function candidatesFor(s: Session): Promise<CandidateOut> {
  const fen = s.chess.fen();
  if (s.candidateCache?.fen === fen) return s.candidateCache.out;
  const engine = await getEngine();
  const out = await engine.candidateSet(fen, { elo: s.profile.elo });
  s.candidateCache = { fen, out };
  return out;
}

async function fallbackPlay(s: Session): Promise<void> {
  const { candidates } = await candidatesFor(s);
  if (s.status !== 'active') return;
  const pick = candidates[0];
  if (!pick) throw new Error('no candidates');
  beginHold(s, { uci: pick.uci, san: pick.san }, []);
}

// ── the LLM turn ─────────────────────────────────────────────────────────────

const PLAY_TOOL = {
  name: 'play',
  description:
    'Play your chess move. Give the move in standard notation (SAN like "Nf3", "exd5", "O-O", or a from-to square pair like "e2e4"). ' +
    'Pick from the candidate moves you are considering; you may try a different legal move if your character truly would, ' +
    'but your candidates already reflect how well you see the board. If the move is illegal you will be told and must try again. ' +
    'If you want to say any table talk, say it BEFORE calling this, in the same turn; staying silent is also fine.',
  input_schema: {
    type: 'object' as const,
    properties: {
      move: { type: 'string', description: 'The move, e.g. "Nf3" or "g1f3".' },
    },
    required: ['move'],
  },
};

/** The hold-turn variant: same tool name, revision semantics. */
const PLAY_UPDATE_TOOL = {
  name: 'play',
  description:
    'Update your queued chess move, or release a held one. You already decided a move this turn; call this with a different legal move to change your decision, ' +
    'or with the same move to let a held move finally land. SAN like "Nf3" or a square pair like "g1f3".',
  input_schema: PLAY_TOOL.input_schema,
};

const WAIT_TOOL = {
  name: 'wait',
  description:
    'Hold your queued move back instead of letting it land, for example because the player asked you to wait. ' +
    'Nothing will play until you call play() again in a later turn; new messages and quiet moments will remind you.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const PROPOSE_DRAW_TOOL = {
  name: 'propose_draw',
  description:
    'Offer the player a draw, or accept their standing draw offer if they made one. ' +
    'Use it when the position is dead equal or your character would rather split the point. ' +
    'If you are only OFFERING (no standing offer from the player), still play your move this turn.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const FORFEIT_TOOL = {
  name: 'forfeit',
  description:
    'Resign the game. Only when your position is hopeless or your character would genuinely quit. ' +
    'Say your parting line first in the same turn.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const CHESS_MAX_HOPS = 5;
const TURN_TIMEOUT_MS = 90_000;

function colorName(c: ChessColor): string {
  return c === 'w' ? 'White' : 'Black';
}

const PIECE_NAMES: Record<string, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};

/**
 * Deterministic plain-sentence description of a committed ply, for the
 * prompt's last-moves delta. Possessives are from the character's viewpoint
 * ("takes your pawn" when the player captures). This line is what keeps the
 * model from confabulating what the player just did: it never has to parse
 * notation.
 */
function describePly(prevFen: string | undefined, rec: ChessMoveRecord, mine: boolean): string {
  try {
    const probe = new Chess(prevFen);
    const mv = probe.move(rec.san);
    let text: string;
    if (mv.san.startsWith('O-O-O')) text = `${rec.san}, castling long`;
    else if (mv.san.startsWith('O-O')) text = `${rec.san}, castling short`;
    else if (mv.captured) {
      const whose = mine ? 'their' : 'your';
      text = `${rec.san}, ${PIECE_NAMES[mv.piece] ?? 'piece'} takes ${whose} ${PIECE_NAMES[mv.captured] ?? 'piece'} on ${mv.to}`;
    } else {
      text = `${rec.san}, ${PIECE_NAMES[mv.piece] ?? 'piece'} to ${mv.to}`;
    }
    if (mv.promotion) text += `, promoting to a ${PIECE_NAMES[mv.promotion] ?? 'queen'}`;
    if (mv.san.endsWith('#')) text += ', checkmate';
    else if (mv.san.endsWith('+')) text += ', giving check';
    return text;
  } catch {
    return rec.san;
  }
}

/** The last `n` plies as viewpoint-labeled sentences, oldest first. */
function describeRecentPlies(s: Session, n: number): Array<{ mine: boolean; text: string }> {
  const aiColor: ChessColor = s.playerColor === 'w' ? 'b' : 'w';
  const start = Math.max(0, s.history.length - n);
  const out: Array<{ mine: boolean; text: string }> = [];
  for (let i = start; i < s.history.length; i++) {
    const prevFen = i === 0 ? undefined : s.history[i - 1].fen;
    const mine = (i % 2 === 0 ? 'w' : 'b') === aiColor;
    out.push({ mine, text: describePly(prevFen, s.history[i], mine) });
  }
  return out;
}

async function buildChessBlock(
  s: Session,
  kind: TurnKind,
  playerName: string,
  quietSec?: number,
): Promise<string> {
  const aiColor: ChessColor = s.playerColor === 'w' ? 'b' : 'w';
  const lines: string[] = [];
  lines.push('# CHESS GAME');
  lines.push(
    `You are playing a casual, untimed chess game against ${playerName} inside the Sei app. ` +
      `You are ${colorName(aiColor)}; they are ${colorName(s.playerColor)}. ` +
      'The chat beside the board is your table talk: stay fully in character, keep lines short like your usual texting, ' +
      'and never dump raw move lists or coordinates into chat. Refer to moves naturally (the knight, that pawn grab).',
  );
  if (s.profile.styleNote) lines.push(`Your chess personality: ${s.profile.styleNote}`);

  if (kind === 'game-over' && s.result) {
    const r = s.result;
    const outcome =
      r.winner === null
        ? `The game just ended in a draw (${r.reason.replace('draw-', '')}).`
        : r.winner === aiColor
          ? `You just WON (${r.reason === 'resign' ? `${playerName} resigned` : r.reason}).`
          : `You just LOST (${r.reason === 'forfeit' ? 'you resigned' : r.reason}).`;
    lines.push(outcome);
    lines.push('React to the result in one or two short lines, in character. No tools this turn.');
    return lines.join('\n\n');
  }

  // Ground truth about what just happened on the board. Translated sentences,
  // never raw notation: the model must not have to parse SAN to know what the
  // player did (that is how commentary starts hallucinating moves).
  const moveNo = Math.floor(s.history.length / 2) + 1;
  if (s.history.length === 0) {
    lines.push('Move 1. No moves have been played yet.');
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
        `You decided on ${s.hold.move.san} this turn but you are HOLDING it back (you called wait()). ` +
          'It will not land until you call play() again, with the same move or a different one. ' +
          'Call play() when you are ready; keep waiting by simply not calling it.',
      );
    } else {
      lines.push(
        `You have already decided your move this turn: ${s.hold.move.san}. It lands on the board shortly after this conversation goes quiet. ` +
          'To change your decision, call play() again with your new move. ' +
          `If ${playerName} asks you to hold on, or you want to keep it back for now, call wait().`,
      );
    }
  };

  if (kind === 'chat-reply' || kind === 'idle') {
    const playersTurn = s.chess.turn() === s.playerColor;
    if (kind === 'chat-reply') {
      if (s.hold) holdLines();
      else {
        lines.push(
          playersTurn
            ? `It is ${playerName}'s move; you are waiting. Reply to their message.`
            : 'It is YOUR move, but first just reply to their message; you will pick your move right after.',
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
          'Otherwise reply with nothing at all: silence at a chess board is normal.',
      );
    }
    if (s.drawOffer === 'player') {
      lines.push(
        `${playerName} has OFFERED YOU A DRAW. Accept it with propose_draw(), or let the game continue by not accepting.`,
      );
    }
    if (s.chess.isCheck()) lines.push(`${colorName(s.chess.turn())} is in check.`);
    return lines.join('\n\n');
  }

  // kind === 'move': the full CCE candidate view.
  const { macro, candidates } = await candidatesFor(s);
  lines.push(
    `It is YOUR move. ${s.chess.isCheck() ? 'You are in check. ' : ''}${macro.text} ` +
      'When you talk about material, say ahead or behind; never name specific pieces as captured unless they appear in the lines above.',
  );
  const candText = candidates
    .map((c, i) => {
      let t = `${i + 1}. ${c.san}: ${c.sentence}`;
      if (c.line) t += ` ${c.line.sentence}`;
      return t;
    })
    .join('\n');
  lines.push(
    'The moves you are considering (these reflect how well you personally see the board right now):\n' + candText,
  );
  if (s.drawOffer === 'player') {
    lines.push(
      `${playerName} has OFFERED YOU A DRAW. Accept it with propose_draw(), or decline by simply playing your move (you can acknowledge the offer in chat either way).`,
    );
  }
  if (s.drawDeclinedNote) {
    lines.push(`You offered a draw earlier and ${playerName} declined it. Play on.`);
    s.drawDeclinedNote = false;
  }
  lines.push(
    'Table talk is OPTIONAL this turn. If their last move or your reply deserves one short in-character line, say it as plain text BEFORE calling play(). ' +
      'Many moves deserve no comment at all; in that case just call play() with your move and nothing else.',
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
 * Run one chess LLM turn. kind:
 *   'move'       — it is the AI's move: optional commentary + the play/draw/
 *                  forfeit loop. Commentary is BUFFERED into the hold and only
 *                  presents after the prethink delay.
 *   'chat-reply' — answer player chat with the game as context. During a hold
 *                  it can revise (play), hold (wait) or accept a draw.
 *   'idle'       — quiet-table tick; a line is optional, silence expected.
 *   'game-over'  — react to the finished game.
 * Returns the persisted commentary messages (for 'move', the buffered ones).
 */
async function runChessLlmTurn(
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
  // prefix stays cached while the per-move chess view re-bills (it is small).
  system.push({ type: 'text', text: await buildChessBlock(s, opts.kind, playerName, quietSec) });

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
    if (s.drawOffer === 'player') t.push(PROPOSE_DRAW_TOOL as Anthropic.Messages.Tool);
    return t;
  };
  const tools: Anthropic.Messages.Tool[] =
    opts.kind === 'move'
      ? ([PLAY_TOOL, PROPOSE_DRAW_TOOL, FORFEIT_TOOL, REMEMBER_TOOL] as Anthropic.Messages.Tool[])
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

    for (let hop = 0; hop < CHESS_MAX_HOPS && !stale(); hop++) {
      const res = await client.messages.create(
        { model, max_tokens: 300, system, tools, messages: messages as never },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const u = res.usage;
      console.log(
        `[sei/chess] turn char=${s.characterId.slice(0, 8)} kind=${opts.kind} hop=${hop} ` +
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
          const raw = String((tu.input as { move?: string })?.move ?? '').trim();
          const picked = tryParseMove(s, raw);
          if (!picked) {
            note = `"${raw}" is not a legal move for you here. Your candidates: ${s.candidateCache?.out.candidates.map((c) => c.san).join(', ') ?? 'unknown'}. Call play() again with one of them or another legal move. Do not mention this correction in chat.`;
          } else if (played) {
            note = 'You already played your move this turn.';
          } else {
            played = true;
            beginHold(s, picked, []); // commentary attached after the loop
            note = `You play ${picked.san}. It will land on the board in a moment; do not call play() again this turn.`;
          }
        } else if (tu.name === 'play' && opts.kind !== 'move' && s.hold) {
          const raw = String((tu.input as { move?: string })?.move ?? '').trim();
          const picked = tryParseMove(s, raw);
          if (!picked) {
            note = `"${raw}" is not a legal move for you here. Your queued move is still ${s.hold.move.san}. Do not mention this correction in chat.`;
          } else {
            const wasHeld = s.hold.held;
            const changed = s.hold.move.uci !== picked.uci;
            s.hold.move = picked;
            if (s.hold.presented) {
              // Re-publish so the renderer re-arms its reveal on the new move.
              s.pendingAiMove = picked;
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
              note = `You will play ${picked.san}. It lands once this exchange goes quiet.`;
            } else {
              note = changed
                ? `Your queued move is now ${picked.san}.`
                : `Your queued move stays ${picked.san}.`;
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
          note = `You hold ${s.hold.move.san} back. Nothing will play until you call play() again in a later turn.`;
        } else if (tu.name === 'propose_draw' && (opts.kind === 'move' || s.drawOffer === 'player')) {
          if (s.drawOffer === 'player') {
            note = 'You accept the draw. The game ends now; say your closing line if you have not.';
            // End AFTER the loop so the closing line still lands.
            played = true;
            clearHoldTimers(s);
            s.hold = null;
            s.pendingAiMove = null;
            setImmediate(() => {
              if (!stale()) endSession(s, { winner: null, reason: 'draw-agreed' });
            });
          } else {
            s.drawOffer = 'ai';
            push(s);
            note = `Your draw offer is on the table; ${playerName} will accept or decline it. Still play your move now with play().`;
          }
        } else if (tu.name === 'forfeit' && opts.kind === 'move') {
          note = 'You resign the game. Say your parting line if you have not already.';
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
        await fallbackPlay(s);
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
  }
}

function tryParseMove(s: Session, raw: string): { uci: string; san: string } | null {
  if (!raw) return null;
  const probe = new Chess(s.chess.fen());
  // SAN first ("Nf3", "O-O", "exd5"), then UCI ("g1f3", "e7e8q").
  try {
    const m = probe.move(raw);
    return { uci: m.from + m.to + (m.promotion ?? ''), san: m.san };
  } catch {
    /* fall through to UCI */
  }
  const uci = raw.toLowerCase().replace(/[^a-h1-8qrbn]/g, '');
  if (uci.length < 4) return null;
  try {
    const m = probe.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return { uci: m.from + m.to + (m.promotion ?? ''), san: m.san };
  } catch {
    return null;
  }
}

/** Everything down; called from app shutdown. */
export async function shutdownChess(): Promise<void> {
  for (const s of sessions.values()) {
    try { s.turnCtrl?.abort(); } catch { /* already down */ }
    clearHoldTimers(s);
    flushChatBuffer(s);
    s.queue?.dispose();
    s.queue = null;
  }
  sessions.clear();
  if (enginePromise) {
    try {
      const engine = (await enginePromise) as { dispose?: () => Promise<void> };
      await engine.dispose?.();
    } catch {
      /* already down */
    }
    enginePromise = null;
  }
}
