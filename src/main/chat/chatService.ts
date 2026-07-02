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

    const [history, memory, summary] = await Promise.all([
      chatStore.readRecent(args.characterId, RECENT),
      readMemoryTail(args.characterId),
      readSummary(args.characterId),
    ]);

    const system = buildSystemBlocks({
      persona: character.persona,
      name: character.name,
      preferredName: config.preferred_name ?? '',
      memory,
      summary,
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

    if (!replyText) replyText = '…';
    const reply: ChatMessage = { id: randomUUID(), role: 'companion', text: replyText, ts: Date.now() };
    await chatStore.appendMessage(args.characterId, reply);

    // #6 — stamp last_chatted on a successful reply so a plain chat counts as a
    // "last interaction" for the card date + ordering (device-local, like
    // last_launched; the cloud upsert omits it). Best-effort — a persistence
    // hiccup must not fail the chat turn.
    try {
      await saveCharacter({ ...character, last_chatted: new Date().toISOString() });
    } catch (err) {
      console.warn(`[sei] failed to stamp last_chatted for ${args.characterId}: ${(err as Error).message}`);
    }

    return { reply, launch };
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
  if (lan.kind === 'connected') {
    try {
      await deps.summon(characterId);
      return {
        note: 'Launched. You are now joining the player\'s Minecraft world. Tell them you are jumping in.',
        launch: { game, status: 'summoning' },
      };
    } catch (e) {
      return {
        note: `Could not join: ${(e as Error).message}. Tell the player something came up and you could not join this time.`,
        launch: { game, status: 'lan-not-open' },
      };
    }
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
