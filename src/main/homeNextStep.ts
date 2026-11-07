/**
 * The Home "up next" card (261013, retention O2 / T119).
 *
 * 43 of 56 users active on day 0 were not back on day 1, and there is no
 * outside recall channel (no email, no OS notification, by decision). So the
 * one lever is the app itself: someone who reopens it should see a concrete
 * reason to keep going. T80 / T96 already save a "Plan for next time" entry
 * to the character's MEMORY.md at the end of a session; this module reads it
 * back for the Home screen.
 *
 * Rules (pure, unit-tested in homeNextStep.test.ts):
 *   - The plan is the NEWEST `Plan for next time:` entry in MEMORY.md. Older
 *     ones were superseded by it, so an expired or consumed newest plan means
 *     no plan, never a fall back to an older one.
 *   - It expires after NEXT_STEP_MAX_AGE_MS (7 days).
 *   - It is consumed once a later session's greeting has seen it: a game
 *     session going online or a voice call greeting (both greetings are told
 *     about the plan, NEXT_TIME_GREETING). Nothing in T80 marked a plan as
 *     used, and MEMORY.md is model-facing, so the mark lives in a small
 *     sidecar, NEXT_STEP.json in the memory dir, as a watermark
 *     (`consumedAt`): a plan written at or before it is used up. Starting a
 *     session from the card is the same event, so it needs no extra mark.
 *   - No usable plan: the newest active goal from the HEARTBEAT goal files
 *     (one per game), also within 7 days. Goals are not consumed; they stay
 *     until the companion clears them.
 *   - Nothing: no entry at all, so the renderer shows no card.
 *
 * Where a plan came from (game + which game, call, backseat) is not in the
 * MEMORY.md line. Main tags it in the same sidecar right after the plan is
 * written (tagLatestPlan: session close for a companion quit, call end for a
 * companion hang-up, the player-end check's save), keyed by the plan's
 * normalized text. A plan with no tag (written before this shipped, or
 * reworded by compaction) has surface null and the card opens the games
 * picker instead of guessing.
 *
 * Never throws to callers that ask for a card: a missing or broken file is
 * "nothing to show".
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { HomeNextStep, HomeNextStepSurface } from '../shared/homeNextStep';
import { gameIdFromName } from '../shared/homeNextStep';
import { GAME_IDS, isGameId, type GameId } from '../shared/gameIpc';
import { acceptPlayerLine, normalizePlayerLine, parsePlanLine } from '../bot/brain/nextStep.js';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { goalsFileFor } from './playerEndNextStep';
import { PLAYER_TASK_TAG } from '../bot/brain/promptLibrary.js';

/** A plan or goal older than this is not shown. */
export const NEXT_STEP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** tagLatestPlan only tags a plan written this recently. */
export const TAG_WINDOW_MS = 10 * 60_000;
/** The sidecar keeps this many tags (newest last). */
const MAX_TAGS = 20;
export const LEDGER_FILE = 'NEXT_STEP.json';


export interface NextStepTag {
  /** planKey() of the plan text. */
  key: string;
  /** The entry's stamp, ISO. */
  at: string;
  surface: HomeNextStepSurface;
  game?: string;
  /**
   * 261014: the plan written to the player, shown on the card in place of
   * the companion's own note. Absent on tags written before it existed and
   * when the model gave none; the card then shows the note.
   */
  line?: string;
}

export interface NextStepLedger {
  v: 1;
  tags: NextStepTag[];
  /** Plans written at or before this (ISO) were seen by a later greeting. */
  consumedAt?: string;
}

export interface StampedEntry {
  at: number;
  text: string;
}

/** A plan entry: the step text, plus the game its line names (261020). */
export interface PlanEntry extends StampedEntry {
  /** Bot game id from "Plan for next time in <game>:", or null. */
  game: GameId | null;
}

// ── pure ──────────────────────────────────────────────────────────────────

/** Loose key for matching a plan's text: lowercase letters, digits, spaces. */
export function planKey(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every `- [stamp] text` entry with a parseable stamp, in file order. */
export function stampedEntries(body: string): StampedEntry[] {
  const out: StampedEntry[] = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = /^- \[([^\]]+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    const text = m[2].trim();
    if (!Number.isFinite(at) || !text) continue;
    out.push({ at, text });
  }
  return out;
}

/** The plan entries of a MEMORY.md body, prefix removed, in file order. */
export function planEntries(memory: string): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const e of stampedEntries(memory)) {
    const plan = parsePlanLine(e.text);
    if (plan) out.push({ at: e.at, text: plan.step, game: gameIdFromName(plan.gameName) });
  }
  return out;
}

/** The newest entry by stamp (the later one wins a tie). */
function newest<T extends StampedEntry>(entries: T[]): T | null {
  let best: T | null = null;
  for (const e of entries) if (!best || e.at >= best.at) best = e;
  return best;
}

/** The newest tag recorded for a plan, if any. */
function tagFor(plan: StampedEntry, ledger: NextStepLedger): NextStepTag | undefined {
  const key = planKey(plan.text);
  let tag: NextStepTag | undefined;
  for (const t of ledger.tags) if (t.key === key) tag = t; // newest tag wins
  return tag;
}

/**
 * 261020: the bot game a plan belongs to, or null when it is not tied to one
 * (a call plan, "ask how the interview went"). The tag decides when it names
 * a game (it was set from the plan's content or the session it came from);
 * else the game the memory line names.
 */
export function planGame(plan: PlanEntry, ledger: NextStepLedger): GameId | null {
  const tag = tagFor(plan, ledger);
  if (tag?.surface === 'game' && isGameId(tag.game)) return tag.game;
  return plan.game;
}

/**
 * 261020: whether a plan belongs to a DIFFERENT bot game than `game`. Such a
 * plan is not raised by this game's greeting and is not used up by it, so
 * the Home card keeps offering the right game.
 */
export function planIsForOtherGame(plan: PlanEntry, ledger: NextStepLedger, game: GameId | null | undefined): boolean {
  if (!game) return false;
  const g = planGame(plan, ledger);
  return g !== null && g !== game;
}

function capitalize(s: string): string {
  return s.length > 0 && /[a-z]/.test(s[0]) ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A plan as card text: one line, no trailing period, first letter up. */
export function planDisplayText(text: string): string {
  return capitalize(String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').trim());
}

const FINISH_CUE = /\b(?:finish(?:ed)?|done|complete(?:d)?|success)\s*(?:when|once|if|after|:|=)/i;

/**
 * A goal as card text. Goals are the companion's working notes ("Get iron
 * tools with Alex: gather wood, make a wooden pickaxe. Finish when an iron
 * pickaxe exists."), so keep the headline: drop the finish condition, keep
 * the first sentence, and keep only the part before a colon when the goal is
 * written as "headline: steps". Empty when nothing readable is left.
 */
export function goalDisplayText(text: string): string {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  // A task the player gave (setGoal for_player) is stored with a tag in front
  // and usually written as "Alex asked: grab coal..." or "For Alex: chop...".
  // The card shows the task itself: no tag, no "who asked" head, and the
  // colon rule below would keep only that head.
  const playerTask = s.startsWith(PLAYER_TASK_TAG);
  if (playerTask) {
    s = s
      .slice(PLAYER_TASK_TAG.length)
      .trim()
      .replace(/^(?:for\s+[^\s:]+\s*:|[^\s:]+\s+(?:asked|wants)(?:\s+me)?(?:\s+to)?\s*:?)\s*/i, '');
  }
  const fc = FINISH_CUE.exec(s);
  if (fc && fc.index > 0) s = s.slice(0, fc.index);
  s = s.split(/(?<=[.!?;])\s+/)[0] ?? '';
  const colon = s.indexOf(':');
  if (colon >= 8 && !playerTask) s = s.slice(0, colon);
  s = s.replace(/[\s.,;:!?-]+$/, '').trim();
  return capitalize(s);
}

export interface PickInput {
  characterId: string;
  /** MEMORY.md body ('' when missing). */
  memory: string;
  ledger: NextStepLedger;
  /** Goal file bodies by game id. */
  goals: Array<{ game: string; body: string }>;
  now: number;
}

/**
 * The newest plan when it is still open: under NEXT_STEP_MAX_AGE_MS old and
 * not yet seen by a later greeting. Older plans never count (see top).
 */
export function openPlan(p: { memory: string; ledger: NextStepLedger; now: number }): PlanEntry | null {
  const plan = newest(planEntries(p.memory));
  if (!plan || p.now - plan.at > NEXT_STEP_MAX_AGE_MS) return null;
  const consumedAt = p.ledger.consumedAt ? Date.parse(p.ledger.consumedAt) : NaN;
  if (Number.isFinite(consumedAt) && plan.at <= consumedAt) return null;
  return plan;
}

/** The card for one character, or null when there is nothing to show. */
export function pickNextStep(p: PickInput): HomeNextStep | null {
  const fresh = (at: number) => p.now - at <= NEXT_STEP_MAX_AGE_MS;
  const plan = openPlan(p);
  if (plan) {
    const tag = tagFor(plan, p.ledger);
    // 261014: the line written to the player when there is one, else the
    // companion's note as before.
    const text = (tag?.line && normalizePlayerLine(tag.line)) || planDisplayText(plan.text);
    if (text) {
      // 261020: an untagged plan whose line names its game still opens it.
      const surface = tag?.surface ?? (plan.game ? 'game' : null);
      return {
        characterId: p.characterId,
        source: 'plan',
        text,
        at: plan.at,
        surface,
        game: tag?.game ?? (surface === 'game' ? plan.game : null),
      };
    }
  }
  let goal: { at: number; text: string; game: string } | null = null;
  for (const g of p.goals) {
    for (const e of stampedEntries(g.body)) {
      if (!fresh(e.at)) continue;
      const text = goalDisplayText(e.text);
      if (!text) continue;
      if (!goal || e.at >= goal.at) goal = { at: e.at, text, game: g.game };
    }
  }
  if (!goal) return null;
  return { characterId: p.characterId, source: 'goal', text: goal.text, at: goal.at, surface: 'game', game: goal.game };
}

/** A sidecar body as a ledger; anything unreadable is an empty one. */
export function parseLedger(raw: string | null): NextStepLedger {
  const empty: NextStepLedger = { v: 1, tags: [] };
  if (!raw) return empty;
  try {
    const j = JSON.parse(raw) as Partial<NextStepLedger> | null;
    if (!j || typeof j !== 'object') return empty;
    const tags = Array.isArray(j.tags)
      ? j.tags.filter(
          (t): t is NextStepTag =>
            !!t &&
            typeof t.key === 'string' &&
            typeof t.at === 'string' &&
            (t.surface === 'game' || t.surface === 'call' || t.surface === 'backseat' || t.surface === 'chat') &&
            (t.game === undefined || typeof t.game === 'string'),
        )
          // 261014: a non-string line is dropped, the tag kept.
          .map((t) => (t.line === undefined || typeof t.line === 'string' ? t : { ...t, line: undefined }))
      : [];
    const out: NextStepLedger = { v: 1, tags };
    if (typeof j.consumedAt === 'string' && Number.isFinite(Date.parse(j.consumedAt))) out.consumedAt = j.consumedAt;
    return out;
  } catch {
    return empty;
  }
}

// ── files ─────────────────────────────────────────────────────────────────

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function readLedger(memoryDir: string): Promise<NextStepLedger> {
  return parseLedger((await readOrEmpty(path.join(memoryDir, LEDGER_FILE))) || null);
}

/** Read-modify-write the sidecar under its lock. `fn` returns false = no write. */
async function updateLedger(memoryDir: string, fn: (l: NextStepLedger) => boolean): Promise<boolean> {
  const file = path.join(memoryDir, LEDGER_FILE);
  return withFileLock(file, async () => {
    const ledger = parseLedger((await readOrEmpty(file)) || null);
    if (!fn(ledger)) return false;
    await atomicWrite(file, JSON.stringify(ledger) + '\n');
    return true;
  });
}

/** The card for one character from its memory dir. Never throws. */
export async function readHomeNextStep(memoryDir: string, characterId: string, now = Date.now()): Promise<HomeNextStep | null> {
  try {
    const [memory, ledger, goals] = await Promise.all([
      readOrEmpty(path.join(memoryDir, 'MEMORY.md')),
      readLedger(memoryDir),
      Promise.all(GAME_IDS.map(async (game) => ({ game, body: await readOrEmpty(goalsFileFor(memoryDir, game)) }))),
    ]);
    return pickNextStep({ characterId, memory, ledger, goals, now });
  } catch {
    return null;
  }
}

/**
 * The plan a greeting starting now should raise (openPlan), as its note
 * text, or null. Read BEFORE consumeNextStep marks it used: main ships it in
 * the bot's init (FIRST_CONTACT) and the call greeting note. Never throws.
 * 261020: `game` = the greeting is a game session's. A plan for a different
 * game is not this greeting's to raise (null): a Minecraft plan made the main
 * thing of a Stardew greeting turns into a Stardew task.
 */
export async function readPendingPlan(
  memoryDir: string,
  now = Date.now(),
  opts: { game?: GameId | null } = {},
): Promise<string | null> {
  return (await readPendingPlanFor(memoryDir, now, opts))?.text ?? null;
}

/**
 * readPendingPlan plus whether the plan is tied to `game`. 261020 (review):
 * a game greeting raises a plan with no game (a call plan the model gave no
 * game, "ask how the interview went") too, but as something to talk about:
 * `notForGame` tells the bot to say so (promptLibrary nextTimeGreeting).
 */
export async function readPendingPlanFor(
  memoryDir: string,
  now = Date.now(),
  opts: { game?: GameId | null } = {},
): Promise<{ text: string; notForGame: boolean } | null> {
  try {
    const [memory, ledger] = await Promise.all([readOrEmpty(path.join(memoryDir, 'MEMORY.md')), readLedger(memoryDir)]);
    const plan = openPlan({ memory, ledger, now });
    if (!plan || planIsForOtherGame(plan, ledger, opts.game)) return null;
    return { text: plan.text, notForGame: !!opts.game && planGame(plan, ledger) !== opts.game };
  } catch {
    return null;
  }
}

/**
 * Record where the newest plan came from. Call right after a plan was
 * written (it must be at most TAG_WINDOW_MS old). Returns whether a tag was
 * written. Never throws. 261014: `line` is the plan written to the player,
 * shown on the card instead of the note (normalized here; empty = none). A
 * line that reads as the companion's own note (playerLineProblem) is not
 * stored, so the card shows the note as before.
 */
export async function tagLatestPlan(
  memoryDir: string,
  source: {
    surface: HomeNextStepSurface;
    game?: string | null;
    line?: string | null;
    /** Checked against (nextStep.js playerLineProblem); a line that fails is not stored. */
    names?: { character?: string | null; players?: string[] };
  },
  now = Date.now(),
): Promise<boolean> {
  try {
    const plan = newest(planEntries(await readOrEmpty(path.join(memoryDir, 'MEMORY.md'))));
    if (!plan || Math.abs(now - plan.at) > TAG_WINDOW_MS) return false;
    const tag: NextStepTag = {
      key: planKey(plan.text),
      at: new Date(plan.at).toISOString(),
      surface: source.surface,
      ...(source.game ? { game: source.game } : {}),
    };
    const line = acceptPlayerLine(source.line ?? null, source.names ?? {});
    if (line) tag.line = line;
    return await updateLedger(memoryDir, (l) => {
      l.tags = [...l.tags.filter((t) => t.key !== tag.key), tag].slice(-MAX_TAGS);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * A session whose greeting is told about the plan started: every plan
 * written up to now is used. Writes only when there is an unconsumed plan,
 * so most session starts touch nothing. Returns whether it wrote. Never throws.
 * 261020: `game` = a game session started. A newest plan for a different game
 * was not raised by it (readPendingPlan), so it stays open for that game.
 */
export async function consumeNextStep(
  memoryDir: string,
  now = Date.now(),
  opts: { game?: GameId | null } = {},
): Promise<boolean> {
  try {
    const plan = newest(planEntries(await readOrEmpty(path.join(memoryDir, 'MEMORY.md'))));
    if (!plan) return false;
    return await updateLedger(memoryDir, (l) => {
      if (planIsForOtherGame(plan, l, opts.game)) return false;
      const prev = l.consumedAt ? Date.parse(l.consumedAt) : NaN;
      if (Number.isFinite(prev) && plan.at <= prev) return false;
      l.consumedAt = new Date(now).toISOString();
      return true;
    });
  } catch {
    return false;
  }
}

// ── renderer notification ────────────────────────────────────────────────

let notify: ((characterId: string) => void) | null = null;

/** index.ts binds the `home:next-step-changed` push once at startup. */
export function bindHomeNextStepNotifier(fn: ((characterId: string) => void) | null): void {
  notify = fn;
}

/** Tell the renderer a character's card may have changed. */
export function noteHomeNextStepChanged(characterId: string): void {
  try {
    notify?.(characterId);
  } catch {
    /* a closed window just misses the push */
  }
}
