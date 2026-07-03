/**
 * Chat turn orchestration (main process). Builds the prompt, calls Anthropic,
 * runs the single `launch` tool loop, persists both sides, returns the reply.
 *
 * The launch loop implements the user's spec: launch() starts the summon
 * immediately when a LAN world is open; otherwise it feeds a plain-language
 * tool_result back to the model explaining the world is not open and how to open
 * it, and the model paraphrases that in its own voice.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ChatSendResult, LanState } from '../../shared/ipc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter, saveCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from './sdk';
import { buildSystemBlocks, LAUNCH_TOOL } from './chatPrompts';
import { readSummary } from './continuity';
import * as chatStore from './chatStore';

export interface ChatDeps {
  getLanState: () => LanState;
  summon: (characterId: string) => Promise<void>;
  /** Task 4 — true when the character's bot is fully spawned in-world right now. */
  isInGame?: (characterId: string) => boolean;
  /**
   * Task 4 — route a message INTO the live game session (shared brain + prompt
   * cache). Returns false if no session took it, so the caller can fall back to
   * the standalone chat brain.
   */
  routeToBot?: (characterId: string, payload: { from: string; text: string }) => boolean;
  /** Task 1 — record that this turn launched a game, for the "joined" ack. */
  onLaunch?: (characterId: string) => void;
  /** The (non-blocking) join kicked off by launch() failed — post a chat notice. */
  onLaunchFailed?: (characterId: string, reason: string) => void;
}

const RECENT = 50;
const MEMORY_BUDGET_BYTES = 6000;
const MAX_HOPS = 3;

/**
 * In-flight chat turn per character (chat #9). A new send for the same character
 * aborts the previous one's LLM call and supersedes it, so the user can fire a
 * follow-up (or correction) without waiting — the stale turn never appends a
 * reply. Keyed by characterId; the entry is the current turn's controller.
 */
const inflight = new Map<string, AbortController>();

/** Sentinel thrown when a turn was interrupted/superseded (not a real failure). */
export const CHAT_ABORTED = 'CHAT_ABORTED';

/** True if the error is our deliberate abort (vs a real API/timeout error). */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'AbortError' || /abort/i.test(e?.message ?? '');
}

async function readMemoryTail(characterId: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(characterId), 'MEMORY.md'), 'utf8');
    return raw.length <= MEMORY_BUDGET_BYTES ? raw : raw.slice(-MEMORY_BUDGET_BYTES);
  } catch {
    return '';
  }
}

/**
 * Split a reply into the separate chat messages the UI should send. A blank line
 * (paragraph break) is the split point, so a model that writes two thoughts with
 * an empty line between them lands as two messages — the way a person double-taps
 * enter in a chat. No blank line → one message. Empty chunks are dropped; a reply
 * with no content collapses to a single "…" so the turn is never message-less.
 */
export function splitReply(text: string): string[] {
  const parts = text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : ['…'];
}

/** Concatenate the text blocks of an Anthropic response content array. */
function textOf(content: Array<{ type: string }>): string {
  return content
    .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
    .join('')
    .trim();
}

/** Map the persisted transcript into an alternating Anthropic messages array. */
function toMessages(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of history) {
    // A finished play session is shared history, not chatter: surface it as a
    // bracketed system fact so the companion knows you actually played together
    // (the game→chat memory gap — otherwise chat only sees MEMORY.md, which may
    // never have captured the session). Framed so the model doesn't read it as
    // the player speaking or as a still-hypothetical plan.
    if (m.role === 'system' && m.event?.kind === 'play') {
      out.push({
        role: 'user',
        content: `[Shared history: ${m.text} You were there together in the world — treat it as something you actually did, not a plan.]`,
      });
      continue;
    }
    // Other system rows (e.g. "joined your world") are UI-only; skip them so
    // they don't pollute the model's turn-taking.
    if (m.role === 'system') continue;
    // A quoted reply is surfaced to the model as a short lead-in so it knows
    // what the user is referring to, then the actual message text.
    let content = m.text;
    if (m.replyTo) {
      const who = m.replyTo.role === 'companion' ? 'your earlier message' : 'their earlier message';
      content = `(replying to ${who}: "${m.replyTo.text}")\n${m.text}`;
    }
    const role = m.role === 'companion' ? 'assistant' : 'user';
    // Merge consecutive same-role turns. An interrupted turn (#9) leaves a user
    // message with no reply, so the transcript can hold two user turns in a row;
    // Anthropic requires strict alternation, so fold them into one.
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && typeof content === 'string') {
      last.content = `${last.content}\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  // Anthropic requires the first message to be from the user.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function sendChatMessage(
  args: { characterId: string; text: string; replyTo?: ChatMessage['replyTo'] },
  deps: ChatDeps,
): Promise<ChatSendResult> {
  // #9 — supersede any in-flight turn for this character: abort its LLM call so
  // this new message interrupts + replaces it. `superseded()` catches the race
  // where the old call resolved between abort() and the abort taking effect.
  inflight.get(args.characterId)?.abort();
  const ctrl = new AbortController();
  inflight.set(args.characterId, ctrl);
  const superseded = (): boolean => inflight.get(args.characterId) !== ctrl;

  try {
    const character = await getCharacter(args.characterId);
    if (!character) throw new Error('Character not found');
    const config = await loadConfig();

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: args.text,
      ts: Date.now(),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    };
    await chatStore.appendMessage(args.characterId, userMsg);

    // Task 4 — if the companion is live in-game, route this message INTO that
    // session (same brain + prompt cache) instead of the standalone chat brain,
    // so the two surfaces are one conversation. The bot receives it as an
    // out-of-band "message via Sei chat" and replies asynchronously over the
    // chat:message push; we return `routed` so the renderer keeps the typing
    // indicator up until that reply lands. Falls through to the chat brain if
    // the session vanished between the check and the post.
    if (deps.isInGame?.(args.characterId) && deps.routeToBot) {
      const from = (config.preferred_name ?? '').trim() || 'The player';
      if (deps.routeToBot(args.characterId, { from, text: args.text })) {
        return { replies: [], routed: true };
      }
    }

    const [history, memory, summary] = await Promise.all([
      chatStore.readRecent(args.characterId, RECENT),
      readMemoryTail(args.characterId),
      readSummary(args.characterId),
    ]);

    // Author's proactiveness dial (0-2), same source + clamp the bot uses
    // (character.metadata.proactiveness), so the character is as forward in chat
    // as it is in-game. Missing/out-of-range → reactive (1).
    const rawProactiveness = character.metadata?.proactiveness;
    const proactiveness =
      typeof rawProactiveness === 'number' && Number.isInteger(rawProactiveness)
        ? Math.min(Math.max(0, rawProactiveness), 2)
        : 1;

    const system = buildSystemBlocks({
      persona: character.persona,
      name: character.name,
      preferredName: config.preferred_name ?? '',
      proactiveness,
      memory,
      summary,
      // Per-turn: is an open-to-LAN world detected right now? Lets the model
      // decide launch() vs. open-to-LAN instructions.
      openWorldDetected: deps.getLanState().kind === 'open',
    });

    const messages = toMessages(history);
    const { client, model } = await buildChatSdk();

    let launch: ChatSendResult['launch'];
    let replyText = '';

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await client.messages.create(
        // Hard cap kept low so a reply can't ratchet into paragraphs. Each turn
        // feeds the model its own prior replies (toMessages), and with a generous
        // ceiling it self-conditions on the last (longest) turn and creeps up a
        // sentence each time. 200 tokens comfortably fits the 1–2 sentence target
        // from the system prompt without truncating mid-sentence.
        { model, max_tokens: 200, system, tools: [LAUNCH_TOOL], messages: messages as never },
        // #9 — abortable: a follow-up send aborts this signal.
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const text = textOf(res.content);
      if (text) replyText = text;

      const toolUse = res.content.find((b) => b.type === 'tool_use') as
        | { type: 'tool_use'; id: string; name: string; input: { game?: string } }
        | undefined;
      if (!toolUse || toolUse.name !== 'launch') break;

      messages.push({ role: 'assistant', content: res.content });
      const game = String(toolUse.input?.game ?? 'minecraft');
      const result = await executeLaunch(args.characterId, game, deps);
      launch = result.launch;
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result.note }] as never,
      });
    }

    // #9 — if a newer send arrived (or we were aborted) while this turn ran,
    // drop the reply rather than append a stale one.
    if (ctrl.signal.aborted || superseded()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }

    // Split on blank lines so a multi-paragraph reply lands as separate messages
    // (task 8). Each is its own persisted message + its own bubble in the UI,
    // which reveals them one at a time. Stamp ascending ts so ordering is stable.
    const now = Date.now();
    const replies: ChatMessage[] = splitReply(replyText).map((text, i) => ({
      id: randomUUID(),
      role: 'companion',
      text,
      ts: now + i,
    }));
    for (const reply of replies) await chatStore.appendMessage(args.characterId, reply);

    // #6 — stamp last_chatted on a successful reply so a plain chat counts as a
    // "last interaction" for the card date + ordering (device-local, like
    // last_launched; the cloud upsert omits it). Best-effort — a persistence
    // hiccup must not fail the chat turn.
    try {
      await saveCharacter({ ...character, last_chatted: new Date().toISOString() });
    } catch (err) {
      console.warn(`[sei] failed to stamp last_chatted for ${args.characterId}: ${(err as Error).message}`);
    }

    return { replies, launch };
  } catch (err) {
    // Interrupt/supersede surfaces as a typed sentinel so the renderer can tell
    // it apart from a real failure (and NOT show the "sorry" fallback).
    if (isAbortError(err) || ctrl.signal.aborted || superseded()) {
      const e = new Error(CHAT_ABORTED);
      (e as Error & { code?: string }).code = CHAT_ABORTED;
      throw e;
    }
    throw err;
  } finally {
    // Only clear the map if we're still the current turn (a superseding send
    // already replaced the entry and must keep its own controller).
    if (inflight.get(args.characterId) === ctrl) inflight.delete(args.characterId);
  }
}

async function executeLaunch(
  characterId: string,
  game: string,
  deps: ChatDeps,
): Promise<{ note: string; launch: NonNullable<ChatSendResult['launch']> }> {
  if (game !== 'minecraft') {
    return {
      note: `The game "${game}" is not available yet — only Minecraft can be launched right now. Tell the player it is coming soon.`,
      launch: { game, status: 'lan-not-open' },
    };
  }
  const lan = deps.getLanState();
  if (lan.kind === 'open') {
    // Fire the summon but DO NOT await it here — a full join can take many
    // seconds or time out, and blocking the chat turn on it is what left the UI
    // stuck on "typing…". Acknowledge immediately; the deterministic "joined
    // your world" line confirms the real join, and a failure posts a notice.
    deps.onLaunch?.(characterId);
    void deps.summon(characterId).catch((e) => {
      deps.onLaunchFailed?.(characterId, (e as Error)?.message ?? 'unknown error');
    });
    return {
      note:
        'You are on your way into the player\'s Minecraft world right now — tell them you\'re hopping in. ' +
        'Do NOT claim you have already arrived; you are still joining. Keep it to one short line.',
      launch: { game, status: 'summoning' },
    };
  }
  return {
    note:
      'The player\'s Minecraft world is not open to LAN, so you cannot join yet. ' +
      'In Minecraft they need to pause the game (press Esc), click "Open to LAN", then "Start LAN World". ' +
      'Explain this to them in your own voice and ask them to do it, then you can hop in.',
    launch: { game, status: 'lan-not-open' },
  };
}

export { readRecent } from './chatStore';
export const chatStoreApi = chatStore;
