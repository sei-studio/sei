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
import type { ChatMessage, LogBatch } from '../../shared/ipc';
import {
  CANVAS_H,
  CANVAS_W,
  DRAW_ERR_MC_ACTIVE,
  MAX_ROUNDS,
  MIN_ROUNDS,
  TURN_MS,
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
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import { splitReply } from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import { clampChatLanguage } from '../../shared/chatLanguage';
import { pickWords } from './wordBank';
import { matchesWord, redactWord } from './guessMatch';
import { guessGate } from './guessSchedule';
import { humanizeStroke } from './strokeHumanize';
import {
  MAX_AI_STROKES,
  MAX_DRAW_HOPS,
  PEN_TOOL,
  buildDrawTurnBlock,
  buildGuessTurnBlock,
  buildTurnEndBlock,
  drawContractBlock,
  turnEndLine,
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
const DRAW_TOOLS = [PEN_TOOL, REMEMBER_TOOL] as Anthropic.Messages.Tool[];

interface GuessSched {
  strokesSinceDispatch: number;
  lastDispatchAt: number;
  lastCompletedAt: number;
  inFlight: boolean;
  lastSnapshotHash: string;
  lastGuessText: string;
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
}

interface Session {
  gameId: string;
  characterId: string;
  phase: DrawPhase;
  rounds: number;
  round: number;
  drawer: DrawRole | null;
  /** Two words per round: [playerTurn, aiTurn]. */
  words: string[];
  word: string;
  turnEndsAt: number;
  /** Bumped every turn; guards every async continuation. */
  turnKey: string;
  turnStartedAt: number;
  strokes: DrawStroke[];
  chat: DrawChatMessage[];
  scores: { player: number; ai: number };
  gallery: DrawGalleryEntry[];
  guessed: boolean;
  poll: NodeJS.Timeout | null;
  turnTimer: NodeJS.Timeout | null;
  gapTimer: NodeJS.Timeout | null;
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
    turnEndsAt: s.phase === 'drawing' ? s.turnEndsAt : null,
    strokes: s.strokes,
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
  return m;
}

function systemLine(s: Session, text: string): void {
  s.chat.push({ id: randomUUID(), from: 'player', text, at: Date.now(), system: true });
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async function newSession(characterId: string): Promise<Session> {
  const character = await getCharacter(characterId);
  const config = await loadConfig();
  return {
    gameId: randomUUID(),
    characterId,
    phase: 'setup',
    rounds: 3,
    round: 0,
    drawer: null,
    words: [],
    word: '',
    turnEndsAt: 0,
    turnKey: randomUUID(),
    turnStartedAt: 0,
    strokes: [],
    chat: [],
    scores: { player: 0, ai: 0 },
    gallery: [],
    guessed: false,
    poll: null,
    turnTimer: null,
    gapTimer: null,
    guess: {
      strokesSinceDispatch: 0,
      lastDispatchAt: 0,
      lastCompletedAt: 0,
      inFlight: false,
      lastSnapshotHash: '',
      lastGuessText: '',
      ctrl: null,
    },
    draw: {
      ctrl: null,
      running: false,
      strokesUsed: 0,
      pendingPlayerChat: [],
      thread: [],
      toolNotes: new Map(),
      done: false,
    },
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
  const s = await newSession(characterId);
  sessions.set(characterId, s);

  s.rounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(rounds) || 1));
  s.words = pickWords(s.rounds * 2);
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
  // transcript and in every future prompt. What DOES belong is the shape of
  // the session, and the words are the part of it worth carrying, because they
  // are what the two of them actually talked about for six minutes.
  const drawn = (who: DrawRole): string =>
    s.gallery
      .filter((g) => g.drawer === who)
      .map((g) => g.word)
      .join(', ');
  const parts = [
    `You and ${s.aiName} played Draw!.`,
    `${s.scores.player}-${s.scores.ai} over ${turnsPlayed} turn${turnsPlayed === 1 ? '' : 's'}.`,
  ];
  const mine = drawn('player');
  const theirs = drawn('ai');
  if (mine) parts.push(`You drew: ${mine}.`);
  if (theirs) parts.push(`${s.aiName} drew: ${theirs}.`);

  const ev: ChatMessage = {
    id: randomUUID(),
    role: 'system',
    text: parts.join(' '),
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
  s.phase = 'drawing';
  s.drawer = drawer;
  s.guessed = false;
  s.strokes = [];
  s.turnStartedAt = Date.now();
  s.turnEndsAt = s.turnStartedAt + TURN_MS;
  // words[] is laid out two per round: the player's turn then the character's.
  s.word = s.words[(s.round - 1) * 2 + (drawer === 'player' ? 0 : 1)] ?? '';

  s.guess = {
    strokesSinceDispatch: 0,
    // Seed the dispatch clock at turn start so the first look is a full
    // TIME_TRIGGER_MS in, not immediately at a blank canvas.
    lastDispatchAt: Date.now(),
    lastCompletedAt: 0,
    inFlight: false,
    lastSnapshotHash: '',
    lastGuessText: '',
    ctrl: null,
  };
  s.draw = {
    ctrl: null,
    running: false,
    strokesUsed: 0,
    pendingPlayerChat: [],
    thread: [],
    toolNotes: new Map(),
    done: false,
  };

  systemLine(
    s,
    drawer === 'player'
      ? `Round ${s.round} of ${s.rounds}. Your turn to draw: ${s.word}.`
      : `Round ${s.round} of ${s.rounds}. ${s.aiName} is drawing.`,
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

  const guesserName = drawer === 'player' ? s.aiName : s.playerName;
  systemLine(s, turnEndLine({ guessed, word: s.word, guesserName }));

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
  // Nothing to say into before the game starts or after it is over.
  if (s.phase === 'setup' || s.phase === 'gallery') return;

  const correct = s.phase === 'drawing' && s.drawer === 'ai' && matchesWord(clean, s.word);
  say(s, 'player', clean, correct ? { correct: true } : undefined);
  push(s);

  if (correct) {
    endTurn(s, true);
    return;
  }
  // Mid-drawing table talk: let the character answer it (hint requests included).
  if (s.phase === 'drawing' && s.drawer === 'ai') {
    s.draw.pendingPlayerChat.push(clean);
    void runDrawTurn(s);
  }
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
  const gate = guessGate({
    phase: s.phase,
    drawer: s.drawer,
    inFlight: s.guess.inFlight,
    strokeCount: s.strokes.length,
    strokesSinceDispatch: s.guess.strokesSinceDispatch,
    lastDispatchAt: s.guess.lastDispatchAt,
    lastCompletedAt: s.guess.lastCompletedAt,
    now: Date.now(),
  });
  if (!gate.go) return;
  await dispatchGuess(s);
}

async function dispatchGuess(s: Session): Promise<void> {
  const key = s.turnKey;
  // Claim the single-flight slot BEFORE the first await, or two ticks can race
  // through the guard and both dispatch.
  s.guess.inFlight = true;
  s.guess.strokesSinceDispatch = 0;
  s.guess.lastDispatchAt = Date.now();

  try {
    const dataUrl = await requestSnapshot(s);
    if (s.turnKey !== key) return;
    if (!dataUrl) return;

    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    if (!base64) return;

    // Unchanged canvas: the player has not drawn since the last look, so a
    // second opinion on the same picture is a repeat guess and wasted credit.
    const hash = createHash('sha1').update(base64).digest('hex');
    if (hash === s.guess.lastSnapshotHash) return;
    s.guess.lastSnapshotHash = hash;

    const lines = await runGuessCall(s, base64, key);
    if (s.turnKey !== key) return;

    for (const line of lines) {
      // A repeat of the immediately previous guess reads as a stutter.
      if (line.toLowerCase() === s.guess.lastGuessText.toLowerCase()) continue;
      s.guess.lastGuessText = line;
      const correct = matchesWord(line, s.word);
      say(s, 'ai', line, correct ? { correct: true } : undefined);
      push(s);
      if (correct) {
        endTurn(s, true);
        return;
      }
    }
  } catch (err) {
    log(s, `guess failed: ${String(err)}`);
  } finally {
    s.guess.inFlight = false;
    s.guess.lastCompletedAt = Date.now();
  }
}

async function runGuessCall(s: Session, imageBase64: string, key: string): Promise<string[]> {
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
    return splitReply(text, punctuation).slice(0, 2);
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
      for (const line of splitReply(text, punctuation).slice(0, 2)) {
        if (isSilence(line)) continue;
        say(s, 'ai', line);
      }
      push(s);
    } finally {
      clearTimeout(timeout);
      if (s.endCtrl === ctrl) s.endCtrl = null;
    }
  } catch (err) {
    log(s, `turn-end reaction failed: ${String(err)}`);
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

// ── the character's drawing turn ─────────────────────────────────────────────

/**
 * Drives the drawing turn to completion, then parks. Re-entrant by design:
 * a player line arriving after the picture is finished calls back in to run a
 * reply hop, and the `running` flag keeps two of those from overlapping.
 */
async function runDrawTurn(s: Session): Promise<void> {
  if (s.draw.running) return;
  if (s.phase !== 'drawing' || s.drawer !== 'ai') return;
  s.draw.running = true;
  const key = s.turnKey;

  try {
    for (let hop = 0; hop < MAX_DRAW_HOPS; hop++) {
      if (s.turnKey !== key || s.phase !== 'drawing') return;
      if (Date.now() >= s.turnEndsAt) return;
      // Finished picture with nothing to answer: park until a player line
      // wakes us.
      if (s.draw.done && s.draw.pendingPlayerChat.length === 0) return;
      if (s.draw.strokesUsed >= MAX_AI_STROKES && s.draw.pendingPlayerChat.length === 0) return;

      const more = await runDrawCall(s, key);
      if (s.turnKey !== key) return;
      if (!more && s.draw.pendingPlayerChat.length === 0) return;
    }
  } catch (err) {
    log(s, `draw turn failed: ${String(err)}`);
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

  const pending = s.draw.pendingPlayerChat;
  s.draw.pendingPlayerChat = [];

  // First hop opens the thread with the turn block; later hops answer the
  // outstanding tool calls, folding in anything the player said meanwhile.
  if (s.draw.thread.length === 0) {
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
      resuming: false,
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
    const secondsLeft = Math.max(0, Math.round((s.turnEndsAt - Date.now()) / 1000));
    const notes: string[] = [];
    if (pending.length > 0) {
      notes.push(
        `${s.playerName} says: ${pending.map((t) => `"${t}"`).join(' ')}\n` +
          'Answer if it wants an answer (never with the word), then carry on drawing.',
      );
    }
    notes.push(
      `${s.draw.strokesUsed}/${MAX_AI_STROKES} strokes used, about ${secondsLeft}s left. ` +
        'Keep drawing if the picture is not recognisable yet, otherwise stop calling pen.',
    );
    content.push({ type: 'text', text: notes.join('\n\n') });
    s.draw.thread.push({ role: 'user', content });
  }

  const ctrl = new AbortController();
  s.draw.ctrl = ctrl;
  const timeout = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS * 2);

  let toolCalls = 0;
  // remember() writes are async and the stream handler is not, so they are
  // collected here and drained once the message closes.
  const remembers: Array<{ id: string; input: unknown }> = [];

  const emitBlock = (b: Anthropic.ContentBlock): void => {
    if (s.turnKey !== key || s.phase !== 'drawing') return;

    if (b.type === 'text') {
      for (const part of splitReply(b.text, punctuation).slice(0, 2)) {
        // Backstop for the never-say-your-word rule.
        const safe = redactWord(part, s.word);
        if (!safe) continue;
        say(s, 'ai', safe);
      }
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
    if (b.name !== 'pen') return;
    // Counted even when the stroke is refused below, because the API still
    // needs a tool_result for it on the next hop.
    toolCalls += 1;
    if (s.draw.strokesUsed >= MAX_AI_STROKES) return;

    const input = b.input as { points?: unknown; style?: unknown; closed?: unknown };
    const raw = Array.isArray(input?.points) ? input.points : [];
    const points = raw
      .map((p) => p as { x?: unknown; y?: unknown })
      .filter((p) => typeof p?.x === 'number' && typeof p?.y === 'number')
      .map((p) => ({ x: p.x as number, y: p.y as number }));
    if (points.length < 2) return;

    const h = humanizeStroke(randomUUID(), points, {
      smooth: input?.style !== 'straight',
      closed: input?.closed === true,
    });
    if (!h) return;

    s.draw.strokesUsed += 1;
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
    if (toolCalls === 0) s.draw.done = true;
  } finally {
    clearTimeout(timeout);
    s.draw.ctrl = null;
  }

  return toolCalls > 0;
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
