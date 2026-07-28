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
 * One turn in flight per session, ever. Beyond that:
 *
 *   'user'  always runs. Being spoken to and ignored is the one failure the
 *           player definitely notices, so a user tick ABORTS an in-flight
 *           gate/jolt turn and takes its place: a reaction to six seconds ago
 *           is worth less than an answer to the question just asked.
 *   'gate'  and 'jolt' are dropped whenever a turn is already running, when
 *           the session is paused, or when the companion spoke less than
 *           MIN_SPEAK_GAP_MS ago. They are never queued. A queued reaction
 *           arrives describing a moment that has passed, which reads as the
 *           companion being confused rather than late.
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
  type BackseatLine,
  type BackseatMode,
  type BackseatState,
  type BackseatTick,
} from '../../shared/backseatIpc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildSystemBlocks, markLastMessageCached, REMEMBER_TOOL } from '../chat/chatPrompts';
import { toMessages, isSilenceFiller, splitReply } from '../chat/chatService';
import { readChatContext, foldIfDue } from '../chat/continuity';
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import { clampChatLanguage } from '../../shared/chatLanguage';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import * as chatStore from '../chat/chatStore';
import { BACKSEAT_CONTRACT, SAVE_CLIP_TOOL, tickNote } from './backseatPrompts';
import { gateGrid, resetGateWindow } from './salienceGate';

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
}

const sessions = new Map<string, Session>();
let deps: BackseatDeps | null = null;

export function initBackseatService(d: BackseatDeps): void {
  deps = d;
}

function requireDeps(): BackseatDeps {
  if (!deps) throw new Error('backseat service not initialized');
  return deps;
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
  };
  sessions.set(characterId, s);
  resetGateWindow(characterId);
  // The overlay window is not decoration: it is the renderer that owns the
  // capture pipeline, because it is the only one guaranteed to stay visible
  // (and therefore unthrottled) while the player is in a fullscreen game.
  const { openBackseatOverlay } = await import('../backseatOverlay');
  openBackseatOverlay({ characterId, sourceId, mode });
  push(s);

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
  resetGateWindow(characterId);
  try {
    const { closeBackseatOverlay } = await import('../backseatOverlay');
    closeBackseatOverlay();
  } catch {
    /* the window may already be gone */
  }
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
    const minutes = Math.max(1, Math.round(durationMs / 60000));
    const row: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      ts: Date.now(),
      text: `You watched ${minutes === 1 ? 'a minute' : `${minutes} minutes`} of ${s.state.sourceName || 'their game'} together.`,
      event: { kind: 'play', game: 'Backseat', durationMs },
    };
    await chatStore.appendMessage(characterId, row);
    requireDeps().pushChatMessage(characterId, row);
    const character = await getCharacter(characterId);
    if (character) void foldIfDue(characterId, character.persona.expanded).catch(() => {});
  } catch (err) {
    console.warn(`[sei] backseat play row failed: ${(err as Error).message}`);
  }
}

/** Drop every session (renderer death/reload — capture cannot outlive it). */
export function clearAllBackseat(): void {
  for (const id of [...sessions.keys()]) void endBackseat(id).catch(() => {});
}

// ── The gate passthrough ──────────────────────────────────────────────────

export async function askGate(
  characterId: string,
  grid: string,
  transcript?: string,
): Promise<boolean> {
  const s = sessions.get(characterId);
  if (!s || s.state.phase !== 'watching') return false;
  // Spending a gate call while the companion is barred from speaking anyway
  // is pure waste, and it also skews the adaptive threshold's window with
  // grids that could never have produced a line.
  if (Date.now() - s.lastSpokeAt < MIN_SPEAK_GAP_MS) return false;
  if (s.inflight) return false;
  return await gateGrid(characterId, grid, transcript);
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
    console.warn(`[sei] backseat clip write failed: ${(err as Error).message}`);
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
  characterId: string,
  content: Anthropic.Messages.ContentBlock[],
): Promise<void> {
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'remember') continue;
    const text = String((b.input as { text?: string })?.text ?? '').trim();
    if (!text) continue;
    try {
      await appendMemory(path.join(paths.memoryDir(characterId), 'MEMORY.md'), text);
    } catch (err) {
      console.warn(`[sei] backseat remember() failed: ${(err as Error).message}`);
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
  if (!isUser) {
    if (s.inflight) return;
    if (Date.now() - s.lastSpokeAt < MIN_SPEAK_GAP_MS) return;
  } else if (s.inflight && s.inflightKind !== 'user') {
    // Preempt a reaction with an answer.
    s.inflight.abort();
    s.inflight = null;
    s.inflightKind = null;
  } else if (s.inflight) {
    return;
  }

  const ctrl = new AbortController();
  s.inflight = ctrl;
  s.inflightKind = tick.kind;
  try {
    await runTurn(s, tick, ctrl);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name !== 'AbortError' && !/abort/i.test(e?.message ?? '')) {
      console.warn(`[sei] backseat turn failed: ${e?.message}`);
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
    language: clampChatLanguage(config.chat_language),
    // The whole-session contract rides inside the cached region, so the grid
    // explanation and the register are written once and read every tick.
    extraStable: BACKSEAT_CONTRACT,
  } as Parameters<typeof buildSystemBlocks>[0]);

  const messages = toMessages(history.slice(-RECENT_CAP));

  // The player's own line is a real user message; a gate/jolt tick is not, so
  // it is framed as a system note. Either way the grid is attached to the same
  // turn, and images go BEFORE text (Anthropic's documented ordering).
  const note = tickNote({
    kind: tick.kind,
    joltReason: tick.joltReason,
    secondsSinceLastLine: s.lastSpokeAt ? (Date.now() - s.lastSpokeAt) / 1000 : null,
    sourceName: s.state.sourceName,
    transcript: tick.transcript,
  });
  const base64 = tick.grid.replace(/^data:image\/\w+;base64,/, '');
  const content: unknown[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
    { type: 'text', text: tick.kind === 'user' ? `${note}\n\n${tick.text ?? ''}` : note },
  ];
  messages.push({ role: 'user', content: content as never });
  markLastMessageCached(messages);

  const { client, model } = await buildChatSdk();
  const res = await client.messages.create(
    {
      model,
      // Two short lines. A cap this low is itself a register control: it is
      // hard to write a paragraph in 160 tokens.
      max_tokens: 160,
      system,
      tools: [SAVE_CLIP_TOOL, REMEMBER_TOOL],
      messages: messages as never,
    },
    { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
  );
  if (ctrl.signal.aborted || s.inflight !== ctrl) return;

  await honorRemember(s.characterId, res.content);

  const replyText = res.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // Silence is the normal outcome. Note this does NOT reset lastSpokeAt, so a
  // quiet turn does not start a new gap; the companion stays as available as
  // it was before the tick.
  if (!replyText || isSilenceFiller(replyText)) {
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
  const parts = splitReply(replyText, character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual')
    .filter((t) => t && !isSilenceFiller(t));
  if (!parts.length) return;

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
