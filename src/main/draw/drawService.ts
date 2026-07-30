/**
 * Draw! minigame service (main process): authoritative game state, the turn
 * clock, and the character's two turn runners.
 *
 * One game per character, mutually exclusive with a Minecraft summon. Shape
 * follows chess (src/main/chess/chessService.ts): the renderer holds no game
 * logic at all, every intent lands here, and a full DrawGameState snapshot is
 * pushed back on draw:state.
 *
 * ── The character's GUESSING turn ────────────────────────────────────────────
 * While the player draws, the character is shown periodic snapshots of their
 * canvas. Dispatch is a 500ms poll rather than a web of one-shot timers,
 * because the triggers are all conditions on state and a poll makes them
 * trivially inspectable and testable:
 *
 *   stroke trigger   3 completed strokes since the last dispatch (a stroke
 *                    only counts once the pen is lifted);
 *   time trigger     10s since the last dispatch;
 *   cooldown         never within 5s of the PREVIOUS guess COMPLETING, so a
 *                    slow model call cannot be followed instantly by another;
 *   single flight    one request at a time.
 *
 * "At most one queued guess" falls out of the poll for free: any number of
 * strokes drawn during an in-flight call leave `strokesSinceDispatch` high,
 * and the single dispatch that follows resets it to zero. There is no queue to
 * overflow.
 *
 * Two edge cases are handled explicitly because they otherwise produce the
 * game's worst behaviour:
 *
 *   - An UNCHANGED canvas never reaches the model. The snapshot is hashed and
 *     compared to the last one sent; identical means the player has not drawn
 *     since, and guessing again at the same picture just repeats the previous
 *     guess and burns credits. This also covers the blank canvas at turn start
 *     and the case where the player is thinking rather than drawing.
 *   - A LONG single stroke still triggers. The snapshot includes the
 *     in-progress stroke, so a player spending 30s on one continuous outline
 *     keeps changing the hash and keeps the character talking, even though no
 *     stroke has been committed and the stroke trigger never fires.
 *
 * A turn that ends (correct guess or clock) aborts any in-flight call and
 * bumps the turn key, so a late reply can never post into the next turn.
 *
 * ── The character's DRAWING turn ─────────────────────────────────────────────
 * The character calls the `pen` tool, one call per stroke. Blocks are consumed
 * as they complete off the stream, humanized (src/main/draw/strokeHumanize.ts)
 * and pushed straight out on draw:ai-stroke with playback timing, so the first
 * stroke starts appearing on the player's canvas seconds before the model has
 * finished deciding the rest of the picture. The renderer plays the queue at
 * hand speed; main never waits for it.
 *
 * Plain text on a drawing turn is table talk, and it is passed through
 * redactWord first: the prompt tells the character never to say its word, and
 * this is the backstop for when it does anyway.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { raiseUsageLimitPopup } from '../chat/usageLimit';
import type { ChatMessage, ChatSendResult, LogBatch } from '../../shared/ipc';
import { isCallActive } from '../voice/callState';
import {
  CANVAS_H,
  CANVAS_W,
  DRAW_ERR_MC_ACTIVE,
  MAX_ROUNDS,
  MIN_ROUNDS,
  TURN_MS,
  WORD_CHOICES,
  type DrawAiStroke,
  type DrawChatMessage,
  type DrawGalleryEntry,
  type DrawGameState,
  type DrawPhase,
  type DrawRole,
  type DrawSnapshotRequest,
  type DrawStroke,
} from '../../shared/drawIpc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildSystemBlocks, REMEMBER_TOOL } from '../chat/chatPrompts';
import { readChatContext, foldIfDue } from '../chat/continuity';
import { playSummaryText } from '../chat/playSummary';
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import { splitReply } from '../chat/chatService';
import { plainLine } from '../chat/plainLine';
import * as chatStore from '../chat/chatStore';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import { clampChatLanguage } from '../../shared/chatLanguage';
import { pickWords } from './wordBank';
import { findWordMatch, matchesWord, saysWord } from './guessMatch';
import { guessGate } from './guessSchedule';
import { humanizeStroke } from './strokeHumanize';
import {
  CLEAR_TOOL,
  MAX_AI_STROKES,
  MAX_DRAW_HOPS,
  PEN_TOOL,
  buildDrawTurnBlock,
  buildGuessTurnBlock,
  buildTurnEndBlock,
  drawContractBlock,
  selfLookNote,
  turnClockLine,
  turnEndLine,
  type DrawRestart,
} from './drawPrompts';

// ── deps + module state ──────────────────────────────────────────────────────

export interface DrawDeps {
  pushState: (state: DrawGameState) => void;
  pushAiStroke: (s: DrawAiStroke) => void;
  pushSnapshotRequest: (r: DrawSnapshotRequest) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
  pushLog?: (batch: LogBatch) => void;
}

let deps: DrawDeps | null = null;

export function initDrawService(d: DrawDeps): void {
  deps = d;
}

function requireDeps(): DrawDeps {
  if (!deps) throw new Error('draw service not initialized');
  return deps;
}

// ── tuning ───────────────────────────────────────────────────────────────────

/** Scheduler poll. The policy itself lives in guessSchedule.ts. */
const POLL_MS = 500;
/** How long the renderer gets to answer a snapshot request. */
const SNAPSHOT_TIMEOUT_MS = 2_000;
/**
 * How long the character may go without saying anything before an UNCHANGED
 * canvas is allowed through anyway. 10s (260729, from the web version; was
 * 30s): equal to the time trigger, so a player who stops drawing still hears a
 * guess roughly every 10 seconds instead of the character going quiet for half
 * a minute.
 */
const UNCHANGED_NUDGE_MS = 10_000;
/** Pause on the reveal between turns. */
const TURN_GAP_MS = 4_000;
/**
 * The turn-end reaction beat runs inside that gap, and the gap waits for it.
 * These bound the wait: the call is abandoned after the timeout, and whatever
 * it did say gets at least the minimum pause on screen before the next turn
 * wipes the canvas.
 */
const TURN_END_TIMEOUT_MS = 12_000;
const TURN_END_MIN_PAUSE_MS = 1_800;
/** The last turn's reaction is a closing line, and the gallery replaces the
 *  whole screen, so it gets longer to be read. */
const GAME_END_MIN_PAUSE_MS = 3_400;

/**
 * Tool arrays, one per turn kind — a DELIBERATE divergence from chess, which
 * hands every turn kind one array precisely to stop the cache prefix flipping
 * (`tools` sits ahead of `system`, so changing it re-bills persona + memory +
 * knowledge).
 *
 * Here the trade goes the other way. A Draw! turn lasts three minutes, which is
 * already past the prompt cache's five-minute TTL by the time the SAME turn
 * kind comes round again, so a unified array would buy at most one warm prefix
 * per game. What it would cost is real: handing `pen` to a turn where the
 * character is supposed to be GUESSING invites it to answer with a stroke, and
 * a guess call that returns a tool call and no text is a silent look at the
 * player's canvas. Within a single turn the array never changes, so every call
 * after the first of that turn still hits the cache.
 */
const GUESS_TOOLS = [REMEMBER_TOOL] as Anthropic.Messages.Tool[];
const DRAW_TOOLS = [PEN_TOOL, CLEAR_TOOL, REMEMBER_TOOL] as Anthropic.Messages.Tool[];

/**
 * How often the character may look at its OWN canvas mid-turn (260728).
 *
 * The look costs an image on top of the thread, so it is rationed the same way
 * the guessing scheduler rations its looks: it happens only when the player has
 * just said something (which is when "are they getting it?" is a live
 * question), and never twice inside this window.
 */
const SELF_LOOK_COOLDOWN_MS = 12_000;
/**
 * Quiet time before the parked drawing runner is re-woken with its own canvas
 * attached (the idle backup, 260729 from the web version). A parked runner
 * otherwise wakes only on player chat, so a silent player meant the character
 * sat on a three-stroke picture for the rest of the turn. Not armed inside the
 * floor: a nudge that lands at the buzzer produces a stroke nobody sees.
 * (The web runs 15s/10s of a 60s turn; these are its values for our 180s one.)
 */
const DRAW_IDLE_NUDGE_MS = 30_000;
const DRAW_IDLE_FLOOR_MS = 20_000;
/**
 * Engine-forced restart (260729, from the web version). When the player has
 * fired this many wrong lines at one picture, the picture has failed, and
 * waiting for the model to decide to `clear` was measured optimistic: live,
 * the character defended a tractor nobody could read for a whole turn. The
 * game wipes the canvas itself and the next drawing call opens fresh with
 * "the game wiped it for you, draw it differently". Guarded so it never fires
 * on an almost-there picture with no time to rebuild: once per turn, only
 * while a real picture exists, and only with enough clock left for the redraw
 * to be guessable.
 */
const AUTO_CLEAR_WRONG_GUESSES = 6;
const AUTO_CLEAR_MIN_LEFT_MS = 45_000;
const AUTO_CLEAR_MIN_STROKES = 4;
/**
 * Wipes allowed per drawing turn. Two is enough to abandon a bad idea and
 * commit to a better one; unbounded is a way to spend a whole turn on a blank
 * page.
 */
const MAX_CLEARS = 2;

interface GuessSched {
  strokesSinceDispatch: number;
  lastDispatchAt: number;
  lastCompletedAt: number;
  inFlight: boolean;
  lastSnapshotHash: string;
  lastGuessText: string;
  /** Player lines said during THEIR drawing turn that still want an answer. */
  pendingPlayerChat: string[];
  /** When the character last posted a line this turn. 0 = not yet. */
  lastSpokeAt: number;
  ctrl: AbortController | null;
}

interface DrawRun {
  ctrl: AbortController | null;
  running: boolean;
  strokesUsed: number;
  /** Player lines that landed mid-turn and still want an answer. */
  pendingPlayerChat: string[];
  /**
   * The tool-use conversation for THIS drawing turn, carried across hops.
   *
   * This has to be a real thread. A drawing takes more strokes than one
   * response returns (the model stops on `tool_use` awaiting results), and if
   * each hop started fresh the model would not see the strokes it had already
   * drawn: it would restart the picture every hop instead of continuing it,
   * because "you have already drawn 4 strokes" in the prompt says nothing
   * about WHERE it put them.
   */
  thread: Anthropic.MessageParam[];
  /**
   * tool_result text for tool_use ids from the LAST assistant turn that need
   * something other than the default "drawn" — currently only remember(),
   * whose write happens after the stream closes and whose outcome the model
   * should see on the next hop.
   */
  toolNotes: Map<string, string>;
  /** The model returned no tool call: the picture is finished. */
  done: boolean;
  /** When the character last looked at its own canvas. 0 = not yet. */
  lastLookAt: number;
  /** Wipes spent this turn (see MAX_CLEARS). */
  clears: number;
  /**
   * Blank-canvas correction (260728/260729). Two ways to be staring at an
   * empty page: the model cleared it and walked away, or it opened the turn
   * with table talk and zero pen calls (found live on the web). A no-stroke
   * hop on a blank canvas gets a corrective user note and another hop instead
   * of parking as done. Bounded, and reset per clear.
   */
  blankNudges: number;
  nudgeBlank: boolean;
  /**
   * The model's own `intent` strings for the strokes of the CURRENT attempt
   * (260729). Captured at wipe time so the restart block can say what the
   * failed picture was, stroke by stroke — "draw it differently" needs
   * something concrete to differ from.
   */
  strokeIntents: string[];
  /**
   * Set when a wipe happened and the redraw belongs to a FRESH thread: the
   * next drawing call opens with a new turn block carrying this instead of
   * continuing the old conversation (260729). Relying on the model to clear
   * and redraw inside one turn kept failing live; a reset thread whose opening
   * line is "the page is blank, start again" does not.
   */
  restart: DrawRestart | null;
  /** Player lines during this attempt that were not the word. Reset per wipe. */
  wrongGuesses: number;
  /** The engine wipes a failed picture at most once per turn. */
  autoCleared: boolean;
  /** End of the last hop (or turn start). Feeds the idle backup tick. */
  lastActivityAt: number;
  /**
   * Idle backup (260729): a parked drawing runner used to wake ONLY on player
   * chat, so a silent player meant the character sat on a three-stroke picture
   * for the rest of the turn. After DRAW_IDLE_NUDGE_MS of quiet the tick
   * re-wakes it with fresh eyes on its own canvas and "the player has not
   * guessed it yet".
   */
  idleNudge: boolean;
}

function freshGuess(): GuessSched {
  return {
    strokesSinceDispatch: 0,
    // Seed the dispatch clock at turn start so the first look is a full
    // TIME_TRIGGER_MS in, not immediately at a blank canvas.
    lastDispatchAt: Date.now(),
    lastCompletedAt: 0,
    inFlight: false,
    lastSnapshotHash: '',
    lastGuessText: '',
    pendingPlayerChat: [],
    lastSpokeAt: 0,
    ctrl: null,
  };
}

function freshDraw(): DrawRun {
  return {
    ctrl: null,
    running: false,
    strokesUsed: 0,
    pendingPlayerChat: [],
    thread: [],
    toolNotes: new Map(),
    done: false,
    lastLookAt: 0,
    clears: 0,
    blankNudges: 0,
    nudgeBlank: false,
    strokeIntents: [],
    restart: null,
    wrongGuesses: 0,
    autoCleared: false,
    lastActivityAt: Date.now(),
    idleNudge: false,
  };
}

interface Session {
  gameId: string;
  characterId: string;
  phase: DrawPhase;
  rounds: number;
  round: number;
  drawer: DrawRole | null;
  /**
   * Undealt words for the rest of the game, all distinct. Dealt one at a time
   * to the character and WORD_CHOICES at a time to the player, so the pool is
   * stocked for the worst case: every round spends 1 + WORD_CHOICES of it.
   */
  pool: string[];
  /** The words on offer during a 'pick' phase; empty otherwise. */
  wordChoices: string[];
  word: string;
  turnEndsAt: number;
  /** Bumped every turn; guards every async continuation. */
  turnKey: string;
  turnStartedAt: number;
  strokes: DrawStroke[];
  /** Bumped by the character's `clear` tool; see DrawGameState.clearSeq. */
  clearSeq: number;
  chat: DrawChatMessage[];
  scores: { player: number; ai: number };
  gallery: DrawGalleryEntry[];
  guessed: boolean;
  poll: NodeJS.Timeout | null;
  turnTimer: NodeJS.Timeout | null;
  gapTimer: NodeJS.Timeout | null;
  /**
   * Usage-limit pause (260730). A 402/429 mid-turn freezes the game instead of
   * letting it run silent: timers cleared, remaining turn time latched, both
   * runners parked. draw:resume re-arms everything from pausedRemainingMs.
   */
  paused: boolean;
  pausedRemainingMs: number;
  guess: GuessSched;
  draw: DrawRun;
  /** In-flight turn-end reaction call, so teardown can abort it. */
  endCtrl: AbortController | null;
  startedAt: number;
  /** finishGame has already run for this session; it must never run twice. */
  finished: boolean;
  playerName: string;
  aiName: string;
}

const sessions = new Map<string, Session>();
/** In-flight snapshot requests, keyed by requestId. */
const snapshotWaiters = new Map<string, (dataUrl: string | null) => void>();

function log(s: Session, line: string): void {
  const d = deps;
  if (!d?.pushLog) return;
  try {
    d.pushLog({
      characterId: s.characterId,
      lines: [{ ts: Date.now(), level: 'info', source: 'draw', text: line }],
    } as unknown as LogBatch);
  } catch {
    /* logging is never load-bearing */
  }
}

// ── state projection ─────────────────────────────────────────────────────────

/**
 * The answer is only ever sent to the renderer when the local player is
 * entitled to it: while THEY are drawing, or once the turn is over. During the
 * character's turn the view layer never receives the word at all.
 */
function visibleWord(s: Session): string | null {
  if (s.phase === 'turn-end') return s.word || null;
  if (s.phase === 'drawing' && s.drawer === 'player') return s.word || null;
  return null;
}

function toState(s: Session): DrawGameState {
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    phase: s.phase,
    rounds: s.rounds,
    round: s.round,
    drawer: s.drawer,
    turnKey: s.turnKey,
    word: visibleWord(s),
    wordChoices: s.phase === 'pick' ? s.wordChoices : [],
    turnEndsAt: s.phase === 'drawing' ? s.turnEndsAt : null,
    ...(s.paused ? { paused: true, pausedRemainingMs: s.pausedRemainingMs } : {}),
    strokes: s.strokes,
    clearSeq: s.clearSeq,
    chat: s.chat,
    scores: s.scores,
    gallery: s.gallery,
    playerName: s.playerName,
    aiName: s.aiName,
  };
}

function push(s: Session): void {
  requireDeps().pushState(toState(s));
}

function say(s: Session, from: DrawRole, text: string, extra?: Partial<DrawChatMessage>): DrawChatMessage {
  const m: DrawChatMessage = { id: randomUUID(), from, text, at: Date.now(), ...extra };
  s.chat.push(m);
  if (from === 'ai') speakOnCall(s, text);
  return m;
}

/**
 * Voice call during Draw! (260729): while a live call is running, every line
 * the character says in the game is ALSO spoken through the call. The line is
 * pushed as a voice-stamped chat message — the renderer speaks any
 * `voice: true` push and never renders it as a bubble — but deliberately NOT
 * persisted: the per-line game chat stays out of the transcript (the Draw!
 * continuity contract), and voice rows are invisible in the UI anyway.
 */
function speakOnCall(s: Session, text: string): void {
  if (!isCallActive(s.characterId)) return;
  try {
    requireDeps().pushChatMessage(s.characterId, {
      id: randomUUID(),
      role: 'companion',
      text,
      ts: Date.now(),
      voice: true,
    } as ChatMessage);
  } catch {
    /* renderer gone */
  }
}

/**
 * Where the winning word sits in the winning line, so the renderer highlights
 * the word rather than the whole sentence. Spread into the `correct` extra;
 * empty when the span cannot be located (renderer falls back to the line).
 */
function winningRange(line: string, word: string): Partial<DrawChatMessage> {
  const range = findWordMatch(line, word);
  return range ? { correctRange: range } : {};
}

/**
 * A game line in the chat log. `modelText` is what the CHARACTER reads in its
 * place, and every caller that writes in the second person or names a live
 * secret MUST supply one: the chat log is replayed verbatim into the prompt,
 * so "Your turn to draw: horn" both leaked the answer to the guesser and was
 * read by the character as its own instruction (260728).
 */
function systemLine(s: Session, text: string, modelText?: string): void {
  s.chat.push({
    id: randomUUID(),
    from: 'player',
    text,
    at: Date.now(),
    system: true,
    ...(modelText ? { modelText } : {}),
  });
}

/**
 * The drawer typed their own word. The line never reaches the log; this goes in
 * its place, and the character additionally reads a plain instruction telling
 * it which side of the round it is on.
 */
function wordSlipLine(s: Session, who: DrawRole): void {
  systemLine(
    s,
    who === 'ai'
      ? `${s.aiName} can't type this word! They're drawing it, not guessing it.`
      : "You can't type this word! You're drawing it, not guessing it.",
    who === 'ai'
      ? 'You cannot type this word! You are drawing it, not guessing it. Do not respond to this message.'
      : `${s.playerName} typed the word they are drawing, so the game hid the line. You did not see it.`,
  );
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async function newSession(characterId: string, rounds = 3): Promise<Session> {
  const character = await getCharacter(characterId);
  const config = await loadConfig();
  return {
    gameId: randomUUID(),
    characterId,
    phase: 'setup',
    // Carried across "play again" so the setup screen opens on the length the
    // player last chose rather than resetting to the default every time.
    rounds,
    round: 0,
    drawer: null,
    pool: [],
    wordChoices: [],
    word: '',
    turnEndsAt: 0,
    turnKey: randomUUID(),
    turnStartedAt: 0,
    strokes: [],
    clearSeq: 0,
    chat: [],
    scores: { player: 0, ai: 0 },
    gallery: [],
    guessed: false,
    poll: null,
    turnTimer: null,
    gapTimer: null,
    paused: false,
    pausedRemainingMs: 0,
    guess: freshGuess(),
    draw: freshDraw(),
    endCtrl: null,
    startedAt: Date.now(),
    finished: false,
    playerName: (config.preferred_name ?? '').trim() || 'You',
    aiName: character?.name ?? 'Companion',
  };
}

/** Open the surface at the setup screen (or return the live game). */
export async function openDraw(characterId: string): Promise<DrawGameState> {
  if (requireDeps().isSummoned(characterId)) {
    const err = new Error('Minecraft session active') as Error & { code?: string };
    err.code = DRAW_ERR_MC_ACTIVE;
    throw err;
  }
  let s = sessions.get(characterId);
  if (!s) {
    s = await newSession(characterId);
    sessions.set(characterId, s);
  }
  push(s);
  return toState(s);
}

/** Start a game with the chosen round count. */
export async function startDraw(characterId: string, rounds: number): Promise<DrawGameState> {
  if (requireDeps().isSummoned(characterId)) {
    const err = new Error('Minecraft session active') as Error & { code?: string };
    err.code = DRAW_ERR_MC_ACTIVE;
    throw err;
  }
  // A fresh game every start, so a replay never inherits the previous scores.
  // A previous game still mid-play is abandoned properly rather than dropped,
  // or its playtime would never be reported.
  const prev = sessions.get(characterId);
  if (prev) {
    teardownTimers(prev);
    prev.turnKey = randomUUID();
    if (prev.round > 0) await finishGame(prev, prev.phase === 'gallery' ? 'completed' : 'abandoned');
  }
  const clamped = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(rounds) || 1));
  const s = await newSession(characterId, clamped);
  sessions.set(characterId, s);

  // One word for each of the character's turns, WORD_CHOICES for each of the
  // player's. All distinct, so nothing offered can duplicate anything drawn.
  s.pool = pickWords(s.rounds * (1 + WORD_CHOICES));
  s.round = 1;
  s.startedAt = Date.now();
  log(s, `game start rounds=${s.rounds}`);

  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('draw_game_started', { character_id: characterId, rounds: s.rounds });
    } catch { /* analytics is never load-bearing */ }
  })();

  beginTurn(s, 'player');
  return toState(s);
}

/**
 * Back to the setup screen after a game (the gallery's "play again").
 *
 * Deliberately NOT a straight restart: the round count is the one thing a
 * player is most likely to want to change once they have seen how long a game
 * actually takes, so this returns them to the screen where they choose it, with
 * their previous choice already selected.
 */
export async function newDrawGame(characterId: string): Promise<DrawGameState> {
  if (requireDeps().isSummoned(characterId)) {
    const err = new Error('Minecraft session active') as Error & { code?: string };
    err.code = DRAW_ERR_MC_ACTIVE;
    throw err;
  }
  const prev = sessions.get(characterId);
  if (prev) {
    teardownTimers(prev);
    prev.turnKey = randomUUID();
    if (prev.round > 0) await finishGame(prev, prev.phase === 'gallery' ? 'completed' : 'abandoned');
  }
  const s = await newSession(characterId, prev?.rounds ?? 3);
  sessions.set(characterId, s);
  push(s);
  return toState(s);
}

/**
 * The player chose one of the offered words; the turn starts now. Ignored
 * unless that word is actually on offer, so a stale click from a previous
 * round cannot deal a word the player never saw.
 */
export function pickDrawWord(characterId: string, word: string): DrawGameState | null {
  const s = sessions.get(characterId);
  if (!s) return null;
  if (s.phase !== 'pick' || s.drawer !== 'player') return toState(s);
  const chosen = s.wordChoices.find((w) => w === word);
  if (!chosen) return toState(s);
  s.word = chosen;
  s.wordChoices = [];
  log(s, `word picked round=${s.round} word="${chosen}"`);
  startDrawingPhase(s);
  return toState(s);
}

export function getDrawState(characterId: string): DrawGameState | null {
  const s = sessions.get(characterId);
  return s ? toState(s) : null;
}

export function isDrawActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.phase !== 'gallery';
}

function teardownTimers(s: Session): void {
  if (s.poll) clearInterval(s.poll);
  if (s.turnTimer) clearTimeout(s.turnTimer);
  if (s.gapTimer) clearTimeout(s.gapTimer);
  s.poll = null;
  s.turnTimer = null;
  s.gapTimer = null;
  s.guess.ctrl?.abort();
  s.draw.ctrl?.abort();
  s.endCtrl?.abort();
  s.guess.ctrl = null;
  s.draw.ctrl = null;
  s.endCtrl = null;
}

/** Close the game. An unfinished game is recorded as abandoned. */
export async function endDraw(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  teardownTimers(s);
  sessions.delete(characterId);
  // Bump the key so any continuation still in flight sees a dead turn.
  s.turnKey = randomUUID();
  if (s.round > 0) await finishGame(s, s.phase === 'gallery' ? 'completed' : 'abandoned');
}

/**
 * Usage-limit pause (260730). A 402/429 out of any of this session's model
 * calls means every further call this turn would fail the same way, so
 * instead of a silent frozen game: freeze the clock (latch the remaining
 * time), stop the poll and turn timers, and mark the state paused. The
 * HardStopModal (raised by raiseUsageLimitPopup before this runs) explains;
 * the draw surface shows its own paused notice with a Resume control.
 * Only a live 'drawing' phase pauses — a turn-end reaction failure just
 * costs the reaction line.
 */
function pauseForUsageLimit(s: Session): void {
  if (s.paused || s.phase !== 'drawing') return;
  s.paused = true;
  s.pausedRemainingMs = Math.max(10_000, s.turnEndsAt - Date.now());
  if (s.turnTimer) { clearTimeout(s.turnTimer); s.turnTimer = null; }
  if (s.poll) { clearInterval(s.poll); s.poll = null; }
  s.guess.ctrl?.abort();
  log(s, `usage-limit pause: ${Math.round(s.pausedRemainingMs / 1000)}s of the turn latched`);
  push(s);
}

/**
 * Resume after a usage-limit pause (draw:resume). Re-arms the clock from the
 * latched remainder and restarts whichever runner the drawer implies. Safe to
 * call when nothing is paused. If credits are still depleted the next model
 * call pauses the game again, so a hopeful click costs nothing.
 */
export function resumeDraw(characterId: string): void {
  const s = sessions.get(characterId);
  if (!s || !s.paused) return;
  s.paused = false;
  s.turnStartedAt = Date.now() - (TURN_MS - s.pausedRemainingMs);
  s.turnEndsAt = Date.now() + s.pausedRemainingMs;
  const key = s.turnKey;
  s.turnTimer = setTimeout(() => {
    if (s.turnKey === key) endTurn(s, false);
  }, s.pausedRemainingMs);
  if (s.drawer === 'player') {
    s.poll = setInterval(() => void tickGuessScheduler(s), POLL_MS);
  } else {
    s.poll = setInterval(() => tickDrawIdle(s), POLL_MS);
    // Quiet time while paused must not read as player silence.
    s.draw.lastActivityAt = Date.now();
    void runDrawTurn(s);
  }
  log(s, 'usage-limit pause resumed');
  push(s);
}

/**
 * Write the gallery PNG the renderer composed to the Desktop. Returns the
 * saved path. The filename carries the character and a local timestamp so a
 * second game never silently overwrites the first.
 */
export async function saveGallery(characterId: string, pngDataUrl: string): Promise<string> {
  const base64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
  if (!base64 || base64 === pngDataUrl) throw new Error('expected a PNG data URL');

  const { app } = await import('electron');
  const { writeFile } = await import('node:fs/promises');
  const s = sessions.get(characterId);
  const who = (s?.aiName ?? 'sei').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sei';

  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

  let dir: string;
  try {
    dir = app.getPath('desktop');
  } catch {
    // No desktop on this platform/profile (headless, some Linux setups).
    dir = app.getPath('downloads');
  }
  const file = path.join(dir, `draw-${who}-${stamp}.png`);
  await writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}

export function shutdownDraw(): void {
  for (const s of sessions.values()) teardownTimers(s);
  sessions.clear();
  snapshotWaiters.clear();
}

/**
 * Analytics + the transcript row. `duration_ms` is the shared key every timed
 * surface emits so the dashboard can sum playtime in one query across
 * Minecraft, chess, calls and this (see the games rule in CLAUDE.md). Fired
 * for abandoned games too: that time was still spent.
 */
async function finishGame(s: Session, reason: 'completed' | 'abandoned'): Promise<void> {
  // A completed game finishes when the last turn resolves, and AGAIN when the
  // player closes the gallery. Without this guard that is two draw_game_ended
  // events and two transcript rows for one game.
  if (s.finished) return;
  s.finished = true;
  const durationMs = Date.now() - s.startedAt;
  const turnsPlayed = s.gallery.length;

  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('draw_game_ended', {
        character_id: s.characterId,
        duration_ms: durationMs,
        reason,
        rounds: s.rounds,
        turns_played: turnsPlayed,
        player_score: s.scores.player,
        ai_score: s.scores.ai,
      });
    } catch { /* analytics is never load-bearing */ }
  })();

  // Nothing happened at all: leave no transcript row.
  if (turnsPlayed === 0) return;

  // The in-game chat is deliberately NOT persisted: a guessing turn is a wall
  // of "cat? dog? is that a house?" that would bury real conversation in the
  // transcript and in every future prompt. Nor are the words or the score: one
  // shape for every game surface, see src/main/chat/playSummary.ts.
  const ev: ChatMessage = {
    id: randomUUID(),
    role: 'system',
    text: playSummaryText(s.aiName, 'Draw!', durationMs),
    ts: Date.now(),
    event: { kind: 'play', game: 'Draw!', durationMs },
  } as ChatMessage;
  try {
    await chatStore.appendMessage(s.characterId, ev);
    requireDeps().pushChatMessage(s.characterId, ev);
  } catch { /* best-effort */ }

  // Fold the transcript if the row above pushed it over the trigger, exactly
  // as chat and chess do after their turns. Fire-and-forget and single-flighted
  // inside foldIfDue; a game ending must never wait on a summarizer call.
  try {
    const character = await getCharacter(s.characterId);
    void foldIfDue(s.characterId, character?.persona?.expanded).catch(() => {});
  } catch { /* best-effort */ }
}

// ── turn sequencing ──────────────────────────────────────────────────────────

function beginTurn(s: Session, drawer: DrawRole): void {
  teardownTimers(s);
  s.turnKey = randomUUID();
  s.drawer = drawer;
  s.guessed = false;
  s.strokes = [];
  s.word = '';
  s.wordChoices = [];

  s.guess = freshGuess();
  s.draw = freshDraw();

  // The character is dealt its word; the player chooses theirs first, and the
  // clock does not start until they have (startDrawingPhase, via pickDrawWord).
  if (drawer === 'ai') {
    s.word = s.pool.shift() ?? '';
    startDrawingPhase(s);
    return;
  }

  s.phase = 'pick';
  s.wordChoices = s.pool.splice(0, WORD_CHOICES);
  log(s, `pick round=${s.round} choices=${s.wordChoices.join('/')}`);
  push(s);
}

/**
 * Arm the live turn: clock, reveal line, and whichever of the two runners the
 * drawer implies. Split out of beginTurn so the player's pick screen can sit in
 * front of it without any of the turn's timers running.
 */
function startDrawingPhase(s: Session): void {
  const drawer = s.drawer ?? 'player';
  s.phase = 'drawing';
  s.turnStartedAt = Date.now();
  s.turnEndsAt = s.turnStartedAt + TURN_MS;

  // The player-facing wording and the character-facing wording differ on
  // purpose: the second person means opposite things to the two readers, and
  // the word itself must never appear in what the guesser is shown.
  systemLine(
    s,
    drawer === 'player'
      ? `Round ${s.round} of ${s.rounds}. Your turn to draw.`
      : `Round ${s.round} of ${s.rounds}. ${s.aiName} is drawing.`,
    drawer === 'player'
      ? `Round ${s.round} of ${s.rounds}. ${s.playerName} draws, you guess.`
      : `Round ${s.round} of ${s.rounds}. You draw, ${s.playerName} guesses.`,
  );

  const key = s.turnKey;
  s.turnTimer = setTimeout(() => {
    if (s.turnKey === key) endTurn(s, false);
  }, TURN_MS);

  log(s, `turn start round=${s.round} drawer=${drawer} word="${s.word}"`);
  push(s);

  if (drawer === 'player') {
    s.poll = setInterval(() => void tickGuessScheduler(s), POLL_MS);
  } else {
    // The poll slot is free on this turn kind, so it hosts the idle backup.
    s.poll = setInterval(() => tickDrawIdle(s), POLL_MS);
    void runDrawTurn(s);
  }
}

function endTurn(s: Session, guessed: boolean): void {
  if (s.phase !== 'drawing') return;
  const drawer = s.drawer ?? 'player';
  teardownTimers(s);
  // Any async continuation that wakes up after this sees a stale key.
  s.turnKey = randomUUID();

  s.guessed = guessed;
  if (guessed) {
    if (drawer === 'player') s.scores.ai += 1;
    else s.scores.player += 1;
  }

  s.gallery.push({
    round: s.round,
    drawer,
    word: s.word,
    strokes: s.strokes,
    guessed,
  });

  // Whoever landed it did so on a specific line, and for the character's own
  // correct guess that line is the whole point of the reaction beat below.
  const winningLine = guessed
    ? ([...s.chat].reverse().find((m) => m.correct)?.text ?? null)
    : null;

  const reveal = turnEndLine({
    guessed,
    word: s.word,
    guesser: drawer === 'player' ? 'ai' : 'player',
    aiName: s.aiName,
    playerName: s.playerName,
  });
  systemLine(s, reveal.text, reveal.modelText);

  s.phase = 'turn-end';
  log(s, `turn end round=${s.round} drawer=${drawer} guessed=${guessed} strokes=${s.strokes.length}`);
  push(s);

  // Reaction beat, then advance. The gap WAITS for the call rather than racing
  // it: a reaction that lands after the next turn has already wiped the canvas
  // reads as the character talking about the wrong picture.
  const key = s.turnKey;
  const startedAt = Date.now();
  const gameOver = drawer === 'ai' && s.round >= s.rounds;
  void runTurnEndReaction(s, key, { drawer, guessed, winningLine, gameOver }).finally(() => {
    if (sessions.get(s.characterId) !== s || s.turnKey !== key || s.phase !== 'turn-end') return;
    const floor = gameOver ? GAME_END_MIN_PAUSE_MS : TURN_END_MIN_PAUSE_MS;
    const wait = Math.max(floor, TURN_GAP_MS - (Date.now() - startedAt));
    s.gapTimer = setTimeout(() => advanceTurn(s), wait);
  });
}

function advanceTurn(s: Session): void {
  const wasDrawer = s.drawer;
  if (wasDrawer === 'player') {
    // Same round, roles swap.
    beginTurn(s, 'ai');
    return;
  }
  if (s.round >= s.rounds) {
    s.phase = 'gallery';
    s.drawer = null;
    s.word = '';
    teardownTimers(s);
    log(s, `game over ${s.scores.player}-${s.scores.ai}`);
    push(s);
    void finishGame(s, 'completed');
    return;
  }
  s.round += 1;
  beginTurn(s, 'player');
}

// ── player intents ───────────────────────────────────────────────────────────

export function playerStroke(characterId: string, stroke: DrawStroke): void {
  const s = sessions.get(characterId);
  if (!s || s.phase !== 'drawing' || s.drawer !== 'player') return;
  if (!Array.isArray(stroke?.points) || stroke.points.length < 2) return;
  s.strokes.push({
    id: stroke.id || randomUUID(),
    points: stroke.points
      .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map((p) => ({
        x: Math.max(0, Math.min(CANVAS_W, p.x)),
        y: Math.max(0, Math.min(CANVAS_H, p.y)),
      })),
  });
  // Only a completed stroke counts toward the trigger: the pen has been lifted.
  s.guess.strokesSinceDispatch += 1;
  push(s);
}

export function playerErase(characterId: string, strokeId: string): void {
  const s = sessions.get(characterId);
  if (!s || s.phase !== 'drawing' || s.drawer !== 'player') return;
  const before = s.strokes.length;
  s.strokes = s.strokes.filter((x) => x.id !== strokeId);
  // An erase is not a new stroke, so it does not advance the stroke trigger.
  // It does change the canvas, which the snapshot hash picks up on the next
  // time trigger, so the character still reacts to a rubbed-out mistake.
  if (s.strokes.length !== before) push(s);
}

/**
 * A chat line from the player. While the character is drawing this is also the
 * guess channel; while the player is drawing it is table talk the character
 * will see on its next look.
 */
export async function playerChat(characterId: string, text: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  const clean = text.trim();
  if (!clean) return;
  // Nothing to say into before the game starts, while choosing a word, or
  // after it is over.
  if (s.phase === 'setup' || s.phase === 'pick' || s.phase === 'gallery') return;

  // The player is drawing and just typed their own word. Written out it hands
  // the round away, so the line never enters the log at all: the character
  // reads the chat verbatim and would simply take the answer from it.
  if (s.phase === 'drawing' && s.drawer === 'player' && saysWord(clean, s.word)) {
    wordSlipLine(s, 'player');
    push(s);
    return;
  }

  const correct = s.phase === 'drawing' && s.drawer === 'ai' && matchesWord(clean, s.word);
  say(s, 'player', clean, correct ? { correct: true, ...winningRange(clean, s.word) } : undefined);
  push(s);

  if (correct) {
    endTurn(s, true);
    return;
  }
  if (s.phase !== 'drawing') return;
  if (s.drawer === 'ai') {
    // Mid-drawing table talk: let the character answer it (hints included).
    // Every non-winning line also counts against the picture (see the
    // engine-forced restart above): six wrong guesses at one attempt means
    // the attempt has failed.
    s.draw.wrongGuesses += 1;
    s.draw.pendingPlayerChat.push(clean);
    void runDrawTurn(s);
    return;
  }
  // The player is drawing and talking at the same time. Queue it for the guess
  // scheduler, which picks it up on the next poll (within POLL_MS) and answers
  // it whether or not the canvas has changed. Before 260728 this branch did not
  // exist and the line simply sat in the log unanswered.
  s.guess.pendingPlayerChat.push(clean);
}

/**
 * `chat:send` routing while a Draw! game is live (260729), mirroring chess:
 * a message typed in the chat screen — or DICTATED on a live voice call —
 * lands in the game as a guess or table talk instead of reaching a chat brain
 * that knows nothing about the round. Returns null when no game is taking
 * chat, falling through to the normal path. `replies` is empty + `streamed`:
 * the character's side arrives over the draw:state push (and, on a call, as
 * spoken voice pushes), so the chat screen must not wait for a reply here.
 */
export async function handlePlayerChat(args: {
  characterId: string;
  text: string;
}): Promise<ChatSendResult | null> {
  const s = sessions.get(args.characterId);
  if (!s || (s.phase !== 'drawing' && s.phase !== 'turn-end')) return null;
  await playerChat(args.characterId, args.text);
  return { replies: [], streamed: true };
}

/** The renderer's answer to a draw:snapshot-request. */
export function receiveSnapshot(requestId: string, dataUrl: string): void {
  const w = snapshotWaiters.get(requestId);
  if (!w) return;
  snapshotWaiters.delete(requestId);
  w(dataUrl);
}

function requestSnapshot(s: Session): Promise<string | null> {
  const requestId = randomUUID();
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      snapshotWaiters.delete(requestId);
      resolve(v);
    };
    snapshotWaiters.set(requestId, done);
    setTimeout(() => done(null), SNAPSHOT_TIMEOUT_MS);
    try {
      requireDeps().pushSnapshotRequest({ characterId: s.characterId, requestId });
    } catch {
      done(null);
    }
  });
}

// ── memory ───────────────────────────────────────────────────────────────────

/**
 * Honor one remember() call, returning the tool_result note. The wording is
 * chess's verbatim: the same model meets this tool on three surfaces, and it
 * should read identically on all of them.
 */
async function honorRemember(s: Session, raw: unknown): Promise<string> {
  const text = String((raw as { text?: string })?.text ?? '').trim();
  if (!text) return 'Nothing saved; the text was empty.';
  try {
    // 0 means the bounded duplicate guard skipped the write; saying "saved"
    // there would teach the model it had stored something it had not.
    const written = await appendMemory(
      path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
      text,
    );
    log(s, written === 0 ? 'remember(): duplicate, not written' : 'remember(): saved');
    return written === 0
      ? 'You already saved that a moment ago; nothing new was written. Continue.'
      : 'Saved. Continue; do not mention saving it.';
  } catch (err) {
    log(s, `remember() failed: ${String(err)}`);
    return 'Could not save it. Continue.';
  }
}

/**
 * Honor remember() in a SINGLE-SHOT call (the guessing turn), which offers the
 * tool but runs no tool loop. Without this the write would be silently dropped,
 * the same trap chatService's voice turns hit.
 */
async function honorRememberCalls(s: Session, content: Anthropic.ContentBlock[]): Promise<void> {
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'remember') continue;
    await honorRemember(s, b.input);
  }
}

// ── the character's guessing turn ────────────────────────────────────────────

/** One poll tick: ask the policy, dispatch if it says go. */
async function tickGuessScheduler(s: Session): Promise<void> {
  if (s.paused) return;
  const gate = guessGate({
    phase: s.phase,
    drawer: s.drawer,
    inFlight: s.guess.inFlight,
    strokeCount: s.strokes.length,
    strokesSinceDispatch: s.guess.strokesSinceDispatch,
    lastDispatchAt: s.guess.lastDispatchAt,
    lastCompletedAt: s.guess.lastCompletedAt,
    pendingChat: s.guess.pendingPlayerChat.length > 0,
    now: Date.now(),
  });
  if (!gate.go) return;
  await dispatchGuess(s);
}

async function dispatchGuess(s: Session): Promise<void> {
  const key = s.turnKey;
  // Claim the single-flight slot BEFORE the first await, or two ticks can race
  // through the guard and both dispatch. Draining the chat queue here is part
  // of the same claim: lines that arrive during the call stay queued for the
  // next one instead of being answered twice.
  s.guess.inFlight = true;
  s.guess.strokesSinceDispatch = 0;
  s.guess.lastDispatchAt = Date.now();
  const said = s.guess.pendingPlayerChat;
  s.guess.pendingPlayerChat = [];

  try {
    const dataUrl = await requestSnapshot(s);
    if (s.turnKey !== key) return;
    if (!dataUrl) return;

    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    if (!base64) return;

    // Unchanged canvas: the player has not drawn since the last look, so a
    // second opinion on the same picture is usually a repeat guess and wasted
    // credit. Two exceptions, both cases where staying silent is worse:
    //
    //   - the player SAID something. They are owed an answer whether or not
    //     they have touched the canvas since;
    //   - the character has been quiet a long time. Skipping forever is how a
    //     player who pauses to think ends up watching their companion freeze,
    //     which is exactly what this guard used to do. After NUDGE_MS it gets
    //     one more look, and the prompt tells it the picture has not changed so
    //     it says something new rather than repeating its last guess.
    const unchanged = createHash('sha1').update(base64).digest('hex') === s.guess.lastSnapshotHash;
    const quietFor = Date.now() - (s.guess.lastSpokeAt || s.turnStartedAt);
    if (unchanged && said.length === 0 && quietFor < UNCHANGED_NUDGE_MS) return;
    s.guess.lastSnapshotHash = createHash('sha1').update(base64).digest('hex');

    const lines = await runGuessCall(s, base64, key, { said, unchanged });
    if (s.turnKey !== key) return;

    for (const line of lines) {
      // A repeat of the immediately previous guess reads as a stutter.
      if (line.toLowerCase() === s.guess.lastGuessText.toLowerCase()) continue;
      s.guess.lastGuessText = line;
      s.guess.lastSpokeAt = Date.now();
      const correct = matchesWord(line, s.word);
      say(s, 'ai', line, correct ? { correct: true, ...winningRange(line, s.word) } : undefined);
      push(s);
      if (correct) {
        endTurn(s, true);
        return;
      }
    }
  } catch (err) {
    log(s, `guess failed: ${String(err)}`);
    // A failed call must not swallow what the player said.
    s.guess.pendingPlayerChat.unshift(...said);
    if (await raiseUsageLimitPopup(err)) pauseForUsageLimit(s);
  } finally {
    s.guess.inFlight = false;
    s.guess.lastCompletedAt = Date.now();
  }
}

async function runGuessCall(
  s: Session,
  imageBase64: string,
  key: string,
  opts: { said: string[]; unchanged: boolean },
): Promise<string[]> {
  const { system, sdk, punctuation } = await prepareCall(s);
  if (s.turnKey !== key) return [];

  const turnChat = chatSinceTurnStart(s);
  const block = buildGuessTurnBlock({
    round: s.round,
    rounds: s.rounds,
    aiName: s.aiName,
    playerName: s.playerName,
    turnChat,
    priorChat: s.chat.slice(0, s.chat.length - turnChat.length),
    secondsLeft: Math.max(0, Math.round((s.turnEndsAt - Date.now()) / 1000)),
    said: opts.said,
    unchanged: opts.unchanged,
    strokeCount: s.strokes.length,
    gallery: s.gallery,
  });

  const ctrl = new AbortController();
  s.guess.ctrl = ctrl;
  const timeout = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await sdk.client.messages.create(
      {
        model: sdk.model,
        max_tokens: 200,
        system,
        tools: GUESS_TOOLS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
              },
              { type: 'text', text: block },
            ],
          },
        ],
      },
      { signal: ctrl.signal },
    );
    // A guessing turn is single-shot, so a remember() here is honored inline
    // rather than answered with a tool_result.
    await honorRememberCalls(s, res.content);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    // One look produces one or two short lines, never a wall.
    return splitReply(text, punctuation)
      .slice(0, 2)
      .map(plainLine)
      .filter(Boolean)
      .filter((l) => !isFakeGameLine(l));
  } finally {
    clearTimeout(timeout);
    s.guess.ctrl = null;
  }
}

// ── the turn-end reaction beat ───────────────────────────────────────────────

/**
 * One short line between turns, so the character knows how the turn actually
 * resolved. See buildTurnEndBlock for why this exists: a hedged sentence that
 * happens to contain the word WINS, and without this beat the character carried
 * on believing it had guessed something else.
 *
 * Never throws: the gap timer is armed from `.finally()` either way, so a
 * failed or slow reaction can only cost the line, never the game.
 */
async function runTurnEndReaction(
  s: Session,
  key: string,
  ctx: { drawer: DrawRole; guessed: boolean; winningLine: string | null; gameOver: boolean },
): Promise<void> {
  try {
    const { system, sdk, punctuation } = await prepareCall(s);
    if (s.turnKey !== key || s.phase !== 'turn-end') return;

    const turnChat = chatSinceTurnStart(s);
    const block = buildTurnEndBlock({
      round: s.round,
      rounds: s.rounds,
      aiName: s.aiName,
      playerName: s.playerName,
      drawer: ctx.drawer,
      word: s.word,
      guessed: ctx.guessed,
      winningLine: ctx.winningLine,
      scores: s.scores,
      turnChat,
      priorChat: s.chat.slice(0, s.chat.length - turnChat.length),
      gameOver: ctx.gameOver,
      // Includes the turn that just ended: endTurn pushes it before this runs.
      gallery: s.gallery,
    });

    const ctrl = new AbortController();
    s.endCtrl = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), TURN_END_TIMEOUT_MS);
    try {
      const res = await sdk.client.messages.create(
        {
          model: sdk.model,
          max_tokens: 200,
          system,
          tools: GUESS_TOOLS,
          messages: [{ role: 'user', content: block }],
        },
        { signal: ctrl.signal },
      );
      if (s.turnKey !== key || s.phase !== 'turn-end') return;
      await honorRememberCalls(s, res.content);

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      // The word is public by now (the reveal line already named it), so this
      // is deliberately NOT redacted.
      for (const raw of splitReply(text, punctuation).slice(0, 2)) {
        const line = plainLine(raw);
        if (!line || isSilence(line) || isFakeGameLine(line)) continue;
        say(s, 'ai', line);
      }
      push(s);
    } finally {
      clearTimeout(timeout);
      if (s.endCtrl === ctrl) s.endCtrl = null;
    }
  } catch (err) {
    log(s, `turn-end reaction failed: ${String(err)}`);
    void raiseUsageLimitPopup(err);
  }
}

/**
 * The "(silence)" convention chat and voice already use: models cannot return
 * an empty reply, but they reliably write the literal filler when told quiet is
 * allowed, so it is parsed out rather than fought.
 */
function isSilence(line: string): boolean {
  return /^[([]?\s*(silence|says nothing|stays? silent|no reply)\s*[)\]]?[.!]?$/i.test(line.trim());
}

/**
 * Fabricated game-state backstop (260729, live capture on the web). The prompt
 * renders real system lines as "[game] Round 2 of 3. ..." and the model copied
 * the format into chat, announcing a round change that had not happened. The
 * prompt now forbids it (drawContractBlock) and this drops whatever slips
 * through: the [game] prefix belongs to the engine alone.
 */
function isFakeGameLine(line: string): boolean {
  return /^\s*\[\s*game\s*\]/i.test(line);
}

/**
 * Wipe the character's canvas mid-turn. Shared by the model's `clear` tool and
 * the engine's forced restart (260729). Returns the wiped strokes' intents,
 * for the restart block's "do not redraw that" line.
 */
function wipeAiCanvas(s: Session): string[] {
  const priorIntents = s.draw.strokeIntents;
  s.draw.strokeIntents = [];
  s.draw.clears += 1;
  s.draw.strokesUsed = 0;
  // Each wipe gets its own shot at the blank-page backstop, and guesses at
  // the OLD picture must not count against the new one.
  s.draw.blankNudges = 0;
  s.draw.wrongGuesses = 0;
  s.strokes = [];
  s.clearSeq += 1;
  return priorIntents;
}

// ── the character's drawing turn ─────────────────────────────────────────────

/**
 * The idle backup. A parked runner (done, or out of strokes) otherwise wakes
 * only on player chat; a silent player left the character certain a
 * three-stroke blob was finished. After DRAW_IDLE_NUDGE_MS of quiet this
 * re-enters the loop with `idleNudge` set, which bypasses the park conditions
 * for exactly one hop and attaches fresh eyes. Out-of-strokes is deliberately
 * NOT exempt: `clear` refunds the budget, so "clear and change" is still on
 * the table.
 */
function tickDrawIdle(s: Session): void {
  if (s.paused) return;
  if (s.phase !== 'drawing' || s.drawer !== 'ai') return;
  if (s.draw.running || s.draw.idleNudge) return;
  if (Date.now() - s.draw.lastActivityAt < DRAW_IDLE_NUDGE_MS) return;
  if (s.turnEndsAt - Date.now() < DRAW_IDLE_FLOOR_MS) return;
  s.draw.lastActivityAt = Date.now();
  s.draw.idleNudge = true;
  log(s, 'draw idle nudge: re-waking the parked runner');
  void runDrawTurn(s);
}

/**
 * Drives the drawing turn to completion, then parks. Re-entrant by design:
 * a player line arriving after the picture is finished calls back in to run a
 * reply hop, and the `running` flag keeps two of those from overlapping.
 */
async function runDrawTurn(s: Session): Promise<void> {
  if (s.draw.running) return;
  if (s.paused) return;
  if (s.phase !== 'drawing' || s.drawer !== 'ai') return;
  s.draw.running = true;
  const key = s.turnKey;

  try {
    for (let hop = 0; hop < MAX_DRAW_HOPS; hop++) {
      if (s.turnKey !== key || s.phase !== 'drawing') return;
      if (Date.now() >= s.turnEndsAt) return;
      // Finished picture with nothing to answer and no idle wake: park until
      // a player line or the idle backup wakes us.
      const wake = s.draw.pendingPlayerChat.length > 0 || s.draw.idleNudge;
      if (s.draw.done && !wake) return;
      if (s.draw.strokesUsed >= MAX_AI_STROKES && !wake) return;

      const more = await runDrawCall(s, key);
      if (s.turnKey !== key) return;
      if (!more && s.draw.pendingPlayerChat.length === 0) return;
    }
  } catch (err) {
    log(s, `draw turn failed: ${String(err)}`);
    if (await raiseUsageLimitPopup(err)) pauseForUsageLimit(s);
  } finally {
    s.draw.running = false;
    // A line that landed while the last hop was closing out still deserves an
    // answer, and the loop above has already exited.
    if (s.turnKey === key && s.phase === 'drawing' && s.draw.pendingPlayerChat.length > 0) {
      void runDrawTurn(s);
    }
  }
}

/**
 * Prompt-cache the drawing thread incrementally across hops (260728).
 *
 * The thread is append-only and re-sent verbatim every hop, so without a
 * breakpoint each hop re-bills every earlier hop at full input price — the one
 * quadratic cost in the game. A marker on the last message caches the whole
 * prefix; the next hop then pays full price only for what it appended. The
 * marker MOVES: unlike chat, the same array persists across hops, so the old
 * stamp must be stripped or the request exceeds the API's four-breakpoint
 * budget (three are already spent inside `system`). Break-even is one re-read,
 * so only the final hop's increment ever loses (the 25% write premium on a few
 * hundred tokens); the thread dying with the turn costs nothing — expiry is
 * free and the next turn's calls still match the system prefix.
 */
function markThreadCached(thread: Anthropic.MessageParam[]): void {
  for (const m of thread) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && typeof b === 'object' && 'cache_control' in b) {
        delete (b as { cache_control?: unknown }).cache_control;
      }
    }
  }
  const last = thread[thread.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const tail = last.content[last.content.length - 1];
  if (tail && typeof tail === 'object') {
    (tail as { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' };
  }
}

/**
 * One hop of the drawing turn's tool-use loop. Returns true when the model
 * asked to keep going (it made tool calls), false when it is finished.
 *
 * The thread on s.draw carries the whole turn: the opening prompt, every
 * assistant response with its pen calls, and a tool_result for each one. That
 * is what lets stroke 9 land in the right place relative to stroke 1.
 *
 * Strokes leave for the renderer the moment their tool_use block completes on
 * the stream, so playback starts while the model is still deciding the rest.
 */
async function runDrawCall(s: Session, key: string): Promise<boolean> {
  const { system, sdk, punctuation } = await prepareCall(s);
  if (s.turnKey !== key) return false;

  // Forced restart (260729): the player has thrown enough wrong lines at this
  // picture that it has demonstrably failed, and there is still time to draw a
  // better one. Wipe it at a hop boundary (never mid-response, so an in-flight
  // reply's strokes cannot land on the fresh page) and open a fresh thread
  // that says the game did it.
  if (
    !s.draw.autoCleared &&
    s.draw.wrongGuesses >= AUTO_CLEAR_WRONG_GUESSES &&
    s.draw.clears < MAX_CLEARS &&
    s.draw.strokesUsed >= AUTO_CLEAR_MIN_STROKES &&
    s.turnEndsAt - Date.now() > AUTO_CLEAR_MIN_LEFT_MS
  ) {
    s.draw.autoCleared = true;
    const wrongGuesses = s.draw.wrongGuesses;
    const priorIntents = wipeAiCanvas(s);
    s.draw.thread = [];
    s.draw.toolNotes.clear();
    s.draw.done = false;
    s.draw.restart = { auto: true, wrongGuesses, priorIntents };
    log(s, `auto-clear after ${wrongGuesses} wrong guesses (${s.draw.clears}/${MAX_CLEARS} wipes)`);
    push(s);
  }

  const pending = s.draw.pendingPlayerChat;
  s.draw.pendingPlayerChat = [];
  // Consume the idle wake. Un-park `done` for this one hop; a text-only
  // answer re-parks through the toolCalls === 0 branch below.
  const idle = s.draw.idleNudge;
  s.draw.idleNudge = false;
  if (idle) s.draw.done = false;

  // First hop opens the thread with the turn block; later hops answer the
  // outstanding tool calls, folding in anything the player said meanwhile.
  if (s.draw.thread.length === 0) {
    const restart = s.draw.restart;
    s.draw.restart = null;
    const turnChat = chatSinceTurnStart(s);
    const block = buildDrawTurnBlock({
      round: s.round,
      rounds: s.rounds,
      word: s.word,
      aiName: s.aiName,
      playerName: s.playerName,
      turnChat,
      priorChat: s.chat.slice(0, s.chat.length - turnChat.length),
      secondsLeft: Math.max(0, Math.round((s.turnEndsAt - Date.now()) / 1000)),
      strokesUsed: s.draw.strokesUsed,
      gallery: s.gallery,
      ...(restart ? { restart } : {}),
    });
    s.draw.thread.push({ role: 'user', content: [{ type: 'text', text: block }] });
  } else {
    // Every tool_use in the last assistant turn needs a result, or the API
    // rejects the request.
    const last = s.draw.thread[s.draw.thread.length - 1];
    const content: Anthropic.ContentBlockParam[] = [];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      for (const b of last.content) {
        if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use') {
          const id = (b as Anthropic.ToolUseBlock).id;
          content.push({
            type: 'tool_result',
            tool_use_id: id,
            // Anything other than a pen stroke left its outcome here.
            content: s.draw.toolNotes.get(id) ?? 'drawn',
          });
        }
      }
    }
    s.draw.toolNotes.clear();

    // Eyes on its own page (260728). Rationed exactly like the guessing
    // scheduler's looks: it happens only when the player has just said
    // something (which is when "are they getting it?" is a live question) or
    // on an idle wake, and never twice inside the cooldown (the idle wake
    // bypasses the cooldown: fresh eyes are the point of it).
    let look = '';
    if (
      (pending.length > 0 || idle) &&
      s.draw.strokesUsed > 0 &&
      (idle || Date.now() - s.draw.lastLookAt >= SELF_LOOK_COOLDOWN_MS)
    ) {
      const dataUrl = await requestSnapshot(s);
      if (s.turnKey !== key) return false;
      look = dataUrl?.replace(/^data:image\/\w+;base64,/, '') ?? '';
      if (look === dataUrl) look = '';
      if (look) s.draw.lastLookAt = Date.now();
    }

    const secondsLeft = Math.max(0, Math.round((s.turnEndsAt - Date.now()) / 1000));
    const notes: string[] = [];
    if (pending.length > 0) {
      notes.push(
        `${s.playerName} says: ${pending.map((t) => `"${t}"`).join(' ')}\n` +
          // 260729, live capture (web): the player guessed "credit card", the
          // word was something else, and the character answered "yes! that's
          // it!" then role-played the round ending. It was never told the
          // engine adjudicates, so a close guess FELT right and it called the
          // win.
          'The game has already checked every one of those lines against your word: NONE of them is it. ' +
          'A correct guess ends the turn on the spot, so if you are reading this, they have not got it, ' +
          'however close a line feels. Never tell them a guess is right or "counts". You may say a guess ' +
          'is close or cold, but only the game says when it is got. ' +
          'Answer if it wants an answer (never with the word), then carry on drawing. ' +
          'A reply on its own is not an answer to "draw more" or "I cannot tell what that is": ' +
          'if they are asking for more picture, put more picture on the page in the same turn.',
      );
    }
    if (look) notes.push(selfLookNote(s.word, s.playerName));
    if (idle) {
      notes.push(
        `${s.playerName} has not guessed it yet, and they have gone quiet. ` +
          'Judge the picture, not your memory of drawing it: if it is on the right track, add the detail that would give it away. ' +
          'If you doubt a stranger could name it, call clear and draw it a DIFFERENT way. ' +
          'Never draw a second version on top of or beside the old one. Do not answer this with words alone.',
      );
    }
    // Blank-page corrections. Two ways to be staring at an empty page: the
    // model cleared it and walked away (260728), or it opened the turn with
    // table talk and zero pen calls (found live on the web). One note covers
    // whichever happened.
    const nudged = s.draw.nudgeBlank;
    s.draw.nudgeBlank = false;
    if (s.draw.strokesUsed === 0 && (nudged || s.draw.clears > 0)) {
      notes.push(
        s.draw.clears > 0
          ? 'The canvas is BLANK: you cleared it and have not drawn the replacement yet. ' +
              `${s.playerName} is watching an empty page. Draw the new picture now, with pen calls, ` +
              'before saying anything else.'
          : 'The canvas is BLANK. You have not drawn anything: the player is staring at an empty page ' +
              'while you talk. Call `pen` NOW and draw your word. Do not reply with text only.',
      );
    }
    notes.push(
      `${s.draw.strokesUsed}/${MAX_AI_STROKES} strokes used. ${turnClockLine(secondsLeft)} ` +
        'Keep drawing if the picture is not recognisable yet, otherwise stop calling pen.',
    );
    // The recency slot, every hop. The equivalent line closes the opening turn
    // block, but on later hops that block is thousands of tokens up the thread
    // and the model drifted into third-person mutterings about the player
    // ("they're getting close to something here") that all landed in chat.
    notes.push(
      `Anything you type is a chat line ${s.playerName} reads the moment you send it. ` +
        'Speak straight TO them: "you", never their name, never "they". ' +
        'You have no private notes here.',
    );
    if (look) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: look },
      });
    }
    content.push({ type: 'text', text: notes.join('\n\n') });
    s.draw.thread.push({ role: 'user', content });
  }

  markThreadCached(s.draw.thread);

  const ctrl = new AbortController();
  s.draw.ctrl = ctrl;
  const timeout = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS * 2);

  let toolCalls = 0;
  let cleared = false;
  let clearedIntents: string[] = [];
  // remember() writes are async and the stream handler is not, so they are
  // collected here and drained once the message closes.
  const remembers: Array<{ id: string; input: unknown }> = [];

  const emitBlock = (b: Anthropic.ContentBlock): void => {
    if (s.turnKey !== key || s.phase !== 'drawing') return;

    if (b.type === 'text') {
      let slipped = false;
      for (const raw of splitReply(b.text, punctuation).slice(0, 2)) {
        const part = plainLine(raw);
        if (!part || isFakeGameLine(part)) continue;
        // Backstop for the never-say-your-word rule. The line is dropped
        // WHOLE rather than patched: 260728 replaced the answer with "[...]"
        // in place, which still pointed at exactly where the word went and
        // read to the player as a bug rather than as the game stepping in.
        if (saysWord(part, s.word)) {
          slipped = true;
          continue;
        }
        say(s, 'ai', part);
      }
      if (slipped) wordSlipLine(s, 'ai');
      push(s);
      return;
    }
    if (b.type !== 'tool_use') return;
    if (b.name === 'remember') {
      // Counted so the hop loop runs once more: that is what delivers the
      // tool_result the API requires for this id, and lets the character carry
      // on drawing afterwards.
      toolCalls += 1;
      remembers.push({ id: b.id, input: b.input });
      return;
    }
    if (b.name === 'clear') {
      toolCalls += 1;
      if (s.draw.clears >= MAX_CLEARS) {
        s.draw.toolNotes.set(b.id, 'no more wipes left this turn. work with what is on the page.');
        return;
      }
      cleared = true;
      clearedIntents = wipeAiCanvas(s);
      s.draw.toolNotes.set(
        b.id,
        `canvas wiped. ${s.playerName} is now watching a blank page: draw the new picture NOW, ` +
          'in this same turn, and do not stop calling pen until it is on the page.',
      );
      log(s, `ai cleared canvas (${s.draw.clears}/${MAX_CLEARS})`);
      push(s);
      return;
    }
    if (b.name !== 'pen') return;
    // Counted even when the stroke is refused below, because the API still
    // needs a tool_result for it on the next hop.
    toolCalls += 1;
    if (s.draw.strokesUsed >= MAX_AI_STROKES) return;

    const input = b.input as { intent?: unknown; points?: unknown; style?: unknown; closed?: unknown };
    const raw = Array.isArray(input?.points) ? input.points : [];
    const points = raw
      .map((p) => p as { x?: unknown; y?: unknown })
      .filter((p) => typeof p?.x === 'number' && typeof p?.y === 'number')
      .map((p) => ({ x: p.x as number, y: p.y as number }))
      .slice(0, 120);
    if (points.length < 2) return;

    const h = humanizeStroke(randomUUID(), points, {
      smooth: input?.style !== 'straight',
      closed: input?.closed === true,
    });
    if (!h) return;

    s.draw.strokesUsed += 1;
    if (typeof input?.intent === 'string' && input.intent.trim()) {
      s.draw.strokeIntents.push(input.intent.trim().slice(0, 80));
    }
    s.strokes.push(h.stroke);
    try {
      requireDeps().pushAiStroke({
        characterId: s.characterId,
        gameId: s.gameId,
        turnKey: key,
        stroke: h.stroke,
        delayBeforeMs: h.delayBeforeMs,
        durationMs: h.durationMs,
      });
    } catch { /* renderer gone */ }
  };

  try {
    const stream = sdk.client.messages.stream(
      {
        model: sdk.model,
        max_tokens: 4000,
        system,
        tools: DRAW_TOOLS,
        messages: s.draw.thread,
      },
      { signal: ctrl.signal },
    );
    // Blocks are released as they complete, so the first stroke can be on the
    // player's canvas long before the model finishes the picture.
    //
    // Dedupe is by COUNT, not by object identity: the blocks handed to the
    // event and the blocks on the final accumulated message are not
    // guaranteed to be the same references, and an identity Set would then
    // emit every stroke twice. Events arrive in content order, so the count of
    // events already handled is exactly the prefix of final.content to skip.
    let emitted = 0;
    stream.on('contentBlock', (b) => {
      emitted += 1;
      emitBlock(b as Anthropic.ContentBlock);
    });
    const final = await stream.finalMessage();
    // Anything the event did not deliver (an SDK path that does not emit it).
    for (let i = emitted; i < final.content.length; i++) emitBlock(final.content[i]);
    // Keep the assistant turn verbatim so the next hop's tool_results line up
    // with the ids it actually issued.
    s.draw.thread.push({ role: 'assistant', content: final.content });
    for (const r of remembers) s.draw.toolNotes.set(r.id, await honorRemember(s, r.input));
    if (cleared && s.draw.strokesUsed === 0 && s.turnKey === key && s.phase === 'drawing') {
      // The wipe was not followed by a redraw in the same response (260729).
      // Do not nudge down the old conversation: reset the thread so the very
      // next call opens fresh on "the page is blank, start the drawing again",
      // with the wiped attempt's stroke intents carried in so it draws the
      // word a different way instead of the same picture twice.
      s.draw.thread = [];
      s.draw.toolNotes.clear();
      s.draw.done = false;
      s.draw.restart = { auto: false, priorIntents: clearedIntents };
      log(s, 'clear with no redraw in the same response: resetting the thread for a fresh start');
    } else if (toolCalls === 0) {
      // Blank-page backstop. A text-only response normally means the picture
      // is finished, but on a blank canvas it means the character is talking
      // at an empty page: either it opened the turn with table talk and zero
      // pen calls (found live on the web) or it cleared and walked away
      // (260728). One nudge hop tells it the page is blank (the flag folds the
      // correction into the next hop's user message so roles keep
      // alternating); bounded, reset per clear, and skipped when the turn is
      // nearly over anyway.
      if (
        s.draw.strokesUsed === 0 &&
        s.draw.blankNudges < 2 &&
        Date.now() < s.turnEndsAt - 15_000 &&
        s.turnKey === key &&
        s.phase === 'drawing'
      ) {
        s.draw.blankNudges += 1;
        s.draw.nudgeBlank = true;
        log(s, 'blank canvas: nudging a redraw hop');
      } else {
        s.draw.done = true;
      }
    }
  } finally {
    clearTimeout(timeout);
    s.draw.ctrl = null;
    s.draw.lastActivityAt = Date.now();
  }

  return toolCalls > 0 || !s.draw.done;
}

// ── shared call prep ─────────────────────────────────────────────────────────

function chatSinceTurnStart(s: Session): DrawChatMessage[] {
  return s.chat.filter((m) => m.at >= s.turnStartedAt);
}

async function readMemoryTail(id: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(id), 'MEMORY.md'), 'utf8');
    // Mirrors chatService / chessService (260725: 6000 -> 12000).
    return humanizeMemoryStamps(raw.length <= 12000 ? raw : raw.slice(-12000));
  } catch {
    return '';
  }
}

/**
 * Persona + memory + knowledge + the whole-game contract, assembled the same
 * way chess does it. The contract goes in `extraStable` so it rides inside the
 * cached system region: it is byte-identical for all ten turns of a game, and
 * only the per-turn block below the cache mark is re-billed.
 */
async function prepareCall(s: Session): Promise<{
  system: Anthropic.TextBlockParam[];
  sdk: Awaited<ReturnType<typeof buildChatSdk>>;
  punctuation: 'casual' | 'deliberate';
}> {
  const character = await getCharacter(s.characterId);
  if (!character) throw new Error('character not found');
  const config = await loadConfig();
  const [{ summary }, memory, knowledge] = await Promise.all([
    readChatContext(s.characterId),
    readMemoryTail(s.characterId),
    readKnowledgeForPrompt(s.characterId).catch(() => ''),
  ]);

  const punctuation: 'casual' | 'deliberate' =
    character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual';

  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness: 1,
    // Not the Discord-like chat surface: live game, board/canvas beside chat.
    surface: 'game',
    punctuation,
    memory,
    summary,
    knowledge,
    openWorldDetected: false,
    inGame: false,
    voiceCall: false,
    language: clampChatLanguage(config.chat_language),
    extraStable: drawContractBlock({
      playerName: s.playerName,
      rounds: s.rounds,
      turnSeconds: Math.round(TURN_MS / 1000),
    }),
  } as Parameters<typeof buildSystemBlocks>[0]) as unknown as Anthropic.TextBlockParam[];

  const sdk = await buildChatSdk();
  return { system, sdk, punctuation };
}

/** Test seam: drive a tick by hand, without the interval. */
export const __test = { tickGuessScheduler, sessions };
