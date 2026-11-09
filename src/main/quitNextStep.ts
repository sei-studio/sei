/**
 * The "next time" check for sessions the APP QUIT ended (261013, T120).
 *
 * playerEndNextStep.ts runs one small LLM check after a session the player
 * ended (Stop, closed the world, hung up) and may save a `Plan for next
 * time:` line that the next greeting and the Home "up next" card use. A
 * session that ends because the player quits the app (window close on
 * Windows, Cmd-Q, app quit with a bot or call still live) never ran it:
 * there is no time for an LLM call inside quit. Live 0.6.8 data had a hook on
 * 3 of 73 session ends, and many first sessions end exactly this way.
 *
 * So the check is split across the quit:
 *
 *   1. Quit (before-quit -> closePlaySession with reason 'app_quit', plus the
 *      open out-of-game calls): write what the check needs to
 *      PENDING_NEXT_STEP.json in the character's memory dir. Synchronous and
 *      tiny (mkdir + write + rename of a few KB, wrapped in try/catch), no
 *      network, no LLM, no await, so it cannot delay or break the quit. A
 *      game session keeps its conversation digest in the file; the bot posts
 *      a fresher one while the supervisor drains it, and that refreshes the
 *      file (refreshQuitDigest). A call keeps only its window: its lines are
 *      already in the chat transcript.
 *   2. Next launch (a few seconds after bootstrap, and again after a scope
 *      switch, i.e. sign-in): for each pending file in the active profile,
 *      run the same check (startPlayerEndNextStep, so the same gates apply:
 *      trivial session, offline, cloud over its limit, local-model time box,
 *      scoped turn), save + tag the plan (surface + game) and notify the Home
 *      card. The file is deleted afterwards whatever the answer. It is kept
 *      only when the check could not run: the backend is not ready (cloud
 *      with no session), another check holds the character, or the check
 *      was cancelled; and for up to PENDING_MAX_ATTEMPTS launches when it
 *      failed (offline, error, timeout).
 *   3. Skipped (file deleted, no call) when it is older than
 *      PENDING_MAX_AGE_MS (7 days, the Home card's own window), or when a
 *      new session with the character already started: a game going online
 *      or a call greeting in this app run (noteNewSessionForQuit), or a
 *      later play/call row in the transcript. That greeting has moved on, so
 *      a plan from the older session would be stale.
 *
 * Analytics: the check's own `next_step_checked` / `next_step_saved` with
 * `source: 'app_quit'` and `late_hours` (how long after the quit it ran).
 * Shape only, never the plan or any transcript text.
 */
import path from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import {
  PLAYER_END_MIN_MS,
  parseSessionDigest,
  startPlayerEndNextStep,
  type DigestLine,
  type PlayerEndInput,
  type PlayerEndOutcome,
  type SessionDigest,
} from './playerEndNextStep';
import { NEXT_STEP_MAX_AGE_MS } from './homeNextStep';
import { chatCheckInput } from './chatNextStep';
import type { ChatMessage } from '../shared/ipc';
import { isGameId } from '../shared/gameIpc';

export const PENDING_FILE = 'PENDING_NEXT_STEP.json';
/** A pending check older than this is dropped unrun (same window as the Home card). */
export const PENDING_MAX_AGE_MS = NEXT_STEP_MAX_AGE_MS;
/** Launches a failing check (offline, error, timeout) is retried on. */
export const PENDING_MAX_ATTEMPTS = 3;
/** How long after bootstrap the launch pass runs (auth + token refresh settle). */
export const LAUNCH_DELAY_MS = 10_000;
/** A play/call row this long after the quit is a later session, not the quit's own row. */
export const LATER_SESSION_MARGIN_MS = 60_000;

/** 261107: 'chat' = a text chat open at quit (chatNextStep.ts). */
export type PendingSurface = 'game' | 'call' | 'chat';

export interface PendingQuitNextStep {
  v: 1;
  characterId: string;
  surface: PendingSurface;
  /** Game id (game surface only). */
  game?: string;
  durationMs: number;
  /** When the quit ended it, ms epoch. */
  endedAt: number;
  /** The conversation (game surface; a call reads its transcript). */
  digest?: SessionDigest;
  /** Launches that tried and failed. */
  attempts?: number;
}

// ── pure ──────────────────────────────────────────────────────────────────

/** A pending file body as a record, or null when unusable. */
export function parsePending(raw: string | null): PendingQuitNextStep | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<PendingQuitNextStep> | null;
    if (!j || typeof j !== 'object') return null;
    if (typeof j.characterId !== 'string' || !j.characterId) return null;
    if (j.surface !== 'game' && j.surface !== 'call' && j.surface !== 'chat') return null;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!num(j.durationMs) || !num(j.endedAt)) return null;
    const out: PendingQuitNextStep = {
      v: 1,
      characterId: j.characterId,
      surface: j.surface,
      durationMs: j.durationMs as number,
      endedAt: j.endedAt as number,
    };
    if (j.surface === 'game' && typeof j.game === 'string' && j.game) out.game = j.game;
    if (j.digest) {
      const d = parseSessionDigest(j.digest);
      if (d) out.digest = d;
    }
    if (num(j.attempts)) out.attempts = Math.floor(j.attempts as number);
    return out;
  } catch {
    return null;
  }
}

/** Hours between the quit and now, one decimal, for `late_hours`. */
export function lateHours(endedAt: number, now: number): number {
  return Math.max(0, Math.round(((now - endedAt) / 3_600_000) * 10) / 10);
}

/**
 * A call's conversation from the chat transcript: the voice rows inside the
 * call window (from `since` to `until`), last 16, plus how many the player
 * spoke. Shared by the live hang-up check and the deferred quit check.
 */
export function callDigestFromRows(
  rows: ChatMessage[],
  since: number,
  until = Number.POSITIVE_INFINITY,
): { lines: DigestLine[]; playerLines: number } {
  const voice = rows.filter(
    (r) => r.voice === true && r.ts >= since && r.ts <= until && (r.role === 'user' || r.role === 'companion'),
  );
  return {
    lines: voice.slice(-16).map((r) => ({ who: r.role === 'user' ? 'player' : 'you', text: r.text })),
    playerLines: voice.filter((r) => r.role === 'user').length,
  };
}

/**
 * A bot-game play row or a call row written after the quit: a later session
 * whose greeting was told about plans happened. Chess, Draw! and backseat
 * rows do not count (their greetings never see the plan).
 */
export function hasLaterSession(rows: ChatMessage[], endedAt: number): boolean {
  return rows.some((r) => {
    if (r.role !== 'system' || !r.event || r.ts <= endedAt + LATER_SESSION_MARGIN_MS) return false;
    return r.event.kind === 'call' || (r.event.kind === 'play' && isGameId(r.event.game));
  });
}

/** What to do with the file after a check returned `outcome`. */
export function afterOutcome(outcome: PlayerEndOutcome, attempts: number): 'delete' | 'keep' | 'retry' {
  if (outcome === 'busy' || outcome === 'cancelled') return 'keep';
  if (outcome === 'offline' || outcome === 'error' || outcome === 'timeout') {
    return attempts + 1 >= PENDING_MAX_ATTEMPTS ? 'delete' : 'retry';
  }
  return 'delete';
}

// ── quit side (synchronous) ───────────────────────────────────────────────

/** Records written during this quit, by character, for refreshQuitDigest. */
const written = new Map<string, { dir: string; record: PendingQuitNextStep }>();

function writeSync(dir: string, record: PendingQuitNextStep): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, PENDING_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record) + '\n', 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one session the quit is ending. Synchronous, never throws, a few KB
 * on local disk. Sessions too short for the check (PLAYER_END_MIN_MS) write
 * nothing. Returns whether it wrote.
 */
export function persistQuitSession(record: Omit<PendingQuitNextStep, 'v'>, memoryDir?: string): boolean {
  try {
    if (!(record.durationMs >= PLAYER_END_MIN_MS)) return false;
    const dir = memoryDir ?? boundMemoryDir?.(record.characterId);
    if (!dir) return false;
    const full: PendingQuitNextStep = { v: 1, ...record };
    if (!writeSync(dir, full)) return false;
    written.set(record.characterId, { dir, record: full });
    return true;
  } catch {
    return false;
  }
}

/**
 * The bot posted its final digest while the supervisor drained it on quit
 * (after the session was already closed and persisted). Rewrite that
 * session's file with it, so the last lines before the quit are included.
 * Synchronous, never throws, a no-op for anything this quit did not write.
 */
export function refreshQuitDigest(characterId: string, raw: unknown): void {
  try {
    const w = written.get(characterId);
    if (!w || w.record.surface !== 'game') return;
    const d = parseSessionDigest(raw);
    if (!d) return;
    w.record = { ...w.record, digest: d };
    writeSync(w.dir, w.record);
  } catch {
    /* the earlier digest stays */
  }
}

// ── launch side ───────────────────────────────────────────────────────────

export type PendingResult =
  | PlayerEndOutcome
  | 'expired'
  | 'superseded'
  | 'not_ready'
  | 'unreadable';

export interface QuitRunDeps {
  /** <profileRoot>/memory of the ACTIVE scope. */
  memoryRoot(): string;
  /** Cloud backend has a signed-in session (BYOK / local: always true). */
  backendReady(): Promise<boolean>;
  /** Recent chat transcript rows (chatStore.readRecent). */
  recentRows(characterId: string): Promise<ChatMessage[]>;
  /** "playing Minecraft together" for a game id. */
  activityFor(game: string): string;
  /** startPlayerEndNextStep (tests inject a fake). */
  start(input: PlayerEndInput): Promise<PlayerEndOutcome>;
  now(): number;
  log(msg: string): void;
}

/** Characters a session started for in this app run (game online / call greeting). */
const startedThisRun = new Set<string>();

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* already gone: deleting is idempotent */
  }
}

/** Build the check input for one pending record. */
async function inputFor(p: PendingQuitNextStep, rows: ChatMessage[], deps: QuitRunDeps): Promise<PlayerEndInput> {
  const eventProps = { late_hours: lateHours(p.endedAt, deps.now()) };
  if (p.surface === 'game') {
    const game = p.game ?? 'minecraft';
    return {
      characterId: p.characterId,
      surface: 'game',
      game,
      activity: deps.activityFor(game),
      durationMs: p.durationMs,
      lines: p.digest?.lines ?? [],
      playerLines: p.digest?.playerLines ?? 0,
      goalsGame: game,
      source: 'app_quit',
      eventProps,
    };
  }
  if (p.surface === 'chat') {
    // endedAt is the chat's last message; its lines are typed transcript rows.
    return chatCheckInput({
      characterId: p.characterId,
      startedAt: p.endedAt - p.durationMs,
      lastAt: p.endedAt,
      rows,
      source: 'app_quit',
      eventProps,
    });
  }
  const call = callDigestFromRows(rows, p.endedAt - p.durationMs - 30_000, p.endedAt + 5_000);
  return {
    characterId: p.characterId,
    surface: 'call',
    activity: 'a voice call',
    durationMs: p.durationMs,
    lines: call.lines,
    playerLines: call.playerLines,
    source: 'app_quit',
    eventProps,
  };
}

/** One character's pending file, start to finish. Never throws. */
export async function runPendingFor(dir: string, deps: QuitRunDeps): Promise<PendingResult | null> {
  const file = path.join(dir, PENDING_FILE);
  const raw = await readOrNull(file);
  if (raw === null) return null;
  const p = parsePending(raw);
  if (!p) {
    await removeFile(file);
    return 'unreadable';
  }
  const short = p.characterId.slice(0, 8);
  if (deps.now() - p.endedAt > PENDING_MAX_AGE_MS) {
    await removeFile(file);
    return 'expired';
  }
  if (startedThisRun.has(p.characterId)) {
    await removeFile(file);
    return 'superseded';
  }
  let rows: ChatMessage[] = [];
  try {
    rows = await deps.recentRows(p.characterId);
  } catch {
    /* no transcript yet */
  }
  if (hasLaterSession(rows, p.endedAt)) {
    await removeFile(file);
    return 'superseded';
  }
  let ready = false;
  try {
    ready = await deps.backendReady();
  } catch {
    ready = false;
  }
  if (!ready) return 'not_ready';
  let outcome: PlayerEndOutcome;
  try {
    outcome = await deps.start(await inputFor(p, rows, deps));
  } catch {
    outcome = 'error';
  }
  // A session that started while the check ran already deleted the file.
  if (startedThisRun.has(p.characterId)) return 'superseded';
  const attempts = p.attempts ?? 0;
  const next = afterOutcome(outcome, attempts);
  if (next === 'delete') await removeFile(file);
  else if (next === 'retry') writeSync(dir, { ...p, attempts: attempts + 1 });
  deps.log(`[sei/next-step] ${short} app-quit check (${p.surface}): ${outcome}, file ${next}`);
  return outcome;
}

let running: Promise<void> | null = null;

/**
 * Run every pending app-quit check in the active profile, one at a time.
 * Single-flight: a second call while one runs joins it. Never rejects.
 */
export function runPendingQuitNextSteps(deps?: QuitRunDeps): Promise<void> {
  if (running) return running;
  const d = deps ?? defaultDeps();
  running = (async () => {
    try {
      let dirs: string[] = [];
      const root = d.memoryRoot();
      try {
        dirs = await readdir(root);
      } catch {
        return;
      }
      for (const name of dirs) {
        try {
          await runPendingFor(path.join(root, name), d);
        } catch {
          /* next character */
        }
      }
    } catch {
      /* never surfaces */
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * A new session for this character went live (a game online, a call
 * greeting): its greeting moved on, so a pending app-quit check for an older
 * session is dropped (and one in flight was already aborted by
 * yieldToNewSession). Fire and forget.
 */
export function noteNewSessionForQuit(characterId: string): void {
  startedThisRun.add(characterId);
  try {
    if (!boundMemoryDir) return;
    void removeFile(path.join(boundMemoryDir(characterId), PENDING_FILE));
  } catch {
    /* best-effort */
  }
}

/** Tests only. */
export function _resetQuitNextStep(): void {
  written.clear();
  startedThisRun.clear();
  running = null;
}

// ── production wiring ─────────────────────────────────────────────────────

let boundMemoryDir: ((characterId: string) => string) | null = null;
let boundMemoryRoot: (() => string) | null = null;
let boundActivity: (game: string) => string = (game) => `playing ${game} with the player`;

/** index.ts binds the main-only pieces once at startup. */
export function bindQuitNextStepRuntime(b: {
  memoryDir: (characterId: string) => string;
  memoryRoot: () => string;
  activityFor: (game: string) => string;
}): void {
  boundMemoryDir = b.memoryDir;
  boundMemoryRoot = b.memoryRoot;
  boundActivity = b.activityFor;
}

function defaultDeps(): QuitRunDeps {
  return {
    memoryRoot() {
      if (!boundMemoryRoot) throw new Error('app-quit next step: runtime not bound');
      return boundMemoryRoot();
    },
    async backendReady() {
      const { getAiBackendKind } = await import('./apiKeyStore');
      if ((await getAiBackendKind()) !== 'cloud-proxy') return true;
      const { getClient } = await import('./auth/supabaseClient');
      const { data } = await getClient().auth.getSession();
      return !!data.session;
    },
    async recentRows(characterId) {
      const { readRecent } = await import('./chat/chatStore');
      return readRecent(characterId, 80);
    },
    activityFor: (game) => boundActivity(game),
    start: (input) => startPlayerEndNextStep(input, undefined, { yieldAlways: true }),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };
}
