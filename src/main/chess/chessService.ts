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
 *   decide -> present immediately (commentary bubbles + pendingAiMove push;
 *   the sampled "human think" prethink delay was removed 260729) -> renderer
 *   reveals after its quiet gate (2s after the last utterance finishes
 *   printing/speaking) -> ack -> commit.
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
import { raiseUsageLimitPopup } from '../chat/usageLimit';
import { Chess } from 'chess.js';
import type { ChatMessage, ChatSendResult, LogBatch } from '../../shared/ipc';
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
import { playSummaryText } from '../chat/playSummary';
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import {
  splitReply,
  toMessages,
  foldUserNote,
  CHAT_ABORTED,
  isSilenceFiller,
  TRANSCRIPT_STOP_SEQUENCES,
} from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import { createPriorityQueue, Priority } from '../../bot/brain/fsm.js';
import { isCallActive } from '../voice/callState';
import { surfaceLanguage } from '../../shared/chatLanguage';
import { ensureModel, modelReady } from './modelStore';
import { getOrCreateChessProfile, type ChessProfile } from './chessProfile';
import { createChessLog, NULL_CHESS_LOG, type ChessLog } from './chessLog';

// ── deps + module state ──────────────────────────────────────────────────────

export interface ChessDeps {
  pushState: (state: ChessGameState) => void;
  pushDownload: (p: ChessDownloadProgress) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
  /**
   * Batched log delivery into the in-app developer console (same channel the
   * Minecraft bot logs ride). Optional: tests run without it.
   */
  pushLog?: (batch: LogBatch) => void;
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
  /** Human-difficulty signals from cce-1 `think` (informational; the prethink
   * delay that consumed them was removed 260729). */
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
  /** Move-turn table talk, pushed at presentation. */
  commentary: ChatMessage[];
  /** Commentary pushed + pendingAiMove published to the renderer. */
  presented: boolean;
  /** wait(): the move only wakes on player messages or idle ticks. */
  held: boolean;
  replyCycles: number;
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
  /** Per-game session log (file + in-app developer console). Never null. */
  log: ChessLog;
  /**
   * 260724 continuity: append-only game record, one line per committed ply,
   * merged into the LLM thread by timestamp alongside the chat transcript. This
   * is what makes a game ONE continuous conversation instead of a 2-ply keyhole:
   * at move 25 she can see all 24 prior moves, her own candidates each round,
   * and every word either of you said.
   *
   * Never persisted (the renderer's transcript stays chat-only) and rendered
   * deterministically, so turn N's array is a strict prefix-extension of turn
   * N-1's — which is exactly what prefix-incremental prompt caching needs.
   */
  gameLog: Array<{ ts: number; text: string }>;
  /**
   * SANs of the candidate set for the move currently being decided, folded into
   * the gameLog line when it commits ("you were considering ..., and played X").
   */
  consideredSans: string[];
  /**
   * Last macro band from the engine ("Material is even ... between 10% and 85%").
   * Kept so chat and idle turns can be told where she thinks she stands without
   * paying for a fresh Maia + Stockfish pass. One ply stale at worst, which suits
   * a character who cannot reliably tell whether she is winning.
   */
  lastMacro: string;
  /**
   * When the AI started thinking about the current move (the player's move
   * landed / warm-up concluded it moves first). Diagnostic only since 260729:
   * logged as decideLatency when the move presents. Null while not deciding.
   */
  thinkingSince: number | null;
  /**
   * Any chat rows (either side) landed during this game. An abandoned 0-move
   * game that never spoke leaves no transcript row; one that DID speak must
   * leave the "left unfinished" row, or later plain-chat turns read the stale
   * table talk as a live game.
   */
  spoke: boolean;
}

/**
 * Presentation timing. Exported and mutable for tests only; not user copy.
 * A decided move presents immediately (the sampled prethink delay was removed
 * 260729); postthink (the 2s quiet gate after the last utterance) lives
 * renderer-side in useAiMoveReveal's settle window.
 */
export const CHESS_TIMING = {
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
  if (existing) void existing.log.close().catch(() => {});

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
    log: NULL_CHESS_LOG,
    gameLog: [],
    consideredSans: [],
    lastMacro: '',
    thinkingSince: null,
    spoke: false,
  };
  try {
    s.log = await createChessLog(characterId, d.pushLog ?? (() => {}));
  } catch { /* logging is never load-bearing */ }
  s.log.line(
    `game start id=${s.gameId.slice(0, 8)} character=${characterId.slice(0, 8)} ` +
      `player=${colorName(playerColor)} ai=${colorName(playerColor === 'w' ? 'b' : 'w')} elo=${profile.elo}`,
  );
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

  // Analytics (260728): a game surface must report its own playtime, or it is
  // invisible — `minutes` used to mean Minecraft only. Lazy import so the
  // module graph (and the tests) never depend on analytics being initialized;
  // capture() is a no-op when it is not. No board state, no chat, no persona.
  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('chess_game_started', {
        character_id: characterId,
        player_color: playerColor,
        ai_elo: profile.elo,
        profile_source: profile.source,
      });
    } catch { /* analytics is never load-bearing */ }
  })();

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
  recordPly(s, false);
  s.log.line(`player move ${san} (${uci}) fen=${s.chess.fen()}`);
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
  void old.log.close().catch(() => {});
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
  void s.log.close().catch(() => {});
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
  s.spoke = true;
  s.log.line(`player chat${args.voiceCall ? ' (voice)' : ''}: ${truncateForLog(args.text)}`);

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

/** Log payload clamp: chat/LLM text lines stay readable, never unbounded. */
function truncateForLog(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/**
 * Append the just-committed ply to the append-only game record (see
 * Session.gameLog). Call immediately after history.push, from BOTH sides.
 *
 * For our own move the line also carries the candidate set we chose from, so a
 * later turn can honestly answer "why didn't you take with the other knight" —
 * the alternatives are otherwise gone the moment the turn ends.
 */
function recordPly(s: Session, mine: boolean): void {
  const i = s.history.length - 1;
  const rec = s.history[i];
  if (!rec) return;
  const prevFen = i === 0 ? undefined : s.history[i - 1].fen;
  const moveNo = Math.floor(i / 2) + 1;
  const what = describePly(prevFen, rec, mine);
  let text: string;
  if (mine) {
    const others = s.consideredSans.filter((san) => san !== rec.san);
    const considered = others.length ? ` (you were also considering ${others.join(', ')})` : '';
    text = `(game) Move ${moveNo}: you played ${what}${considered}.`;
    s.consideredSans = [];
  } else {
    text = `(game) Move ${moveNo}: they played ${what}.`;
  }
  s.gameLog.push({ ts: Date.now(), text });
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
  s.thinkingSince = Date.now();
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
      s.log.line(`move turn failed (attempt ${attempt + 1}): ${describeErr(err)}`);
      // Usage limit (260730): raise the popup, skip the retry (it would 402
      // again), and fall through to fallbackPlay — the ENGINE picks the move
      // for free, so the game stays alive and playable; after a top up the
      // next turn simply talks again. Nothing here ends the session.
      const limited = await raiseUsageLimitPopup(err);
      if (!limited && attempt === 0 && isConnectionError(err)) {
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
      void raiseUsageLimitPopup(err);
      console.warn(`[sei/chess] chat reply failed: ${describeErr(err)}`);
    }
  }
  // streamed: true — every reply line was already persisted AND pushed live
  // over the chat:message push inside runChessLlmTurn (speak()). Without the
  // flag the renderer's reveal loop re-appends result.replies on top of the
  // pushed copies, so every gameplay reply rendered twice (260721).
  for (const e of entries) e.resolve({ replies, streamed: true });

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
      void raiseUsageLimitPopup(err);
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

/** Enter the hold for a decided move. Presentation is the CALLER's job once
 * the turn's commentary is final (it used to be the prethink timer's; the
 * sampled "human think" delay was removed 260729, so the real engine + LLM
 * latency is the only wait the player sees). The cap timer still force-commits
 * an unpresented hold, so an aborted turn cannot strand the move. */
function beginHold(s: Session, move: { uci: string; san: string }, commentary: ChatMessage[]): void {
  clearHoldTimers(s);
  s.hold = {
    move,
    decidedAt: Date.now(),
    commentary,
    presented: false,
    held: false,
    replyCycles: 0,
    capTimer: null,
  };
  s.log.line(
    `decided ${move.san} (${move.uci}) ` +
      `decideLatency=${s.thinkingSince == null ? '?' : Date.now() - s.thinkingSince}ms commentaryLines=${commentary.length}`,
  );
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
  if (s.hold.capTimer) clearTimeout(s.hold.capTimer);
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
    s.spoke = true;
  }
  if (s.status !== 'active' || !s.hold || s.hold.held) return;
  s.pendingAiMove = s.hold.move;
  s.log.line(`presented ${s.hold.move.san} (pendingAiMove published, ${lines.length} commentary line(s))`);
  push(s);
}

/** Cap fired (or reply cycles ran out): land the move now, mid-conversation. */
async function forceCommit(s: Session): Promise<void> {
  if (s.status !== 'active' || !s.hold) return;
  s.log.line(`force-commit ${s.hold.move.san} (reply-cycle or wall-clock cap)`);
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
  recordPly(s, true);
  s.log.line(`ai move ${move.san} (${move.uci}) committed fen=${s.chess.fen()}`);
  clearHoldTimers(s);
  s.hold = null;
  s.pendingAiMove = null;
  s.aiThinking = false;
  s.thinkingSince = null;
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
  s.log.line(
    `game over: ${result.winner === null ? 'draw' : `${colorName(result.winner)} wins`} ` +
      `(${result.reason}) plies=${s.history.length} durationMs=${durationMs}`,
  );

  // Analytics (260728): `duration_ms` is the SHARED contract every timed
  // surface emits, so the dashboard can sum playtime across Minecraft, chess
  // and calls with one query. Fired for abandoned games too (that time was
  // still spent); `reason` distinguishes them. See the games rule in CLAUDE.md.
  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('chess_game_ended', {
        character_id: s.characterId,
        duration_ms: durationMs,
        plies: s.history.length,
        reason: result.reason,
        // 'player' | 'ai' | 'draw' — never the raw colour, which would need
        // playerColor to interpret.
        outcome: result.winner === null ? 'draw' : result.winner === s.playerColor ? 'player' : 'ai',
        ai_elo: s.profile.elo,
        spoke: s.spoke,
      });
    } catch { /* analytics is never load-bearing */ }
  })();
  // Transcript event ("You and X played chess. You won in N moves.") — same
  // shape the Minecraft/watch sessions append, rendered with the gamepad icon.
  // Abandoned games leave no row ONLY when nothing happened at all (no moves
  // AND no chat): if any table talk landed in the transcript, the closing row
  // must land too, or a later plain-chat turn reads the stale game talk as a
  // live game and resumes it ("the board's still waiting").
  if (result.reason !== 'abandoned' || s.history.length > 0 || s.spoke) {
    const plyCount = s.history.length;
    void (async () => {
      let name = 'your companion';
      let rowLanguage: 'zh' | undefined;
      try {
        const c = await getCharacter(s.characterId);
        if (c?.name) name = c.name;
        const { characterLanguage } = await import('../../shared/chatLanguage');
        if (characterLanguage(c?.metadata) === 'zh') rowLanguage = 'zh';
      } catch { /* generic name */ }
      // Replay payload: SAN/UCI only (the renderer rebuilds per-ply FENs from
      // the start position), so a long game stays a few hundred bytes in the
      // persisted transcript. Zero-move games have nothing to scrub through.
      const chess =
        s.history.length > 0
          ? {
              moves: s.history.map((h) => ({ san: h.san, uci: h.uci })),
              playerColor: s.playerColor,
              result,
              aiElo: s.profile.elo,
            }
          : undefined;
      const ev: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        text: chessSummaryText(name, s.playerColor, result, plyCount, durationMs, rowLanguage),
        ts: Date.now(),
        event: { kind: 'play', game: 'Chess', durationMs, ...(chess ? { chess } : {}) },
      } as ChatMessage;
      try {
        await chatStore.appendMessage(s.characterId, ev);
        requireDeps().pushChatMessage(s.characterId, ev);
      } catch { /* best-effort */ }
    })();
  }

  if (!opts?.silent) {
    // No mechanical memory line for the result (260725): template writes read
    // as canned next to the character's own remember() notes, and the game-over
    // reaction turn below can remember() anything actually worth keeping.
    // Let the character react to the result in chat.
    void runChessLlmTurn(s, { kind: 'game-over', voiceCall: isCallActive(s.characterId) }).catch(() => {});
  }
}

/**
 * Human-readable transcript line for a finished game (the play-row text; the
 * watch service's session summary is the copy twin). User copy: plain,
 * factual, no em dashes.
 */
export function chessSummaryText(
  name: string,
  playerColor: ChessColor,
  result: ChessResult,
  plyCount: number,
  durationMs: number,
  language?: 'en' | 'zh',
): string {
  if (result.reason === 'abandoned') {
    return language === 'zh'
      ? `你和${name}有一局国际象棋没有下完。`
      : `You and ${name} left a chess game unfinished.`;
  }
  // One shape for every game surface, results deliberately omitted: see the
  // note in src/main/chat/playSummary.ts. playerColor / result / plyCount are
  // kept in the signature because the ChessReplayData on the same row still
  // carries them for the replay card.
  void playerColor;
  void plyCount;
  return playSummaryText(name, language === 'zh' ? '国际象棋' : 'Chess', durationMs, language);
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
  // Remembered until the move commits, then folded into the gameLog line.
  s.consideredSans = out.candidates.map((c) => c.san);
  s.lastMacro = out.macro.text;
  return out;
}

async function fallbackPlay(s: Session): Promise<void> {
  const { candidates } = await candidatesFor(s);
  if (s.status !== 'active') return;
  const pick = candidates[0];
  if (!pick) throw new Error('no candidates');
  s.log.line(`fallback: playing first candidate ${pick.san} (no valid play() from the model)`);
  beginHold(s, { uci: pick.uci, san: pick.san }, []);
  await presentHold(s);
}

// ── the LLM turn ─────────────────────────────────────────────────────────────

const PLAY_TOOL = {
  name: 'play',
  description:
    'Play your chess move, or revise a move you already queued this turn. ' +
    'Give the move in standard notation (SAN like "Nf3", "exd5", "O-O", or a from-to square pair like "e2e4"). ' +
    'Pick from the candidate moves you are considering; you may try a different legal move if your character truly would, ' +
    'but your candidates already reflect how well you see the board. If the move is illegal you will be told and must try again. ' +
    'When a move is already queued, calling this with a different move changes your decision, and calling it with the same move ' +
    'releases one you were holding back. The game state above says which situation you are in. ' +
    'If you want to say any table talk, say it BEFORE calling this, in the same turn; staying silent is also fine.',
  input_schema: {
    type: 'object' as const,
    properties: {
      move: { type: 'string', description: 'The move, e.g. "Nf3" or "g1f3".' },
    },
    required: ['move'],
  },
};

const WAIT_TOOL = {
  name: 'wait',
  description:
    'Hold your queued move back instead of letting it land, for example because the player asked for a moment. ' +
    'While you hold, the game is PAUSED on your turn: the player CANNOT move or act on the board until you call play() again in a later turn. ' +
    'Use it for a short pause in the conversation, never to let the player act first (they cannot). New messages and quiet moments will remind you.',
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

/**
 * ONE tool array for every turn kind, deliberately.
 *
 * `tools` is the FIRST element of Anthropic's cache prefix (tools → system →
 * messages), so any change to it invalidates the entire cached prompt — system
 * and transcript included. Handing move turns one array and chat/idle/game-over
 * turns another meant the prefix flipped on nearly every turn: a live 15-minute
 * game logged cacheRead=0 on ~half its requests, every one of them re-billing
 * the whole persona + memory + transcript at the cache-WRITE rate.
 *
 * Which tools are actually legal right now is a per-turn fact, so it belongs in
 * the turn block (prose, in the uncached tail) and in the tool_result notes —
 * not in the tool list. An out-of-context call costs one hop and is answered
 * with a correction; a churning tool array cost several thousand tokens a turn.
 */
const CHESS_TOOLS = [
  PLAY_TOOL,
  WAIT_TOOL,
  PROPOSE_DRAW_TOOL,
  FORFEIT_TOOL,
  REMEMBER_TOOL,
] as Anthropic.Messages.Tool[];

const CHESS_MAX_HOPS = 5;
const TURN_TIMEOUT_MS = 90_000;

/**
 * A square name or a notation move anywhere in a spoken line.
 *
 * Matches, bounded so it never fires inside an ordinary word:
 *   - a bare square, "e4" / "h7";
 *   - SAN with any prefix/disambiguation/capture/promotion/check decoration,
 *     "Nf3", "exd5", "Qxd5+", "Rae1", "e8=Q#";
 *   - castling, "O-O" / "O-O-O" and the 0-0 spelling.
 * The bare-square alternative is what does most of the work: every SAN move
 * ends in a destination square, so "Nf3" is caught by its own "f3" tail.
 *
 * False positives are possible in casual texting ("b4" for "before") and are
 * accepted: the cost is one dropped bubble, and she has plenty else to say.
 * Exported for testing.
 */
const CHESS_COORD_RE =
  /(?<![A-Za-z0-9])(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[KQRBN])?[+#]?|[O0]-[O0](?:-[O0])?)(?![A-Za-z0-9])/;

export function hasChessCoordinates(text: string): boolean {
  return CHESS_COORD_RE.test(text);
}

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

/**
 * The STATIC half of the chess prompt: who is playing, the table-talk contract,
 * the chess personality. Identical for every turn of a game, so it rides in the
 * CACHED system blocks (buildSystemBlocks' extraStable) instead of being
 * re-billed 40+ times a game.
 *
 * 260724 rewrite. The old contract banned "no piece-to-square descriptions",
 * "no plans", "no analysis" on top of the notation ban, which left mood as the
 * only compliant output — and produced exactly that: 21 of 24 move turns in a
 * live game opened with a contentless "ok" / "alright" / "okay okay". Chess talk
 * is the point of the feature; the ONLY thing that actually has to go is
 * coordinates, because square names read as robotic out loud. So: encourage the
 * chess talk, ban the coordinates, and hold the line on length.
 */
function chessContractBlock(s: Session, playerName: string): string {
  const aiColor: ChessColor = s.playerColor === 'w' ? 'b' : 'w';
  const lines: string[] = [];
  lines.push('# CHESS GAME');
  lines.push(
    `You are playing a casual, untimed chess game against ${playerName} inside the Sei app. ` +
      `You are ${colorName(aiColor)}; they are ${colorName(s.playerColor)}. ` +
      'Every plain-text line you write is SPOKEN OUT LOUD at the board, exactly as written.',
  );
  lines.push(
    'TALK ABOUT THE CHESS. Real chess talk is wanted, not filler. React to what they just played, ' +
      'say what you are worried about or going for, call the position how you see it, needle them, complain, gloat, ' +
      'ask how a rule works if you genuinely do not know. Pieces, threats, trades, attacks, king safety, who is ahead: ' +
      'all fair game, in ordinary spoken words. "your knight has been annoying me all game", "i think i\'m getting squeezed", ' +
      '"you really just gave me that rook", "this is going badly for me and i know it".',
  );
  lines.push(
    'NEVER SAY COORDINATES OR NOTATION. This is the one hard rule. No square names and no move notation, ever: ' +
      'not "e4", not "Nf3", not "exd5", not "O-O", not "the pawn on d5". People say these out loud only in a chess club, ' +
      'and you are not in one. Point at pieces the way a person does instead: "your bishop", "that knight you just moved", ' +
      '"the pawn in front of your king", "the rook in the corner". A line containing a square or a notation move is ' +
      'THROWN AWAY and never reaches them, so the thought is simply lost. Say it in words.',
  );
  lines.push(
    'KEEP IT SHORT. One line, the length of a text message. A second line only if it genuinely earns its place. ' +
      'Never open with "ok", "okay", "alright", "well", "lmao ok", or any variant, and never narrate that you are thinking ' +
      '("let me think", "lemme just", "here goes", "alright let\'s see"). If you have nothing specific to say about the ' +
      'position or about them, say NOTHING at all. Silence at a chess board is normal and common; a comment on every ' +
      'single move is not.',
  );
  lines.push(
    'Do not announce the move you are about to play or are holding: the board shows it by itself, and a real player ' +
      'does not narrate their own moves. Do not write analysis or notes to self ("I am reading the board state", ' +
      '"I calculate..."). If you would not say it out loud across the table, do not write it. ' +
      `Write ONLY your own lines: never dialogue or moves for ${playerName}, never "Human:" / "Player:" lines, ` +
      'never bracketed stage directions like "(it is your turn to move)". The app narrates the game and prompts each turn.',
  );
  if (s.profile.styleNote) lines.push(`Your chess personality: ${s.profile.styleNote}`);
  return lines.join('\n\n');
}

/**
 * The VOLATILE half: what is true on the board right now, and what this turn is
 * for. Appended as the LAST user message (after the cache breakpoint), never to
 * the system array — see BuildSystemArgs.extraStable for why that matters.
 */
async function buildChessTurnBlock(
  s: Session,
  kind: TurnKind,
  playerName: string,
  quietSec?: number,
): Promise<string> {
  const aiColor: ChessColor = s.playerColor === 'w' ? 'b' : 'w';
  const lines: string[] = [];

  if (kind === 'game-over' && s.result) {
    const r = s.result;
    const outcome =
      r.winner === null
        ? `The game just ended in a draw (${r.reason.replace('draw-', '')}).`
        : r.winner === aiColor
          ? `You just WON (${r.reason === 'resign' ? `${playerName} resigned` : r.reason}).`
          : `You just LOST (${r.reason === 'forfeit' ? 'you resigned' : r.reason}).`;
    lines.push(outcome);
    lines.push(
      'React to the result in ONE short line, two at the very most, in character. ' +
        'Say something about how the game actually went, not a generic sign-off. No tools this turn.',
    );
    return lines.join('\n\n');
  }

  // Ground truth about what just happened on the board. Translated sentences,
  // never raw notation: the model must not have to parse SAN to know what the
  // player did (that is how commentary starts hallucinating moves).
  //
  // The FULL game is already above as "(game) Move N: ..." lines in the thread,
  // so this is only the immediate delta — what changed since it last looked up.
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
  // How the game feels to HER, on every turn kind — not just when she is moving.
  // This band is deliberately wide (cce-1 bandHalfWidth at her Elo): she cannot
  // actually tell how she is doing, and that uncertainty is what her confidence
  // is built on. It has to be present on chat and idle turns too, or she talks
  // about the game with no sense of whether she is winning it.
  if (kind !== 'move' && s.lastMacro) {
    lines.push(`Where you think you stand: ${s.lastMacro}`);
  }

  const holdLines = (): void => {
    if (!s.hold) return;
    if (s.hold.held) {
      lines.push(
        `Game state: it is YOUR turn, and you are HOLDING your move back (you called wait()). Your chosen move (${s.hold.move.san}) has NOT been played; nothing is on the board yet. ` +
          `While you hold, the game is PAUSED: ${playerName} CANNOT move, respond on the board, or do anything at all until your move lands. Holding never lets them act first; chess does not work that way. ` +
          `If ${playerName} asks you to move, says it is your turn, or wants the game to continue, call play() NOW (same move or a different one). ` +
          'Keep waiting only if the pause itself is still what they want. Never tell them to play or to move: they cannot until you do. Do not say your held move in chat.',
      );
    } else {
      lines.push(
        `Game state: it is YOUR turn and your move is already chosen (${s.hold.move.san}). It has not appeared on the board yet, but it lands BY ITSELF moments after this conversation goes quiet; you do not need to do anything. ` +
          'To change your decision, call play() again with your new move. ' +
          `If ${playerName} asks you to hold on, or you want to keep it back for now, call wait(). Do not announce the move in chat; the board will show it.`,
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
            ? `Game state: it is ${playerName}'s move. Your last move is already on the board and nothing of yours is pending or held. Reply to their message.`
            : 'Game state: it is YOUR move, but first just reply to their message; you will pick your move right after.',
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
        'A message is OPTIONAL here, and most of the time the right answer is none. Say something only if you have ONE ' +
          'specific line worth saying out loud right now: something about the position, something about them, a needle, ' +
          'a real mood. If it would be filler, reply with nothing at all.',
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
      'That range is genuinely how much you can tell: you are not able to work out whether you are winning, ' +
      'so let it set how confident you sound rather than quoting it. ' +
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
    'The moves you are considering, and roughly how each one plays out in your head:\n' +
      candText +
      '\n\nThese are HUNCHES, not calculations, and the lines you imagine are how YOU picture it going, ' +
      'not what will actually happen. There is no score attached to any of them and you cannot work out which is best. ' +
      'Pick the one that feels most like you: the exciting one, the greedy one, the safe one, whatever fits your mood ' +
      'and how the game has been going. Do not try to reason out the strongest move; you are not able to.',
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
    'Table talk is OPTIONAL this turn and most moves deserve none: just call play() and say nothing. ' +
      'Speak only if THEIR last move or the state of the game gives you something specific to say, and then it is ONE ' +
      'short line as plain text BEFORE calling play(). ' +
      'Never reveal or describe the move you are about to play: the board announces it for you.',
  );
  return lines.join('\n\n');
}

/**
 * One continuous conversation for the whole game: the persisted chat transcript
 * and the append-only game record (Session.gameLog), merged by timestamp.
 *
 * Both inputs only ever grow at the end and both carry real wall-clock stamps,
 * so the merged array is append-only too — turn N's rendering of rows 1..k is
 * byte-identical to turn N-1's. That is the property prefix-incremental prompt
 * caching needs, and it is why nothing here may be rewritten retroactively.
 *
 * Game rows ride as `user` turns (the same shape toMessages already gives play
 * rows), so consecutive game lines and player messages fold into one turn.
 */
function buildGameThread(s: Session, history: ChatMessage[]): ChatMessage[] {
  if (s.gameLog.length === 0) return history;
  const rows: ChatMessage[] = [
    ...history,
    ...s.gameLog.map((g) => ({ id: `ply-${g.ts}`, role: 'user' as const, text: g.text, ts: g.ts })),
  ];
  // Stable sort: on an exact tie the chat line keeps its place before the ply.
  return rows.sort((a, b) => a.ts - b.ts);
}

async function readMemoryTail(id: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(id), 'MEMORY.md'), 'utf8');
    // Mirrors chatService's MEMORY_BUDGET_BYTES (260725: 6000 -> 12000).
    // 260725: stamps render local-time for the model, exactly as chatService's
    // readMemoryTail and the bot's readMemoryForSeed do. buildSystemBlocks now
    // tells the model to date each note against today's local clock, so raw UTC
    // ISO stamps here made table talk misdate shared memories.
    return humanizeMemoryStamps(raw.length <= 12000 ? raw : raw.slice(-12000));
  } catch {
    return '';
  }
}

/**
 * Run one chess LLM turn. kind:
 *   'move'       — it is the AI's move: optional commentary + the play/draw/
 *                  forfeit loop. Commentary is BUFFERED into the hold and
 *                  presents with the move as soon as the turn loop ends.
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
  const [{ summary, history }, memory, knowledge] = await Promise.all([
    readChatContext(s.characterId),
    readMemoryTail(s.characterId),
    readKnowledgeForPrompt(s.characterId).catch(() => ''),
  ]);
  const quietSec = (Date.now() - s.lastActivityAt) / 1000;

  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness: 1,
    // Not the Discord-like chat surface: live game, board/canvas beside chat.
    surface: 'game',
    punctuation: character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual',
    memory,
    summary,
    knowledge,
    openWorldDetected: false,
    inGame: false,
    voiceCall: opts.voiceCall,
    // 260730: character-pinned language wins over the auto-detected one.
    language: surfaceLanguage(character.metadata, config.chat_language),
    // STATIC for the whole game, so it rides inside the cached region. The
    // volatile per-turn view goes in the messages tail below, never here.
    extraStable: chessContractBlock(s, playerName),
  } as Parameters<typeof buildSystemBlocks>[0]);
  const turnBlock = await buildChessTurnBlock(s, opts.kind, playerName, quietSec);

  // Per-turn session log: the compact context that was sent, every hop's
  // output and tool traffic, what was spoken vs suppressed, and timing. One
  // multi-line [chess:turn] event per LLM turn in file + dev console.
  const turnT0 = Date.now();
  const turnLog: string[] = [
    `kind=${opts.kind} voiceCall=${opts.voiceCall} historyMsgs=${history.length} plies=${s.gameLog.length}`,
    '--- chess turn block sent ---',
    turnBlock,
    '--- turn ---',
  ];

  // 260724: the whole game as one conversation. No slice() — the transcript and
  // the move record both ride in full, so at move 25 she can still see move 3,
  // what she was considering at the time, and everything either of you said.
  // The growth is ~110 tokens a ply and it is all cache reads; the previous
  // 30-message keyhole was both blinder AND more expensive (see below).
  const messages = toMessages(buildGameThread(s, history));

  // Cache breakpoint at the end of the STABLE prefix, then the volatile turn
  // block folded on after it. Order matters and is the whole point:
  //   tools (fixed) → system (fixed + persona/memory/summary) → thread ...★... turn block
  // Everything up to ★ is byte-identical to last turn, so it is a cache READ.
  // The turn block changes every turn, so it must sit AFTER the mark; when the
  // thread already ends on a user turn the block folds into it (Anthropic wants
  // alternating roles) and the mark moves one turn back, which costs only that
  // trailing user turn.
  const endsOnUser = messages.length > 0 && messages[messages.length - 1].role === 'user';
  markLastMessageCached(endsOnUser ? messages.slice(0, -1) : messages);
  foldUserNote(messages, turnBlock);

  const ctrl = new AbortController();
  s.turnCtrl = ctrl;
  const seq = s.turnSeq;
  const stale = (): boolean => s.turnSeq !== seq || ctrl.signal.aborted;
  const timeout = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);

  // Fixed for every turn kind — see CHESS_TOOLS. Which ones are legal right now
  // is stated in the turn block instead, where it costs nothing to vary.
  const tools = CHESS_TOOLS;

  // Move-turn table talk presents together with the move at the end of the
  // turn loop; everything else speaks immediately.
  const deferSpeech = opts.kind === 'move';
  // Backstop for the "keep it short" contract: a turn may not spill more than a
  // couple of bubbles no matter what the model does. A live game-over turn wrote
  // five lines against a prompt asking for one or two.
  const maxParts = opts.kind === 'chat-reply' ? 3 : 2;
  const spoken: ChatMessage[] = [];
  const speak = async (text: string): Promise<void> => {
    for (const part of splitReply(text, character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual')) {
      // Silence sentinel drop (260721): the idle/move prompts sanction saying
      // nothing, and models act that out by WRITING "(silence)"-style fillers
      // instead of staying quiet (a live chess idle tick persisted a literal
      // "(silence)" chat row). A sentinel part is no message at all: not
      // persisted, not pushed. Applies to every turn kind; unlike typed plain
      // chat, the game prompts sanction silence throughout the session.
      if (!part) continue;
      if (isSilenceFiller(part)) {
        turnLog.push(`suppressed (silence sentinel): ${truncateForLog(part, 120)}`);
        continue;
      }
      // Coordinates are the one hard ban in the table-talk contract, and prose
      // alone does not hold it: a live game had her say a bare "c6" out loud on
      // move 1 and the player had to correct her in-game. Squares and notation
      // read as robotic aloud, so a line carrying them is dropped rather than
      // mangled — everything else about the chess is encouraged.
      if (hasChessCoordinates(part)) {
        turnLog.push(`suppressed (coordinates in spoken line): ${truncateForLog(part, 120)}`);
        continue;
      }
      if (spoken.length >= maxParts) {
        turnLog.push(`suppressed (over ${maxParts}-line cap): ${truncateForLog(part, 120)}`);
        continue;
      }
      turnLog.push(`say${deferSpeech ? ' (buffered until present)' : ''}: ${truncateForLog(part)}`);
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
      s.spoke = true;
    }
  };

  // Set when a hold-turn released a held move (play() after wait()); the
  // presentation restarts after the reply finishes.
  let presentAfterTurn = false;

  try {
    const { client, model } = await buildChatSdk();
    let played = false;

    for (let hop = 0; hop < CHESS_MAX_HOPS && !stale(); hop++) {
      // stop_sequences (260722): the model may not continue the transcript
      // past its own turn. A live voice-call game had a chat-reply turn keep
      // writing — a fabricated player line ("Human: ... *plays Nc6*") plus an
      // invented "(it is your turn)" direction — and speak() faithfully
      // persisted and TTS'd all of it. Cutting generation at the other side's
      // line-start markers means the leak text is never produced at all.
      const res = await client.messages.create(
        {
          model,
          // Short by construction, not just by instruction: with a generous
          // ceiling the model self-conditions on its own longest prior turn and
          // creeps up a line each round (same failure the chat path caps at 200).
          max_tokens: 160,
          system,
          tools,
          stop_sequences: TRANSCRIPT_STOP_SEQUENCES,
          messages: messages as never,
        },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const u = res.usage;
      console.log(
        `[sei/chess] turn char=${s.characterId.slice(0, 8)} kind=${opts.kind} hop=${hop} ` +
          `in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
      );
      turnLog.push(
        `hop=${hop} in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
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
            note = `You play ${picked.san}. It will land on the board in a moment; do not call play() again this turn, and do not announce the move in chat.`;
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
              note = `You will play ${picked.san}. It lands once this exchange goes quiet. Do not announce the move in chat.`;
            } else {
              note = changed
                ? `Your queued move is now ${picked.san}. Do not announce it in chat.`
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
              // 260725: 0 means the bounded duplicate guard skipped the write.
              // Same honesty fix as the game brain and chat surfaces.
              const written = await appendMemory(
                path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
                memText,
              );
              note =
                written === 0
                  ? 'You already saved that a moment ago; nothing new was written. Continue.'
                  : 'Saved. Continue; do not mention saving it.';
            } catch {
              note = 'Could not save it. Continue.';
            }
          } else {
            note = 'Nothing saved; the text was empty.';
          }
        } else {
          note = `The tool "${tu.name}" is not available right now.`;
        }
        turnLog.push(`tool: ${tu.name}(${truncateForLog(JSON.stringify(tu.input ?? {}), 200)})`);
        turnLog.push(`  -> ${truncateForLog(note, 300)}`);
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
        // Attach the buffered table talk to the hold and present right away
        // (260729: no prethink delay — commentary is final once the loop ends).
        s.hold.commentary = spoken.slice();
        await presentHold(s);
      }
    } else if (presentAfterTurn) {
      await presentHold(s);
    }

    void foldIfDue(s.characterId, character.persona.expanded).catch(() => {});
    return spoken;
  } catch (err) {
    if (ctrl.signal.aborted || s.turnSeq !== seq) {
      turnLog.push('aborted (superseded or timed out)');
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }
    turnLog.push(`error: ${describeErr(err)}`);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (s.turnCtrl === ctrl) s.turnCtrl = null;
    turnLog.push(`total=${Date.now() - turnT0}ms spokenParts=${spoken.length}`);
    s.log.block('turn', turnLog.join('\n'));
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
    if (s.status !== 'ended') {
      // App closing mid-game: end it as abandoned (silent = no memory line,
      // no reaction turn) so the transcript still records the unfinished
      // game, same as shutdownWatch. Best-effort: the append races app exit.
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    } else {
      // Already ended; a game-over reaction turn may still be in flight.
      try { s.turnCtrl?.abort(); } catch { /* already down */ }
      clearHoldTimers(s);
      flushChatBuffer(s);
      s.queue?.dispose();
      s.queue = null;
    }
    void s.log.close().catch(() => {});
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
