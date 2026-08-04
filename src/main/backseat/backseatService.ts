/**
 * Backseat service (260728) — session state, tick arbitration, and the
 * companion turn runner.
 *
 * The renderer raises ticks; this module decides which of them become speech.
 * That split matters: the three triggers fire at wildly different rates and
 * have no idea about each other, so all of the "should the companion actually
 * talk right now" judgement has to live in one place, and this is it.
 *
 * ── Tick arbitration ────────────────────────────────────────────────────
 *
 * One turn in flight per session, ever. Which tick wins is a strict priority
 * ladder (PRIORITY below), and the ordering is the whole point: the more
 * specific the reason for looking, the more it deserves the turn.
 *
 *   'user'  the player spoke. Being spoken to and ignored is the one failure
 *           they definitely notice, so it preempts anything and ignores
 *           MIN_SPEAK_GAP_MS.
 *   'start' the share just opened, once per session. Below 'user' rather than
 *           equal to it, so a player who says something while the first look
 *           is still running gets answered instead of talked over.
 *   'jolt'  something measurable changed on screen or in the sound. Preempts a
 *           scheduled look, because a reaction to the thing that just happened
 *           beats an idle glance at the same six seconds.
 *   'idle'  the scheduled look. Preempts nothing.
 *
 * A tick that cannot preempt is DROPPED, never queued. A queued reaction
 * arrives describing a moment that has passed, which reads as the companion
 * being confused rather than late.
 *
 * Silence is a first-class outcome: most ticks end with the model replying
 * "(silence)", which is parsed out and never persisted or spoken.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../../shared/ipc';
import {
  MIN_SPEAK_GAP_MS,
  PREV_GRID_MAX_AGE_MS,
  type BackseatLine,
  type BackseatMode,
  type BackseatState,
  type BackseatTick,
} from '../../shared/backseatIpc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildSystemBlocks, markMessageCached, REMEMBER_TOOL } from '../chat/chatPrompts';
import { toMessages, isSilenceFiller, splitReply } from '../chat/chatService';
import { readChatContext, foldIfDue } from '../chat/continuity';
import { playSummaryText } from '../chat/playSummary';
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import { surfaceLanguage } from '../../shared/chatLanguage';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import * as chatStore from '../chat/chatStore';
import type { LogBatch } from '../../shared/ipc';
import { BACKSEAT_CONTRACT, SAVE_CLIP_TOOL, stripDashes, tickNote } from './backseatPrompts';
import { createBackseatLog, NULL_BACKSEAT_LOG, type BackseatLog } from './backseatLog';

/**
 * Tick priority. Strictly ordered: a tick preempts an in-flight turn only when
 * its priority is higher, and is dropped otherwise.
 */
const PRIORITY: Record<BackseatTick['kind'], number> = { user: 4, start: 3, jolt: 2, idle: 1 };

const MEMORY_BUDGET_BYTES = 12000;
/** Transcript window. Backseat turns are frequent and short, so the same
 *  reasoning as voice applies: memory and the rolling summary carry the long
 *  arc, and a small verbatim tail keeps the per-tick prefill cheap. */
const RECENT_CAP = 12;
/** Lines kept for the overlay's mini chat. */
const LINE_TAIL = 30;
/** How long a clip request waits on the renderer before giving up. */
const CLIP_TIMEOUT_MS = 12_000;
/** The one surface constant that is genuinely a per-surface tier: backseat
 *  runs at the reactive tier like chat, chess and voice. */
const BACKSEAT_PROACTIVENESS = 1;

export interface BackseatDeps {
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  pushState: (state: BackseatState) => void;
  pushLine: (characterId: string, line: BackseatLine) => void;
  requestClip: (characterId: string, requestId: string) => void;
  /** True when a voice call is open, so replies are spoken rather than shown. */
  isCallActive?: (characterId: string) => boolean;
  /** Batched log lines into the in-app developer console (LogsBar), same
   *  pipeline as bot/chess/draw logs. */
  pushLog?: (batch: LogBatch) => void;
}

interface Session {
  characterId: string;
  state: BackseatState;
  /** Aborts the in-flight turn, if any. */
  inflight: AbortController | null;
  /** Kind of the in-flight turn, so a user tick knows what it may preempt. */
  inflightKind: BackseatTick['kind'] | null;
  lastSpokeAt: number;
  /** Pending clip harvests, keyed by requestId. */
  clips: Map<string, (b64: string | null) => void>;
  /** Set once a clip has been saved for the current moment, so a model that
   *  calls save_clip on two consecutive ticks about the same play does not
   *  produce two files. Cleared when the companion next stays quiet. */
  clipCooldownUntil: number;
  /**
   * Index into the chat history where this session's verbatim window starts.
   *
   * Prompt caching (260801): the obvious `history.slice(-RECENT_CAP)` slides
   * by one every time a line is appended, which changes the FIRST message in
   * the request and therefore invalidates the whole message prefix — a
   * guaranteed cache miss on every line the companion speaks. Holding the
   * start fixed and only re-anchoring once the window has grown to twice
   * RECENT_CAP makes the prefix byte-identical between ticks, which is the
   * only thing a breakpoint can actually exploit. Cost of the re-anchor is one
   * miss per RECENT_CAP lines instead of one per line.
   *
   * -1 until the first turn reads the history length.
   */
  historyAnchor: number;
  /**
   * The half-size copy of the grid the companion was looking at when it last
   * spoke, and when that was (260802). Sent alongside the next grid so the
   * model can tell what has moved on since its own last line.
   *
   * Held here rather than fetched from anywhere because there is nowhere to
   * fetch it from: the chat store has only ever held text, so without this the
   * companion's memory of what it has SEEN is exactly one image deep.
   */
  prevGrid: { data: string; at: number } | null;
  /** Per-session log into the in-app console + a rolling file (backseatLog). */
  log: BackseatLog;
}

const sessions = new Map<string, Session>();
let deps: BackseatDeps | null = null;

/**
 * Dev only: keep the most recent grid per kind on disk so a human can check
 * what the models are actually being shown (cell legibility, ordering, JPEG
 * artifacts). Overwrites in place — this is a peephole, not a recording.
 */
async function dumpGridForDev(kind: string, grid: string): Promise<void> {
  try {
    const { app } = await import('electron');
    if (app.isPackaged) return;
    const dir = path.join(app.getPath('userData'), 'backseat-debug');
    await mkdir(dir, { recursive: true });
    const b64 = grid.replace(/^data:image\/\w+;base64,/, '');
    await writeFile(path.join(dir, `grid-${kind}-latest.jpg`), Buffer.from(b64, 'base64'));
  } catch {
    /* debug aid only, never load-bearing */
  }
}

export function initBackseatService(d: BackseatDeps): void {
  deps = d;
}

function requireDeps(): BackseatDeps {
  if (!deps) throw new Error('backseat service not initialized');
  return deps;
}

/** One line to BOTH sinks: the terminal (prefixed) and the session's in-app
 *  console log. Every user-visible diagnostic in this module goes through
 *  here — a line that only reaches the terminal is invisible to anyone
 *  debugging from LogsBar (260728: the in-app console read empty for a whole
 *  session while the terminal had the full story). */
function slog(s: Session, msg: string, warn = false): void {
  (warn ? console.warn : console.log)(`[sei/backseat] ${msg}`);
  s.log.line(msg);
}

export function getBackseatState(characterId: string): BackseatState | null {
  return sessions.get(characterId)?.state ?? null;
}

function push(s: Session): void {
  requireDeps().pushState({ ...s.state, lines: [...s.state.lines] });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function startBackseat(
  characterId: string,
  sourceId: string,
  sourceName: string,
  mode: BackseatMode,
): Promise<BackseatState> {
  const existing = sessions.get(characterId);
  if (existing && existing.state.phase !== 'ended') await endBackseat(characterId);

  const character = await getCharacter(characterId);
  const log = await createBackseatLog(characterId, deps?.pushLog ?? (() => {}));
  const s: Session = {
    characterId,
    state: {
      characterId,
      phase: 'watching',
      mode,
      sourceName,
      aiName: character?.name ?? 'Your companion',
      lines: [],
      startedAt: Date.now(),
    },
    inflight: null,
    inflightKind: null,
    lastSpokeAt: 0,
    clips: new Map(),
    clipCooldownUntil: 0,
    historyAnchor: -1,
    prevGrid: null,
    log,
  };
  sessions.set(characterId, s);
  slog(s, `session start: mode=${mode}, source="${sourceName}"`);
  // 260803: main no longer opens a window here. The renderer starts capture
  // itself right after this resolves (useBackseatStore.share), which is what
  // lets the share be a call control rather than a launch.
  push(s);

  void (async () => {
    const { app } = await import('electron');
    if (!app.isPackaged) {
      slog(s, `dev grid dumps: ${path.join(app.getPath('userData'), 'backseat-debug')}`);
    }
  })().catch(() => {});

  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('backseat_started', {
        character_id: characterId,
        mode,
        source_kind: sourceId.startsWith('screen:') ? 'screen' : 'window',
      });
    } catch {
      /* analytics is never load-bearing */
    }
  })();

  return s.state;
}

export function setBackseatPaused(characterId: string, paused: boolean): void {
  const s = sessions.get(characterId);
  if (!s || s.state.phase === 'ended') return;
  s.state.phase = paused ? 'paused' : 'watching';
  // Pausing aborts whatever was mid-thought. The player pressed pause because
  // they stopped wanting commentary, and a line that lands two seconds later
  // is exactly the thing they were trying to stop.
  if (paused) {
    s.inflight?.abort();
    s.inflight = null;
    s.inflightKind = null;
  }
  push(s);
}

export async function endBackseat(characterId: string): Promise<void> {
  const s = sessions.get(characterId);
  if (!s || s.state.phase === 'ended') return;
  s.inflight?.abort();
  s.inflight = null;
  s.state.phase = 'ended';
  const durationMs = Date.now() - s.state.startedAt;
  const lineCount = s.state.lines.length;
  // Unresolved clip harvests would otherwise keep their promises alive.
  for (const resolve of s.clips.values()) resolve(null);
  s.clips.clear();
  push(s);
  sessions.delete(characterId);
  slog(
    s,
    `session end: ${Math.round(durationMs / 1000)}s, ${lineCount} line(s) said`,
  );
  try {
    const { stopAudioTap } = await import('./audioTap');
    stopAudioTap();
  } catch {
    /* tap never ran */
  }
  void (async () => {
    try {
      const { capture } = await import('../analytics');
      // duration_ms is the load-bearing key name: the analytics dashboard sums
      // playtime across every event in SESSION_EVENTS by that field.
      capture('backseat_ended', {
        character_id: characterId,
        duration_ms: durationMs,
        mode: s.state.mode,
        lines: lineCount,
      });
    } catch {
      /* analytics is never load-bearing */
    }
  })();

  // Continuity, OUT/short-term: one play row so the session exists in the
  // rolling summary, then the fold. Without this the companion watches an hour
  // of someone's game and afterwards has no idea it happened.
  try {
    // One shape for every game surface (src/main/chat/playSummary.ts). The
    // window name is deliberately dropped with the rest of the detail; what
    // survives is that the two of them spent the time together.
    const character = await getCharacter(characterId);
    const row: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      ts: Date.now(),
      text: playSummaryText(
        character?.name ?? 'your companion',
        'Backseat',
        durationMs,
        // The row is PERSISTED transcript content, so it is written in the
        // language the two of them talk in, not the current UI language.
        // playSummaryText only has a zh wording; every other language falls
        // back to the English sentence, same as Draw!.
        surfaceLanguage(character?.metadata, (await loadConfig()).chat_language) === 'zh'
          ? 'zh'
          : undefined,
      ),
      event: { kind: 'play', game: 'Backseat', durationMs },
    };
    await chatStore.appendMessage(characterId, row);
    requireDeps().pushChatMessage(characterId, row);
    if (character) void foldIfDue(characterId, character.persona.expanded).catch(() => {});
  } catch (err) {
    slog(s, `play row failed: ${(err as Error).message}`, true);
  }
  void s.log.close().catch(() => {});
}

/**
 * The player started talking over a line that is still generating (260804).
 *
 * Without this the barge-in only silences what has already been synthesised:
 * the turn behind it keeps running and its line arrives a second later, which
 * is the companion finishing the sentence the player interrupted. The abort is
 * enough on its own — runTurn checks `s.inflight !== ctrl` after the call and
 * returns without speaking or persisting.
 *
 * Deliberately NOT a phase change. The session stays live and the next tick,
 * which is almost always the player's own words, runs normally.
 */
export function interruptBackseat(characterId: string): void {
  const s = sessions.get(characterId);
  if (!s || !s.inflight) return;
  slog(s, `${s.inflightKind ?? 'idle'} turn aborted: the player started talking`);
  s.inflight.abort();
  s.inflight = null;
  s.inflightKind = null;
}

/** Drop every session (renderer death/reload — capture cannot outlive it). */
export function clearAllBackseat(): void {
  for (const id of [...sessions.keys()]) void endBackseat(id).catch(() => {});
}

// ── Clips ─────────────────────────────────────────────────────────────────

/** Answer to a backseat:clip-request. `b64` is null when capture could not
 *  produce a segment. */
export function receiveClip(characterId: string, requestId: string, b64: string | null): void {
  const s = sessions.get(characterId);
  const resolve = s?.clips.get(requestId);
  if (!resolve) return;
  s!.clips.delete(requestId);
  resolve(b64);
}

async function harvestClip(s: Session): Promise<string | null> {
  const requestId = randomUUID();
  const got = new Promise<string | null>((resolve) => {
    s.clips.set(requestId, resolve);
    setTimeout(() => {
      if (s.clips.delete(requestId)) resolve(null);
    }, CLIP_TIMEOUT_MS);
  });
  requireDeps().requestClip(s.characterId, requestId);
  const b64 = await got;
  if (!b64) return null;
  try {
    const dir = path.join(paths.profileRoot(), 'clips', s.characterId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
    await writeFile(file, Buffer.from(b64, 'base64'));
    return file;
  } catch (err) {
    slog(s, `clip write failed: ${(err as Error).message}`, true);
    return null;
  }
}

// ── Turn runner ───────────────────────────────────────────────────────────

async function readMemoryTail(characterId: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(characterId), 'MEMORY.md'), 'utf8');
    return humanizeMemoryStamps(
      raw.length <= MEMORY_BUDGET_BYTES ? raw : raw.slice(-MEMORY_BUDGET_BYTES),
    );
  } catch {
    return '';
  }
}

/**
 * Continuity, OUT/long-term: remember() writes to the same per-character
 * MEMORY.md that chat, voice, chess and the bot all share. Honored inline
 * because a backseat tick is a single-shot call with no tool loop, and an
 * un-honored tool call is a silently dropped write.
 */
async function honorRemember(
  s: Session,
  content: Anthropic.Messages.ContentBlock[],
): Promise<void> {
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'remember') continue;
    const text = String((b.input as { text?: string })?.text ?? '').trim();
    if (!text) continue;
    try {
      await appendMemory(path.join(paths.memoryDir(s.characterId), 'MEMORY.md'), text);
    } catch (err) {
      slog(s, `remember() failed: ${(err as Error).message}`, true);
    }
  }
}

export async function handleTick(tick: BackseatTick): Promise<void> {
  const s = sessions.get(tick.characterId);
  if (!s) return;
  if (s.state.phase === 'ended') return;
  // Paused holds everything, including user ticks: the overlay's chat input is
  // disabled while paused, so a user tick arriving here is a race with the
  // button, and honoring it would speak right after the player asked for quiet.
  if (s.state.phase === 'paused') return;

  const isUser = tick.kind === 'user';
  const label = tick.kind + (tick.joltReason ? `:${tick.joltReason}` : '');

  // Being talked to always earns an answer, so a user tick skips the speak-gap
  // floor. Everything else respects it: two lines about the same six seconds
  // is worse than one.
  if (!isUser && Date.now() - s.lastSpokeAt < MIN_SPEAK_GAP_MS) {
    slog(s, `tick ${label} dropped (spoke ${((Date.now() - s.lastSpokeAt) / 1000).toFixed(1)}s ago)`);
    return;
  }

  if (s.inflight) {
    const running = s.inflightKind ?? 'idle';
    if (PRIORITY[tick.kind] <= PRIORITY[running]) {
      slog(s, `tick ${label} dropped (${running} turn in flight)`);
      return;
    }
    slog(s, `tick ${label} preempts in-flight ${running} turn`);
    s.inflight.abort();
    s.inflight = null;
    s.inflightKind = null;
  }
  slog(s, `tick ${label} -> turn`);
  void dumpGridForDev(tick.kind, tick.grid);

  // The player's typed line is real conversation: persist it to the shared
  // chat thread (so the main window shows it and the NEXT turn's history has
  // the player's side), and echo it into the overlay's mini chat. Without this
  // the transcript read like the companion talking to itself (260728 live).
  //
  // The row is voice-flagged on a call, exactly as the companion's own reply
  // below is. That was missing, and it became visible the moment user turns
  // started routing through here: a spoken utterance is transcribed, so a chat
  // row is a CAPTION of something already said aloud, and the thread filled
  // with the player's own half of the call (reported live). `voice` is
  // the existing answer to that (see ChatMessage.voice): the row is still
  // persisted, and the model still reads it as history, it is only hidden from
  // the transcript, which shows the "You and X called for Y" summary instead.
  if (isUser && tick.text) {
    const onCall = requireDeps().isCallActive?.(s.characterId) === true;
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: tick.text,
      ts: Date.now(),
      ...(onCall ? { voice: true } : {}),
    };
    try {
      await chatStore.appendMessage(s.characterId, msg);
    } catch (err) {
      slog(s, `player line persist failed: ${(err as Error).message}`, true);
    }
    const d = requireDeps();
    d.pushChatMessage(s.characterId, msg);
    const line: BackseatLine = { id: msg.id, text: msg.text, at: msg.ts, who: 'player' };
    s.state.lines.push(line);
    while (s.state.lines.length > LINE_TAIL) s.state.lines.shift();
    d.pushLine(s.characterId, line);
  }

  const ctrl = new AbortController();
  s.inflight = ctrl;
  s.inflightKind = tick.kind;
  try {
    await runTurn(s, tick, ctrl);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name !== 'AbortError' && !/abort/i.test(e?.message ?? '')) {
      slog(s, `turn failed: ${e?.message}`, true);
    }
  } finally {
    if (s.inflight === ctrl) {
      s.inflight = null;
      s.inflightKind = null;
    }
  }
}

async function runTurn(s: Session, tick: BackseatTick, ctrl: AbortController): Promise<void> {
  const character = await getCharacter(s.characterId);
  if (!character) return;
  const config = await loadConfig();
  const [{ summary, history }, memory, knowledge] = await Promise.all([
    readChatContext(s.characterId),
    readMemoryTail(s.characterId),
    readKnowledgeForPrompt(s.characterId).catch(() => ''),
  ]);

  const voiceCall = requireDeps().isCallActive?.(s.characterId) === true;
  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness: BACKSEAT_PROACTIVENESS,
    punctuation:
      character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual',
    memory,
    summary,
    knowledge,
    openWorldDetected: false,
    inGame: false,
    voiceCall,
    // A character pinned to a language speaks it on EVERY surface, so this
    // reads the pin first and falls back to the auto-detected conversation
    // language, the same as chat, voice, chess and Draw!.
    language: surfaceLanguage(character.metadata, config.chat_language),
    // The whole-session contract rides inside the cached region, so the grid
    // explanation and the register are written once and read every tick.
    extraStable: BACKSEAT_CONTRACT,
  } as Parameters<typeof buildSystemBlocks>[0]);

  // Verbatim window, anchored rather than sliding (see Session.historyAnchor).
  // A sliding tail changes messages[0] every time a line lands, which throws
  // away the entire message-prefix cache; re-anchoring only when the window has
  // doubled costs one miss per RECENT_CAP lines instead of one per line.
  if (s.historyAnchor < 0 || history.length - s.historyAnchor > RECENT_CAP * 2) {
    s.historyAnchor = Math.max(0, history.length - RECENT_CAP);
  }
  // On a user tick the player's line was just persisted (handleTick), so it is
  // also the tail of `history`; drop that copy — the canonical one goes inline
  // below with the grid attached, and the model must not read it twice.
  let recent = history.slice(s.historyAnchor);
  if (tick.kind === 'user' && tick.text) {
    const last = recent[recent.length - 1];
    if (last && last.role === 'user' && last.text === tick.text) recent = recent.slice(0, -1);
  }
  const messages = toMessages(recent);
  // Prompt caching (260801), and the reason this is NOT markLastMessageCached.
  // buildSystemBlocks already spent three of Anthropic's four breakpoints. The
  // fourth belongs HERE, at the end of the history, not on the message below:
  // that message carries a fresh ~1548-token grid and a note unique to this
  // tick, so a breakpoint on it writes ~1600 tokens at the 1.25x write
  // multiplier every single tick and can never read one of them back. Marking
  // the history instead makes system + transcript a cache READ per tick and
  // leaves the image as plain input, written nowhere.
  markMessageCached(messages, messages.length - 1);

  // The player's own line is a real user message; a gate/jolt tick is not, so
  // it is framed as a system note. Either way the grid is attached to the same
  // turn, and images go BEFORE text (Anthropic's documented ordering).
  // The previous grid, when there is a usable one. It goes FIRST, so the model
  // reads the old picture and then the new one in that order, and it sits after
  // the cache breakpoint as plain input: moving it above the breakpoint would
  // change the message array's shape every tick and invalidate the entire
  // prefix to save 396 tokens.
  const prevAge = s.prevGrid ? Date.now() - s.prevGrid.at : Infinity;
  const prev = prevAge <= PREV_GRID_MAX_AGE_MS ? s.prevGrid : null;

  const note = tickNote({
    kind: tick.kind,
    joltReason: tick.joltReason,
    secondsSinceLastLine: s.lastSpokeAt ? (Date.now() - s.lastSpokeAt) / 1000 : null,
    sourceName: s.state.sourceName,
    transcript: tick.transcript,
    shareLabel: tick.shareLabel,
    frameAges: tick.frameAges,
    secondsSincePrevGrid: prev ? prevAge / 1000 : undefined,
  });
  const strip = (d: string): string => d.replace(/^data:image\/\w+;base64,/, '');
  const image = (data: string): unknown => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data },
  });
  const content: unknown[] = [
    ...(prev ? [image(strip(prev.data))] : []),
    image(strip(tick.grid)),
    { type: 'text', text: tick.kind === 'user' ? `${note}\n\n${tick.text ?? ''}` : note },
  ];
  messages.push({ role: 'user', content: content as never });

  const { client, model } = await buildChatSdk();
  const res = await client.messages.create(
    {
      model,
      // Two short lines. A cap this low is itself a register control: it is
      // hard to write a paragraph in 160 tokens. 260804: a tick the player
      // SPOKE gets room for a real answer, because this is now the only turn
      // they get — the director routes their utterance here rather than running
      // a second, screenless one alongside it.
      max_tokens: tick.kind === 'user' ? 400 : 160,
      system,
      tools: [SAVE_CLIP_TOOL, REMEMBER_TOOL],
      messages: messages as never,
    },
    { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
  );
  if (ctrl.signal.aborted || s.inflight !== ctrl) return;

  // The cache layout above is only worth anything if it hits, and the only way
  // to know is to read it back. cacheRead should dominate within a session;
  // cacheWrite staying high tick after tick means the prefix is churning.
  const u = res.usage as unknown as {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  slog(
    s,
    `turn ${tick.kind}: in=${u?.input_tokens ?? 0} cacheRead=${u?.cache_read_input_tokens ?? 0} ` +
      `cacheWrite=${u?.cache_creation_input_tokens ?? 0}`,
  );

  await honorRemember(s, res.content);

  // stripDashes because asking did not work: the contract has forbidden em
  // dashes since 260802 and the model still writes them in most lines, and
  // these lines are spoken aloud where a dash has no sound.
  const replyText = stripDashes(
    res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
  );

  // 260802: silence is no longer an outcome the prompts offer, so reaching here
  // means the model ignored an explicit instruction (or returned nothing at
  // all). The parse STAYS, because without it a stray "(silence)" would be
  // spoken aloud in a voice call, but it is now an anomaly worth counting
  // rather than the expected path — if this line shows up often in a session
  // log, the contract is not landing and the fix is the prompt, not the parse.
  if (!replyText || isSilenceFiller(replyText)) {
    slog(
      s,
      `turn ${tick.kind}: NO LINE despite always-speak` +
        (replyText ? ` ("${replyText.slice(0, 60)}")` : ' (empty reply)'),
    );
    s.clipCooldownUntil = 0;
    return;
  }

  const clipCall = res.content.find(
    (b) => b.type === 'tool_use' && b.name === 'save_clip',
  ) as Anthropic.Messages.ToolUseBlock | undefined;
  let clip: { path: string; reason: string } | null = null;
  if (clipCall && Date.now() >= s.clipCooldownUntil) {
    // One clip per moment: the model reliably calls save_clip again on the very
    // next tick about the same play, and two files for one highlight is worse
    // than none.
    s.clipCooldownUntil = Date.now() + 30_000;
    const file = await harvestClip(s);
    if (file) {
      clip = {
        path: file,
        reason: String((clipCall.input as { reason?: string })?.reason ?? '').trim() || 'that bit',
      };
    }
  }

  s.lastSpokeAt = Date.now();
  // What the companion was looking at when it wrote this line, for the next
  // turn to compare against. Set only on a turn that produced a line, so the
  // prompt's "what you were looking at when you last spoke" stays true.
  if (tick.gridSmall) s.prevGrid = { data: tick.gridSmall, at: tick.capturedAt };
  const parts = splitReply(replyText, character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual')
    .filter((t) => t && !isSilenceFiller(t));
  if (!parts.length) return;
  slog(s, `turn ${tick.kind}: said ${parts.length} line(s)${clip ? ' + clip' : ''}`);

  const d = requireDeps();
  const now = Date.now();
  for (let i = 0; i < parts.length; i++) {
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'companion',
      text: parts[i],
      ts: now + i,
      // In voice mode the line is spoken by the live call and hidden from the
      // transcript, exactly as every other call line is.
      ...(voiceCall ? { voice: true } : {}),
      // The clip rides on the last part so it renders under the whole thought.
      ...(clip && i === parts.length - 1 ? { clip } : {}),
    };
    await chatStore.appendMessage(s.characterId, msg);
    d.pushChatMessage(s.characterId, msg);
    // The overlay's mini chat is fed separately: it shows lines in BOTH modes
    // (voice included, where the transcript deliberately hides them) because
    // the overlay is the only thing on screen while a game is fullscreen.
    const line: BackseatLine = {
      id: msg.id,
      text: msg.text,
      at: msg.ts,
      ...(clip && i === parts.length - 1 ? { clipPath: clip.path } : {}),
    };
    s.state.lines.push(line);
    while (s.state.lines.length > LINE_TAIL) s.state.lines.shift();
    d.pushLine(s.characterId, line);
  }
  push(s);
}
