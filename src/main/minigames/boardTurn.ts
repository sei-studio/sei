/**
 * One LLM turn of a board minigame (Four in a Row, Fleet Battle), 261127.
 *
 * The same shape chess uses (src/main/chess/chessService.ts runChessLlmTurn),
 * pulled out so both board games share ONE tool loop instead of each
 * hand-rolling its own:
 *
 *   - the persona system prompt from buildSystemBlocks (persona, memory tail,
 *     summary, knowledge, language), the game's rules as `extraStable` so they
 *     ride inside the cached prefix, and a clock pinned for the whole game;
 *   - the thread = the chat transcript merged with the game's own append-only
 *     move log, cache-marked at its end, with the volatile turn block folded
 *     on after the mark;
 *   - ONE fixed tool array for every turn kind (tools are the first part of
 *     the cache prefix), the turn block says which tool this turn is for;
 *   - every tool_use answered with a tool_result block in ONE user message.
 *     The Fleet Battle service this replaces sent the notes back as a plain
 *     text user message: the next hop then carried a tool_use with no
 *     tool_result, which Anthropic (and the OpenAI-compatible APIs) reject
 *     with a 400. That is what killed the AI turn the first time the model
 *     re-fired a cell, so the engine shot for it;
 *   - table talk is spoken through the same path chess uses (splitReply, the
 *     silence filter, voice:true on a call, persisted and pushed). On a chat
 *     reply or the game-over reaction it is the plain text. On a move or
 *     placement turn plain text is the model's PRIVATE scratch space and the
 *     line it says out loud is the optional `say` field of the move tool
 *     (SAY_PROPERTY), the same split as the bot's say() (260616): real games
 *     with Haiku 5.5 had it work the board out in plain text ("Board check:
 *     red has col 4 rows 1 and 3...") and every word of that reached the
 *     player as table talk. A rejected call's `say` is dropped.
 *   - say before the move, reaction after it (T568). The `say` of a legal
 *     call is said BEFORE the move lands (ToolOutcome.apply), so it is about
 *     what already happened: written in the same call as the shot, it could
 *     not know the result, and lines like "i hit one!" or "three across now"
 *     sat next to results that said otherwise. When the result is a moment
 *     worth a word (Fleet Battle: her shot sank a ship; Four in a Row: after
 *     her piece someone can make four right now) the game sends the result
 *     as checked facts with the tool_result and the model gets one more hop,
 *     its plain text said out loud. Only on those moves, so the extra call
 *     is bounded (at most 5 a Fleet Battle game; the threat moves of a Four
 *     in a Row game), not one per turn.
 *
 * The runner never decides a move. A tool call the game rejects goes back to
 * the model as an error tool_result so it can correct itself; a turn that
 * ends without a move returns `moved: false` and the caller decides whether to
 * try again or stop in the failed state.
 *
 * Errors: provider failures are thrown unchanged (the caller classifies
 * them); the attempt deadline throws a TimeoutError; a turn superseded by the
 * game ending or another turn throws CHAT_ABORTED.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../../shared/ipc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter } from '../characterStore';
import { CHAT_TIMEOUT_MS } from '../chat/sdk';
import { buildLlmProvider, providerTimeoutMs } from '../llm';
import type { LlmMessage, LlmProvider } from '../llm/types';
import { buildSystemBlocks, markLastMessageCached } from '../chat/chatPrompts';
import { readChatContext } from '../chat/continuity';
import { readKnowledgeForPrompt } from '../knowledge/knowledgeStore';
import {
  splitReply,
  toMessages,
  foldUserNote,
  CHAT_ABORTED,
  isSilenceFiller,
  TRANSCRIPT_STOP_SEQUENCES,
} from '../chat/chatService';
import * as chatStore from '../chat/chatStore';
import { appendMemory, humanizeMemoryStamps } from '../../bot/brain/memory/memoryLog.js';
import { companionLanguageFor } from '../companionLanguage';
import { surfaceErrorClass, type SurfaceErrorClass } from '../surfaceErrorClass';
import type { MinigameTurnFailReason, MinigameTurnFailure } from '../../shared/minigameTurn';

export type BoardTurnKind = 'move' | 'place' | 'chat-reply' | 'game-over';

/** What the game made of one of the model's tool calls. */
export interface ToolOutcome {
  /** The tool_result text the model reads. */
  note: string;
  /** Sent as is_error: the call was rejected (illegal move, bad input). */
  isError?: boolean;
  /** The move (or the fleet) was applied: the turn's job is done. */
  moved?: boolean;
  /** Count this call as an illegal move attempt. */
  illegal?: boolean;
  /**
   * Move turns: a legal move the game has NOT put on the board yet. The
   * runner says the call's `say` first and only then calls this, so the line
   * is said before the result shows and never sits next to a result it could
   * not know (T568). Returns the tool_result note and, when the result is a
   * moment worth a word, `reaction`: the result in checked facts plus the ask,
   * sent with the note, and the model gets ONE more hop whose plain text is
   * said out loud. Null = the game moved on before the move could land.
   */
  apply?: () => { note: string; reaction?: string } | null;
}

export interface BoardToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface BoardTurnArgs {
  /** Log tag, e.g. 'connect4'. */
  surface: string;
  characterId: string;
  kind: BoardTurnKind;
  /** Whole-game rules, cached (BuildSystemArgs.extraStable). */
  contract: string;
  /** What is true now and what this turn is for. Volatile, after the mark. */
  turnBlock: string;
  /** Append-only move record, merged into the thread by timestamp. */
  gameLog: ReadonlyArray<{ ts: number; text: string }>;
  /**
   * Chat-reply turns: ids of the player's messages this reply answers. They
   * are moved to the end of the thread (see buildGameThread).
   */
  unansweredIds?: ReadonlyArray<string>;
  /** Clock pinned at game start (chatPrompts.clockNow) so the prefix stays stable. */
  clock: string;
  /** The game's fixed tool array. Must not change between turns of a game. */
  tools: ReadonlyArray<unknown>;
  voiceCall: boolean;
  maxHops: number;
  maxTokens: number;
  /** True once this turn no longer counts (game ended, superseded). */
  isStale: () => boolean;
  /** Game tools. `remember` is handled here and never reaches it. */
  onTool: (tu: BoardToolUse) => Promise<ToolOutcome>;
  /** User note sent after a hop that ended without the move (move/place turns). */
  noMoveNudge?: string;
  /**
   * Receives the turn's AbortController so the game can cancel it
   * (done=false), and again when the turn is over (done=true).
   */
  registerAbort: (ctrl: AbortController, done: boolean) => void;
  pushChatMessage: (characterId: string, message: ChatMessage) => void;
  /** Test seam: the provider to use (defaults to buildLlmProvider()). */
  provider?: LlmProvider;
}

export interface BoardTurnResult {
  moved: boolean;
  /** Lines that reached the player (persisted + pushed). */
  spoken: ChatMessage[];
  hops: number;
  /** Tool calls the game rejected as illegal moves. */
  illegal: number;
  /** Hops that ended with no tool call at all on a move/place turn. */
  noToolHops: number;
  /** The last rejection note, for the next attempt's turn block. */
  lastRejection: string | null;
}

/**
 * The optional table-talk field of every move tool (play, fire, place_fleet).
 * On move turns plain text is private, so this is the only way a line said
 * with a move reaches the player.
 */
export const SAY_PROPERTY = {
  type: 'string',
  description:
    'Optional. One short line you say out loud, in your own voice, just BEFORE your move lands, so it can only be ' +
    'about what already happened (their last move, the game so far) or a tip. Leave it out on most moves. Never put ' +
    'a cell name, a column number or your plan in it (the board shows the move), and do not start it with "ok".',
} as const;

/** Most tokens the reaction hop may write: one short spoken line. */
const REACTION_MAX_TOKENS = 200;

/**
 * The result an attempt reports when its move was already applied by an
 * earlier hop or attempt of the same turn (the runner threw after the tool
 * call landed). The caller returns it instead of running the turn again, so
 * a retry never makes a second move.
 */
export function alreadyMovedResult(): BoardTurnResult {
  return { moved: true, spoken: [], hops: 0, illegal: 0, noToolHops: 0, lastRejection: null };
}

/**
 * Wall-clock budget for one attempt at a turn: chess's 90s, or twice the
 * provider's own per-call floor when that is longer (Ollama's is 120s for a
 * cold local load, so a local model gets 240s instead of being cut off).
 */
export const ATTEMPT_BUDGET_MS = 90_000;
export function attemptBudgetMs(llm: Pick<LlmProvider, 'kind'>): number {
  return Math.max(ATTEMPT_BUDGET_MS, providerTimeoutMs(llm, CHAT_TIMEOUT_MS) * 2);
}

/** Error thrown when an attempt runs past its wall-clock budget. */
export class BoardTurnTimeout extends Error {
  constructor(ms: number) {
    super(`board turn timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function readMemoryTail(id: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(id), 'MEMORY.md'), 'utf8');
    // Same budget and local-time stamps as chess / chatService (12000 bytes).
    return humanizeMemoryStamps(raw.length <= 12000 ? raw : raw.slice(-12000));
  } catch {
    return '';
  }
}

/**
 * Transcript rows + the game's move log, in time order (chess buildGameThread).
 *
 * `unansweredIds` (chat-reply turns): the player's messages this reply is for
 * go last, after the move log and her own move line. In time order a line
 * typed while her move was running sat BEFORE that move and the line she said
 * with it, so Haiku 5.5 read it as already answered ("Ren hasn't said anything
 * yet", 4 of 4 in the 261128 eval).
 */
export function buildGameThread(
  history: ChatMessage[],
  gameLog: ReadonlyArray<{ ts: number; text: string }>,
  unansweredIds: ReadonlyArray<string> = [],
): ChatMessage[] {
  const rows: ChatMessage[] = [
    ...history,
    ...gameLog.map((g, i) => ({ id: `game-${g.ts}-${i}`, role: 'user' as const, text: g.text, ts: g.ts })),
  ].sort((a, b) => a.ts - b.ts);
  if (unansweredIds.length === 0) return rows;
  const pending = new Set(unansweredIds);
  return [...rows.filter((m) => !pending.has(m.id)), ...rows.filter((m) => pending.has(m.id))];
}

/** Longest quoted player line in a chat-reply turn block. */
const QUOTE_MAX = 280;
/** Most player lines quoted in one chat-reply turn block (the latest ones). */
const QUOTE_LINES = 3;

/**
 * The chat-reply turn's opening: the player's unanswered line(s), quoted.
 * "They just said something" alone left the model to find the line in the
 * thread, and it often found its own move talk instead. Starts with
 * "They just said" (the eval harness keys chat-reply turns on it).
 */
export function unansweredNote(texts: ReadonlyArray<string>): string {
  const quoted = texts
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-QUOTE_LINES)
    .map((t) => `"${truncate(t, QUOTE_MAX)}"`);
  if (quoted.length === 0) return 'They just said something.';
  return (
    `They just said to you: ${quoted.join(', then ')}. You have not answered ${quoted.length > 1 ? 'these' : 'this'} ` +
    'yet. Talk to them as "you", not about them.'
  );
}

/**
 * Chat replies may run two or three short lines when the player asks how to
 * play or for help (product call 261128: "increase line length, fix until
 * they can teach"). false = "one short line, or nothing" everywhere.
 */
export const LONGER_HELP_REPLIES = true;

/** The contract's chat-reply sentence, shared by Four in a Row and Fleet Battle. */
export function chatReplyRule(longerHelp: boolean = LONGER_HELP_REPLIES): string {
  const base =
    'When they talk to you, or when the game is over, there is no move to make and your plain text is said out ' +
    'loud, exactly as written. One short line, or nothing.';
  return longerHelp
    ? `${base} When they ask how to play, or ask for help or the rules, you can use two or three short lines to explain.`
    : base;
}

/**
 * The opening of each game's teaching paragraph (T567). Personas that are
 * shy, gloomy or "bad at games" told a beginner "i'm still figuring this out
 * too" and then gave thin or wrong rules (261128 eval). The persona shapes
 * how it teaches, never whether the rules it states are right.
 */
export const TEACHING_LEAD =
  'If they are new to the game or ask you to teach them, teach them as you play. You know this game and how ' +
  'to play it well, whatever your persona is like, so the rules and tips you give are plain and correct, and ' +
  'you never tell them you do not know the game yourself. How you say them is all yours: your words, your ' +
  'attitude, your habits, the way you would explain anything to them. A longer explanation is still you ' +
  'talking, never a manual.';

/**
 * Chat-reply facts outrank the player (T568). A beginner said "C7 is a miss"
 * about a cell nobody had fired at; Lyra agreed ("C7 is out") against her own
 * facts list and the player lost the ship for 31 shots.
 */
export const FACTS_WIN =
  'They are new and can misremember the board; these facts are always right. When something they say does not ' +
  'match them, do not go along with it: tell them, kindly and in your own way, what really happened.';

/**
 * The last line of a chat-reply turn block. Lyra, given the teaching
 * paragraph, planned her answer in plain text on chat turns ("Ren is new and
 * asks to be taught as we go. I should reply with the rules...") and every
 * word of it was said out loud (T567 probe, 2 of 2 Four in a Row openers).
 */
export const SPOKEN_NOW =
  'Everything you write now is said out loud to them exactly as written, so write only the words you say to them.';

/**
 * A model reply made fit to send back as an assistant turn. Anthropic rejects
 * (400) an assistant message with no content or a whitespace-only text block,
 * and a reply can be exactly that (an empty answer before the nudge hop).
 * Blank text blocks are dropped; a reply left with nothing becomes a short
 * placeholder the model reads as its own silence.
 */
export function replayableContent(
  content: readonly Anthropic.Messages.ContentBlock[],
): Anthropic.Messages.ContentBlockParam[] {
  const kept = content.filter((b) => b.type !== 'text' || b.text.trim().length > 0);
  if (kept.length) return kept as Anthropic.Messages.ContentBlockParam[];
  return [{ type: 'text', text: '(no reply)' }];
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export async function runBoardTurn(a: BoardTurnArgs): Promise<BoardTurnResult> {
  const character = await getCharacter(a.characterId);
  if (!character) throw new Error('character not found');
  const config = await loadConfig();
  const [{ summary, history }, memory, knowledge] = await Promise.all([
    readChatContext(a.characterId),
    readMemoryTail(a.characterId),
    readKnowledgeForPrompt(a.characterId).catch(() => ''),
  ]);
  const punctuation = character.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual';
  const lang = companionLanguageFor(character, config);
  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness: 1,
    surface: 'game',
    punctuation,
    memory,
    summary,
    knowledge,
    openWorldDetected: false,
    inGame: false,
    voiceCall: a.voiceCall,
    language: lang.language,
    adoptedLanguage: lang.adopted,
    extraStable: a.contract,
    pinnedClock: a.clock,
  } as Parameters<typeof buildSystemBlocks>[0]);

  const messages: LlmMessage[] = toMessages(buildGameThread(history, a.gameLog, a.unansweredIds));
  const endsOnUser = messages.length > 0 && messages[messages.length - 1].role === 'user';
  markLastMessageCached(endsOnUser ? messages.slice(0, -1) : messages);
  // "(game)" like the move log: with the player's line moved right before
  // it, a bare board read as something the player pasted ("the board you
  // pasted doesn't match", 261128 eval re-run).
  foldUserNote(messages, `(game) ${a.turnBlock}`);

  const llm = a.provider ?? (await buildLlmProvider());
  const budget = attemptBudgetMs(llm);
  const ctrl = new AbortController();
  a.registerAbort(ctrl, false);
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  // The abort alone is not a deadline: a provider call that ignores the signal
  // would never settle. Every call is raced against this.
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      // Mark first: the abort wakes stale(), which must read it as a timeout
      // (retried), not as the turn being superseded.
      timedOut = true;
      try { ctrl.abort(); } catch { /* already done */ }
      reject(new BoardTurnTimeout(budget));
    }, budget);
  });
  deadline.catch(() => { /* observed through the race below */ });
  const stale = (): boolean => a.isStale() || (ctrl.signal.aborted && !timedOut);

  // Move/place turns: plain text is the model's private scratch space; only
  // the move tool's `say` (and the reaction hop, below) is said.
  const privateText = a.kind === 'move' || a.kind === 'place';
  const maxParts = a.kind === 'chat-reply' ? 3 : 2;
  const spoken: ChatMessage[] = [];
  // Parts said by the current speaker (the move's say, then the reaction:
  // each gets its own budget).
  let partsNow = 0;
  const persist = async (msg: ChatMessage): Promise<void> => {
    await chatStore.appendMessage(a.characterId, msg);
    a.pushChatMessage(a.characterId, msg);
    spoken.push(msg);
  };
  const speak = async (text: string): Promise<void> => {
    for (const part of splitReply(text, punctuation)) {
      if (!part || isSilenceFiller(part)) continue;
      if (partsNow >= maxParts) continue;
      partsNow++;
      await persist({
        id: randomUUID(),
        role: 'companion',
        text: part,
        ts: Math.max(Date.now(), (spoken[spoken.length - 1]?.ts ?? 0) + 1),
        ...(a.voiceCall ? { voice: true } : {}),
      });
    }
  };

  let moved = false;
  let reaction: string | null = null;
  let hops = 0;
  let illegal = 0;
  let noToolHops = 0;
  let lastRejection: string | null = null;

  try {
    for (let hop = 0; hop < a.maxHops && !stale(); hop++) {
      hops = hop + 1;
      let res: Awaited<ReturnType<LlmProvider['call']>>;
      try {
        res = await Promise.race([
          llm.call({
            maxTokens: a.maxTokens,
            system,
            tools: a.tools as never,
            stopSequences: TRANSCRIPT_STOP_SEQUENCES,
            messages,
            timeoutMs: CHAT_TIMEOUT_MS,
            signal: ctrl.signal,
          }),
          deadline,
        ]);
      } catch (err) {
        if (err instanceof BoardTurnTimeout) timedOut = true;
        throw err;
      }
      const u = res.usage;
      console.log(
        `[sei/${a.surface}] turn char=${a.characterId.slice(0, 8)} kind=${a.kind} hop=${hop} ` +
          `in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
      );
      if (stale()) break;

      const text = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) {
        // Move/place turns: plain text is the model's scratch space, never said.
        if (privateText) console.log(`[sei/${a.surface}] scratch (private): ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
        else await speak(text);
      }

      const toolUses = res.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      if (!toolUses.length) {
        if ((a.kind === 'move' || a.kind === 'place') && a.noMoveNudge && hop + 1 < a.maxHops) {
          noToolHops++;
          messages.push({ role: 'assistant', content: replayableContent(res.content) });
          messages.push({ role: 'user', content: a.noMoveNudge });
          continue;
        }
        if (a.kind === 'move' || a.kind === 'place') noToolHops++;
        break;
      }

      messages.push({ role: 'assistant', content: replayableContent(res.content) });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let out: ToolOutcome;
        if (tu.name === 'remember') {
          out = await rememberNote(a.characterId, tu.input);
        } else if (moved) {
          out = { note: 'Your move is already made this turn. Do not call it again.', isError: true };
        } else if (stale()) {
          out = { note: 'The game has moved on; this does nothing now.', isError: true };
        } else {
          out = await a.onTool({ id: tu.id, name: tu.name, input: tu.input });
          if (out.moved) {
            // The line said with a legal move goes out BEFORE the move lands
            // (out.apply), so it can never claim a result it did not know.
            const say = (tu.input as { say?: unknown } | null)?.say;
            if (typeof say === 'string' && say.trim()) {
              // A line that fails to land (a chat-store write) never costs the move.
              await speak(say.trim()).catch((err) => {
                console.warn(`[sei/${a.surface}] move line not said: ${(err as Error)?.message ?? err}`);
              });
            }
            if (out.apply) {
              const applied = stale() ? null : out.apply();
              if (!applied) {
                out = { note: 'The game has moved on; this does nothing now.', isError: true };
              } else {
                out = { ...out, note: applied.reaction ? `${applied.note}\n\n${applied.reaction}` : applied.note };
                reaction = applied.reaction ?? null;
              }
            }
            moved = !out.isError;
          }
          if (out.illegal) {
            illegal++;
            lastRejection = out.note;
          }
        }
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: out.note,
          ...(out.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });

      if (moved) break;
      if (a.kind === 'chat-reply' || a.kind === 'game-over') {
        // A reply that already said its line is the whole turn. Chess keeps
        // going after tools that return something to talk about (search); no
        // board tool does, and a second hop only said the same line again.
        if (text) break;
      }
    }

    // The reaction hop (T568): the move landed on a moment worth a word (a
    // sink, a chance to make four), and the model now sees the result as
    // checked facts in the tool_result. One call, only on those moves; its
    // plain text is said out loud, and nothing it calls does anything.
    if (moved && reaction && !stale()) {
      hops++;
      const res = await Promise.race([
        llm.call({
          maxTokens: REACTION_MAX_TOKENS,
          system,
          tools: a.tools as never,
          stopSequences: TRANSCRIPT_STOP_SEQUENCES,
          messages,
          timeoutMs: CHAT_TIMEOUT_MS,
          signal: ctrl.signal,
        }),
        deadline,
      ]).catch((err) => {
        // The move already landed: a failed reaction only loses the line.
        if (err instanceof BoardTurnTimeout) timedOut = true;
        console.warn(`[sei/${a.surface}] reaction hop failed: ${(err as Error)?.message ?? err}`);
        return null;
      });
      if (res && !stale()) {
        const u = res.usage;
        console.log(
          `[sei/${a.surface}] turn char=${a.characterId.slice(0, 8)} kind=${a.kind} reaction ` +
            `in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} cacheRead=${u?.cache_read_input_tokens ?? 0}`,
        );
        const line = res.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        partsNow = 0;
        if (line) await speak(line);
      }
    }

    if (a.isStale()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }
    return { moved, spoken, hops, illegal, noToolHops, lastRejection };
  } catch (err) {
    if (!timedOut && (ctrl.signal.aborted || a.isStale())) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    a.registerAbort(ctrl, true);
  }
}

async function rememberNote(characterId: string, input: unknown): Promise<ToolOutcome> {
  const memText = String((input as { text?: string } | undefined)?.text ?? '').trim();
  if (!memText) return { note: 'Nothing saved; the text was empty.' };
  try {
    // 0 = the bounded duplicate guard skipped the write (chess 260725).
    const written = await appendMemory(
      path.join(paths.memoryDir(characterId), 'MEMORY.md'),
      memText,
      undefined,
      { section: 'app' },
    );
    return {
      note:
        written === 0
          ? 'You already saved that a moment ago; nothing new was written. Continue.'
          : 'Saved. Continue; do not mention saving it.',
    };
  } catch {
    return { note: 'Could not save it. Continue.' };
  }
}

// ── attempts: retry, then a clear failed state (never an engine move) ────────

/** Attempts per character turn before the game stops in the failed state. */
export const MOVE_ATTEMPTS = 3;
/** Pause before attempt 2 and 3 after a provider error or timeout. */
export const RETRY_BACKOFF_MS = [1500, 4000] as const;

/** Error classes a second attempt cannot fix: stop at once. */
const FATAL_CLASSES = new Set<SurfaceErrorClass>([
  'no_api_key',
  'config',
  'auth',
  'payment_required',
  'model_not_found',
  'context_length',
  'tools_unsupported',
  'not_found',
  'request_too_large',
  'out_of_memory',
]);

export type AttemptOutcome =
  | {
      kind: 'moved';
      result: BoardTurnResult;
      attempts: number;
      /** Illegal tool calls across all attempts. */
      illegal: number;
    }
  | {
      kind: 'failed';
      failure: MinigameTurnFailure;
      /** surfaceErrorClass of the last provider error, when there was one. */
      errorClass: SurfaceErrorClass | null;
      illegal: number;
    }
  | { kind: 'aborted' };

export interface AttemptArgs {
  /**
   * Run one attempt. `retryNote` is null on the first attempt, else a short
   * plain sentence saying why the previous attempt did not count, for the
   * turn block.
   */
  attempt: (index: number, retryNote: string | null) => Promise<BoardTurnResult>;
  /** False once the turn no longer matters (game over, superseded). */
  isLive: () => boolean;
  /** raiseUsageLimitPopup for this surface; non-null = cloud wall, stop. */
  onUsageLimit: (err: unknown) => Promise<'depleted' | 'rate_limited' | null>;
  /** Called after each failed attempt (logging, analytics). */
  onAttemptError?: (index: number, err: unknown, errorClass: SurfaceErrorClass) => void;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * Run a character turn with retries. Illegal moves and timeouts are given back
 * to the model on the next attempt; a usage limit or an auth/config problem
 * stops at once. Returns the failure instead of ever choosing a move.
 */
export async function runWithAttempts(p: AttemptArgs): Promise<AttemptOutcome> {
  const max = p.maxAttempts ?? MOVE_ATTEMPTS;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let illegal = 0;
  let retryNote: string | null = null;
  let lastReason: MinigameTurnFailReason = 'no_move';
  let lastClass: SurfaceErrorClass | null = null;
  for (let i = 0; i < max; i++) {
    if (!p.isLive()) return { kind: 'aborted' };
    try {
      const result = await p.attempt(i, retryNote);
      illegal += result.illegal;
      if (result.moved) return { kind: 'moved', result, attempts: i + 1, illegal };
      if (result.illegal > 0) {
        lastReason = 'illegal_move';
        retryNote =
          `Your last try did not count: ${result.lastRejection ?? 'that move was not legal.'} ` +
          'Make your move now with a legal choice.';
      } else {
        lastReason = 'no_move';
        retryNote = 'Your last try did not count: you did not make a move. Make your move now.';
      }
      lastClass = null;
    } catch (err) {
      if ((err as Error)?.message === CHAT_ABORTED || !p.isLive()) return { kind: 'aborted' };
      const cls = surfaceErrorClass(err);
      lastClass = cls;
      p.onAttemptError?.(i, err, cls);
      const limited = await p.onUsageLimit(err);
      if (limited) {
        return {
          kind: 'failed',
          failure: { reason: limited === 'depleted' ? 'credit_wall' : 'rate_limited', attempts: i + 1 },
          errorClass: cls,
          illegal,
        };
      }
      if (FATAL_CLASSES.has(cls)) {
        return {
          kind: 'failed',
          failure: { reason: cls === 'auth' || cls === 'no_api_key' ? 'auth' : 'provider_error', attempts: i + 1 },
          errorClass: cls,
          illegal,
        };
      }
      lastReason = err instanceof BoardTurnTimeout || cls === 'timeout' ? 'timeout' : 'provider_error';
      retryNote = null;
      if (i + 1 < max) {
        await sleep(RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)]);
      }
    }
  }
  if (!p.isLive()) return { kind: 'aborted' };
  return { kind: 'failed', failure: { reason: lastReason, attempts: max }, errorClass: lastClass, illegal };
}
