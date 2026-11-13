/**
 * The "next time" hook for sessions the PLAYER ends (261011, retention O2).
 *
 * T80 (261008, sessionGoodbye.ts + src/bot/brain/nextStep.js) lets the
 * companion's own goodbye carry a `next_time` field that is saved to MEMORY.md
 * as `Plan for next time: <step>`, and the next greeting may bring it up. But
 * most sessions are ended by the player (Stop, closing the world, hanging
 * up), and those have no goodbye turn: on the first day of 0.6.8 the hook was
 * set on 2 of 40 calls and 1 of 33 game sessions.
 *
 * So after a player-ended session with real content, main runs ONE small
 * background call on the session's own provider (cloud = Haiku through the
 * proxy, which counts against the allowance: max PLAYER_END_MAX_TOKENS out,
 * a compact input) that answers with a short plan tied to a real unfinished
 * goal or remembered thing, or `none`. A plan is saved exactly the way T80
 * saves one, so NEXT_TIME_GREETING already covers the next greeting. Nothing
 * is spoken: the player already left.
 *
 * Rules this module keeps:
 *   - It never blocks anything. Callers fire and forget; the whole run is
 *     time-boxed (PLAYER_END_TIMEOUT_MS, or the provider's own local floor for
 *     Ollama and friends, see providerTimeoutMs) and swallows every error.
 *   - It skips trivial sessions (under PLAYER_END_MIN_MS, or fewer than two
 *     player lines and no goal), offline sessions, and a cloud account over
 *     its limit (cloudOverLimit, so no credit wall is ever raised; a 402 from
 *     the call itself is swallowed too, never routed to the usage popup).
 *   - One check per character at a time, and at most one per
 *     DEDUPE_WINDOW_MS: a backseat share ends with its call, and both ends
 *     would otherwise each pay for a check.
 *   - A new session for the character aborts a check still running on a
 *     LOCAL model (Ollama), so the next session never waits behind it on the
 *     same GPU. Remote checks are left to finish: they cost the next session
 *     nothing and the plan is still useful for the one after.
 *   - Account switch: the run is a scoped turn, so a plan whose call
 *     straddles a switch is dropped instead of landing in the next account.
 *
 * Analytics: shape only, never the plan text or any transcript.
 * `next_step_checked {character_id, source:'player_end', surface, game?,
 * saved, outcome, reached_model, duration_s}` for every check, plus
 * `next_step_saved {character_id, source:'player_end', surface, game?}` when a
 * plan was written. 261107 (O2 reach): a check skipped before the model
 * (trivial, offline, over_limit, busy, no_character) used to send nothing,
 * so a session that never got a plan could not be told from one that was
 * never checked; every outcome is sent now, with `reached_model` saying
 * whether the call went out. Session ends that never run a check report
 * through reportNextStepNotRun (below), so there is one next_step_checked
 * per session end. The session's `_ended` event has already fired by then
 * (it is not delayed for this), so these are follow-ups; the companion path
 * keeps `next_step_hook` and gains `next_step_source: 'companion'` on the
 * `_ended` event itself (sessionGoodbye.ts).
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { LlmProvider } from './llm/types';
import { normalizeNextStep, nextStepMemoryLine, normalizePlayerLine } from '../bot/brain/nextStep.js';
import { PLAYER_END_NEXT_STEP_SYSTEM, PLAYER_END_RECAP_ADDENDUM } from '../bot/brain/promptLibrary.js';
import { gameDisplayName, gameIdFromName, nameInSentence } from '../shared/homeNextStep';
import { GAME_IDS, isGameId, type GameId } from '../shared/gameIpc';

/** 261107: 'chat' = a text-chat session (chatNextStep.ts). */
export type NextStepSurface = 'game' | 'call' | 'backseat' | 'chat';

export interface DigestLine {
  /** The human player, this companion, or a sibling companion. */
  who: 'player' | 'you' | 'other';
  text: string;
}

export interface SessionDigest {
  lines: DigestLine[];
  /** Lines the player spoke over the whole session (not just the window). */
  playerLines: number;
  selfLines: number;
}

/** A session shorter than this is not worth a call. */
export const PLAYER_END_MIN_MS = 2 * 60_000;
/** The time box for the whole check on a remote model. */
export const PLAYER_END_TIMEOUT_MS = 15_000;
/** The plan is a few words; this caps a runaway reply. */
export const PLAYER_END_MAX_TOKENS = 150;
/**
 * 261113 (v0.7 D1): a game session's check also writes the session's recap
 * (50 words or less, about 80 tokens) ahead of the plan lines.
 */
export const PLAYER_END_RECAP_MAX_TOKENS = 400;
/** A second end for the same character inside this window is skipped. */
export const DEDUPE_WINDOW_MS = 60_000;

/**
 * Digest lines the check reads (and keeps from the bot's report). 261113:
 * 16 -> 40 with the bot's DIGEST_MAX_LINES, so a recap covers more than the
 * goodbye at the end of a session.
 */
const MAX_LINES = 40;
const LINE_CHARS = 200;
const MAX_GOALS = 5;
const MAX_MEMORIES = 8;
const MEMORY_CHARS = 200;

/** Game end reasons that mean the player ended it. */
const PLAYER_ENDED_GAME_REASONS = new Set(['user_stop', 'world_closed', 'disconnected']);

export function isPlayerEndedGame(reason: string | undefined): boolean {
  return typeof reason === 'string' && PLAYER_ENDED_GAME_REASONS.has(reason);
}

/** Long enough, and either the player talked (`minPlayerLines`, default 2) or there was a goal. */
export function worthChecking(p: { durationMs: number; playerLines: number; goals: number; minPlayerLines?: number }): boolean {
  return p.durationMs >= PLAYER_END_MIN_MS && (p.playerLines >= (p.minPlayerLines ?? 2) || p.goals > 0);
}

// ── session digests from the bot port ─────────────────────────────────────

const digests = new Map<string, SessionDigest>();

function cleanLine(raw: unknown): DigestLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { who?: unknown; text?: unknown };
  if (typeof r.text !== 'string') return null;
  const text = r.text.replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS);
  if (!text) return null;
  const who = r.who === 'you' || r.who === 'other' ? r.who : 'player';
  return { who, text };
}

/** Validate a raw {type:'session-digest'} payload. null when unusable. */
export function parseSessionDigest(raw: unknown): SessionDigest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { lines?: unknown; playerLines?: unknown; selfLines?: unknown };
  if (!Array.isArray(r.lines)) return null;
  const lines = r.lines
    .slice(-MAX_LINES)
    .map(cleanLine)
    .filter((l): l is DigestLine => l !== null);
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { lines, playerLines: count(r.playerLines), selfLines: count(r.selfLines) };
}

/** The live bot posted its session digest (botSupervisor onSessionDigest). */
export function noteSessionDigest(characterId: string, raw: unknown): void {
  const d = parseSessionDigest(raw);
  if (d) digests.set(characterId, d);
}

/** Read and forget a character's digest (once per session close). */
export function takeSessionDigest(characterId: string): SessionDigest | null {
  const d = digests.get(characterId) ?? null;
  digests.delete(characterId);
  return d;
}

/** A new session went live: drop anything an earlier one left behind. */
export function clearSessionDigest(characterId: string): void {
  digests.delete(characterId);
}

// ── prompt ────────────────────────────────────────────────────────────────

/** Entry texts of a MEMORY.md / HEARTBEAT.md body, stamps removed, oldest first. */
export function entryTexts(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => l.startsWith('- ['))
    .map((l) => l.replace(/^- \[[^\]]*\]\s*/, '').trim())
    .filter(Boolean);
}

/** A MEMORY.md entry and the section it sits under ("World 2 — Sky Base (Minecraft)"), or null above the first section. */
export interface MemoryEntry {
  text: string;
  place: string | null;
}

/**
 * 261020: memory entries with their section. MEMORY.md is shared by every
 * game and the app, and its section headers are the only thing that says
 * where a memory is from. Without them the check read a Minecraft copper
 * bulb build as Stardew work (Stardew has copper too) and labeled the plan
 * Stardew.
 */
export function memoryEntries(body: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  let place: string | null = null;
  for (const l of body.split('\n')) {
    if (l.startsWith('## ')) {
      place = l.slice(3).trim() || null;
      continue;
    }
    if (!l.startsWith('- [')) continue;
    const text = l.replace(/^- \[[^\]]*\]\s*/, '').trim();
    if (text) out.push({ text, place });
  }
  return out;
}

/** The memories block: entries grouped under the place they are from, in order. */
function renderMemories(memories: Array<string | MemoryEntry>): string {
  const items = memories.slice(-MAX_MEMORIES).map((m) => (typeof m === 'string' ? { text: m, place: null } : m));
  if (!items.length) return '';
  const hasPlaces = items.some((m) => m.place);
  const out: string[] = [hasPlaces ? 'Some of your recent memories, under the heading of where each is from:' : 'Some of your recent memories:'];
  let place: string | null | undefined;
  for (const m of items) {
    if (hasPlaces && m.place !== place) {
      out.push(`${m.place ?? 'Earlier'}:`);
      place = m.place;
    }
    out.push(`- ${m.text.slice(0, MEMORY_CHARS)}`);
  }
  return out.join('\n');
}

function formatMinutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function speaker(l: DigestLine): string {
  if (l.who === 'you') return 'you';
  if (l.who === 'other') return 'another companion';
  return 'player';
}

export function buildPlayerEndPrompt(p: {
  name: string;
  activity: string;
  durationMs: number;
  lines: DigestLine[];
  goals: string[];
  memories: Array<string | MemoryEntry>;
  /** 261113: also ask for the session's recap (game sessions, see runSessionEnd). */
  recap?: boolean;
}): { system: string; user: string } {
  // {card_name}: the name as the Home card shows it ("red" reads "Red").
  const base = p.recap ? `${PLAYER_END_NEXT_STEP_SYSTEM}\n\n${PLAYER_END_RECAP_ADDENDUM}` : PLAYER_END_NEXT_STEP_SYSTEM;
  const system = base.split('{card_name}')
    .join(nameInSentence(p.name))
    .split('{name}')
    .join(p.name)
    .split('{games}')
    .join(gameList());
  const parts: string[] = [`Session: ${p.activity}, about ${formatMinutes(p.durationMs)}. The player ended it.`];
  const goals = p.goals.slice(-MAX_GOALS);
  parts.push(goals.length ? `Your goals when it ended:\n${goals.map((g) => `- ${g}`).join('\n')}` : 'Your goals when it ended: none.');
  const lines = p.lines.slice(-MAX_LINES);
  parts.push(
    lines.length
      ? `The end of the conversation, oldest first:\n${lines.map((l) => `${speaker(l)}: ${l.text}`).join('\n')}`
      : 'Nobody said anything near the end.',
  );
  const memories = renderMemories(p.memories);
  if (memories) parts.push(memories);
  parts.push(
    p.recap
      ? 'Reply with the recap: line first, then the three lines (note:, player: and game:) or the word none.'
      : 'Reply with the three lines (note:, player: and game:), or with none.',
  );
  return { system, user: parts.join('\n\n') };
}

/** One reply line as a plan note: quotes, a "Plan for next time:" lead and a trailing period dropped. */
function cleanNote(raw: string): string | null {
  let s = raw
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/^(plan for next time(?: in [^:]{1,60})?|next time|next step)\s*:\s*/i, '')
    .replace(/[.。]+$/, '')
    .trim();
  s = s.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  if (!s) return null;
  if (/^(none|nothing|no|n\/a)(?![a-z])/i.test(s) && s.split(/\s+/).length <= 3) return null;
  if (/^(无|没有|なし|없음)$/.test(s)) return null;
  return normalizeNextStep(s);
}

const LABELED = /^\s*[*_-]*\s*(note|player|game)\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/i;
/** A possible second label later on the same line ("note: x player: y"). */
const INLINE_LABEL = /\s+(?=[*_]*\s*(note|player|game)\s*[*_]*\s*[:：])/gi;
const LABEL_ORDER = ['note', 'player', 'game'];

/** A mid-line `game:` value that is really an answer: exactly a game's id or name, or none. */
function isExactGameAnswer(raw: string): boolean {
  const v = raw.replace(/^[\s*_"'“”‘’`]+|[\s*_"'“”‘’`.。]+$/g, '').trim();
  if (/^(none|no|n\/a|nothing|无|没有|なし|없음)$/i.test(v)) return true;
  const q = v.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return GAME_IDS.some((id) => q === id || q === gameDisplayName(id).toLowerCase().replace(/[^a-z0-9]+/g, ''));
}

/**
 * Where a labeled value ends because the next label starts, or -1.
 * 261020 (review): only a LATER label in the reply's order (note, player,
 * game) splits a line, and a `game:` only when what follows it is a game
 * answer, so "finish the board game: monopoly" stays one note. A label that
 * opens a line of its own elsewhere in the reply (`ownLine`) is never split
 * out mid-line, so "note: ask the player: how it went" above a real
 * `player:` line stays one note.
 */
function inlineLabelAt(label: string, value: string, ownLine: ReadonlySet<string>): number {
  const from = LABEL_ORDER.indexOf(label);
  for (const m of value.matchAll(INLINE_LABEL)) {
    const next = m[1].toLowerCase();
    if (LABEL_ORDER.indexOf(next) <= from || ownLine.has(next)) continue;
    const at = m.index ?? -1;
    if (at <= 0) continue;
    if (next === 'game') {
      const rest = LABELED.exec(value.slice(at))?.[2] ?? '';
      const end = rest.search(INLINE_LABEL);
      if (!isExactGameAnswer(end >= 0 ? rest.slice(0, end) : rest)) continue;
    }
    return at;
  }
  return -1;
}

/** "Minecraft, Stardew Valley or Don't Starve Together" for the prompt's {games}. */
function gameList(): string {
  const names = GAME_IDS.map(gameDisplayName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? '');
}

export interface PlayerEndPlan {
  /** The private note, saved to MEMORY.md as the plan. */
  step: string;
  /** The line written to the player for the Home strip; null when the model gave none. */
  line: string | null;
  /**
   * 261020: the game the step is done in, from the reply's `game:` line.
   * 'none' = the model said it is not about a game; null = no usable answer.
   */
  game: GameId | 'none' | null;
}

/** A `game:` answer as a game id, 'none', or null when it names no known game. */
export function parseGameAnswer(raw: string | null): GameId | 'none' | null {
  if (raw === null) return null;
  const v = raw.replace(/[\s*_"'“”‘’`.。]+$/g, '').replace(/^[\s*_"'“”‘’`]+/, '').trim();
  if (!v) return null;
  if (/^(none|no|n\/a|nothing|无|没有|なし|없음)$/i.test(v)) return 'none';
  return gameIdFromName(v);
}

/**
 * 261020: where a player-end plan belongs. The model's `game:` answer wins
 * when it names a bot game, even a different one from the session's: a plan
 * for a Minecraft build made in Stardew is a Minecraft plan, tagged so the
 * card offers Minecraft and labeled so the next Stardew session does not
 * read it as a Stardew task. 'none' keeps the session's surface with NO
 * game (review 261020: "ask how the interview went" after Minecraft was
 * tagged Minecraft, so Stardew never raised it and the card offered Play
 * Minecraft; now a game session's card offers the games picker, a backseat
 * one a call, and any game's greeting can raise it as talk). No answer keeps
 * the session, and a game session's plan names its game.
 */
export function resolvePlanPlace(
  session: { surface: NextStepSurface; game?: string },
  answer: GameId | 'none' | null,
): { surface: NextStepSurface; game?: string; memoryGame: GameId | null } {
  if (answer && answer !== 'none') return { surface: 'game', game: answer, memoryGame: answer };
  if (answer === 'none') return { surface: session.surface, memoryGame: null };
  const keep = { surface: session.surface, ...(session.game ? { game: session.game } : {}) };
  return { ...keep, memoryGame: session.surface === 'game' && isGameId(session.game) ? session.game : null };
}

/**
 * 261014: the model's answer, `note: ...` + `player: ...` lines, as a plan
 * and its player-facing line, or null for "none". A reply without labels (an
 * older prompt, a model that ignored the format) is read the old way: its
 * first line is the note and there is no player line. This parses stored
 * notes, not speech.
 */
export function parsePlayerEndReply(text: string): PlayerEndPlan | null {
  const lines: string[] = [];
  const rawLines = String(text ?? '').trim().split('\n');
  const ownLine = new Set(rawLines.map((l) => LABELED.exec(l)?.[1].toLowerCase() ?? ''));
  for (const first of rawLines) {
    // Several labels on one line: split it, so the note does not carry the
    // player line (261020: or the game line after it).
    let raw = first;
    for (;;) {
      const m = LABELED.exec(raw);
      if (m) {
        const at = inlineLabelAt(m[1].toLowerCase(), m[2], ownLine);
        if (at > 0) {
          lines.push(raw.slice(0, raw.length - m[2].length + at));
          raw = m[2].slice(at).trim();
          continue;
        }
      }
      lines.push(raw);
      break;
    }
  }
  let note: string | null = null;
  let player: string | null = null;
  let game: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = LABELED.exec(lines[i]);
    if (!m) continue;
    let value = m[2];
    // A label with its text on the next line.
    if (!value.trim()) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next !== undefined && !LABELED.test(next)) value = next;
    }
    // Markdown left around the value ("**note:** finish roof**").
    value = value.replace(/^[\s*_]+|[\s*_]+$/g, '');
    const label = m[1].toLowerCase();
    if (label === 'note' && note === null) note = value;
    else if (label === 'player' && player === null) player = value;
    else if (label === 'game' && game === null) game = value;
  }
  if (note === null && player === null) {
    // A bare "none" (or a reply that is only a game: line) is no plan.
    const first = lines.find((l) => !LABELED.test(l)) ?? '';
    const step = cleanNote(first);
    return step ? { step, line: null, game: parseGameAnswer(game) } : null;
  }
  const step = cleanNote(note || player || '');
  if (!step) return null;
  const line = player !== null && cleanNote(player) ? normalizePlayerLine(player) : null;
  return { step, line, game: parseGameAnswer(game) };
}

const RECAP_LABEL = /^\s*[*_-]*\s*recap\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/i;
/** A plan label opening later on the recap's own line ("recap: ... note: ..."). */
const INLINE_NOTE = /\s+(?=[*_]*\s*note\s*[*_]*\s*[:：])/i;
const BARE_NONE = /^[\s*_"'“”‘’`]*(none|nothing|no|n\/a|无|没有|なし|없음)[\s*_"'“”‘’`.。]*$/i;

/**
 * 261113 (v0.7 D1): a reply that leads with `recap: ...` (game sessions,
 * buildPlayerEndPrompt `recap`), split into the recap and the plan. The recap
 * runs from its label to the next labeled line, a bare "none" or a blank line
 * (a model that wraps it over two lines keeps both), and what is left is read
 * by parsePlayerEndReply exactly as before, so a recap line is never taken as
 * the plan note. No recap label: recap null, the whole reply is the plan.
 * This parses the labeled format the prompt asks for, not speech.
 */
export function parseSessionEndReply(text: string): { recap: string | null; plan: PlayerEndPlan | null } {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => RECAP_LABEL.test(l));
  if (at < 0) return { recap: null, plan: parsePlayerEndReply(text) };
  let first = RECAP_LABEL.exec(lines[at])![1];
  const rest: string[] = [...lines.slice(0, at)];
  const split = first.search(INLINE_NOTE);
  if (split > 0) {
    rest.push(first.slice(split).trim());
    first = first.slice(0, split);
  }
  const parts = [first];
  let i = at + 1;
  if (split <= 0) {
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        if (parts.join('').trim()) break;
        continue;
      }
      if (LABELED.test(l) || BARE_NONE.test(l)) break;
      parts.push(l);
    }
  }
  rest.push(...lines.slice(i));
  const recap = parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s*_"'“”‘’`]+|[\s*_"'“”‘’`]+$/g, '')
    .trim();
  return {
    recap: recap && !BARE_NONE.test(recap) ? recap : null,
    plan: parsePlayerEndReply(rest.join('\n')),
  };
}

/** The plan note alone (see parsePlayerEndReply), or null for "none". */
export function parseNextStepReply(text: string): string | null {
  return parsePlayerEndReply(text)?.step ?? null;
}

// ── the check ─────────────────────────────────────────────────────────────

export interface PlayerEndInput {
  characterId: string;
  surface: NextStepSurface;
  /** Analytics game id (minecraft, stardew, a backseat game id). */
  game?: string;
  /** What the session was, for the prompt ("playing Minecraft", "a voice call"). */
  activity: string;
  durationMs: number;
  lines: DigestLine[];
  playerLines: number;
  /** Read this game's goal file (HEARTBEAT[.game].md) for goals. Unset = no goals. */
  goalsGame?: string | null;
  /**
   * 261013 (T120): analytics `source`. 'app_quit' is a session the app quit
   * ended, checked on the next launch (quitNextStep.ts). Default 'player_end'.
   */
  source?: 'player_end' | 'app_quit';
  /** Extra shape-only props for the two events (T120: `late_hours`). */
  eventProps?: Record<string, string | number | boolean>;
  /** Fewer player lines than this (and no goal) is trivial. Default 2. */
  minPlayerLines?: number;
  /**
   * 261107: skip when the call would be paid by Sei for a free cloud account
   * (text chat: a check there is a new LLM call). Reported as `not_covered`
   * with `skip_reason: 'free_cloud'`.
   */
  skipOnFreeCloud?: boolean;
  /**
   * 261113 (v0.7 D1): also write the session's recap (runSessionEnd). Game
   * sessions only: their lines never reach the transcript, while a call's or
   * a chat's already do (and fold from there).
   */
  recap?: boolean;
}

/** runSessionEnd's answer: the check's outcome, plus the recap when one was asked for and given. */
export interface SessionEndResult {
  outcome: PlayerEndOutcome;
  recap: string | null;
}

export type PlayerEndOutcome =
  | 'saved'
  | 'none'
  | 'trivial'
  | 'offline'
  | 'over_limit'
  | 'busy'
  | 'timeout'
  | 'error'
  | 'cancelled'
  | 'no_character'
  | 'free_cloud';

export interface PlayerEndDeps {
  buildProvider(): Promise<LlmProvider>;
  /** Electron net.isOnline(); only consulted for remote providers. */
  isOnline(): boolean;
  /** Cloud account over its limit (fails open: false on any error / BYOK). */
  overLimit(): Promise<boolean>;
  /**
   * 261107: the check would be a cost to Sei, i.e. the cloud backend on the
   * free plan (or signed out). BYOK, local models, the ChatGPT plan and a
   * paid plan are false. Fails CLOSED: true on any error or slow read.
   * Only consulted for inputs with `skipOnFreeCloud`.
   */
  freeCloud(): Promise<boolean>;
  readText(file: string): Promise<string>;
  memoryFile(characterId: string): string;
  goalsFile(characterId: string, game: string): string;
  characterName(characterId: string): Promise<string | null>;
  /**
   * Append the plan line. false = not written (duplicate, scope moved).
   * 261020: `inGame` = it belongs under the session's world section; else it
   * is filed under the app section (memoryLog APP_SECTION_HEADER).
   */
  save(characterId: string, line: string, opts?: { inGame?: boolean }): Promise<boolean>;
  /**
   * 261013 (T119): record where a just-saved plan came from, for the Home
   * "up next" card (homeNextStep.ts). Optional; best-effort. 261014: plus
   * the line written to the player for that card, when the model gave one.
   */
  tagPlan?(characterId: string, surface: NextStepSurface, game: string | undefined, line?: string | null): Promise<void>;
  capture(event: string, props: Record<string, unknown>): void;
  /** The deadline for one call on this provider (providerTimeoutMs). */
  timeoutMs(provider: LlmProvider, ms: number): number;
  /** Run the check as a scoped turn (scopeBarrier.withScopedTurn). */
  scoped<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
  log(msg: string): void;
}

class Timeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number, ctrl: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race reports a timeout, not the abort it causes.
      reject(new Timeout());
      ctrl.abort();
    }, ms);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_, reject) => {
    if (ctrl.signal.aborted) reject(new Error('aborted'));
    ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  return Promise.race([p, deadline, aborted]).finally(() => clearTimeout(timer));
}

async function readGoals(deps: PlayerEndDeps, input: PlayerEndInput): Promise<string[]> {
  if (!input.goalsGame) return [];
  try {
    return entryTexts(await deps.readText(deps.goalsFile(input.characterId, input.goalsGame)));
  } catch {
    return [];
  }
}

/**
 * One check, start to finish. Never throws. `ctrl` aborts it (a new session
 * on a local model, tests); the deadline aborts it too.
 */
export async function runPlayerEndNextStep(
  input: PlayerEndInput,
  deps: PlayerEndDeps,
  ctrl: AbortController = new AbortController(),
): Promise<PlayerEndOutcome> {
  return (await runSessionEnd(input, deps, ctrl)).outcome;
}

/**
 * The session-end call (261113, v0.7 D1): the "next time" check, plus, for an
 * input with `recap`, the session's short first-person recap from the same
 * call (no second call; PLAYER_END_RECAP_MAX_TOKENS instead of 150). The
 * recap comes back even when there is no plan; it is null when the call was
 * skipped, failed, timed out or was cancelled, and the caller falls back to
 * the digest lines (playSummary.ts playStory). Never throws.
 */
export async function runSessionEnd(
  input: PlayerEndInput,
  deps: PlayerEndDeps,
  ctrl: AbortController = new AbortController(),
): Promise<SessionEndResult> {
  let recap: string | null = null;
  const { characterId } = input;
  const short = characterId.slice(0, 8);
  let provider: LlmProvider | null = null;
  let reachedModel = false;
  const outcome = await (async (): Promise<PlayerEndOutcome> => {
    try {
      const goals = await readGoals(deps, input);
      if (
        !worthChecking({
          durationMs: input.durationMs,
          playerLines: input.playerLines,
          goals: goals.length,
          minPlayerLines: input.minPlayerLines,
        })
      ) {
        return 'trivial';
      }
      if (input.skipOnFreeCloud && (await deps.freeCloud())) return 'free_cloud';
      provider = await deps.buildProvider();
      const local = provider.kind === 'ollama';
      if (!local && !deps.isOnline()) return 'offline';
      const budget = deps.timeoutMs(provider, PLAYER_END_TIMEOUT_MS);
      return await withDeadline(
        (async (): Promise<PlayerEndOutcome> => {
          if (await deps.overLimit()) return 'over_limit';
          const name = (await deps.characterName(characterId)) ?? null;
          if (!name) return 'no_character';
          let memories: MemoryEntry[] = [];
          try {
            memories = memoryEntries(await deps.readText(deps.memoryFile(characterId)));
          } catch {
            /* no memory yet */
          }
          const prompt = buildPlayerEndPrompt({
            name,
            activity: input.activity,
            durationMs: input.durationMs,
            lines: input.lines,
            goals,
            memories,
            recap: input.recap === true,
          });
          reachedModel = true;
          const res = await provider!.call({
            maxTokens: input.recap ? PLAYER_END_RECAP_MAX_TOKENS : PLAYER_END_MAX_TOKENS,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            timeoutMs: budget,
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted) return 'cancelled';
          const parsed = input.recap ? parseSessionEndReply(res.text) : { recap: null, plan: parsePlayerEndReply(res.text) };
          const plan = parsed.plan;
          recap = parsed.recap;
          const step = plan?.step ?? null;
          const u = res.usage ?? {};
          deps.log(
            `[sei/next-step] ${short} player-end check: ${step ? `plan (${step.length} chars${plan?.line ? `, line ${plan.line.length}` : ', no line'})` : 'none'}` +
              `${input.recap ? `, recap ${recap ? `${recap.length} chars` : 'none'}` : ''}, ` +
              `in ${u.input_tokens ?? 0} / out ${u.output_tokens ?? 0} tokens`,
          );
          if (!step) return 'none';
          // 261020: the plan's game comes from its content (the game: line).
          const place = resolvePlanPlace(input, plan?.game ?? null);
          const memoryLine = nextStepMemoryLine(step, place.memoryGame ? gameDisplayName(place.memoryGame) : undefined);
          const saved = await deps.save(characterId, memoryLine, { inGame: input.surface === 'game' });
          if (saved && deps.tagPlan) {
            try {
              await deps.tagPlan(characterId, place.surface, place.game, plan?.line ?? null);
            } catch {
              /* the card falls back to the games picker */
            }
          }
          return saved ? 'saved' : 'none';
        })(),
        budget,
        ctrl,
      );
    } catch (err) {
      if (err instanceof Timeout) return 'timeout';
      if (ctrl.signal.aborted) return 'cancelled';
      deps.log(`[sei/next-step] ${short} player-end check failed: ${(err as Error)?.message ?? err}`);
      return 'error';
    }
  })();
  // A cancelled check (a new session, or an account switch that may already
  // have re-identified analytics) sends nothing, as before.
  if (outcome !== 'cancelled') reportCheckOutcome(deps.capture, input, outcome, reachedModel);
  // A recap read before a timeout or cancel is not used: the row may already
  // have been written without it, and a cancelled turn must not write.
  return { outcome, recap: outcome === 'saved' || outcome === 'none' ? recap : null };
}

/**
 * The check's `next_step_checked` (and `next_step_saved` on a save). 261107:
 * sent for every outcome, a skip before the model included, so the funnel
 * from session end to saved plan has no invisible step.
 */
function reportCheckOutcome(
  capture: PlayerEndDeps['capture'],
  input: PlayerEndInput,
  outcome: PlayerEndOutcome,
  reachedModel: boolean,
): void {
  const base = {
    character_id: input.characterId,
    source: input.source ?? 'player_end',
    surface: input.surface,
    ...(input.game ? { game: input.game } : {}),
    ...(input.eventProps ?? {}),
  };
  try {
    capture('next_step_checked', {
      ...base,
      saved: outcome === 'saved',
      // 261107: a free cloud chat is the not_covered of before, now with why.
      ...(outcome === 'free_cloud' ? { outcome: 'not_covered', skip_reason: 'free_cloud' } : { outcome }),
      reached_model: reachedModel,
      duration_s: Math.max(0, Math.round(input.durationMs / 1000)),
    });
    if (outcome === 'saved') capture('next_step_saved', base);
  } catch {
    /* analytics is never load-bearing */
  }
}

// ── session ends that never run the check ────────────────────────────────

/** Every surface a session can end on, for analytics (the check itself covers NextStepSurface). */
export type NextStepEventSurface = NextStepSurface | 'chat' | 'chess' | 'draw';

/**
 * Why a session end ran no check (261107, O2 reach). Sent as the
 * `next_step_checked` outcome, `reached_model: false`:
 *   - goodbye: the companion ended it; its goodbye tool carries the plan
 *     (`saved` = it left one, also sent as next_step_saved source 'companion').
 *   - in_game: a call while the character was in a game; the game's end covers it.
 *   - deferred: the app quit ended it; the check runs on the next launch
 *     (quitNextStep.ts), which sends its own event with source 'app_quit'.
 *   - trivial: the app quit ended it, but it was too short to keep for that.
 *   - not_covered: this way of ending runs no check (`end_reason` says which).
 */
export type NextStepNotRun = 'goodbye' | 'in_game' | 'deferred' | 'trivial' | 'not_covered';

export interface NotRunReport {
  characterId: string;
  surface: NextStepEventSurface;
  game?: string;
  outcome: NextStepNotRun;
  /** The `_ended` event's reason (an enum token, never text). */
  endReason?: string;
  durationMs?: number;
  /** goodbye only: its goodbye left a plan. */
  saved?: boolean;
}

/** Shape-only props for a session end that ran no check. Pure. */
export function notRunProps(r: NotRunReport): Record<string, string | number | boolean> {
  return {
    character_id: r.characterId,
    source: 'player_end',
    surface: r.surface,
    ...(r.game ? { game: r.game } : {}),
    saved: r.outcome === 'goodbye' && r.saved === true,
    outcome: r.outcome,
    reached_model: false,
    ...(r.endReason ? { end_reason: r.endReason } : {}),
    ...(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
      ? { duration_s: Math.max(0, Math.round(r.durationMs / 1000)) }
      : {}),
  };
}

/**
 * Report a session end that ran no check. Never throws. `capture` defaults to
 * the app's analytics (loaded lazily, like the check's own events).
 */
export function reportNextStepNotRun(r: NotRunReport, capture?: PlayerEndDeps['capture']): void {
  try {
    (capture ?? captureLazily)('next_step_checked', notRunProps(r));
  } catch {
    /* analytics is never load-bearing */
  }
}

/**
 * A companion goodbye left a plan (sessionGoodbye.ts). The `_ended` event
 * carries it as `next_step_hook`; this is the same save as the one event the
 * player-end check sends, so "saved a next step" counts every source.
 */
export function reportGoodbyePlanSaved(
  r: { characterId: string; surface: NextStepSurface; game?: string },
  capture?: PlayerEndDeps['capture'],
): void {
  try {
    (capture ?? captureLazily)('next_step_saved', {
      character_id: r.characterId,
      source: 'companion',
      surface: r.surface,
      ...(r.game ? { game: r.game } : {}),
    });
  } catch {
    /* analytics is never load-bearing */
  }
}

// ── scheduling ────────────────────────────────────────────────────────────

const inflight = new Map<string, { ctrl: AbortController; local: boolean | null; always: boolean }>();
const lastRun = new Map<string, number>();

/**
 * Start a check in the background. Never rejects. Skipped ('busy') while one
 * is running for the character or one ran inside DEDUPE_WINDOW_MS.
 * `yieldAlways` (T120, a deferred app-quit check): a new session aborts it on
 * any provider, since a plan saved after the new greeting is already stale.
 */
export function startPlayerEndNextStep(
  input: PlayerEndInput,
  deps?: PlayerEndDeps,
  opts: { yieldAlways?: boolean } = {},
): Promise<PlayerEndOutcome> {
  return startSessionEnd(input, deps, opts).then((r) => r.outcome);
}

/** startPlayerEndNextStep with the recap (261113): what closePlaySession waits on. Never rejects. */
export function startSessionEnd(
  input: PlayerEndInput,
  deps?: PlayerEndDeps,
  opts: { yieldAlways?: boolean } = {},
): Promise<SessionEndResult> {
  const { characterId } = input;
  const d = deps ?? defaultDeps();
  const now = d.now();
  const prev = lastRun.get(characterId);
  if (inflight.has(characterId) || (prev !== undefined && now - prev < DEDUPE_WINDOW_MS)) {
    // 261107: visible too (a backseat share ending with its call lands here).
    reportCheckOutcome(d.capture, input, 'busy', false);
    return Promise.resolve({ outcome: 'busy', recap: null });
  }
  lastRun.set(characterId, now);
  const ctrl = new AbortController();
  const entry = { ctrl, local: null as boolean | null, always: opts.yieldAlways === true };
  inflight.set(characterId, entry);
  const tracked: PlayerEndDeps = {
    ...d,
    buildProvider: async () => {
      const p = await d.buildProvider();
      entry.local = p.kind === 'ollama';
      return p;
    },
  };
  return d
    .scoped(() => runSessionEnd(input, tracked, ctrl))
    .catch((): SessionEndResult => ({ outcome: 'cancelled', recap: null }))
    .finally(() => {
      if (inflight.get(characterId) === entry) inflight.delete(characterId);
    });
}

/**
 * A new session for this character is starting. A check on a LOCAL model is
 * aborted so it does not compete with the session for the same machine, and
 * so is a deferred app-quit check on any model (`yieldAlways`).
 */
export function yieldToNewSession(characterId: string): void {
  const entry = inflight.get(characterId);
  if (entry && (entry.always || entry.local !== false)) entry.ctrl.abort();
}

/** Tests only. */
export function _resetPlayerEndNextStep(): void {
  for (const e of inflight.values()) e.ctrl.abort();
  inflight.clear();
  lastRun.clear();
  digests.clear();
}

// ── production wiring ─────────────────────────────────────────────────────

function defaultDeps(): PlayerEndDeps {
  return {
    async buildProvider() {
      const { buildLlmProvider } = await import('./llm');
      return buildLlmProvider();
    },
    isOnline: () => onlineNow(),
    async overLimit() {
      try {
        const { cloudOverLimit } = await import('./cloud/proxyClient');
        return await cloudOverLimit();
      } catch {
        return false;
      }
    },
    freeCloud: () => freeCloudNow(),
    readText: (file) => readFile(file, 'utf8'),
    memoryFile(characterId) {
      return path.join(memoryDirOf(characterId), 'MEMORY.md');
    },
    goalsFile(characterId, game) {
      return goalsFileFor(memoryDirOf(characterId), game);
    },
    async characterName(characterId) {
      const { getCharacter } = await import('./characterStore');
      return (await getCharacter(characterId))?.name ?? null;
    },
    async save(characterId, line, opts) {
      const { scopedTurnCurrent, trackScopedWrite } = await import('./profile/scopeBarrier');
      if (!scopedTurnCurrent()) return false;
      const { appendMemory } = await import('../bot/brain/memory/memoryLog.js');
      const written = await trackScopedWrite(
        appendMemory(path.join(memoryDirOf(characterId), 'MEMORY.md'), line, undefined, opts?.inGame ? {} : { section: 'app' }),
      );
      if (written > 0) {
        try {
          const { maybeCompactChatMemory } = await import('./chat/memoryCompaction');
          void maybeCompactChatMemory(characterId).catch(() => {});
        } catch {
          /* compaction is best-effort */
        }
      }
      return written > 0;
    },
    async tagPlan(characterId, surface, game, line) {
      const { scopedTurnCurrent, trackScopedWrite } = await import('./profile/scopeBarrier');
      if (!scopedTurnCurrent()) return;
      const { tagLatestPlan, noteHomeNextStepChanged } = await import('./homeNextStep');
      const { readPlayerLineNames } = await import('./playerLineNames');
      const dir = memoryDirOf(characterId);
      const names = await readPlayerLineNames(characterId);
      if (await trackScopedWrite(tagLatestPlan(dir, { surface, game, line, names }))) noteHomeNextStepChanged(characterId);
    },
    capture: captureLazily,
    timeoutMs(provider, ms) {
      return timeoutFor(provider, ms);
    },
    async scoped(fn) {
      const { withScopedTurn } = await import('./profile/scopeBarrier');
      return withScopedTurn(fn);
    },
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };
}

/** How long the plan read behind freeCloud may take before it counts as free. */
export const FREE_CLOUD_READ_MS = 5_000;

/**
 * True when a check would be paid by Sei: the cloud backend on the free plan,
 * signed out, or a plan read that failed or took longer than
 * FREE_CLOUD_READ_MS. Any other backend (BYOK, Ollama and other local
 * models, the ChatGPT plan) is the user's own cost; a paid plan spends its
 * own allowance, like a call.
 */
async function freeCloudNow(): Promise<boolean> {
  try {
    const { getAiBackendKind } = await import('./apiKeyStore');
    if ((await getAiBackendKind()) !== 'cloud-proxy') return false;
    const { creditsGet } = await import('./cloud/proxyClient');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FREE_CLOUD_READ_MS);
      timer.unref?.();
    });
    const status = await Promise.race([creditsGet(), slow]).finally(() => clearTimeout(timer));
    return !status || isFreeCloudPlan(status.plan);
  } catch {
    return true;
  }
}

/** A plan that leaves the check's cost with Sei. Pure. */
export function isFreeCloudPlan(plan: string | null | undefined): boolean {
  return plan !== 'quest' && plan !== 'party';
}

let lazyAnalytics: Promise<typeof import('./lazyAnalytics')> | null = null;

function captureLazily(event: string, props: Record<string, unknown>): void {
  void (async () => {
    try {
      // One cached import: the checked + saved pair fires in the same tick,
      // and two concurrent dynamic imports can resolve to different module
      // instances under vitest mocking (lazyAnalytics.ts).
      lazyAnalytics ??= import('./lazyAnalytics').catch((err) => {
        lazyAnalytics = null;
        throw err;
      });
      const { loadAnalytics } = await lazyAnalytics;
      const { capture } = await loadAnalytics();
      capture(event, props);
    } catch {
      /* analytics is never load-bearing */
    }
  })();
}

let boundMemoryDir: ((characterId: string) => string) | null = null;
/** Unbound (bindPlayerEndRuntime never ran) = refuse, never a relative path. */
function memoryDirOf(characterId: string): string {
  if (!boundMemoryDir) throw new Error('player-end next step: runtime not bound');
  return boundMemoryDir(characterId);
}
let timeoutFor: (provider: LlmProvider, ms: number) => number = (_p, ms) => ms;
let onlineNow: () => boolean = () => true;

/**
 * Production bindings that need main-only modules (paths, the llm layer's
 * timeout floors, Electron's net). index.ts calls this once at startup; tests inject deps.
 */
export function bindPlayerEndRuntime(b: {
  memoryDir: (characterId: string) => string;
  providerTimeoutMs: (provider: LlmProvider, ms: number) => number;
  /** Electron net.isOnline(). */
  isOnline: () => boolean;
}): void {
  boundMemoryDir = b.memoryDir;
  timeoutFor = b.providerTimeoutMs;
  onlineNow = b.isOnline;
}

/** The goal file a game session's bot wrote (bot/index.js heartbeat_md_path). */
export function goalsFileFor(memoryDir: string, game: string): string {
  return path.join(memoryDir, game === 'minecraft' ? 'HEARTBEAT.md' : `HEARTBEAT.${game}.md`);
}
