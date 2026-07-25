/**
 * Screen-share ("watch") activity service (main process): the character
 * watches the player's screen and reacts like a duo partner on the couch.
 *
 * Follows the chess session shape (one session per character on the
 * game-agnostic FSM core from src/bot/brain/fsm.js), with a capture loop in
 * place of a board:
 *   P1  sei:chat_received  player message(s); consecutive sends coalesce into
 *                          ONE reply turn (chatBuffer drained at dispatch).
 *   P2  sei:frame          a change-worthy frame passed the gate; run ONE
 *                          image turn over it. Frames are held in memory only
 *                          and discarded the moment the turn takes them.
 *   P3  sei:idle           sampled 45-120s of couch quiet (silent-streak
 *                          backoff); a line is OPTIONAL, silence is normal.
 *
 * Speech model: on frame and idle turns the model's plain text output is a
 * PRIVATE scratchpad — only the say() tool reaches chat, and no tool call at
 * all is silence (the normal outcome). Player chat replies use the normal chat
 * contract (text is the reply), same as the board games. note() maintains a
 * rolling ~2KB session summary (oldest-first eviction) so frame turns carry
 * cheap text context instead of image history.
 *
 * Capture (src/main/watch/capture.ts, injected through deps for tests):
 * desktopCapturer thumbnails polled every 3s in main. The change gate
 * (changeGate.ts, pure) decides which frames are worth an LLM look. Frames
 * are never written to disk.
 *
 * Mutual exclusion: a watch session cannot start while the character is
 * summoned in Minecraft or has an open chess game; conversely a
 * summon or a board-game start ends the watch session (guards live in
 * src/main/ipc.ts, mirroring the summon-side guard).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatSendResult } from '../../shared/ipc';
import type {
  WatchEndReason,
  WatchPreviewPush,
  WatchSessionState,
} from '../../shared/watchIpc';
import {
  WATCH_ERR_CREDITS,
  WATCH_ERR_GAME_ACTIVE,
  WATCH_ERR_MC_ACTIVE,
  WATCH_ERR_SOURCE_GONE,
} from '../../shared/watchIpc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildSystemBlocks, markLastMessageCached, REMEMBER_TOOL } from '../chat/chatPrompts';
import { readChatContext, foldIfDue } from '../chat/continuity';
import {
  splitReply,
  toMessages,
  CHAT_ABORTED,
  isSilenceFiller,
  TRANSCRIPT_STOP_SEQUENCES,
} from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { createPriorityQueue, Priority } from '../../bot/brain/fsm.js';
import { isCallActive } from '../voice/callState';
import { clampChatLanguage } from '../../shared/chatLanguage';
import {
  DEFAULT_GATE_CONFIG,
  decideSend,
  initialGateState,
  isBlankFrame,
  meanAbsDiff,
  reactionIsStale,
  unpromptedSayAllowed,
  type CapturedFrame,
  type GateState,
} from './changeGate';
import { getOrCreateWatchProfile, type WatchProfile } from './watchProfile';

// ── deps + module state ──────────────────────────────────────────────────────

export interface WatchDeps {
  pushState: (state: WatchSessionState) => void;
  pushPreview: (p: WatchPreviewPush) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** True when the character has a live Minecraft session (mutually exclusive). */
  isSummoned: (characterId: string) => boolean;
  /** True when the character has an open chess game (mutually exclusive). */
  isGameActive: (characterId: string) => boolean;
  /**
   * Cloud credit pre-flight, same contract as the summon gate: true = refuse
   * the start. Self-guards for BYOK / signed-out / errors (fail OPEN). Absent
   * = no gate (tests).
   */
  creditsDepleted?: () => Promise<boolean>;
  /** Raise the out-of-playtime surface when the pre-flight refuses. */
  onCreditsDepleted?: () => void;
  /** Frame capture, injected so tests never load Electron. */
  captureFrame?: (sourceId: string) => Promise<CapturedFrame | null>;
}

/** Minimal typed view of the fsm.js priority queue. */
interface WatchQueue {
  enqueue: (priority: number, event: string, data?: unknown) => void;
  resetIdleTimer: () => void;
  dispose: () => void;
}

type TurnKind = 'frame' | 'chat-reply' | 'idle';

interface ChatBufferEntry {
  voiceCall: boolean;
  resolve: (r: ChatSendResult) => void;
}

interface Session {
  sessionId: string;
  characterId: string;
  sourceId: string;
  sourceName: string;
  sourceKind: 'window' | 'screen';
  status: 'active' | 'ended';
  startedAt: number;
  framesSent: number;
  blank: boolean;
  endedReason?: WatchEndReason;
  profile: WatchProfile;
  queue: WatchQueue | null;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  /** Consecutive polls where the source produced nothing (window closed). */
  missedPolls: number;
  /** Consecutive all-black polls (macOS permission signal). */
  blankPolls: number;
  gate: GateState;
  /** Tiny grayscale of the LAST FRAME SENT to the LLM (gate baseline). */
  lastSentGray: Uint8Array | null;
  /** Tiny grayscale of the newest poll (staleness check only). */
  latestGray: Uint8Array | null;
  /** The frame awaiting its LLM turn. Cleared the moment the turn takes it. */
  pendingFrame: CapturedFrame | null;
  frameQueued: boolean;
  /** Rolling session notes (note() tool), capped; oldest evicted first. */
  notes: string[];
  /** The character's last few say() lines, for frame-turn context. */
  recentSay: string[];
  lastUnpromptedSayAt: number;
  chatBuffer: ChatBufferEntry[];
  idleStreak: number;
  lastActivityAt: number;
  turnCtrl: AbortController | null;
  /** Bumps ONLY when the session ends; in-flight turns treat a bump as abort. */
  turnSeq: number;
  inFlightKind: TurnKind | null;
}

/** Timing knobs. Exported and mutable for tests only; not user copy. */
export const WATCH_TIMING = {
  pollMs: 3_000,
  idleMinMs: 45_000,
  idleMaxMs: 120_000,
  /** Idle cadence multiplier cap from consecutive silent ticks. */
  idleBackoffCap: 4,
  /** Consecutive black polls before the permission walkthrough reopens. */
  blankPollThreshold: 3,
  /** Consecutive empty captures before the session ends 'source-lost'. */
  missedPollThreshold: 3,
  /** Sessions shorter than this end silently (no transcript/memory row). */
  minLoggedSessionMs: 30_000,
};

/** Change-gate parameters. Exported and mutable for tests only. */
export const WATCH_GATE = { ...DEFAULT_GATE_CONFIG };

const NOTES_CAP_BYTES = 2_048;
const RECENT_SAY_KEEP = 3;
const WATCH_MAX_HOPS = 3;
const TURN_TIMEOUT_MS = 60_000;

const sessions = new Map<string, Session>();
let deps: WatchDeps | null = null;

export function initWatchService(d: WatchDeps): void {
  deps = d;
}

function requireDeps(): WatchDeps {
  if (!deps) throw new Error('watch service not initialized');
  return deps;
}

async function doCapture(sourceId: string): Promise<CapturedFrame | null> {
  const d = requireDeps();
  if (d.captureFrame) return await d.captureFrame(sourceId);
  const { captureFrame } = await import('./capture');
  return await captureFrame(sourceId);
}

// ── snapshots ────────────────────────────────────────────────────────────────

function snapshot(s: Session): WatchSessionState {
  return {
    sessionId: s.sessionId,
    characterId: s.characterId,
    status: s.status,
    sourceName: s.sourceName,
    sourceKind: s.sourceKind,
    startedAt: s.startedAt,
    framesSent: s.framesSent,
    blank: s.blank,
    ...(s.endedReason ? { endedReason: s.endedReason } : {}),
  };
}

function push(s: Session): WatchSessionState {
  const state = snapshot(s);
  requireDeps().pushState(state);
  return state;
}

// ── public api (wired to IPC handlers) ──────────────────────────────────────

export function isWatchActive(characterId: string): boolean {
  const s = sessions.get(characterId);
  return !!s && s.status !== 'ended';
}

export function getWatchState(characterId: string): WatchSessionState | null {
  const s = sessions.get(characterId);
  return s ? snapshot(s) : null;
}

export async function startWatch(
  characterId: string,
  sourceId: string,
): Promise<WatchSessionState> {
  const d = requireDeps();
  if (d.isSummoned(characterId)) {
    throw new Error(`${WATCH_ERR_MC_ACTIVE}: disconnect the Minecraft session to share your screen`);
  }
  if (d.isGameActive(characterId)) {
    throw new Error(`${WATCH_ERR_GAME_ACTIVE}: close the open game to share your screen`);
  }
  const existing = sessions.get(characterId);
  if (existing && existing.status !== 'ended') {
    if (existing.sourceId === sourceId) return snapshot(existing);
    // A new pick replaces the old session cleanly.
    endSession(existing, 'stopped', { silent: true });
  }

  // Cloud credit pre-flight: same fail-open contract as the summon gate;
  // skipped entirely for BYOK (creditsDepleted self-guards on backend kind).
  if (d.creditsDepleted) {
    let depleted = false;
    try {
      depleted = await d.creditsDepleted();
    } catch {
      depleted = false; // fail OPEN
    }
    if (depleted) {
      d.onCreditsDepleted?.();
      throw new Error(`${WATCH_ERR_CREDITS}: out of playtime`);
    }
  }

  // Validate the pick with one capture before committing (the window can
  // vanish between the picker snapshot and the click). Its name is display
  // truth for the whole session.
  const first = await doCapture(sourceId);
  if (!first) {
    throw new Error(`${WATCH_ERR_SOURCE_GONE}: that window is no longer available`);
  }

  const profile = await getOrCreateWatchProfile(characterId);
  const s: Session = {
    sessionId: randomUUID(),
    characterId,
    sourceId,
    sourceName: await resolveSourceName(sourceId),
    sourceKind: sourceId.startsWith('screen:') ? 'screen' : 'window',
    status: 'active',
    startedAt: Date.now(),
    framesSent: 0,
    blank: false,
    profile,
    queue: null,
    pollTimer: null,
    polling: false,
    missedPolls: 0,
    blankPolls: 0,
    gate: initialGateState(),
    lastSentGray: null,
    latestGray: null,
    pendingFrame: null,
    frameQueued: false,
    notes: [],
    recentSay: [],
    lastUnpromptedSayAt: 0,
    chatBuffer: [],
    idleStreak: 0,
    lastActivityAt: Date.now(),
    turnCtrl: null,
    turnSeq: 0,
    inFlightKind: null,
  };
  s.queue = createPriorityQueue({
    idleFallbackMs: () => sampleIdleDelayMs(s),
    onDispatch: (event: string, _data: unknown, _signal: AbortSignal) => dispatchWatch(s, event),
    onPreempt: (event: string) => {
      // A fresh player message may abort an in-flight IDLE turn (cheap
      // chatter, the reply matters more). Never a frame turn or a reply.
      if (event === 'sei:chat_received' && s.inFlightKind === 'idle') {
        try { s.turnCtrl?.abort(); } catch { /* already done */ }
      }
      return false; // never claim; the event still queues
    },
    logger: console,
  }) as WatchQueue;
  sessions.set(characterId, s);

  // Feed the validated first capture straight through the poll path (it seeds
  // the preview and, via the gate's first-frame rule, the opening look).
  ingestFrame(s, first);
  s.pollTimer = setInterval(() => void pollTick(s), WATCH_TIMING.pollMs);

  return push(s);
}

export async function stopWatch(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') endSession(s, 'stopped');
  sessions.delete(characterId);
}

/**
 * A Minecraft summon or a board-game start took the character over. Ends the
 * session quietly if it was short, with the normal transcript row otherwise.
 */
export async function endWatchForTakeover(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s) return;
  if (s.status !== 'ended') endSession(s, 'superseded');
  sessions.delete(characterId);
}

// ── chat routing ─────────────────────────────────────────────────────────────

/**
 * A player chat message while a watch session is open. Returns null when watch
 * should NOT handle it (no session / ended) so ipc falls through to the normal
 * chat path. The message lands in the chat log immediately, then rides the
 * session queue at P1: consecutive sends coalesce into one reply turn.
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
    if (!s.queue) {
      flushChatBuffer(s);
      return;
    }
    s.queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', { playerSpoke: true });
  });
}

// ── capture loop ─────────────────────────────────────────────────────────────

async function pollTick(s: Session): Promise<void> {
  if (s.status !== 'active' || s.polling) return;
  s.polling = true;
  try {
    const frame = await doCapture(s.sourceId);
    if (s.status !== 'active') return;
    if (!frame) {
      s.missedPolls++;
      if (s.missedPolls >= WATCH_TIMING.missedPollThreshold) {
        endSession(s, 'source-lost');
      }
      return;
    }
    s.missedPolls = 0;
    ingestFrame(s, frame);
  } catch (err) {
    console.warn(`[sei/watch] poll failed: ${(err as Error).message}`);
  } finally {
    s.polling = false;
  }
}

/** Preview push + blank detection + the change gate, for one captured frame. */
function ingestFrame(s: Session, frame: CapturedFrame): void {
  const d = requireDeps();
  s.latestGray = frame.gray;
  d.pushPreview({
    characterId: s.characterId,
    thumbnailDataUrl: frame.previewDataUrl,
    ts: frame.capturedAt,
  });

  // All-black capture = macOS Screen Recording permission missing. Surface it
  // (the renderer reopens the walkthrough) instead of burning LLM turns on
  // black rectangles.
  if (isBlankFrame(frame.gray)) {
    s.blankPolls++;
    if (!s.blank && s.blankPolls >= WATCH_TIMING.blankPollThreshold) {
      s.blank = true;
      push(s);
    }
    return;
  }
  if (s.blank || s.blankPolls > 0) {
    s.blankPolls = 0;
    if (s.blank) {
      s.blank = false;
      push(s);
    }
  }

  const delta = s.lastSentGray ? meanAbsDiff(frame.gray, s.lastSentGray) : 255;
  const decision = decideSend(s.gate, WATCH_GATE, delta, frame.capturedAt);
  s.gate = decision.next;
  if (!decision.send) return;

  s.lastSentGray = frame.gray;
  s.pendingFrame = frame;
  if (!s.frameQueued) {
    s.frameQueued = true;
    s.queue?.enqueue(Priority.P2_MOVEMENT, 'sei:frame', {});
  }
}

// ── fsm dispatch ─────────────────────────────────────────────────────────────

async function dispatchWatch(s: Session, event: string): Promise<void> {
  if (s.status === 'ended') {
    flushChatBuffer(s);
    return;
  }
  try {
    if (event === 'sei:frame') await dispatchFrame(s);
    else if (event === 'sei:chat_received') await dispatchChat(s);
    else if (event === 'sei:idle') await dispatchIdle(s);
  } finally {
    // Idle re-arms itself (enqueues reset the timer; a dispatch does not).
    if (event === 'sei:idle') s.queue?.resetIdleTimer();
  }
}

async function dispatchFrame(s: Session): Promise<void> {
  const frame = s.pendingFrame;
  s.pendingFrame = null; // the frame never outlives its turn
  s.frameQueued = false;
  if (!frame || s.status !== 'active') return;
  s.framesSent++;
  push(s);
  try {
    await runWatchLlmTurn(s, { kind: 'frame', frame, voiceCall: isCallActive(s.characterId) });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/watch] frame turn failed: ${describeErr(err)}`);
    }
  }
}

async function dispatchChat(s: Session): Promise<void> {
  const entries = s.chatBuffer.splice(0);
  if (entries.length === 0) return; // coalesced into an earlier dispatch
  const voiceCall = entries.some((e) => e.voiceCall) || isCallActive(s.characterId);
  // The reply sees the CURRENT screen (fresh capture, best-effort): "look at
  // this" must be answerable. Never persisted; discarded with the turn.
  let frame: CapturedFrame | null = null;
  try {
    frame = await doCapture(s.sourceId);
  } catch {
    frame = null;
  }
  if (frame && isBlankFrame(frame.gray)) frame = null;
  let replies: ChatMessage[] = [];
  try {
    replies = await runWatchLlmTurn(s, { kind: 'chat-reply', frame, voiceCall });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/watch] chat reply failed: ${describeErr(err)}`);
    }
  }
  // streamed: true — every reply line was already persisted AND pushed live
  // over the chat:message push inside runWatchLlmTurn. Without the flag the
  // renderer's reveal loop re-appends result.replies on top of the pushed
  // copies, so every gameplay reply rendered twice (260721).
  for (const e of entries) e.resolve({ replies, streamed: true });
}

async function dispatchIdle(s: Session): Promise<void> {
  if (s.status !== 'active') return;
  if (s.chatBuffer.length > 0) return; // a reply turn is about to run anyway
  if (s.blank) return; // nothing on screen to talk about
  let replies: ChatMessage[] = [];
  try {
    replies = await runWatchLlmTurn(s, { kind: 'idle', frame: null, voiceCall: isCallActive(s.characterId) });
  } catch (err) {
    if ((err as Error).message !== CHAT_ABORTED) {
      console.warn(`[sei/watch] idle turn failed: ${describeErr(err)}`);
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
  const T = WATCH_TIMING;
  const base = T.idleMinMs + Math.random() * Math.max(0, T.idleMaxMs - T.idleMinMs);
  return base * Math.min(1 + s.idleStreak, T.idleBackoffCap);
}

// ── session end ──────────────────────────────────────────────────────────────

function endSession(s: Session, reason: WatchEndReason, opts?: { silent?: boolean }): void {
  s.turnSeq++;
  try { s.turnCtrl?.abort(); } catch { /* already done */ }
  s.turnCtrl = null;
  if (s.pollTimer) clearInterval(s.pollTimer);
  s.pollTimer = null;
  s.pendingFrame = null;
  s.lastSentGray = null;
  s.latestGray = null;
  s.status = 'ended';
  s.endedReason = reason;
  flushChatBuffer(s);
  s.queue?.dispose();
  s.queue = null;
  push(s);

  const durationMs = Date.now() - s.startedAt;
  if (opts?.silent || durationMs < WATCH_TIMING.minLoggedSessionMs) return;

  // Transcript event ("You and X watched your screen") — same shape the
  // Minecraft/chess sessions append, rendered with the gamepad icon. Playtime
  // accounting keys on event.kind 'play' + durationMs.
  void (async () => {
    let name = 'your companion';
    try {
      const c = await getCharacter(s.characterId);
      if (c?.name) name = c.name;
    } catch { /* generic name */ }
    const ev: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      text: `You and ${name} watched your screen together for ${formatWatchDuration(durationMs)}.`,
      ts: Date.now(),
      event: { kind: 'play', game: 'Screen share', durationMs },
    } as ChatMessage;
    try {
      await chatStore.appendMessage(s.characterId, ev);
      requireDeps().pushChatMessage(s.characterId, ev);
    } catch { /* best-effort */ }
  })();

  // Memory: one line in the character's own ledger about the session.
  void (async () => {
    try {
      const config = await loadConfig();
      const player = (config.preferred_name ?? '').trim() || 'the player';
      const gist = s.notes.length ? ` (${s.notes[s.notes.length - 1]})` : '';
      await mkdir(paths.memoryDir(s.characterId), { recursive: true });
      await appendMemory(
        path.join(paths.memoryDir(s.characterId), 'MEMORY.md'),
        `watched ${player}'s screen with them for ${formatWatchDuration(durationMs)}: ${s.sourceName}${gist}`,
      );
    } catch { /* best-effort */ }
  })();
}

/** Human phrase for a session length (mirrors the play-row phrasing). */
function formatWatchDuration(ms: number): string {
  if (ms < 60_000) return 'a few minutes';
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return `${h} hour${h === 1 ? '' : 's'}`;
}

async function resolveSourceName(sourceId: string): Promise<string> {
  const d = requireDeps();
  if (d.captureFrame) return sourceId; // tests: the id doubles as the name
  try {
    const { listSources } = await import('./capture');
    const all = await listSources();
    return all.find((x) => x.id === sourceId)?.name ?? 'your screen';
  } catch {
    return 'your screen';
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

// ── notes (the rolling session summary) ──────────────────────────────────────

function addNote(s: Session, text: string): void {
  const line = text.trim().slice(0, 300);
  if (!line) return;
  s.notes.push(line);
  // Cap ~2KB, oldest-first eviction.
  let total = s.notes.reduce((n, t) => n + t.length + 1, 0);
  while (total > NOTES_CAP_BYTES && s.notes.length > 1) {
    total -= s.notes.shift()!.length + 1;
  }
}

// ── the LLM turn ─────────────────────────────────────────────────────────────

const SAY_TOOL = {
  name: 'say',
  description:
    'Say one short line to the player in the chat. This is the ONLY way your words reach them on frame ' +
    'and quiet turns: plain text output is your private scratchpad and is never shown. ' +
    'One line per call; call it only when the moment genuinely deserves it.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The line to say, short, in your own voice.' },
    },
    required: ['text'],
  },
};

const NOTE_TOOL = {
  name: 'note',
  description:
    'Jot one short line into your private notes for THIS watching session: what is happening, names, the ' +
    'score, a running gag worth calling back to. The player never sees these; they are your own context for ' +
    'later frames. Notes from this session are shown back to you each turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The note line.' },
    },
    required: ['text'],
  },
};

function buildWatchBlock(s: Session, kind: TurnKind, playerName: string, hasImage: boolean): string {
  const lines: string[] = [];
  lines.push('# SCREEN SHARE');
  lines.push(
    `${playerName} is sharing their screen with you inside the Sei app: "${s.sourceName}", usually a game. ` +
      'You are on the couch next to them, watching them play. You are watching, not narrating: most frames ' +
      'deserve no comment at all, and silence is the normal outcome. Speak only when something is genuinely ' +
      'funny, impressive, dangerous, or new. Running gags and callbacks are gold. Never describe the screen ' +
      'back to them; they are looking at it. Keep lines short like your usual texting.',
  );
  const hypeLine =
    s.profile.hype <= 2
      ? 'You are a quiet watcher: long silences, the occasional dry line.'
      : s.profile.hype >= 4
        ? 'You are a vocal watcher: quick reactions, but still only when a moment earns one.'
        : 'You are an even-keeled watcher: comment on real moments, stay quiet otherwise.';
  lines.push(`Your watching style: ${hypeLine}${s.profile.styleNote ? ` ${s.profile.styleNote}` : ''}`);

  if (s.notes.length) {
    lines.push(
      'Your own notes from this session so far (oldest first):\n' +
        s.notes.map((n) => `- ${n}`).join('\n'),
    );
  }
  if (s.recentSay.length) {
    lines.push(
      'The last things you said while watching (do not repeat yourself):\n' +
        s.recentSay.map((t) => `- ${t}`).join('\n'),
    );
  }

  if (kind === 'frame') {
    lines.push(
      'The image is the current snapshot of their screen. Plain text output is your private scratchpad; only ' +
        'the say() tool reaches the chat. If nothing deserves a line, call no tools at all and the moment ' +
        'passes in comfortable silence. Use note() to keep track of what is happening for later.',
    );
  } else if (kind === 'idle') {
    lines.push(
      'Nothing on the screen has changed in a while. A line is OPTIONAL: if you have one short in-character ' +
        'line genuinely worth saying (a callback, a needle, a mood), say it with say(). Otherwise call no ' +
        'tools at all: silence on the couch is normal.',
    );
  } else {
    lines.push(
      hasImage
        ? `${playerName} is talking to you while playing. The image is what their screen looks like right now; ` +
          'use it when the message is about the game. Reply in your normal texting voice.'
        : `${playerName} is talking to you while playing. Reply in your normal texting voice.`,
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

/** postProcessSay-style normalization for a say() line (bot orchestrator twin). */
export function normalizeSayLine(text: string): string {
  return String(text ?? '')
    .replace(/[—–]/g, '-')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256);
}

interface TurnOpts {
  kind: TurnKind;
  frame: CapturedFrame | null;
  voiceCall: boolean;
}

/**
 * Run one watch LLM turn.
 *   'frame'      — one image, notes + recent lines as text context; say() is
 *                  the only voice, no tool call = silence. Reactions to a
 *                  frame that has gone stale (older than 10s AND the screen
 *                  diverged hard since) are dropped, not spoken.
 *   'chat-reply' — normal chat contract (text is the reply) with the live
 *                  screen attached when available.
 *   'idle'       — quiet-couch tick; a say() line is optional.
 * Returns the persisted companion messages.
 */
async function runWatchLlmTurn(s: Session, opts: TurnOpts): Promise<ChatMessage[]> {
  const d = requireDeps();
  const character = await getCharacter(s.characterId);
  if (!character) throw new Error('character not found');
  const config = await loadConfig();
  const playerName = (config.preferred_name ?? '').trim() || 'the player';
  s.inFlightKind = opts.kind;

  const isReply = opts.kind === 'chat-reply';
  const [{ summary, history }, memory] = isReply
    ? await Promise.all([readChatContext(s.characterId), readMemoryTail(s.characterId)])
    : [{ summary: '', history: [] as ChatMessage[] }, await readMemoryTail(s.characterId)];

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
  // Appended AFTER the cache-marked persona/status blocks so the stable prefix
  // stays cached while the per-turn watch view re-bills (it is small).
  system.push({
    type: 'text',
    text: buildWatchBlock(s, opts.kind, playerName, opts.frame !== null),
  });

  const imageBlock = (frame: CapturedFrame): unknown => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: frame.jpegBase64 },
  });

  let messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  if (isReply) {
    messages = toMessages(history.slice(-30));
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: '(watch) (go on)' });
    }
    if (opts.frame) {
      const last = messages[messages.length - 1];
      const text = typeof last.content === 'string' ? last.content : '';
      last.content = [
        imageBlock(opts.frame),
        { type: 'text', text: text || '(watch) (their live screen is attached)' },
      ];
    }
    markLastMessageCached(messages);
  } else if (opts.kind === 'frame' && opts.frame) {
    messages = [
      {
        role: 'user',
        content: [
          imageBlock(opts.frame),
          {
            type: 'text',
            text: '(watch) (a new snapshot of the screen; react only if it deserves it)',
          },
        ],
      },
    ];
  } else {
    messages = [
      {
        role: 'user',
        content: '(watch) (the couch is quiet; say something only if it is worth saying)',
      },
    ];
  }

  const ctrl = new AbortController();
  s.turnCtrl = ctrl;
  const seq = s.turnSeq;
  const stale = (): boolean => s.turnSeq !== seq || ctrl.signal.aborted;
  const timeout = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);

  const tools: Anthropic.Messages.Tool[] = isReply
    ? ([NOTE_TOOL, REMEMBER_TOOL] as Anthropic.Messages.Tool[])
    : ([SAY_TOOL, NOTE_TOOL] as Anthropic.Messages.Tool[]);

  const punctuation = character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual';
  const spoken: ChatMessage[] = [];
  const bufferLine = (raw: string): void => {
    // Silence sentinel drop (260721): the frame/idle prompts sanction saying
    // nothing, and models act that out by WRITING "(silence)"-style fillers
    // (as a say() line or a filler-shaped reply) instead of staying quiet.
    // A sentinel line is no message at all: not buffered, not persisted, not
    // pushed. Checked on the RAW text BEFORE normalizeSayLine, which strips
    // asterisks and would turn "*stays silent*" into a real-looking line.
    // Same choke point covers say() lines and chat-reply text.
    if (isSilenceFiller(raw)) return;
    const part = normalizeSayLine(raw);
    if (!part || isSilenceFiller(part)) return;
    spoken.push({
      id: randomUUID(),
      role: 'companion',
      text: part,
      ts: Date.now() + spoken.length,
      ...(opts.voiceCall ? { voice: true } : {}),
    });
  };

  try {
    const { client, model } = await buildChatSdk();
    let sayCount = 0;

    for (let hop = 0; hop < WATCH_MAX_HOPS && !stale(); hop++) {
      // stop_sequences (260722): reply-turn text is spoken verbatim, so the
      // model may not continue the transcript past its own turn (see the
      // chess voice-call leak note on TRANSCRIPT_STOP_SEQUENCES).
      const res = await client.messages.create(
        {
          model,
          max_tokens: 300,
          system,
          tools,
          stop_sequences: TRANSCRIPT_STOP_SEQUENCES,
          messages: messages as never,
        },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const u = res.usage;
      console.log(
        `[sei/watch] turn char=${s.characterId.slice(0, 8)} kind=${opts.kind} hop=${hop} ` +
          `in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
      );
      if (stale()) break;

      const text = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      // Reply turns: the text IS the reply (normal chat contract). Frame/idle
      // turns: text is a private scratchpad; only say() speaks.
      if (isReply && text) {
        for (const part of splitReply(text, punctuation)) bufferLine(part);
      }

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let note: string;
        if (tu.name === 'say' && !isReply) {
          const rawSay = String((tu.input as { text?: string })?.text ?? '');
          // A say() whose whole text is the silence sentinel is the model
          // acting out "silence is fine": treat it as not speaking at all
          // (no line, no say budget consumed).
          const line = isSilenceFiller(rawSay) ? '' : normalizeSayLine(rawSay);
          if (!line) {
            note = 'Nothing said; the line was empty.';
          } else if (spoken.length === 0 && !unpromptedSayAllowed(s.lastUnpromptedSayAt, Date.now())) {
            // Min 20s between unprompted lines. Once a turn has cleared the
            // cooldown its follow-up line (sayCount 2 cap) rides along.
            note = 'Too soon after your last line. Stay quiet this time; the moment will come back.';
          } else if (sayCount >= 2) {
            note = 'That is enough lines for one moment. Let the screen breathe.';
          } else {
            sayCount++;
            bufferLine(line);
            note = 'Said. Do not repeat it.';
          }
        } else if (tu.name === 'note') {
          const memText = String((tu.input as { text?: string })?.text ?? '').trim();
          if (memText) {
            addNote(s, memText);
            note = 'Noted for this session. Continue; do not mention it.';
          } else {
            note = 'Nothing noted; the text was empty.';
          }
        } else if (tu.name === 'remember' && isReply) {
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
    }

    if (stale()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }

    // Stale-reaction drop: the frame this turn reacted to is gone (older than
    // the staleness window AND the screen has diverged hard since). Speaking
    // now would comment on a moment nobody is looking at.
    if (
      opts.kind === 'frame' &&
      opts.frame &&
      s.latestGray &&
      spoken.length > 0 &&
      reactionIsStale(
        opts.frame.capturedAt,
        Date.now(),
        meanAbsDiff(s.latestGray, opts.frame.gray),
        WATCH_GATE,
      )
    ) {
      console.log('[sei/watch] dropped a stale frame reaction (screen moved on)');
      spoken.length = 0;
    }

    for (const msg of spoken) {
      msg.ts = Date.now();
      await chatStore.appendMessage(s.characterId, msg);
      d.pushChatMessage(s.characterId, msg);
      s.lastActivityAt = Date.now();
      s.recentSay.push(msg.text);
    }
    while (s.recentSay.length > RECENT_SAY_KEEP) s.recentSay.shift();
    if (spoken.length > 0 && !isReply) s.lastUnpromptedSayAt = Date.now();

    if (isReply) void foldIfDue(s.characterId, character.persona.expanded).catch(() => {});
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

/** Everything down; called from app shutdown. */
export async function shutdownWatch(): Promise<void> {
  for (const s of sessions.values()) {
    if (s.status !== 'ended') endSession(s, 'stopped');
  }
  sessions.clear();
}
