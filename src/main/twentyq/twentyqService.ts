/**
 * 20 Questions minigame service (main process): authoritative session state +
 * the character's turn runner.
 *
 * CLONED from src/main/connect4/connect4Service.ts and SIMPLIFIED for the
 * party tier (copy/diverge ledger: .planning/quick/twentyq-reuse-notes.md):
 * no engine, no candidate set, no presentation hold, no pendingAiMove/ack
 * reveal protocol. The whole game IS the conversation, so the FSM queue
 * (src/bot/brain/fsm.js, one per session) carries only:
 *   P1  sei:chat_received  player message(s); consecutive sends coalesce into
 *                          ONE reply turn (chatBuffer drained at dispatch).
 *                          Every reply turn is a game turn: asks, guesses,
 *                          answers, and reveals all happen here.
 *   P2  sei:kickoff        round start; the character opens the round (and,
 *                          in keeper mode, the secret is picked first).
 *   P3  sei:idle           sampled 60-150s of quiet (silent-streak backoff);
 *                          a nudge line is OPTIONAL, silence is normal.
 *
 * Rules bookkeeping (slot accounting, phase legality, winners) is pure typed
 * code in ./rules; the LLM only expresses personality through the tools. An
 * illegal tool call gets a corrective tool_result and a retry, mirroring
 * connect4's illegal-column handling.
 *
 * Sessions span rounds: a round ending shows the result banner and keeps the
 * panel (and this session, and the match score) alive; new_round (tool or
 * IPC) starts the next. Closing the panel ends the session with the usual
 * transcript event + MEMORY.md line.
 *
 * Keeper-mode secrecy: the secret lives ONLY in this module's session state
 * and in the model prompt. Snapshots carry it exclusively inside a finished
 * round's result.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type { TQGameState, TQMode, TQVerdict } from '../../shared/twentyqIpc';
import { TQ_ERR_MC_ACTIVE, TQ_MAX_QUESTIONS } from '../../shared/twentyqIpc';
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
  applyAnswer,
  applyAsk,
  applyForfeit,
  applyGuess,
  createRound,
  noteReply,
  outOfQuestions,
  resolveGuesserExhaustion,
  resolveGuesserReveal,
  resolveKeeperExhaustion,
  resolveKeeperReveal,
  slotsLeft,
  type TQRoundState,
} from './rules';
import { generateSecret } from './secret';

// ── deps + module state ──────────────────────────────────────────────────────

export interface TwentyQDeps {
  pushState: (state: TQGameState) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
}

/** Minimal typed view of the fsm.js priority queue. */
interface TQQueue {
  enqueue: (priority: number, event: string, data?: unknown) => void;
  resetIdleTimer: () => void;
  dispose: () => void;
}

type TurnKind = 'kickoff' | 'chat-reply' | 'idle' | 'round-over';

interface ChatBufferEntry {
  voiceCall: boolean;
  resolve: (r: ChatSendResult) => void;
}

interface Session {
  gameId: string;
  characterId: string;
  mode: TQMode;
  roundState: TQRoundState;
  score: { player: number; character: number };
  /** Rounds that reached a real result (not abandoned). */
  completedRounds: number;
  /** Keeper-mode secrets used so far this session (repeat avoidance). */
  usedSecrets: string[];
  status: 'active' | 'ended';
  aiBusy: boolean;
  startedAt: number;
  turnCtrl: AbortController | null;
  /** Bumps ONLY when the session ends; in-flight turns treat a bump as abort. */
  turnSeq: number;
  queue: TQQueue | null;
  chatBuffer: ChatBufferEntry[];
  /** Consecutive idle ticks that chose silence (backs off the idle cadence). */
  idleStreak: number;
  /** Last chat line / slot spent, for the idle prompt's elapsed-quiet line. */
  lastActivityAt: number;
  /** Kind of the LLM turn currently running (onPreempt aborts 'idle' only). */
  inFlightKind: TurnKind | null;
}

/** Timing knobs. Exported and mutable for tests only; not user copy. */
export const TQ_TIMING = {
  idleMinMs: 60_000,
  idleMaxMs: 150_000,
  /** Idle cadence multiplier cap from consecutive silent ticks. */
  idleBackoffCap: 4,
};

const sessions = new Map<string, Session>();
let deps: TwentyQDeps | null = null;

export function initTwentyQService(d: TwentyQDeps): void {
  deps = d;
}

function requireDeps(): TwentyQDeps {
  if (!deps) throw new Error('twentyq service not initialized');
  return deps;
}

// ── snapshots ────────────────────────────────────────────────────────────────

function snapshot(s: Session): TQGameState {
  const r = s.roundState;
  // Copies, not live references (the connect4 lesson: in-process consumers
  // must never see a pushed snapshot mutate after the fact). The keeper-mode
  // secret is deliberately absent while the round is live.
  return {
    gameId: s.gameId,
    characterId: s.characterId,
    status: s.status,
    mode: s.mode,
    round: r.round,
    questionsUsed: r.questionsUsed,
    log: r.log.map((e) => ({ ...e })),
    roundOver: r.over,
    result: r.result ? { ...r.result } : null,
    score: { ...s.score },
    aiBusy: s.aiBusy,
  };
}

function push(s: Session): TQGameState {
  const state = snapshot(s);
  requireDeps().pushState(state);
  return state;
}

// ── public api (wired to IPC handlers) ──────────────────────────────────────

export function isTwentyQActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getTwentyQState(characterId: string): TQGameState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startTwentyQ(
  characterId: string,
  opts?: { mode?: TQMode },
): Promise<TQGameState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${TQ_ERR_MC_ACTIVE}: disconnect the Minecraft session to play 20 Questions`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') return snapshot(existing);

  const mode: TQMode = opts?.mode === 'keeper' ? 'keeper' : 'guesser';
  const s: Session = {
    gameId: randomUUID(),
    characterId,
    mode,
    roundState: createRound(mode, 1),
    score: { player: 0, character: 0 },
    completedRounds: 0,
    usedSecrets: [],
    status: 'active',
    aiBusy: true, // the kickoff turn is queued below
    startedAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    queue: null,
    chatBuffer: [],
    idleStreak: 0,
    lastActivityAt: Date.now(),
    inFlightKind: null,
  };
  s.queue = createPriorityQueue({
    idleFallbackMs: () => sampleIdleDelayMs(s),
    onDispatch: (event: string, data: unknown, signal: AbortSignal) =>
      dispatchTq(s, event, data as { quietMs?: number } | undefined, signal),
    onPreempt: (event: string) => {
      // A fresh player message may abort an in-flight IDLE turn (cheap
      // chatter, the reply matters more). Never a kickoff or a reply.
      if (event === 'sei:chat_received' && s.inFlightKind === 'idle') {
        try { s.turnCtrl?.abort(); } catch { /* already done */ }
      }
      return false; // never claim; the event still queues
    },
    logger: console,
  }) as TQQueue;
  sessions.set(characterId, s);
  push(s);
  s.queue.enqueue(Priority.P2_MOVEMENT, 'sei:kickoff', {});
  return snapshot(s);
}

/** Start the next round after one ends (same mode; the score carries over). */
export async function newRoundTwentyQ(characterId: string): Promise<TQGameState> {
  const s = sessions.get(characterId);
  if (!s || s.status !== 'active') throw new Error('no active 20 questions game');
  if (!s.roundState.over) throw new Error('the current round is not over');
  startNextRound(s);
  return snapshot(s);
}

export async function endTwentyQ(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') endSession(s);
  sessions.delete(characterId);
}

// ── chat routing ─────────────────────────────────────────────────────────────

/**
 * A player chat message while a session is open. Returns null when 20Q should
 * NOT handle it (no session / session ended) so ipc falls through to the
 * normal chat path. The message lands in the chat log immediately, then rides
 * the session queue at P1: consecutive sends coalesce into one reply turn.
 * Every reply turn is a game turn (ask/guess/answer/reveal are all legal
 * there), so this IS the game loop.
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

// ── fsm dispatch ─────────────────────────────────────────────────────────────

async function dispatchTq(
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
    if (event === 'sei:kickoff') await dispatchKickoff(s);
    else if (event === 'sei:chat_received') await dispatchChat(s);
    else if (event === 'sei:idle') await dispatchIdle(s);
  } finally {
    // Idle re-arms itself (enqueues reset the timer; a dispatch does not).
    if (event === 'sei:idle') s.queue?.resetIdleTimer();
  }
}

/** Open the round: pick the keeper secret if needed, then the invite turn. */
async function dispatchKickoff(s: Session): Promise<void> {
  if (s.status !== 'active' || s.roundState.over) return;
  // A transient transport failure gets one retry after a short pause;
  // anything else is logged and the round waits for the player (the panel
  // still shows the status card, so nothing is stuck).
  for (let attempt = 0; ; attempt++) {
    try {
      if (s.mode === 'keeper' && s.roundState.secret === null) {
        s.aiBusy = true;
        push(s);
        const character = await getCharacter(s.characterId);
        if (!character) throw new Error('character not found');
        const secret = await generateSecret(character, s.usedSecrets);
        if (s.status !== 'active' || s.roundState.over) return;
        s.roundState.secret = secret;
        s.usedSecrets.push(secret);
      }
      await runTqLlmTurn(s, { kind: 'kickoff', voiceCall: isCallActive(s.characterId) });
      return;
    } catch (err) {
      if (s.status !== 'active') return;
      if ((err as Error).message === CHAT_ABORTED) return;
      console.error(`[sei/twentyq] kickoff failed (attempt ${attempt + 1}): ${describeErr(err)}`);
      if (attempt === 0 && isConnectionError(err)) {
        await new Promise((r) => setTimeout(r, 1500));
        if (s.status !== 'active') return;
        continue;
      }
      s.aiBusy = false;
      push(s);
      return;
    }
  }
}

async function dispatchChat(s: Session): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0) return; // coalesced into an earlier dispatch
  // The player replied to whatever question/guess was out.
  noteReply(s.roundState);
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  let replies: ChatMessage[] = [];
  try {
    replies = await runTqLlmTurn(s, { kind: 'chat-reply', voiceCall });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/twentyq] chat reply failed: ${describeErr(err)}`);
    }
  }
  for (const e of entries) e.resolve({ replies });

  // Deterministic exhaustion (guesser mode): all 20 slots burned, the last
  // reply came in, and the turn above did not claim a confirmed guess. The
  // round goes to the player; the reaction turn gives the character its
  // sore-loser (or gracious) moment.
  if (
    s.status === 'active' &&
    s.roundState.mode === 'guesser' &&
    !s.roundState.over &&
    outOfQuestions(s.roundState) &&
    !s.roundState.awaitingReply
  ) {
    const fin = resolveGuesserExhaustion(s.roundState);
    if (fin.ok) {
      afterRoundEnd(s);
      void runTqLlmTurn(s, { kind: 'round-over', voiceCall }).catch(() => {});
    }
  }
}

async function dispatchIdle(s: Session): Promise<void> {
  if (s.status !== 'active') return;
  if (s.chatBuffer.length > 0) return; // a reply turn is about to run anyway
  if (s.roundState.over) return; // result banner is up; do not fill the quiet
  let replies: ChatMessage[] = [];
  try {
    replies = await runTqLlmTurn(s, { kind: 'idle', voiceCall: isCallActive(s.characterId) });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/twentyq] idle turn failed: ${describeErr(err)}`);
    }
    return;
  }
  s.idleStreak = replies.length === 0 ? s.idleStreak + 1 : 0;
}

function flushChatBuffer(s: Session): void {
  for (const e of s.chatBuffer.splice(0)) e.resolve({ replies: [] });
}

/** Variable idle cadence: sampled window + silence backoff. */
function sampleIdleDelayMs(s: Session): number {
  const T = TQ_TIMING;
  const base = T.idleMinMs + Math.random() * Math.max(0, T.idleMaxMs - T.idleMinMs);
  return base * Math.min(1 + s.idleStreak, T.idleBackoffCap);
}

// ── round + session lifecycle ────────────────────────────────────────────────

/** Bookkeeping after rules marked the round over: score, push, idle reset. */
function afterRoundEnd(s: Session): void {
  const result = s.roundState.result;
  if (result?.winner === 'player') s.score.player++;
  else if (result?.winner === 'character') s.score.character++;
  if (result && result.winner !== null) s.completedRounds++;
  s.lastActivityAt = Date.now();
  s.idleStreak = 0;
  push(s);
  s.queue?.resetIdleTimer();
}

function startNextRound(s: Session): void {
  s.roundState = createRound(s.mode, s.roundState.round + 1);
  s.aiBusy = true;
  s.idleStreak = 0;
  push(s);
  s.queue?.enqueue(Priority.P2_MOVEMENT, 'sei:kickoff', {});
}

function endSession(s: Session): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  if (!s.roundState.over && s.roundState.log.length > 0) {
    // Live round with real activity: record it as abandoned (no score).
    s.roundState.over = true;
    s.roundState.result = { winner: null, reason: 'abandoned', secret: null, round: s.roundState.round };
  }
  s.aiBusy = false;
  s.status = 'ended';
  flushChatBuffer(s);
  s.queue?.dispose();
  s.queue = null;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  const played = s.completedRounds > 0 || s.roundState.log.length > 0;
  // Transcript event ("You and X played 20 Questions") — same shape the
  // Minecraft/chess/connect4 sessions append, rendered with the gamepad icon.
  if (played) {
    const ev: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      text: '',
      ts: Date.now(),
      event: { kind: 'play', game: '20 Questions', durationMs },
    } as ChatMessage;
    void chatStore.appendMessage(s.characterId, ev).then(() => {
      requireDeps().pushChatMessage(s.characterId, ev);
    }).catch(() => {});
  }

  if (s.completedRounds > 0) {
    // Memory: one line in the character's own ledger about how it went.
    void (async () => {
      try {
        const config = await loadConfig();
        const player = (config.preferred_name ?? '').trim() || 'the player';
        const role = s.mode === 'guesser' ? 'i guessed' : 'they guessed';
        await appendMemory(
          path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
          `played 20 questions with ${player} (${role}): won ${s.score.character}, lost ${s.score.player}`,
        );
      } catch {
        /* best-effort */
      }
    })();
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

// ── the LLM turn ─────────────────────────────────────────────────────────────

const ASK_TOOL = {
  name: 'ask',
  description:
    'Ask your next yes/no question. Put the exact question in the tool; it is delivered to the player ' +
    'for you, so do NOT repeat it in your plain text. Your plain text is for in-character reasoning and ' +
    'drama BEFORE the question. Each question costs one of your 20 slots. One question per turn, then ' +
    'wait for their answer.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: 'The yes/no question, exactly as the player should read it.' },
    },
    required: ['question'],
  },
};

const GUESS_TOOL = {
  name: 'guess',
  description:
    'Make an explicit guess at what they are thinking of. Costs one of your 20 slots whether or not it ' +
    'is right, so do not guess casually. Give just the thing (for example "a hedgehog"); it is announced ' +
    'to the player for you. Build it up in your plain text first if your character would. Then wait for ' +
    'them to confirm or deny.',
  input_schema: {
    type: 'object' as const,
    properties: {
      answer: { type: 'string', description: 'The thing you are guessing, as a short noun phrase.' },
    },
    required: ['answer'],
  },
};

const REVEAL_CLAIM_TOOL = {
  name: 'reveal',
  description:
    'Claim the round: call this ONLY when the player has just confirmed that your guess was right. ' +
    'The round ends and you win it. Say your victory line in plain text in the same turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      secret: { type: 'string', description: 'The thing it was (your confirmed guess).' },
    },
    required: ['secret'],
  },
};

const ANSWER_TOOL = {
  name: 'answer',
  description:
    'Answer the player\'s yes/no question about your secret. Put your whole spoken reply in "reply" ' +
    '(short, in character, it may carry flavor beyond the bare verdict); it is delivered for you, so do ' +
    'not repeat it in plain text. The verdict must be HONEST: yes, no, or sortof. Only call this when ' +
    'their message actually asks a yes/no question about the thing; plain chat needs no tool. Each ' +
    'answered question costs one of their 20 slots.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reply: { type: 'string', description: 'Your spoken answer line, containing the verdict naturally.' },
      verdict: { type: 'string', enum: ['yes', 'no', 'sortof'], description: 'The honest verdict.' },
    },
    required: ['reply', 'verdict'],
  },
};

const REVEAL_KEEPER_TOOL = {
  name: 'reveal',
  description:
    'End the round by putting the secret on the table. Call with player_got_it true the moment they say ' +
    'the thing (or as good as name it); be honest, a win they earned is theirs. Call with player_got_it ' +
    'false only if they clearly give up and want the answer. Say your reaction in plain text in the same turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      secret: { type: 'string', description: 'Your secret, spelled out.' },
      player_got_it: { type: 'boolean', description: 'True if they just guessed it; false if they gave up.' },
    },
    required: ['secret', 'player_got_it'],
  },
};

const NEW_ROUND_TOOL = {
  name: 'new_round',
  description:
    'Start the next round of 20 Questions (same mode, the match score carries over). Only when the ' +
    'player wants another round or your character genuinely demands a rematch.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const FORFEIT_TOOL = {
  name: 'forfeit',
  description:
    'Give up the current round; the player takes it. Only when your character would genuinely quit. ' +
    'Say your parting line in plain text first in the same turn.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const TQ_MAX_HOPS = 5;
const TURN_TIMEOUT_MS = 90_000;

function buildTqBlock(s: Session, kind: TurnKind, playerName: string, quietSec?: number): string {
  const r = s.roundState;
  const lines: string[] = [];
  lines.push('# 20 QUESTIONS GAME');
  lines.push(
    `You are playing 20 Questions with ${playerName} inside the Sei app (no board, pure conversation). ` +
      'Stay fully in character and keep chat lines short like your usual texting. Reason and emote in ' +
      'plain text; the game moves themselves ride the tools.',
  );
  if (s.score.player + s.score.character > 0) {
    lines.push(`Match score so far: you ${s.score.character}, ${playerName} ${s.score.player}.`);
  }

  if (kind === 'round-over') {
    const res = r.result;
    if (res?.reason === 'out-of-questions' && res.winner === 'player') {
      lines.push(
        `You just burned all ${TQ_MAX_QUESTIONS} questions and never got it. The round goes to ${playerName}. ` +
          'React in one or two short lines, fully in character: sore loser, gracious, conspiracy theories, ' +
          'whatever fits you. You may ask what it actually was. No tools this turn.',
      );
    } else {
      lines.push('The round just ended. React in one or two short lines, in character. No tools this turn.');
    }
    return lines.join('\n\n');
  }

  if (r.over) {
    const res = r.result;
    const summary =
      res?.reason === 'abandoned'
        ? 'the round was closed without a result'
        : res?.winner === 'character'
          ? `you took round ${res.round}`
          : res?.winner === 'player'
            ? `${playerName} took round ${res?.round}`
            : 'the round ended';
    lines.push(
      `The round is over (${summary}). If ${playerName} wants to go again, call new_round(); the score ` +
        'carries over. Otherwise just chat.',
    );
    return lines.join('\n\n');
  }

  const left = slotsLeft(r);

  if (kind === 'kickoff') {
    if (r.mode === 'guesser') {
      lines.push(
        `Round ${r.round} is starting and YOU are the guesser: ${playerName} will think of something and you ` +
          `get ${TQ_MAX_QUESTIONS} yes/no questions to figure it out. Tell them to think of a thing (an object, ` +
          'an animal, a person, anything) and to say when they are ready. One or two short lines, in your own ' +
          'voice. No tools this turn.',
      );
    } else {
      lines.push(
        `Round ${r.round} is starting and YOU are hiding the answer. Your secret is: ${r.secret}. ` +
          `Tell ${playerName} you have something in mind and invite their first yes/no question. Do NOT reveal ` +
          'the secret or drop hints. One or two short lines. No tools this turn.',
      );
    }
    return lines.join('\n\n');
  }

  // Live round, mode rules + ground truth.
  if (r.mode === 'guesser') {
    lines.push(
      `Round ${r.round}. You are the guesser: ${playerName} is thinking of something and you have ` +
        `${left} of ${TQ_MAX_QUESTIONS} questions left. Ask yes/no questions with ask(), one per turn. ` +
        `${playerName} answers in their own words; read their replies carefully, they may be vague or teasing. ` +
        'When you think you know it, call guess(); a guess costs a question slot, right or wrong.',
    );
    if (r.log.length > 0) {
      const recap = r.log
        .map((e, i) => `${i + 1}. ${e.kind === 'guess' ? `GUESS: ${e.text}` : `Q: ${e.text}`}`)
        .join('\n');
      lines.push('Slots you have spent so far (their answers are in the chat):\n' + recap);
    }
    if (r.pendingGuess !== null && !r.awaitingReply) {
      lines.push(
        `You guessed "${r.pendingGuess}" and they have now replied. If their reply confirms you were RIGHT, ` +
          'call reveal() to claim the round. If they denied it, move on: ask your next question or guess again.',
      );
    } else if (r.awaitingReply) {
      lines.push('Your last question is still unanswered; do not spend another slot yet.');
    }
    if (left === 0) {
      lines.push(
        'You have NO questions left. If their last reply confirmed your guess, call reveal() now to claim it. ' +
          'Otherwise the round is lost.',
      );
    } else if (left <= 3) {
      lines.push(`Careful: only ${left} slot${left === 1 ? '' : 's'} left, and a guess costs one too.`);
    }
    lines.push(
      'Make the reasoning fun: think out loud in character before each question, chase wild hypotheses if ' +
        'that is who you are. Keep it to a couple of short lines per turn.',
    );
  } else {
    lines.push(
      `Round ${r.round}. You are hiding the answer. Your secret is: ${r.secret}. ` +
        `${playerName} asks yes/no questions in chat and has used ${r.questionsUsed} of ${TQ_MAX_QUESTIONS}. ` +
        'When their message asks a yes/no question about the thing, call answer() with a short in-character ' +
        'reply plus the honest verdict (yes, no, or sortof). Never lie about the verdict. Plain chat that is ' +
        'not a question needs no tool and costs them nothing.',
    );
    if (r.log.length > 0) {
      const recap = r.log
        .map((e, i) => `${i + 1}. ${e.text}${e.verdict ? ` (${e.verdict})` : ''}`)
        .join('\n');
      lines.push('Questions you have answered so far:\n' + recap);
    }
    lines.push(
      'If they say the secret, or as good as name it, be honest and call reveal() with player_got_it true. ' +
        'If they clearly give up, reveal() with player_got_it false. Do not hint at the secret unless you ' +
        'choose to offer a hint on purpose.',
    );
    if (TQ_MAX_QUESTIONS - r.questionsUsed <= 3) {
      lines.push(`They are nearly out of questions (${TQ_MAX_QUESTIONS - r.questionsUsed} left). Enjoy it as much as your character would.`);
    }
  }

  if (kind === 'idle') {
    const sec = Math.max(1, Math.round(quietSec ?? 0));
    lines.push(
      `Nothing has happened for about ${sec} seconds. ` +
        (r.mode === 'guesser'
          ? r.awaitingReply
            ? 'They still have not answered your question.'
            : 'They have gone quiet.'
          : 'They have not asked anything in a while; if they seem stuck you may offer ONE small hint, or just needle them.'),
    );
    lines.push(
      'A message is OPTIONAL here. If you have one short in-character line genuinely worth saying (a taunt, ' +
        'a nudge, a hint offer), say it. Otherwise reply with nothing at all: silence is normal.',
    );
  }
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
 * Run one 20 Questions LLM turn. kind:
 *   'kickoff'    — open the round (invite / announce a secret). No game tools.
 *   'chat-reply' — answer player chat; THE game turn (ask/guess/answer/reveal).
 *   'idle'       — quiet-table tick; a line is optional, silence expected.
 *   'round-over' — react to a service-forced round end (out of questions).
 * Returns the persisted messages (model text + canonical tool lines).
 */
async function runTqLlmTurn(
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
  s.aiBusy = true;
  push(s);

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
  // prefix stays cached while the per-turn game view re-bills (it is small).
  system.push({ type: 'text', text: buildTqBlock(s, opts.kind, playerName, quietSec) });

  const messages = toMessages(history.slice(-30));
  if (opts.kind === 'kickoff') {
    messages.push({ role: 'user', content: '(game) A new round of 20 Questions is starting. Open it.' });
  } else if (opts.kind === 'round-over') {
    messages.push({ role: 'user', content: '(game) The round just ended. Say your piece.' });
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

  // Tool legality is decided per mode + phase here; anything else the model
  // tries gets a corrective tool_result below.
  const tools: Anthropic.Messages.Tool[] = (() => {
    if (opts.kind === 'round-over') return [];
    const t: Anthropic.Messages.Tool[] = [];
    if (s.roundState.over) {
      if (s.roundState.result?.reason !== 'abandoned') t.push(NEW_ROUND_TOOL as Anthropic.Messages.Tool);
    } else if (opts.kind === 'kickoff' || opts.kind === 'idle') {
      // Talk-only turns: never spend slots outside a reply turn.
    } else if (s.roundState.mode === 'guesser') {
      if (slotsLeft(s.roundState) > 0) {
        t.push(ASK_TOOL as Anthropic.Messages.Tool, GUESS_TOOL as Anthropic.Messages.Tool);
      }
      if (s.roundState.pendingGuess !== null && !s.roundState.awaitingReply) {
        t.push(REVEAL_CLAIM_TOOL as Anthropic.Messages.Tool);
      }
      t.push(FORFEIT_TOOL as Anthropic.Messages.Tool);
    } else {
      if (slotsLeft(s.roundState) > 0) t.push(ANSWER_TOOL as Anthropic.Messages.Tool);
      t.push(REVEAL_KEEPER_TOOL as Anthropic.Messages.Tool, FORFEIT_TOOL as Anthropic.Messages.Tool);
    }
    t.push(REMEMBER_TOOL as Anthropic.Messages.Tool);
    return t;
  })();

  const spoken: ChatMessage[] = [];
  const pushMsg = async (part: string): Promise<void> => {
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'companion',
      text: part,
      ts: Date.now() + spoken.length,
      ...(opts.voiceCall ? { voice: true } : {}),
    };
    spoken.push(msg);
    await chatStore.appendMessage(s.characterId, msg);
    d.pushChatMessage(s.characterId, msg);
    s.lastActivityAt = Date.now();
  };
  /** Model plain text: split into texting-sized bubbles. */
  const speak = async (text: string): Promise<void> => {
    for (const part of splitReply(text, character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual')) {
      if (part) await pushMsg(part);
    }
  };
  /** Canonical game line (a question / guess / answer): exactly one bubble. */
  const speakLine = async (text: string): Promise<void> => {
    const t = text.trim();
    if (t) await pushMsg(t);
  };

  try {
    const { client, model } = await buildChatSdk();

    for (let hop = 0; hop < TQ_MAX_HOPS && !stale(); hop++) {
      const res = await client.messages.create(
        { model, max_tokens: 400, system, tools, messages: messages as never },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const u = res.usage;
      console.log(
        `[sei/twentyq] turn char=${s.characterId.slice(0, 8)} kind=${opts.kind} hop=${hop} ` +
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
        const note = await handleToolCall(s, tu, { speakLine, playerName });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: note });
      }
      messages.push({ role: 'user', content: results });
    }

    if (stale()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
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
    s.aiBusy = false;
    if (s.status === 'active') push(s);
  }
}

/** Map one tool_use onto the rules; returns the tool_result note. */
async function handleToolCall(
  s: Session,
  tu: { name: string; input: unknown },
  ctx: { speakLine: (text: string) => Promise<void>; playerName: string },
): Promise<string> {
  const r = s.roundState;
  const input = (tu.input ?? {}) as Record<string, unknown>;

  if (tu.name === 'ask') {
    const q = String(input.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!q) return 'Empty question; nothing was asked. Call ask() again with your yes/no question.';
    if (r.awaitingReply) return 'Your last question is still unanswered. Wait for their reply; do not spend another slot. Do not mention this correction in chat.';
    const res = applyAsk(r, q);
    if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
    await ctx.speakLine(q);
    push(s);
    let note = `Question ${r.questionsUsed} of ${TQ_MAX_QUESTIONS} delivered. Wait for their answer; do not ask again this turn.`;
    if (slotsLeft(r) === 0) note += ' That was your LAST slot.';
    return note;
  }

  if (tu.name === 'guess') {
    const a = String(input.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!a) return 'Empty guess; nothing happened. Call guess() again with the thing you are guessing.';
    if (r.awaitingReply) return 'Your last question is still unanswered. Wait for their reply first. Do not mention this correction in chat.';
    const res = applyGuess(r, a);
    if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
    await ctx.speakLine(`My guess: ${a}.`);
    push(s);
    let note = `Guess announced (that cost a slot; ${slotsLeft(r)} left). Wait for them to confirm or deny; do not guess again this turn.`;
    if (slotsLeft(r) === 0) note += ' That was your LAST slot.';
    return note;
  }

  if (tu.name === 'answer') {
    const verdictRaw = String(input.verdict ?? '').toLowerCase();
    const verdict = (['yes', 'no', 'sortof'].includes(verdictRaw) ? verdictRaw : null) as TQVerdict | null;
    if (!verdict) return 'The verdict must be yes, no, or sortof. Call answer() again.';
    const fallbackReply = verdict === 'yes' ? 'Yes.' : verdict === 'no' ? 'No.' : 'Sort of.';
    const reply = String(input.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || fallbackReply;
    const res = applyAnswer(r, reply, verdict);
    if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
    await ctx.speakLine(reply);
    push(s);
    if (outOfQuestions(r)) {
      const fin = resolveKeeperExhaustion(r);
      if (fin.ok) {
        afterRoundEnd(s);
        return (
          `Answer delivered, and that was their ${TQ_MAX_QUESTIONS}th and final question. They never got it: ` +
          `the round is YOURS and the secret was "${r.secret}". Say so now, in character, in one or two short lines.`
        );
      }
    }
    return `Answer delivered (${r.questionsUsed} of ${TQ_MAX_QUESTIONS} used).`;
  }

  if (tu.name === 'reveal') {
    if (r.mode === 'guesser') {
      const res = resolveGuesserReveal(r, String(input.secret ?? ''));
      if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
      afterRoundEnd(s);
      return 'The round is yours. Take your bow in one short line if you have not already.';
    }
    const playerGotIt = input.player_got_it === true;
    const res = resolveKeeperReveal(r, playerGotIt);
    if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
    afterRoundEnd(s);
    return playerGotIt
      ? `Honest of you: ${ctx.playerName} got it and takes the round. React in one short line if you have not already.`
      : `You put the secret on the table; the round is yours since they gave up. Tell them what it was in your own words.`;
  }

  if (tu.name === 'forfeit') {
    const secretWas = r.mode === 'keeper' ? r.secret : null;
    const res = applyForfeit(r);
    if (!res.ok) return `${res.error} Do not mention this correction in chat.`;
    afterRoundEnd(s);
    return secretWas
      ? `You give up the round; ${ctx.playerName} takes it. Tell them the secret was "${secretWas}" in your own words if you have not already.`
      : `You give up the round; ${ctx.playerName} takes it. Say your parting line if you have not already.`;
  }

  if (tu.name === 'new_round') {
    if (s.status !== 'active') return 'The game is over.';
    if (!r.over) return 'The current round is not over yet.';
    startNextRound(s);
    return `Round ${s.roundState.round} is set up. Do not open it yourself; you will get a moment to kick it off right after this.`;
  }

  if (tu.name === 'remember') {
    const memText = String((input as { text?: string })?.text ?? '').trim();
    if (memText) {
      try {
        await appendMemory(path.join(paths.memoryDir(s.characterId), 'MEMORY.md'), memText);
        return 'Saved. Continue; do not mention saving it.';
      } catch {
        return 'Could not save it. Continue.';
      }
    }
    return 'Nothing saved; the text was empty.';
  }

  return `The tool "${tu.name}" is not available right now.`;
}

/** Everything down; called from app shutdown. */
export async function shutdownTwentyQ(): Promise<void> {
  for (const s of sessions.values()) {
    try { s.turnCtrl?.abort(); } catch { /* already down */ }
    flushChatBuffer(s);
    s.queue?.dispose();
    s.queue = null;
  }
  sessions.clear();
}
