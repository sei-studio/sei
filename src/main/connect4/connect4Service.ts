/**
 * Forza 4 (Connect Four) minigame service (main process): authoritative game
 * state + the character's column picker.
 *
 * One game per character. Every intent (drop, resign, rematch, end) lands
 * here, mutates the session, and a full CONNECT4GameState snapshot is pushed
 * back over CONNECT4:state.
 *
 * The character's column is chosen by the LLM from a `play(column)` tool
 * call — no external engine, no model download. When the model does not
 * produce a valid column, the first available column is played so the game
 * never stalls.
 *
 * Mutually exclusive with chess / Draw! / Minecraft summon via
 * gameLaunch (cross-launch gate) and deps.isSummoned.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LlmMessage } from '../llm/types';
import type { ChatMessage } from '../../shared/ipc';
import type {
  CONNECT4Color,
  CONNECT4GameState,
  CONNECT4GameStatus,
  CONNECT4MoveRecord,
  CONNECT4Result,
} from '../../shared/connect4Ipc';
import { CONNECT4_ERR_MC_ACTIVE } from '../../shared/connect4Ipc';
import { buildLlmProvider } from '../llm';
import { loadAnalytics } from '../lazyAnalytics';
import { getCharacter } from '../characterStore';
import { loadConfig } from '../configStore';
import { accountSwitchingError, beginSessionStart, trackScopedWrite } from '../profile/scopeBarrier';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { paths } from '../paths';
import { isCallActive } from '../voice/callState';
import { REMEMBER_TOOL } from '../chat/chatPrompts';
import { foldIfDue } from '../chat/continuity';

const ROWS = 6;
const COLS = 7;
const WIN = 4;

const sessions = new Map<string, Session>();
let deps: ForzaDeps | null = null;

export interface ForzaDeps {
  pushState: (state: CONNECT4GameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

export interface CONNECT4StartOpts {
  playerColor?: 'r' | 'y' | 'random';
}

interface Session {
  gameId: string;
  characterId: string;
  board: Array<Array<CONNECT4Color | null>>;
  turn: CONNECT4Color;
  playerColor: CONNECT4Color;
  status: CONNECT4GameStatus;
  aiThinking: boolean;
  pendingAiMove: { column: number } | null;
  result: CONNECT4Result | null;
  history: CONNECT4MoveRecord[];
  moves: number;
  startedAt: number;
  lastActivityAt: number;
  turnCtrl: AbortController | null;
  turnSeq: number;
  /** Any chat rows (either side) landed during this game. */
  spoke: boolean;
}

export function initCONNECT4Service(d: ForzaDeps): void {
  deps = d;
}

function requireDeps(): ForzaDeps {
  if (!deps) throw new Error('CONNECT4 service not initialized');
  return deps;
}

function emptyBoard(): Array<Array<CONNECT4Color | null>> {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// ── snapshots ────────────────────────────────────────────────────────────────

function snapshot(s: Session): CONNECT4GameState {
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    board: s.board,
    turn: s.turn,
    playerColor: s.playerColor,
    aiThinking: s.aiThinking,
    pendingAiMove: s.pendingAiMove,
    result: s.result,
    history: s.history,
    moves: s.moves,
  };
}

function push(s: Session): CONNECT4GameState {
  const state = snapshot(s);
  requireDeps().pushState(state);
  return state;
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
  opts?: CONNECT4StartOpts,
): Promise<CONNECT4GameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${CONNECT4_ERR_MC_ACTIVE}: disconnect the Minecraft session to play Forza 4`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') {
    return snapshot(existing);
  }
  if (existing) sessions.delete(characterId);
  const startGuard = beginSessionStart();

  const pick = opts?.playerColor ?? 'random';
  const playerColor: CONNECT4Color =
    pick === 'random' ? (Math.random() < 0.5 ? 'r' : 'y') : pick;
  const aiColor: CONNECT4Color = playerColor === 'r' ? 'y' : 'r';

  const s: Session = {
    gameId: randomUUID(),
    characterId,
    board: emptyBoard(),
    turn: 'r', // red always starts
    playerColor,
    status: 'active',
    aiThinking: false,
    pendingAiMove: null,
    result: null,
    history: [],
    moves: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    spoke: false,
  };
  sessions.set(characterId, s);

  if (!startGuard.stillValid()) {
    sessions.delete(characterId);
    throw accountSwitchingError();
  }
  push(s);

  void (async () => {
    try {
      const { capture } = await loadAnalytics();
      capture('connect4_game_started', {
        character_id: characterId,
        player_color: playerColor,
        ai_color: aiColor,
      });
    } catch { /* analytics is never load-bearing */ }
  })();

  // Character moves second (yellow), unless the player chose yellow.
  if (s.turn !== s.playerColor) enqueueAiMove(s);
  return snapshot(s);
}

export async function playerMove(
  characterId: string,
  column: number,
): Promise<{ ok: boolean; error?: string; state: CONNECT4GameState }> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') {
    throw new Error('no active Forza 4 game');
  }
  if (s.aiThinking || s.pendingAiMove || s.turn !== s.playerColor) {
    return { ok: false, error: 'not your turn', state: snapshot(s) };
  }
  const row = dropRow(s.board, column);
  if (row === -1) {
    return { ok: false, error: 'column full', state: snapshot(s) };
  }
  applyMove(s, column, row, s.playerColor);
  s.lastActivityAt = Date.now();
  const state = push(s);
  if (checkGameOver(s)) return { ok: true, state: snapshot(s) };
  enqueueAiMove(s);
  return { ok: true, state };
}

export async function resign(characterId: string): Promise<CONNECT4GameState> {
  const s = requireActive(characterId);
  const winner: CONNECT4Color = s.playerColor === 'r' ? 'y' : 'r';
  endSession(s, { winner, reason: 'resign' });
  return snapshot(s);
}

export async function rematch(characterId: string): Promise<CONNECT4GameState> {
  const old = sessions.get(characterId);
  if (!old || old.status !== 'ended') throw new Error('no finished game to rematch');
  sessions.delete(characterId);
  return startCONNECT4(characterId, { playerColor: old.playerColor });
}

export async function endCONNECT4(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') {
    endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
  }
  sessions.delete(characterId);
}

// ── analytics + continuity OUT ───────────────────────────────────────────────

function endSession(
  s: Session,
  result: CONNECT4Result,
  opts?: { silent?: boolean },
): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  s.aiThinking = false;
  s.pendingAiMove = null;
  s.status = 'ended';
  s.result = result;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  void (async () => {
    try {
      const { capture } = await loadAnalytics();
      capture('connect4_game_ended', {
        character_id: s.characterId,
        duration_ms: durationMs,
        plies: s.moves,
        reason: result.reason,
        outcome: result.winner === null ? 'draw' : result.winner === s.playerColor ? 'player' : 'ai',
      });
    } catch { /* analytics is never load-bearing */ }
  })();

  // Continuity OUT: transcript play row, then foldIfDue.
  if (result.reason !== 'abandoned' || s.history.length > 0 || s.spoke) {
    void trackScopedWrite((async () => {
      let name = 'your companion';
      try {
        const c = await getCharacter(s.characterId);
        if (c?.name) name = c.name;
      } catch { /* generic name */ }
      const ev: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        text: CONNECT4SummaryText(name, result, s.moves, durationMs, s.playerColor),
        ts: Date.now(),
        event: { kind: 'play', game: 'Forza 4', durationMs },
      };
      try {
        const { appendMessage } = await import('../chat/chatStore');
        await appendMessage(s.characterId, ev);
        requireDeps().pushChatMessage(s.characterId, ev);
      } catch { /* best-effort */ }
      if (!opts?.silent) void foldIfDue(s.characterId, 'app').catch(() => {});
    })());
  }
}

function CONNECT4SummaryText(
  name: string,
  result: CONNECT4Result,
  plyCount: number,
  durationMs: number,
  playerColor: CONNECT4Color,
): string {
  if (result.reason === 'abandoned') {
    return `You and ${name} left a Forza 4 game unfinished.`;
  }
  if (result.winner === null) {
    return `You and ${name} drew a Forza 4 game after ${plyCount} moves.`;
  }
  const won = result.winner === playerColor;
  return won
    ? `You beat ${name} at Forza 4 in ${plyCount} moves.`
    : `${name} beat you at Forza 4 in ${plyCount} moves.`;
}

// ── internals ────────────────────────────────────────────────────────────────

function requireActive(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'active') throw new Error('no active Forza 4 game');
  return s;
}

/** First empty row from the bottom in `column`, or -1 when full. */
function dropRow(board: Array<Array<CONNECT4Color | null>>, column: number): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][column] === null) return r;
  }
  return -1;
}

function applyMove(
  s: Session,
  column: number,
  row: number,
  color: CONNECT4Color,
): void {
  s.board[row][column] = color;
  s.history.push({ column, row, color });
  s.moves++;
  s.lastActivityAt = Date.now();
}

/** True when the last committed move made 4 in a row (any direction). */
function checkWin(s: Session, row: number, col: number, color: CONNECT4Color): boolean {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let step = 1; step < WIN; step++) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || s.board[r][c] !== color) break;
      count++;
    }
    for (let step = 1; step < WIN; step++) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || s.board[r][c] !== color) break;
      count++;
    }
    if (count >= WIN) return true;
  }
  return false;
}

function checkGameOver(s: Session): boolean {
  if (s.moves === 0) return false;
  const last = s.history[s.history.length - 1];
  if (!last) return false;
  if (checkWin(s, last.row, last.column, last.color)) {
    endSession(s, { winner: last.color, reason: 'connect-four' });
    return true;
  }
  if (s.moves === ROWS * COLS) {
    endSession(s, { winner: null, reason: 'draw' });
    return true;
  }
  return false;
}

function nextTurn(s: Session): CONNECT4Color {
  return s.turn === 'r' ? 'y' : 'r';
}

// ── AI move (LLM picks the column) ───────────────────────────────────────────

const PLAY_TOOL = {
  name: 'play',
  description:
    'Drop your piece in a column. Only works on the turn that asks you to move. ' +
    'Give the column number 0-6 (left to right). A full column is illegal — pick another. ' +
    'If you want to say any table talk, say it BEFORE calling this, in the same turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      column: { type: 'number', description: 'Column 0-6 to drop your piece into.' },
    },
    required: ['column'],
  },
};

const CONNECT4_TOOLS = [PLAY_TOOL, REMEMBER_TOOL];
const CONNECT4_MAX_HOPS = 5;
const TURN_TIMEOUT_MS = 90_000;

function enqueueAiMove(s: Session): void {
  if (s.status !== 'active' || s.turn === s.playerColor) return;
  if (s.aiThinking) return;
  s.aiThinking = true;
  push(s);
  void runAiTurn(s);
}

async function runAiTurn(s: Session): Promise<void> {
  const d = requireDeps();
  const character = await getCharacter(s.characterId);
  if (!character) {
    s.aiThinking = false;
    push(s);
    return;
  }
  const config = await loadConfig();
  const playerName = (config.preferred_name ?? '').trim() || 'the player';
  const aiColor: CONNECT4Color = s.playerColor === 'r' ? 'y' : 'r';
  const [{ summary, history }] = await Promise.all([
    (async () => {
      const { readChatContext } = await import('../chat/continuity');
      return await readChatContext(s.characterId);
    })(),
  ]);

  const system = [
    `# FORZA 4 GAME`,
    `You are playing a casual Forza 4 (Connect Four) game against ${playerName} inside the Sei app.`,
    `You are ${aiColor === 'r' ? 'red' : 'yellow'}; they are ${s.playerColor === 'r' ? 'red' : 'yellow'}. Red moves first.`,
    'Every plain-text line you write is spoken out loud at the board, exactly as written.',
    '',
    'TALK ABOUT THE GAME. React to their last drop, say what you are going for, needle them, complain, gloat. Keep it short — one line, the length of a text message. Never open with "ok", "okay", "alright", or any variant. If you have nothing specific to say, say nothing at all.',
    '',
    'NEVER SAY COLUMN NUMBERS OUT LOUD. Point at columns in words instead ("the leftmost column", "the middle column", "the rightmost column").',
    '',
    'Do not announce the column you are about to play: the board shows it by itself.',
  ].join('\n');

  const boardText = s.board
    .map((row, r) =>
      row.map((cell, c) => (cell === null ? '.' : cell === 'r' ? 'R' : 'Y')).join(' '),
    )
    .join('\n');

  const legalCols: number[] = [];
  for (let c = 0; c < COLS; c++) {
    if (dropRow(s.board, c) !== -1) legalCols.push(c);
  }

  const messages: LlmMessage[] = [
    ...(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
    {
      role: 'user',
      content:
        `It is YOUR move. Board (rows top to bottom, . = empty, R = red, Y = yellow):\n${boardText}\n\n` +
        `Legal columns: ${legalCols.join(', ')}. Call play() with one of them.`,
    },
  ];

  const ctrl = new AbortController();
  s.turnCtrl = ctrl;
  const seq = s.turnSeq;
  const stale = () => s.turnSeq !== seq || ctrl.signal.aborted;
  const timeout = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);

  const spoken: ChatMessage[] = [];
  let played = false;

  try {
    const llm = await buildLlmProvider();
    for (let hop = 0; hop < CONNECT4_MAX_HOPS && !stale(); hop++) {
      const res = await llm.call({
        maxTokens: 160,
        system,
        tools: CONNECT4_TOOLS,
        messages,
        timeoutMs: 90_000,
        signal: ctrl.signal,
      });

      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) await speak(s, text, spoken);

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content: res.content });
      const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const tu of toolUses) {
        let note: string;
        if (tu.name === 'play') {
          const raw = Number((tu.input as { column?: number })?.column);
          if (!Number.isFinite(raw) || raw < 0 || raw >= COLS || dropRow(s.board, raw) === -1) {
            note = `"${String((tu.input as { column?: number })?.column)}" is not a legal column here. Legal columns: ${legalCols.join(', ')}. Call play() again.`;
          } else if (played) {
            note = 'You already played your move this turn.';
          } else {
            played = true;
            const row = dropRow(s.board, raw);
            applyMove(s, raw, row, aiColor);
            const state = push(s);
            if (checkGameOver(s)) {
              // game over already ended the session
            } else {
              s.turn = nextTurn(s);
              s.aiThinking = false;
              push(s);
            }
            note = `You drop into column ${raw}. It lands on the board; do not call play() again this turn.`;
          }
        } else if (tu.name === 'remember') {
          const memText = String((tu.input as { text?: string })?.text ?? '').trim();
          if (memText) {
            try {
              const written = await appendMemory(
                pathJoinMemory(s.characterId),
                memText,
                undefined,
                { section: 'app' },
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
          note = `The tool "${tu.name}" does nothing on this turn and never will. Do not call it again.`;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: note });
      }
      messages.push({ role: 'user', content: results });

      if (played) break;
    }

    if (stale()) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }

    if (!played && s.status === 'active') {
      // Fallback: first legal column so the game never stalls.
      const col = legalCols[0];
      if (col !== undefined) {
        const row = dropRow(s.board, col);
        applyMove(s, col, row, aiColor);
        const state = push(s);
        if (!checkGameOver(s)) {
          s.turn = nextTurn(s);
          s.aiThinking = false;
          push(s);
        }
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted || s.turnSeq !== seq) return;
    console.error(`[sei/CONNECT4] AI turn failed: ${describeErr(err)}`);
    s.aiThinking = false;
    push(s);
  } finally {
    clearTimeout(timeout);
    if (s.turnCtrl === ctrl) s.turnCtrl = null;
    s.aiThinking = false;
    if (s.status === 'active' && s.turn !== s.playerColor) {
      void enqueueAiMove(s);
    }
  }
}

async function speak(
  s: Session,
  text: string,
  spoken: ChatMessage[],
): Promise<void> {
  const d = requireDeps();
  const parts = text.split(/\n+/).filter(Boolean);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'companion',
      text: trimmed,
      ts: Date.now(),
      ...(isCallActive(s.characterId) ? { voice: true } : {}),
    };
    spoken.push(msg);
    try {
      const { appendMessage } = await import('../chat/chatStore');
      await appendMessage(s.characterId, msg);
      d.pushChatMessage(s.characterId, msg);
      s.lastActivityAt = Date.now();
      s.spoke = true;
    } catch { /* best-effort */ }
  }
}

function pathJoinMemory(characterId: string): string {
  return path.join(paths.memoryDir(characterId), 'MEMORY.md');
}

function describeErr(err: unknown): string {
  const e = err as Error & { status?: number; cause?: Error };
  let out = `${e.name ?? 'Error'}: ${e.message}`;
  if (e.status !== undefined) out += ` status=${e.status}`;
  for (let c = e.cause; c; c = c.cause as Error | undefined) {
    out += ` <- ${c.name ?? 'Error'}: ${c.message}`;
  }
  return out;
}

// ── account switch + shutdown ────────────────────────────────────────────────

export function endAllCONNECT4(reason: string): void {
  for (const s of [...sessions.values()]) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    }
    sessions.delete(s.characterId);
  }
}

export async function shutdownCONNECT4(): Promise<void> {
  for (const s of sessions.values()) {
    if (s.status !== 'ended') {
      endSession(s, { winner: null, reason: 'abandoned' }, { silent: true });
    }
    try { s.turnCtrl?.abort(); } catch { /* already down */ }
  }
  sessions.clear();
}
