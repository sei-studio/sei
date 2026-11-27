/**
 * Fleet Battle minigame service (main process, internal id BATTLESHIP):
 * authoritative game state + the character's own turns.
 *
 * Two 10x10 grids per character (player + character), five ships each. The
 * game opens in `preparing`: the player places their fleet (placeFleet) while
 * the character places its own with ONE `place_fleet` tool call, validated by
 * the rules (fleetProblem) and retried like a move. The battle opens once both
 * fleets are ready; then the two alternate shots and the first to sink every
 * opposing ship wins.
 *
 * The character plays for real (261127 rewrite, docs/agents/battleship.md):
 *   - every shot is its own `fire(cell)` call ("B7", as the board labels
 *     cells) through the shared board-game turn runner
 *     (src/main/minigames/boardTurn.ts): persona, memory and chat history in
 *     the prompt like chess, tool results as real tool_result blocks;
 *   - the engine only enforces the rules. It never shoots or places ships for
 *     the character: a rejected call goes back as a tool error, a failed turn
 *     is retried (MOVE_ATTEMPTS), and after that the game stops in
 *     `aiTurnFailed` until the player presses Try again;
 *   - plain text it writes is table talk, spoken like chess, landing together
 *     with the shot.
 *
 * Turns run on one fsm.js priority queue per session, single-flight like
 * chess: P1 player chat, P2 the character's placement or shot. No idle
 * chatter. Each turn carries a token, so a shot from a stale turn can never
 * land during the player's turn.
 *
 * Mutually exclusive with Minecraft summon via deps.isSummoned.
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type {
  BATTLESHIPGameState,
  BATTLESHIPGrid,
  BATTLESHIPGameStatus,
  BATTLESHIPPlacement,
  BATTLESHIPResult,
  BATTLESHIPShip,
  BATTLESHIPShipName,
  BATTLESHIPShotRecord,
} from '../../shared/battleshipIpc';
import {
  BATTLESHIP_ERR_MC_ACTIVE,
  BATTLESHIP_SHIP_NAMES,
  SHIP_SIZES,
  battleshipCellName,
  fleetProblem,
  parseBattleshipCell,
  placementCells,
  randomFleetPlacement,
} from '../../shared/battleshipIpc';
import type { MinigameTurnFailure } from '../../shared/minigameTurn';
import { loadAnalytics } from '../lazyAnalytics';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { isCallActive } from '../voice/callState';
import { foldIfDue } from '../chat/continuity';
import { REMEMBER_TOOL, clockNow } from '../chat/chatPrompts';
import { CHAT_ABORTED } from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { raiseUsageLimitPopup } from '../chat/usageLimit';
import { companionLanguageFor } from '../companionLanguage';
import { playSummaryText } from '../chat/playSummary';
import { createPriorityQueue, Priority } from '../../bot/brain/fsm.js';
import {
  runBoardTurn,
  runWithAttempts,
  alreadyMovedResult,
  SAY_PROPERTY,
  chatReplyRule,
  unansweredNote,
  type BoardToolUse,
  type BoardTurnArgs,
  type BoardTurnKind,
  type ToolOutcome,
} from '../minigames/boardTurn';

const ROWS = 10;
const COLS = 10;

/** User-facing and model-facing name (never the trademarked one). */
export const BATTLESHIP_GAME_NAME = 'Fleet Battle';
const BATTLESHIP_GAME_NAME_ZH = '舰队对战';

const MAX_HOPS = 4;
/** Room for a little private working-out, one line of talk and the tool call. */
const SHOT_MAX_TOKENS = 700;
/** Five ships of JSON, some private working-out and a line of talk. */
const PLACE_MAX_TOKENS = 1000;
const NO_IDLE_MS = 2_000_000_000;
/** How many of its own recent move lines the turn block shows it. */
const RECENT_LINES = 4;

const sessions = new Map<string, Session>();
let deps: BATTLESHIPDeps | null = null;
let providerOverride: BoardTurnArgs['provider'];
let sleepOverride: ((ms: number) => Promise<void>) | undefined;
let randomOverride: (() => number) | undefined;

export interface BATTLESHIPDeps {
  pushState: (state: BATTLESHIPGameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

export interface BATTLESHIPStartOpts {
  playerStarts?: boolean;
}

interface Queue {
  enqueue: (priority: number, event: string, data?: unknown) => void;
  dispose: () => void;
}

type AiTurnKind = 'place' | 'shot';

interface Session {
  gameId: string;
  characterId: string;
  playerGrid: BATTLESHIPGrid;     // player's own ships (the character shoots here)
  aiGrid: BATTLESHIPGrid;          // the character's ships (hidden from the renderer)
  aiVisibleGrid: BATTLESHIPGrid;   // player's view of the character's board
  turn: 'player' | 'ai';
  status: BATTLESHIPGameStatus;
  playerStarts: boolean;
  playerFleetPlaced: boolean;
  aiFleet: 'placing' | 'ready' | 'failed';
  aiThinking: boolean;
  result: BATTLESHIPResult | null;
  history: BATTLESHIPShotRecord[];
  playerShots: number;
  aiShots: number;
  startedAt: number;
  battleStartedAt: number | null;
  lastActivityAt: number;
  turnCtrl: AbortController | null;
  /** The game-over reaction's LLM call (aborted when the session goes away). */
  reactionCtrl: AbortController | null;
  /** Bumped when the game ends: every turn begun before is stale. */
  turnSeq: number;
  /** Bumped per character turn (placement or shot). */
  moveToken: number;
  /** The moveToken whose move is on the board (a retry never moves twice). */
  appliedToken: number;
  /** The character said a line with its previous move (turn-block nudge toward quiet moves). */
  talkedLastMove: boolean;
  /** The last few lines said with its moves, shown back to it so it does not repeat them. */
  recentLines: string[];
  aiTurnFailed: MinigameTurnFailure | null;
  creditQuiet: boolean;
  spoke: boolean;
  clock: string;
  gameLog: Array<{ ts: number; text: string }>;
  queue: Queue | null;
  /** Player lines waiting for ONE coalesced reply (id + text: the reply quotes them). */
  chatBuffer: Array<{ id: string; text: string; voiceCall: boolean; resolve: (r: ChatSendResult) => void }>;
  /** Per-game variety nudge for the placement turn (placementLean). */
  placeLean: string;
  /** Per-game opening-region nudge for the first shot (openingLean). */
  openingLean: string;
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

export function initBATTLESHIPService(d: BATTLESHIPDeps): void {
  deps = d;
}

function requireDeps(): BATTLESHIPDeps {
  if (!deps) throw new Error('Fleet Battle service not initialized');
  return deps;
}

function emptyGrid(): BATTLESHIPGrid {
  return {
    cells: Array.from({ length: ROWS }, () => Array(COLS).fill('empty')),
    ships: [],
  };
}

function applyFleet(grid: BATTLESHIPGrid, fleet: ReadonlyArray<BATTLESHIPPlacement>): void {
  grid.ships = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) grid.cells[r][c] = 'empty';
  }
  for (const placement of fleet) {
    const cells = placementCells(placement);
    for (const cell of cells) grid.cells[cell.row][cell.col] = 'ship';
    grid.ships.push({ name: placement.name, size: SHIP_SIZES[placement.name], cells, sunk: false });
  }
}

function cloneGrid(grid: BATTLESHIPGrid): BATTLESHIPGrid {
  return {
    cells: grid.cells.map((row) => row.slice()),
    ships: grid.ships.map((sh) => ({ ...sh, cells: sh.cells.map((c) => ({ ...c })) })),
  };
}

function snapshot(s: Session): BATTLESHIPGameState {
  const aiVisible = cloneGrid(s.aiVisibleGrid);
  // The character's ships are revealed only once the game is over.
  aiVisible.ships = s.status === 'ended' ? cloneGrid(s.aiGrid).ships : [];
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    playerGrid: cloneGrid(s.playerGrid),
    aiVisibleGrid: aiVisible,
    turn: s.turn,
    aiThinking: s.aiThinking,
    pendingAiMove: null,
    result: s.result,
    history: s.history.map((h) => ({ ...h })),
    shotsFired: s.playerShots + s.aiShots,
    playerShots: s.playerShots,
    aiShots: s.aiShots,
    playerStarts: s.playerStarts,
    playerFleetPlaced: s.playerFleetPlaced,
    aiFleet: s.aiFleet,
    aiTurnFailed: s.aiTurnFailed,
  };
}

function push(s: Session): BATTLESHIPGameState {
  const state = snapshot(s);
  // A dead window must never be able to throw into a turn.
  try {
    requireDeps().pushState(state);
  } catch { /* window gone; the next getState reconciles */ }
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
      captureSurfaceError('battleship', cls, characterId);
    } catch { /* analytics is never load-bearing */ }
  })();
}

// ── public api (wired to IPC handlers) ───────────────────────────────────────

export function isBATTLESHIPActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getBATTLESHIPState(characterId: string): BATTLESHIPGameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startBATTLESHIP(
  characterId: string,
  opts?: BATTLESHIPStartOpts & { rematch?: boolean },
): Promise<BATTLESHIPGameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${BATTLESHIP_ERR_MC_ACTIVE}: disconnect the Minecraft session to play ${BATTLESHIP_GAME_NAME}`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') {
    return snapshot(existing);
  }
  const startGuard = beginSessionStart();
  // A new game over a finished one is a rematch, whichever button started it.
  const isRematch = opts?.rematch === true || !!existing;
  if (existing) dropSession(existing);

  const playerStarts = opts?.playerStarts ?? true;
  const rand = randomOverride ?? Math.random;
  const s: Session = {
    gameId: randomUUID(),
    characterId,
    playerGrid: emptyGrid(),
    aiGrid: emptyGrid(),
    aiVisibleGrid: emptyGrid(),
    turn: playerStarts ? 'player' : 'ai',
    status: 'preparing',
    playerStarts,
    playerFleetPlaced: false,
    aiFleet: 'placing',
    aiThinking: false,
    result: null,
    history: [],
    playerShots: 0,
    aiShots: 0,
    startedAt: Date.now(),
    battleStartedAt: null,
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
    placeLean: placementLean(rand),
    openingLean: openingLean(rand),
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

  capture('battleship_game_started', {
    character_id: characterId,
    player_starts: playerStarts,
    rematch: isRematch,
  });

  // The character places its own fleet while the player places theirs.
  enqueueAiTurn(s);
  return snapshot(s);
}

/**
 * Confirm the player's own fleet. `ships` is the fleet the renderer drew (all
 * five ships); `null` means "place it randomly" (the player's Random button).
 * The battle opens once the character's fleet is ready too.
 */
export async function placeFleet(
  characterId: string,
  ships: BATTLESHIPPlacement[] | null,
): Promise<BATTLESHIPGameState> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'preparing' || s.playerFleetPlaced) {
    throw new Error(`no ${BATTLESHIP_GAME_NAME} game is waiting for your ships`);
  }
  const fleet = ships ?? randomFleetPlacement();
  const problem = fleetProblem(fleet);
  if (problem) throw new Error(`invalid ${BATTLESHIP_GAME_NAME} fleet: ${problem}`);

  applyFleet(s.playerGrid, fleet);
  s.playerFleetPlaced = true;
  s.lastActivityAt = Date.now();
  capture('battleship_fleet_placed', {
    character_id: s.characterId,
    by: 'player',
    random: ships === null,
    ms_since_start: Date.now() - s.startedAt,
  });
  maybeBeginBattle(s);
  push(s);
  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  row: number,
  col: number,
): Promise<{ ok: boolean; error?: string; state: BATTLESHIPGameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error(`no active ${BATTLESHIP_GAME_NAME} game`);
  }
  if (s.aiThinking || s.turn !== 'player') {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
    return { ok: false, error: 'out of bounds', state: snapshot(s) };
  }
  if (s.aiVisibleGrid.cells[row][col] !== 'empty') {
    return { ok: false, error: 'already fired there', state: snapshot(s) };
  }
  applyShot(s, 'player', row, col);
  noteFirstMove(s, 'player');
  if (allShipsSunk(s.aiGrid)) {
    endSession(s, { winner: 'player', reason: 'all-ships-sunk' });
    return { ok: true, state: snapshot(s) };
  }
  s.turn = 'ai';
  enqueueAiTurn(s);
  return { ok: true, state: snapshot(s) };
}

/** Give up. Allowed during placement too (the game simply ends). */
export async function resign(characterId: string): Promise<BATTLESHIPGameState> {
  const s = sessions.get(characterId);
  if (!s || s.status === 'ended') throw new Error(`no ${BATTLESHIP_GAME_NAME} game to resign`);
  endSession(s, { winner: 'ai', reason: 'resign' });
  return snapshot(s);
}

/** New game against the same character; the other side fires first this time. */
export async function rematch(characterId: string): Promise<BATTLESHIPGameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  return startBATTLESHIP(characterId, { playerStarts: !old.playerStarts, rematch: true });
}

/** Try again after a failed character turn (placement or shot). */
export async function retryAiTurn(characterId: string): Promise<BATTLESHIPGameState> {
  const s = sessions.get(characterId);
  if (!s || s.status === 'ended') throw new Error(`no ${BATTLESHIP_GAME_NAME} game`);
  if (!s.aiTurnFailed || s.aiThinking || !aiTurnKind(s)) return snapshot(s);
  s.stats.retryClicks++;
  capture('battleship_turn_retry', {
    character_id: s.characterId,
    reason: s.aiTurnFailed.reason,
    turn_kind: aiTurnKind(s),
  });
  s.creditQuiet = false;
  if (s.aiFleet === 'failed') s.aiFleet = 'placing';
  enqueueAiTurn(s);
  return snapshot(s);
}

export async function endBATTLESHIP(characterId: string): Promise<void> {
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

// ── turn flow ────────────────────────────────────────────────────────────────

/** What the character owes right now, or null when it is not its turn. */
function aiTurnKind(s: Session): AiTurnKind | null {
  if (s.status === 'preparing' && s.aiFleet !== 'ready') return 'place';
  if (s.status === 'active' && s.turn === 'ai') return 'shot';
  return null;
}

function maybeBeginBattle(s: Session): void {
  if (s.status !== 'preparing' || !s.playerFleetPlaced || s.aiFleet !== 'ready') return;
  s.status = 'active';
  s.battleStartedAt = Date.now();
  s.turn = s.playerStarts ? 'player' : 'ai';
  s.gameLog.push({
    ts: Date.now(),
    text: `(game) Both fleets are placed. The battle starts; ${s.playerStarts ? 'they fire' : 'you fire'} first.`,
  });
  if (s.turn === 'ai') enqueueAiTurn(s);
}

function enqueueAiTurn(s: Session): void {
  if (!aiTurnKind(s) || s.aiThinking) return;
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
  if (event === 'sei:your_move') await dispatchAiTurn(s, data?.token ?? -1);
  else if (event === 'sei:chat_received') await dispatchChat(s);
  // sei:idle never does anything here: no idle chatter at the board.
}

function aiTurnLive(s: Session, token: number, seq: number, kind: AiTurnKind): boolean {
  return (
    sessions.get(s.characterId) === s &&
    s.turnSeq === seq &&
    s.moveToken === token &&
    aiTurnKind(s) === kind
  );
}

async function dispatchAiTurn(s: Session, token: number): Promise<void> {
  const seq = s.turnSeq;
  const kind = aiTurnKind(s);
  if (!kind || !aiTurnLive(s, token, seq, kind)) return;
  const voiceCall = isCallActive(s.characterId);
  const live = (): boolean => aiTurnLive(s, token, seq, kind);
  const outcome = await runWithAttempts({
    isLive: live,
    onUsageLimit: (err) => raiseUsageLimitPopup(err, 'battleship'),
    onAttemptError: (i, err, cls) => {
      console.error(`[sei/battleship] ${kind} turn failed (attempt ${i + 1}, ${cls}): ${describeErr(err)}`);
      captureError(s.characterId, `${kind === 'place' ? 'place' : 'move'}_turn_${cls}`);
    },
    sleep: sleepOverride,
    attempt: async (_i, retryNote) => {
      if (s.appliedToken === token) return alreadyMovedResult();
      try {
        // Inside the attempt: a config read that throws is a failed attempt
        // (retried, then Try again), never a turn stuck on "thinking".
        const contract = await contractBlock(s);
        const r = await runBoardTurn({
          surface: 'battleship',
          characterId: s.characterId,
          kind: kind === 'place' ? 'place' : 'move',
          contract,
          turnBlock: turnBlock(s, kind === 'place' ? 'place' : 'move', retryNote),
          gameLog: s.gameLog,
          clock: s.clock,
          tools: BATTLESHIP_TOOLS,
          voiceCall,
          maxHops: MAX_HOPS,
          maxTokens: kind === 'place' ? PLACE_MAX_TOKENS : SHOT_MAX_TOKENS,
          isStale: () => !live(),
          onTool: (tu) => (kind === 'place' ? onPlaceTool(s, tu, live) : onFireTool(s, tu, live)),
          noMoveNudge:
            kind === 'place'
              ? 'Your ships are not placed yet. Call place_fleet() with all five ships now.'
              : 'You have not fired yet. Call fire() with the cell now.',
          registerAbort: (ctrl, done) => registerAbort(s, ctrl, done),
          pushChatMessage: requireDeps().pushChatMessage,
          provider: providerOverride,
        });
        if (r.spoken.length) s.spoke = true;
        return r;
      } catch (err) {
        // The move landed and something after it threw: the turn is done.
        if (s.appliedToken === token && live()) return alreadyMovedResult();
        throw err;
      }
    },
  });

  if (outcome.kind === 'aborted') {
    if (s.moveToken === token && s.status !== 'ended' && s.aiThinking) {
      s.aiThinking = false;
      // Aborted while the turn still stands (nothing superseded it): offer
      // Try again rather than leave the game waiting on nobody.
      if (live()) {
        if (kind === 'place') s.aiFleet = 'failed';
        s.aiTurnFailed = { reason: 'no_move', attempts: 1 };
      }
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
    s.aiThinking = false;
    if (kind === 'place') {
      s.aiFleet = 'ready';
      maybeBeginBattle(s);
      push(s);
    } else if (allShipsSunk(s.playerGrid)) {
      endSession(s, { winner: 'ai', reason: 'all-ships-sunk' });
    } else {
      s.turn = 'player';
      push(s);
    }
    return;
  }
  // Every attempt failed: stop in a clear state. Never an engine move.
  s.stats.retries += outcome.failure.attempts - 1;
  s.stats.failedTurns++;
  if (outcome.failure.reason === 'credit_wall') s.creditQuiet = true;
  if (kind === 'place') s.aiFleet = 'failed';
  s.aiThinking = false;
  s.aiTurnFailed = outcome.failure;
  push(s);
  console.error(
    `[sei/battleship] character could not finish its ${kind}: ${outcome.failure.reason} after ${outcome.failure.attempts} attempt(s)`,
  );
  capture('battleship_turn_failed', {
    character_id: s.characterId,
    turn_kind: kind,
    reason: outcome.failure.reason,
    attempts: outcome.failure.attempts,
    error_class: outcome.errorClass ?? 'none',
    shot_number: s.aiShots + 1,
  });
}

/** The character's place_fleet() call: validated, never completed for it. */
async function onPlaceTool(s: Session, tu: BoardToolUse, live: () => boolean): Promise<ToolOutcome> {
  if (tu.name !== 'place_fleet') {
    return {
      note: `The battle has not started yet; "${tu.name}" does nothing now. Place your ships with place_fleet().`,
      isError: true,
    };
  }
  const parsed = parseFleetInput(tu.input);
  if (typeof parsed === 'string') {
    return { note: `${parsed} Call place_fleet() again with all five ships.`, isError: true, illegal: true };
  }
  const problem = fleetProblem(parsed);
  if (problem) {
    return { note: `${problem} Call place_fleet() again with all five ships.`, isError: true, illegal: true };
  }
  if (!live()) return { note: 'The game has moved on; this does nothing now.', isError: true };
  applyFleet(s.aiGrid, parsed);
  s.appliedToken = s.moveToken; // live() held: this is the turn's token
  // aiFleet turns 'ready' (and the battle may open) only once the runner
  // returns: changing it here made the turn's own stale check fire.
  // No cells here: the log rides every turn's thread, chat replies included,
  // and Haiku 5.5 read its own positions out to the player from it ("the
  // battleship's around C5 to C8", 261128 eval). Move turns show its board.
  s.gameLog.push({ ts: Date.now(), text: '(game) You placed your fleet.' });
  capture('battleship_fleet_placed', {
    character_id: s.characterId,
    by: 'ai',
    ms_since_start: Date.now() - s.startedAt,
  });
  return {
    note: s.playerFleetPlaced
      ? 'Your fleet is placed. Both fleets are ready and the battle begins.'
      : 'Your fleet is placed. Waiting for them to place theirs.',
    moved: true,
  };
}

/** The character's fire() call: rules only, never a substitute cell. */
async function onFireTool(s: Session, tu: BoardToolUse, live: () => boolean): Promise<ToolOutcome> {
  if (tu.name !== 'fire') {
    return { note: `The tool "${tu.name}" does nothing during the battle. Use fire() to shoot.`, isError: true };
  }
  const raw = (tu.input as { cell?: unknown } | undefined)?.cell;
  const cell = parseBattleshipCell(raw);
  if (!cell) {
    return {
      note: `"${String(raw)}" is not a cell. Name it by row letter A to J and column 1 to 10, like B7. Call fire() again.`,
      isError: true,
      illegal: true,
    };
  }
  const here = s.playerGrid.cells[cell.row][cell.col];
  if (here === 'hit' || here === 'miss' || here === 'sunk') {
    return {
      note: `You already fired at ${battleshipCellName(cell.row, cell.col)} (it was a ${here === 'miss' ? 'miss' : 'hit'}). Pick a cell you have not fired at and call fire() again.`,
      isError: true,
      illegal: true,
    };
  }
  if (!live()) return { note: 'It is not your turn any more; this does nothing.', isError: true };
  const shot = applyShot(s, 'ai', cell.row, cell.col);
  s.appliedToken = s.moveToken; // live() held: this is the turn's token
  noteFirstMove(s, 'ai');
  // The shot shows at once; the turn passes only after the runner returns
  // (its table talk lands first), see dispatchAiTurn.
  push(s);
  const name = battleshipCellName(cell.row, cell.col);
  const note = shot.sunkShip
    ? `${name}: hit, and you sank their ${shot.sunkShip}.${allShipsSunk(s.playerGrid) ? ' That was their last ship.' : ''}`
    : shot.hit
      ? `${name}: hit.`
      : `${name}: miss.`;
  return { note: `${note} Your shot is done for this turn.`, moved: true };
}

/** place_fleet input to placements, or a plain reason it cannot be read. */
function parseFleetInput(input: unknown): BATTLESHIPPlacement[] | string {
  const ships = (input as { ships?: unknown } | undefined)?.ships;
  if (!Array.isArray(ships)) return 'Send "ships" as a list of your five ships.';
  const out: BATTLESHIPPlacement[] = [];
  for (const raw of ships) {
    const entry = raw as { ship?: unknown; start?: unknown; direction?: unknown } | null;
    const name = String(entry?.ship ?? '').trim().toLowerCase() as BATTLESHIPShipName;
    if (!BATTLESHIP_SHIP_NAMES.includes(name)) {
      return `"${String(entry?.ship)}" is not one of your ships (${BATTLESHIP_SHIP_NAMES.join(', ')}).`;
    }
    const start = parseBattleshipCell(entry?.start);
    if (!start) return `The ${name}'s start "${String(entry?.start)}" is not a cell like B7.`;
    const dir = String(entry?.direction ?? '').trim().toLowerCase();
    if (dir !== 'right' && dir !== 'down') return `The ${name}'s direction must be "right" or "down".`;
    out.push({ name, row: start.row, col: start.col, horizontal: dir === 'right' });
  }
  return out;
}

async function dispatchChat(s: Session): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0) return;
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  let replies: ChatMessage[] = [];
  const seq = s.turnSeq;
  try {
    const r = await runBoardTurn({
      surface: 'battleship',
      characterId: s.characterId,
      kind: 'chat-reply',
      contract: await contractBlock(s),
      turnBlock: turnBlock(s, 'chat-reply', null, { playerLines: entries.map((e) => e.text), player: await playerNameOf() }),
      gameLog: s.gameLog,
      unansweredIds: entries.map((e) => e.id),
      clock: s.clock,
      tools: BATTLESHIP_TOOLS,
      voiceCall,
      maxHops: 2,
      maxTokens: SHOT_MAX_TOKENS,
      isStale: () => s.turnSeq !== seq || sessions.get(s.characterId) !== s,
      onTool: async (tu) => ({
        note:
          tu.name === 'fire' || tu.name === 'place_fleet'
            ? `${tu.name}() does nothing on a chat reply; your turn is asked for on its own. Reply in text, or say nothing.`
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
      if ((await raiseUsageLimitPopup(err, 'battleship')) === 'depleted') s.creditQuiet = true;
      console.warn(`[sei/battleship] chat reply failed: ${describeErr(err)}`);
      void (async () => {
        try {
          const { surfaceErrorClass } = await loadAnalytics();
          captureError(s.characterId, `chat_turn_${surfaceErrorClass(err)}`);
        } catch { /* analytics is never load-bearing */ }
      })();
    }
  }
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
  capture('battleship_first_move', {
    character_id: s.characterId,
    by,
    ms_since_start: Date.now() - s.startedAt,
  });
}

// ── analytics + continuity OUT ───────────────────────────────────────────────

function endSession(
  s: Session,
  result: BATTLESHIPResult,
  // `reason` overrides the analytics reason only ('account_switch', 'app_quit').
  opts?: { silent?: boolean; reason?: string },
): void {
  if (s.status === 'ended') return;
  const phase = s.status;
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
  capture('battleship_game_ended', {
    character_id: s.characterId,
    duration_ms: durationMs,
    shots: s.playerShots + s.aiShots,
    player_moves: s.playerShots,
    llm_moves: s.stats.llmMoves,
    // Always 0, kept so a dashboard can assert it: the engine never moves.
    engine_moves: 0,
    retries: s.stats.retries,
    illegal_moves: s.stats.illegal,
    failed_turns: s.stats.failedTurns,
    retry_clicks: s.stats.retryClicks,
    chat_replies: s.stats.chatReplies,
    spoke: s.spoke,
    ended_in: phase,
    reason: opts?.reason ?? result.reason,
    outcome: result.reason === 'abandoned' ? 'abandoned' : result.winner ?? 'draw',
  });

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
        text: playSummaryText(name, zh ? BATTLESHIP_GAME_NAME_ZH : BATTLESHIP_GAME_NAME, durationMs, zh ? 'zh' : undefined),
        ts: Date.now(),
        event: { kind: 'play', game: BATTLESHIP_GAME_NAME, durationMs },
      };
      try {
        await chatStore.appendMessage(s.characterId, ev);
        requireDeps().pushChatMessage(s.characterId, ev);
      } catch { /* best-effort */ }
      if (!s.creditQuiet) void foldIfDue(s.characterId, personaExpanded).catch(() => {});
    })());
  }

  if (!opts?.silent && !s.creditQuiet && result.reason !== 'abandoned') {
    void runGameOverTurn(s).catch(() => {});
  }
}

async function runGameOverTurn(s: Session): Promise<void> {
  const r = await runBoardTurn({
    surface: 'battleship',
    characterId: s.characterId,
    kind: 'game-over',
    contract: await contractBlock(s),
    turnBlock: s.result ? gameOverBlock(s, s.result, await playerNameOf()) : turnBlock(s, 'game-over', null),
    gameLog: s.gameLog,
    clock: s.clock,
    tools: BATTLESHIP_TOOLS,
    voiceCall: isCallActive(s.characterId),
    maxHops: 2,
    maxTokens: SHOT_MAX_TOKENS,
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

function shipAt(grid: BATTLESHIPGrid, row: number, col: number): BATTLESHIPShip | null {
  for (const ship of grid.ships) {
    if (ship.cells.some((cell) => cell.row === row && cell.col === col)) return ship;
  }
  return null;
}

export function allShipsSunk(grid: BATTLESHIPGrid): boolean {
  return grid.ships.length > 0 && grid.ships.every((ship) => ship.sunk);
}

/**
 * Fire at (row, col) on the target's board. The caller checked the cell was
 * not fired at before. Records the shot for both the board and the log.
 */
function applyShot(s: Session, by: 'player' | 'ai', row: number, col: number): BATTLESHIPShotRecord {
  const target = by === 'player' ? s.aiGrid : s.playerGrid;
  const view = by === 'player' ? s.aiVisibleGrid : null;
  if (by === 'player') s.playerShots++;
  else s.aiShots++;
  const ship = shipAt(target, row, col);
  let rec: BATTLESHIPShotRecord;
  if (ship) {
    target.cells[row][col] = 'hit';
    if (view) view.cells[row][col] = 'hit';
    if (ship.cells.every((c) => target.cells[c.row][c.col] === 'hit')) {
      ship.sunk = true;
      for (const c of ship.cells) {
        target.cells[c.row][c.col] = 'sunk';
        if (view) view.cells[c.row][c.col] = 'sunk';
      }
      rec = { by, row, col, hit: true, sunkShip: ship.name };
    } else {
      rec = { by, row, col, hit: true, sunkShip: null };
    }
  } else {
    target.cells[row][col] = 'miss';
    if (view) view.cells[row][col] = 'miss';
    rec = { by, row, col, hit: false, sunkShip: null };
  }
  s.history.push(rec);
  s.lastActivityAt = Date.now();
  const name = battleshipCellName(row, col);
  const what = rec.sunkShip ? `hit and sank ${by === 'ai' ? 'their' : 'your'} ${rec.sunkShip}` : rec.hit ? 'hit' : 'miss';
  s.gameLog.push({
    ts: Date.now(),
    text: by === 'ai' ? `(game) You fired at ${name}: ${what}.` : `(game) They fired at ${name}: ${what}.`,
  });
  return rec;
}

// ── prompts ──────────────────────────────────────────────────────────────────

const FIRE_TOOL = {
  name: 'fire',
  description:
    'Fire one shot at their board on your turn. Name the cell as the board labels it: row letter A to J, ' +
    'then column 1 to 10, like "B7". A cell you already fired at is not allowed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      cell: { type: 'string', description: 'The cell, like "B7" (row A-J, column 1-10).' },
      say: SAY_PROPERTY,
    },
    required: ['cell'],
  },
};

const PLACE_FLEET_TOOL = {
  name: 'place_fleet',
  description:
    'Place all five of your ships on your own board before the battle, in one call. Each ship starts at a cell ' +
    'and runs "right" (along the row) or "down" (along the column). Ships must stay on the board and must not overlap. ' +
    'Sizes: carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ships: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            ship: { type: 'string', enum: [...BATTLESHIP_SHIP_NAMES] },
            start: { type: 'string', description: 'Its first cell, like "C2" (the top or left end).' },
            direction: { type: 'string', enum: ['right', 'down'] },
          },
          required: ['ship', 'start', 'direction'],
        },
      },
      say: SAY_PROPERTY,
    },
    required: ['ships'],
  },
};

/** One fixed array for every turn kind (tools lead the cache prefix). */
const BATTLESHIP_TOOLS = [FIRE_TOOL, PLACE_FLEET_TOOL, REMEMBER_TOOL];

async function playerNameOf(): Promise<string> {
  const config = await loadConfig();
  return (config.preferred_name ?? '').trim() || 'the player';
}

async function contractBlock(_s: Session): Promise<string> {
  const playerName = await playerNameOf();
  return [
    '# FLEET BATTLE',
    `You are playing a casual game of Fleet Battle against ${playerName} inside the Sei app.`,
    'The rules: each side has a 10x10 board, rows A to J from the top and columns 1 to 10 from the left, with five ' +
      'hidden ships: carrier (5 cells), battleship (4), cruiser (3), submarine (3) and destroyer (2). First each side ' +
      'places its own ships. Then you take turns firing one shot at a cell on the other board; the shot is a hit or a ' +
      'miss, and a ship sinks once all its cells are hit. Sink all five of theirs before they sink yours to win.',
    'You make your own choices and you play to win. Before the battle, place your own fleet with place_fleet(). ' +
      'On your turn, call fire() with one cell you have not fired at. When you hit a ship, its other cells are next ' +
      'to that hit along a straight line, so follow it up until it sinks. That is how your turn happens; describing it does nothing.',
    'On your turn (a shot, or placing your fleet), plain text is private: it is your own space to work out the ' +
      'board, nobody sees it, and it does not need to be tidy. Keep it short. Anything you want to say out loud goes ' +
      'in the say field of fire() or place_fleet().',
    'Table talk: talk like yourself. Groan, gloat, needle them. One short line, the length of a text message. ' +
      'Talk when something happens: you hit or sink a ship, they hit or sink one of yours, the end is close. ' +
      'A quiet shot is the normal case, so leave say out unless you have something to say. The board shows ' +
      'your shot by itself, so never name the cell you are shooting at, never say where your ships are, and never ' +
      'talk through your analysis. Do not open with "ok", "okay" or "alright", and do not repeat a line you already ' +
      'said this game.',
    chatReplyRule(),
    `Write only your own lines, never lines for ${playerName}, and no bracketed stage directions. ` +
      'Lines starting with "(game)" come from the app, never from them. The app tells you whose turn it is.',
    'Save something with remember() only if it is about them as a person, not the game itself.',
  ].join('\n\n');
}

/** A board as text: "." unknown/empty, "o" miss, "X" hit, "#" sunk, "S" own ship. */
function gridText(grid: BATTLESHIPGrid, showShips: boolean): string {
  const header = `   ${Array.from({ length: COLS }, (_, i) => String(i + 1).padStart(2, ' ')).join('')}`;
  const lines = grid.cells.map((row, r) => {
    const cells = row
      .map((c) => {
        if (c === 'miss') return ' o';
        if (c === 'hit') return ' X';
        if (c === 'sunk') return ' #';
        if (c === 'ship') return showShips ? ' S' : ' .';
        return ' .';
      })
      .join('');
    return `${String.fromCharCode(65 + r)}  ${cells}`;
  });
  return [header, ...lines].join('\n');
}

function shipsLine(grid: BATTLESHIPGrid): string {
  const afloat = grid.ships.filter((sh) => !sh.sunk).map((sh) => `${sh.name} (${sh.size})`);
  const sunk = grid.ships.filter((sh) => sh.sunk).map((sh) => sh.name);
  return `afloat: ${afloat.join(', ') || 'none'}; sunk: ${sunk.join(', ') || 'none'}`;
}

/** Cell names of a grid in row order, picked by state. */
function cellsWhere(grid: BATTLESHIPGrid, pick: (c: BATTLESHIPGrid['cells'][number][number]) => boolean): string[] {
  const out: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (pick(grid.cells[r][c])) out.push(battleshipCellName(r, c));
  }
  return out;
}

const fired = (c: string): boolean => c === 'hit' || c === 'miss' || c === 'sunk';

/**
 * Move turns: the hits on their board whose ship is not sunk yet, each with
 * the cells next to it it has not fired at. Shown, never chosen: the shot is
 * still the model's own fire() call. Haiku 5.5 lost track of open hits late
 * in a game (261128 eval).
 */
export function openHitsText(grid: BATTLESHIPGrid): string {
  const parts: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid.cells[r][c] !== 'hit') continue;
      const next = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ]
        .filter(([nr, nc]) => nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !fired(grid.cells[nr][nc]))
        .map(([nr, nc]) => battleshipCellName(nr, nc));
      parts.push(`${battleshipCellName(r, c)} (next to it, not fired yet: ${next.join(', ') || 'none'})`);
    }
  }
  return parts.length
    ? `Your open hits, on ships not sunk yet: ${parts.join('; ')}.`
    : 'Your open hits: none (no ship you hit is still afloat).';
}

/**
 * Move turns: where it may not shoot again, as a list (the shorter side:
 * the cells fired at, or past half the board the cells still open). Haiku
 * 5.5 re-fired old cells up to 48 times a game reading the grid alone.
 */
export function firedCellsText(grid: BATTLESHIPGrid): string {
  const done = cellsWhere(grid, fired);
  if (done.length === 0) return '';
  if (done.length <= (ROWS * COLS) / 2) {
    return `Cells you already fired at (never again): ${done.join(', ')}.`;
  }
  const open = cellsWhere(grid, (c) => !fired(c));
  return `You fired at ${done.length} cells. The only cells you have not fired at: ${open.join(', ')}.`;
}

function shotText(h: BATTLESHIPShotRecord, whose: string): string {
  const name = battleshipCellName(h.row, h.col);
  return `${name} ${h.sunkShip ? `sank ${whose} ${h.sunkShip}` : h.hit ? 'hit' : 'miss'}`;
}

/** How many shots back each side the chat facts line shows. */
const FACT_SHOTS = 2;

/**
 * Chat-reply turns: the board as checked facts, written the way the
 * character says them TO the player ("you" = the player, "my" = its own).
 * With two grids alone Haiku 5.5 mixed up whose board was whose ("that's a
 * miss on my side, you still have no sunk ship" right after the player sank
 * its battleship, 261128 eval). Probes of the wording, 6-8 replies each to
 * "did i sink one of yours or did you sink one of mine?": "you sank their /
 * they sank yours" was wrong 4/4 (it flipped the pronouns when talking to
 * the player); the same from its side with the player named left 2/6 to
 * 5/8 replies pointing the player at its own hits or flipping a sink.
 */
export function chatFactsText(f: {
  player: string;
  theirShips: ReadonlyArray<BATTLESHIPShip>;
  yourShips: ReadonlyArray<BATTLESHIPShip>;
  history: ReadonlyArray<BATTLESHIPShotRecord>;
  turn: 'player' | 'ai';
  /** The player's hits on its board whose ship is still afloat. */
  theirOpenHits: ReadonlyArray<string>;
}): string {
  const P = f.player;
  const sunk = (ships: ReadonlyArray<BATTLESHIPShip>, whose: string): string => {
    const names = ships.filter((sh) => sh.sunk).map((sh) => `${whose} ${sh.name}`);
    return names.length ? names.join(', ') : `none of ${whose} ships yet`;
  };
  const last = (by: 'ai' | 'player', whose: string): string => {
    const shots = f.history.filter((h) => h.by === by).slice(-FACT_SHOTS).reverse();
    return shots.length ? shots.map((h) => shotText(h, whose)).join(', ') : 'none yet';
  };
  return [
    `Facts the app checked, written the way you say them to ${P} ("you" is ${P}, "I" and "my" are you). ` +
      'Anything you say about the game has to match them:',
    `- You sank: ${sunk(f.yourShips, 'my')}.`,
    `- I sank: ${sunk(f.theirShips, 'your')}.`,
    `- Your last shots, at my board: ${last('player', 'my')}.`,
    `- My last shots, at your board: ${last('ai', 'your')}.`,
    `- Your open hits on my board: ${f.theirOpenHits.join(', ') || 'none'}.`,
    `- Next shot: ${f.turn === 'ai' ? 'mine' : 'yours'}.`,
    `A shooting tip for ${P} can only name a cell from "Your open hits on my board" (when that says none, there is no cell ` +
      'to name), never one from "My last shots".',
  ].join('\n');
}

interface Region {
  label: string;
  rows: [number, number];
  cols: [number, number];
}

function regionLabel(where: string, rows: [number, number], cols: [number, number]): string {
  const L = (r: number): string => String.fromCharCode(65 + r);
  return `the ${where} (rows ${L(rows[0])} to ${L(rows[1])}, columns ${cols[0] + 1} to ${cols[1] + 1})`;
}

const PLACE_REGIONS: Region[] = [
  { label: regionLabel('top left', [0, 4], [0, 4]), rows: [0, 4], cols: [0, 4] },
  { label: regionLabel('top right', [0, 4], [5, 9]), rows: [0, 4], cols: [5, 9] },
  { label: regionLabel('bottom left', [5, 9], [0, 4]), rows: [5, 9], cols: [0, 4] },
  { label: regionLabel('bottom right', [5, 9], [5, 9]), rows: [5, 9], cols: [5, 9] },
  { label: regionLabel('middle', [2, 7], [2, 7]), rows: [2, 7], cols: [2, 7] },
  { label: 'the whole board, spread out', rows: [0, 9], cols: [0, 9] },
];

/** The 3x3 blocks of their board an opening shot is nudged toward. */
const OPENING_REGIONS: Region[] = (() => {
  const bands: Array<[number, number]> = [
    [0, 2],
    [3, 6],
    [7, 9],
  ];
  const rowWords = ['top', 'middle', 'bottom'];
  const colWords = ['left', 'middle', 'right'];
  const out: Region[] = [];
  bands.forEach((rows, ri) =>
    bands.forEach((cols, ci) => {
      const where = ri === 1 && ci === 1 ? 'center' : `${rowWords[ri]} ${colWords[ci]}`;
      out.push({ label: regionLabel(where, rows, cols), rows, cols });
    }),
  );
  return out;
})();

function pickIndex(n: number, rand: () => number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));
}

/**
 * Placement turns: a per-game random region to lean toward plus a few random
 * cells in it, in random order. The character still places every ship
 * itself; this only breaks the habit of the same layout every game (carrier
 * at A1 going right in 32 of 32 eval games).
 */
export function placementLean(rand: () => number = Math.random): string {
  const reg = PLACE_REGIONS[pickIndex(PLACE_REGIONS.length, rand)];
  const pool: string[] = [];
  for (let r = reg.rows[0]; r <= reg.rows[1]; r++) {
    for (let c = reg.cols[0]; c <= reg.cols[1]; c++) pool.push(battleshipCellName(r, c));
  }
  const ideas: string[] = [];
  for (let i = 0; i < 3 && pool.length; i++) ideas.push(pool.splice(pickIndex(pool.length, rand), 1)[0]);
  return (
    `So they cannot guess your layout, this game lean toward ${reg.label}, and mix ships running right and down. ` +
    `A few cells you could start a ship from: ${ideas.join(', ')}.`
  );
}

/**
 * The first shot of a game: a per-game random region of their board (E5 was
 * the first shot in 30 of 30 eval games). The cell is still its own pick.
 */
export function openingLean(rand: () => number = Math.random): string {
  const reg = OPENING_REGIONS[pickIndex(OPENING_REGIONS.length, rand)];
  return `This is your first shot of the game. Pick a cell somewhere in ${reg.label} of their board.`;
}

function turnBlock(
  s: Session,
  kind: BoardTurnKind,
  retryNote: string | null,
  /** Chat-reply turns: the player's unanswered line(s) (quoted at the end) and their name. */
  opts: { playerLines?: ReadonlyArray<string>; player?: string } = {},
): string {
  const playerLines = opts.playerLines ?? [];
  const lines: string[] = [];
  // Its own ship cells ("S") only where it needs them. On a chat reply the
  // board shows only their shots on it: Haiku 5.5 told the player where its
  // ships were despite the rule (261128 eval).
  const showOwnShips = kind !== 'chat-reply' && kind !== 'game-over';
  if (s.status === 'preparing') {
    if (s.aiFleet === 'ready') {
      lines.push('Your fleet is placed. They are still placing theirs; the battle starts when they are done.');
      if (showOwnShips) lines.push(`Your board:\n${gridText(s.aiGrid, true)}`);
    } else {
      lines.push('The battle has not started. Each side is placing its ships.');
    }
  } else {
    lines.push(
      `Their board, where you shoot ("." not fired at, "o" your miss, "X" your hit, "#" a ship you sank). ` +
        `Shots you fired: ${s.aiShots}.`,
    );
    lines.push(gridText(s.playerGrid, false));
    const theirShips = s.playerGrid.ships.filter((sh) => sh.sunk).map((sh) => sh.name);
    lines.push(`Their ships you sank: ${theirShips.join(', ') || 'none yet'}.`);
    lines.push(
      showOwnShips
        ? `Your own board ("S" your ship, "o" their miss, "X" their hit, "#" your sunk ship). Your ships ${shipsLine(s.aiGrid)}.`
        : `Your own board, where they shoot ("o" their miss, "X" their hit, "#" your sunk ship). Your ships ${shipsLine(s.aiGrid)}.`,
    );
    lines.push(gridText(s.aiGrid, showOwnShips));
    const lastTheirs = [...s.history].reverse().find((h) => h.by === 'player');
    if (lastTheirs && kind !== 'chat-reply') {
      const what = lastTheirs.sunkShip ? `hit and sank your ${lastTheirs.sunkShip}` : lastTheirs.hit ? 'hit' : 'miss';
      lines.push(`Their last shot: ${battleshipCellName(lastTheirs.row, lastTheirs.col)}, ${what}.`);
    }
  }

  if (kind === 'place') {
    lines.push(
      'Place your fleet now: call place_fleet() with all five ships, each with its start cell and "right" or "down". ' +
        'Choose the spots yourself; they stay hidden from them.',
    );
    lines.push(s.placeLean);
    if (retryNote) lines.push(retryNote);
  } else if (kind === 'move') {
    lines.push('It is YOUR shot.');
    if (s.aiShots === 0) lines.push(s.openingLean);
    else {
      lines.push(openHitsText(s.playerGrid));
      const done = firedCellsText(s.playerGrid);
      if (done) lines.push(done);
    }
    if (retryNote) lines.push(retryNote);
    if (s.recentLines.length) {
      lines.push(`Your recent lines: ${s.recentLines.map((l) => `"${l}"`).join(' / ')}. Do not say these again or anything close to them.`);
    }
    if (s.talkedLastMove) {
      lines.push('You said something with your last shot, so this one can go by without a word unless their shot really calls for one.');
    }
    lines.push('Work it out in plain text if you need to, then call fire() with one cell you have not fired at, and say only if you have something to say.');
  } else if (kind === 'chat-reply') {
    if (s.status === 'active') {
      lines.push(
        chatFactsText({
          player: opts.player ?? 'the player',
          theirShips: s.playerGrid.ships,
          yourShips: s.aiGrid.ships,
          history: s.history,
          turn: s.turn,
          theirOpenHits: cellsWhere(s.aiGrid, (c) => c === 'hit'),
        }),
      );
    }
    if (s.aiTurnFailed) {
      lines.push(
        `Your last try to ${s.status === 'preparing' ? 'place your fleet' : 'shoot'} did not work, so nothing more ` +
          'happens until they press Try again. If they ask, say it failed and they can press Try again.',
      );
    } else if (aiTurnKind(s)) {
      lines.push('Your own turn comes on its own right after this reply.');
    }
    lines.push(`${unansweredNote(playerLines)} Answer them in text, or say nothing.`);
  }
  return lines.join('\n');
}

/**
 * The game-over turn: the result first and in so many words, no boards,
 * with the player named. With the result under both boards, Haiku 5.5 got it
 * backwards in 2 of 3 games; with a bare "YOU WON" it still told the player
 * "you won" in 3 of 5 scripted wins, so the line names who won and says which
 * side of the table the character is talking from.
 */
function gameOverBlock(s: Session, r: BATTLESHIPResult, player: string): string {
  const theirsSunk = s.playerGrid.ships.filter((sh) => sh.sunk).length;
  const mineAfloat = s.aiGrid.ships.filter((sh) => !sh.sunk).length;
  const Player = player.charAt(0).toUpperCase() + player.slice(1);
  const result =
    r.reason === 'all-ships-sunk'
      ? r.winner === 'ai'
        ? `You won and ${player} lost. You sank all five of ${player}'s ships while ${mineAfloat} of yours were ` +
          `still afloat. You are the winner, talking to the person you just beat.`
        : `${Player} won and you lost. ${Player} sank all five of your ships; you had sunk ${theirsSunk} of theirs. ` +
          `You are the one who lost, talking to the person who beat you.`
      : r.reason === 'resign'
        ? `You won: ${player} gave up. You are the winner, talking to the person who gave up.`
        : 'The game ended without a winner.';
  return [
    `The game is over. ${result} That is settled; the app checked it.`,
    'There is nothing to call now. Write only the line you say to them, in your own voice, or nothing.',
  ].join('\n');
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

export function endAllBATTLESHIP(reason: string): void {
  for (const s of [...sessions.values()]) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true, reason });
    }
    dropSession(s);
  }
}

export async function shutdownBATTLESHIP(): Promise<void> {
  endAllBATTLESHIP('app_quit');
  sessions.clear();
}

/** Test seams: the provider every turn uses, and the retry backoff sleep. */
export function __setBattleshipTestHooks(h: {
  provider?: BoardTurnArgs['provider'];
  sleep?: (ms: number) => Promise<void>;
  /** The per-game nudges' randomness (placementLean, openingLean). */
  random?: () => number;
}): void {
  providerOverride = h.provider;
  sleepOverride = h.sleep;
  randomOverride = h.random;
}

/** Test-only: drop every session without analytics. */
export function __resetBattleshipForTests(): void {
  for (const s of sessions.values()) {
    try { s.turnCtrl?.abort(); } catch { /* ignore */ }
    s.queue?.dispose();
  }
  sessions.clear();
}
