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
import { buildSystemBlocks, LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL } from './chatPrompts';
import { readChatContext, foldIfDue, formatChatTimestamp } from './continuity';
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
  /** The (non-blocking) join kicked off by launch() failed — report it to the
   * player in the companion's own voice (index.ts sendLaunchFailedTurn). */
  onLaunchFailed?: (characterId: string, reason: string) => void;
  /**
   * Task 5 — the companion called quit() from chat: leave the game and end the
   * live session (supervisor.stop). A no-op when no session is live.
   */
  leaveGame?: (characterId: string) => void;
}

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

/**
 * Map the persisted transcript into an alternating Anthropic messages array.
 * Exported for testing. Every emitted row — play rows included — flows through
 * the ONE shared same-role merge at the bottom: a play row is just a `user` row
 * with bracketed content, so two adjacent play rows (or a user message followed
 * by a play row) fold into a single user turn instead of two adjacent `user`
 * messages that Anthropic rejects with 400 "roles must alternate".
 */
export function toMessages(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of history) {
    // Per row, derive role + content first; then run the single shared merge.
    let role: 'user' | 'assistant';
    let content: string;
    if (m.role === 'system' && m.event?.kind === 'play') {
      // A finished play session is shared history, not chatter: surface it as a
      // bracketed system fact so the companion knows you actually played together
      // (the game→chat memory gap — otherwise chat only sees MEMORY.md, which may
      // never have captured the session). Framed so the model doesn't read it as
      // the player speaking or as a still-hypothetical plan.
      role = 'user';
      content = `[${formatChatTimestamp(m.ts)}] [Shared history: ${m.text} You were there together in the world — treat it as something you actually did, not a plan.]`;
    } else if (m.role === 'system' && m.event?.kind === 'call') {
      // A finished voice call is shared history the same way a play session is
      // (260705): without it, a later turn only sees the transcript lines and
      // may not realize they were spoken on a real call.
      role = 'user';
      content = `[${formatChatTimestamp(m.ts)}] [Shared history: ${m.text} That was a real voice call you were both on — treat it as a conversation you actually had.]`;
    } else if (m.role === 'system') {
      // Other system rows (e.g. "joined your world") are UI-only; skip them so
      // they don't pollute the model's turn-taking.
      continue;
    } else {
      // A quoted reply is surfaced to the model as a short lead-in so it knows
      // what the user is referring to, then the actual message text.
      content = m.text;
      if (m.replyTo) {
        const who = m.replyTo.role === 'companion' ? 'your earlier message' : 'their earlier message';
        content = `(replying to ${who}: "${m.replyTo.text}")\n${m.text}`;
      }
      role = m.role === 'companion' ? 'assistant' : 'user';
      // 260703: stamp USER messages with their send time so the model can feel
      // gaps (overnight silence vs rapid-fire). Assistant turns stay unstamped —
      // stamping the model's own prior output teaches it to emit timestamps.
      if (role === 'user') content = `[${formatChatTimestamp(m.ts)}] ${content}`;
    }
    // Merge consecutive same-role turns. An interrupted turn (#9) leaves a user
    // message with no reply, and play rows arrive as user rows, so the transcript
    // can hold two user turns in a row; Anthropic requires strict alternation, so
    // fold them into one.
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  // Anthropic requires the first message to be from the user.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/**
 * Author's proactiveness dial (0-2). Missing / non-integer / out-of-range →
 * reactive (1). MIRROR: src/bot/index.js (~line 538) clamps
 * character.metadata.proactiveness identically; the bot ships as raw ESM in a
 * separate process and CANNOT import from src/main, so these two copies must be
 * kept in sync by hand.
 */
function clampProactiveness(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) ? Math.min(Math.max(0, raw), 2) : 1;
}

/**
 * Shared prompt assembly for a chat turn — getCharacter, loadConfig, the
 * summary+memory reads, the proactiveness clamp, the system blocks, and the
 * alternating messages array. Returns null when the character is missing.
 * Both sendChatMessage and sendLaunchFailedTurn build on this; the two callers
 * differ only in the per-turn openWorldDetected/inGame truth they pass in.
 *
 * NOTE: sendChatMessage appends the player's new message to the transcript
 * BEFORE calling this, so readChatContext here already includes it — do not
 * hoist this call above that append.
 */
async function prepareChatTurn(
  characterId: string,
  opts: { openWorldDetected: boolean; inGame: boolean; voiceCall?: boolean },
) {
  const character = await getCharacter(characterId);
  if (!character) return null;
  const config = await loadConfig();
  // Watermark-based context (260702): every not-yet-summarized message verbatim
  // (50-99 between folds) + the rolling summary. Pure read — the batch fold runs
  // in the background AFTER the reply (see foldIfDue).
  const [{ summary, history }, memory] = await Promise.all([
    readChatContext(characterId),
    readMemoryTail(characterId),
  ]);
  // Same source + clamp the bot uses (character.metadata.proactiveness), so the
  // character is as forward in chat as it is in-game.
  const proactiveness = clampProactiveness(character.metadata?.proactiveness);
  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness,
    memory,
    summary,
    openWorldDetected: opts.openWorldDetected,
    inGame: opts.inGame,
    voiceCall: opts.voiceCall === true,
  });
  const messages = toMessages(history);
  return { character, config, system, messages };
}

/**
 * Split a reply on blank lines (task 8) into separate persisted companion
 * messages — each its own bubble in the UI, revealed one at a time — and append
 * them in order (ascending ts so ordering is stable). Shared by the normal turn
 * and the launch-failed turn.
 */
async function persistReplies(
  characterId: string,
  replyText: string,
  opts?: { voice?: boolean },
): Promise<ChatMessage[]> {
  const now = Date.now();
  const replies: ChatMessage[] = splitReply(replyText).map((text, i) => ({
    id: randomUUID(),
    role: 'companion',
    text,
    ts: now + i,
    // Spoken on a live call → hidden in the chat UI (see ChatMessage.voice).
    ...(opts?.voice ? { voice: true } : {}),
  }));
  for (const reply of replies) await chatStore.appendMessage(characterId, reply);
  return replies;
}

export async function sendChatMessage(
  args: { characterId: string; text: string; replyTo?: ChatMessage['replyTo']; voiceCall?: boolean },
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
      // Sent during a live call (a transcribed utterance, or typed mid-call —
      // either way the exchange is spoken) → hidden in the chat UI.
      ...(args.voiceCall === true ? { voice: true } : {}),
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
        // In-game chatter appends to the transcript without ever running a
        // standalone chat turn, so drain any fold backlog from here too —
        // otherwise a long play session could grow the window unbounded.
        void foldIfDue(args.characterId, character.persona.expanded).catch(() => {});
        return { replies: [], routed: true };
      }
    }

    // Build the prompt AFTER the user message is appended above, so the turn's
    // context includes it. Per-turn truth passed in:
    //   openWorldDetected — is an open-to-LAN world detected right now? Lets the
    //     model decide launch() vs. open-to-LAN instructions.
    //   inGame — usually false here (a live session routes messages in-game), but
    //     re-read so the routed-then-vanished fallback and any races tell the truth.
    const prep = await prepareChatTurn(args.characterId, {
      openWorldDetected: deps.getLanState().kind === 'open',
      inGame: deps.isInGame?.(args.characterId) ?? false,
      // 260705: while a voice call is open the reply is read aloud by TTS, so
      // the system prompt leads with the voice-call primer (spoken register).
      voiceCall: args.voiceCall === true,
    });
    if (!prep) throw new Error('Character not found');
    const { system, messages } = prep;
    const { client, model } = await buildChatSdk();

    let launch: ChatSendResult['launch'];
    let replyText = '';
    // Task 2 — the actual summon is deferred until AFTER the reply is persisted,
    // so the companion's "hopping in" acknowledgement lands in chat before the
    // live-session popup (SummonedWidget) appears. Set when launch() resolves to
    // an open world; fired at the end of the turn.
    let startSummon = false;
    // Voice calls (260705) — the model called end_call(): returned to the
    // renderer, which speaks the goodbye replies first, then hangs up.
    let endCallRequested = false;
    // end_call is offered only while a call is open (block 0 already flips for
    // the primer, so this adds no extra cache churn).
    const tools = args.voiceCall === true ? [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL] : [LAUNCH_TOOL, QUIT_TOOL];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await client.messages.create(
        // Hard cap kept low so a reply can't ratchet into paragraphs. Each turn
        // feeds the model its own prior replies (toMessages), and with a generous
        // ceiling it self-conditions on the last (longest) turn and creeps up a
        // sentence each time. 200 tokens comfortably fits the 1–2 sentence target
        // from the system prompt without truncating mid-sentence.
        { model, max_tokens: 200, system, tools, messages: messages as never },
        // #9 — abortable: a follow-up send aborts this signal.
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      const text = textOf(res.content);
      if (text) replyText = text;

      const toolUse = res.content.find((b) => b.type === 'tool_use') as
        | { type: 'tool_use'; id: string; name: string; input: { game?: string } }
        | undefined;
      if (!toolUse) break;

      messages.push({ role: 'assistant', content: res.content });
      let note: string;
      if (toolUse.name === 'launch') {
        const game = String(toolUse.input?.game ?? 'minecraft');
        const result = resolveLaunch(game, deps);
        launch = result.launch;
        // Defer the real join — don't fire summon mid-loop (task 2).
        if (result.summon) startSummon = true;
        note = result.note;
      } else if (toolUse.name === 'quit') {
        // Task 5 — leave the game from chat. End the live session (no-op when
        // none is live) and tell the model it has logged off.
        deps.leaveGame?.(args.characterId);
        note =
          'You have left the Minecraft world and logged off. You are back in chat only now — ' +
          'say a short goodbye if you have not already. Do not claim you are still in the game.';
      } else if (toolUse.name === 'end_call') {
        // Voice calls (260705) — hang up. The actual teardown is renderer-side
        // (it must finish speaking the goodbye first), so just flag the result.
        endCallRequested = true;
        note =
          'You are hanging up the call — it ends right after this turn. ' +
          'If you have not said goodbye yet, say it now (it is still spoken aloud). ' +
          'The player can still reach you in text chat afterward.';
      } else {
        break;
      }
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: note }] as never,
      });
    }

    // #9 — if a newer send arrived (or we were aborted) while this turn ran,
    // drop the reply rather than append a stale one.
    if (ctrl.signal.aborted || superseded()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }

    const replies = await persistReplies(args.characterId, replyText, { voice: args.voiceCall === true });

    // Background compaction (260702): the reply is persisted, so if 50+
    // messages have aged past the window, fold them NOW — while the player is
    // typing — rather than making some future turn (or a summon) pay for it.
    // Fire-and-forget; single-flighted inside foldIfDue.
    void foldIfDue(args.characterId, character.persona.expanded).catch(() => {});

    // Task 2 — NOW that the "hopping in" reply is persisted (and about to be
    // returned + rendered), kick off the real join. Firing it here rather than
    // mid-loop guarantees the acknowledgement message lands before the live-
    // session popup appears. Still non-blocking: a full join can take many
    // seconds, so we never await it on the chat turn.
    if (startSummon) {
      void deps.summon(args.characterId).catch((e) => {
        deps.onLaunchFailed?.(args.characterId, (e as Error)?.message ?? 'unknown error');
      });
    }

    // #6 — stamp last_chatted on a successful reply so a plain chat counts as a
    // "last interaction" for the card date + ordering (device-local, like
    // last_launched; the cloud upsert omits it). Best-effort — a persistence
    // hiccup must not fail the chat turn.
    try {
      await saveCharacter({ ...character, last_chatted: new Date().toISOString() });
    } catch (err) {
      console.warn(`[sei] failed to stamp last_chatted for ${args.characterId}: ${(err as Error).message}`);
    }

    return { replies, launch, ...(endCallRequested ? { endCall: true } : {}) };
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

/**
 * 260702 (task 2): the deferred join kicked off by launch() failed AFTER the
 * companion already told the player it was hopping in. Without a correcting
 * turn, the companion's own transcript says it joined — so later turns insist
 * "i'm already in" while nothing is in the world. Run a short persona-voiced
 * turn around an ephemeral system note so the companion (a) learns the join
 * failed and (b) tells the player in its own words; its reply is persisted, so
 * the correction survives into every future turn's history. No tools are
 * offered — this turn reports the failure, it must not retry the launch.
 * Replies are persisted here; the caller pushes them to the renderer.
 */
export async function sendLaunchFailedTurn(
  characterId: string,
  reason: string,
): Promise<ChatMessage[]> {
  const prep = await prepareChatTurn(characterId, {
    openWorldDetected: false,
    // This turn exists BECAUSE the join failed — the companion is not in-game.
    inGame: false,
  });
  if (!prep) return [];
  const { system, messages } = prep;
  // Keep the model-facing reason to a single sanitized line — the raw summon
  // error can carry a multi-line stderr tail.
  const shortReason = (reason || 'unknown error').split('\n')[0].slice(0, 200);
  const note =
    `[System note — not the player speaking: your attempt to join the Minecraft world just failed (${shortReason}). ` +
    'You never made it in; you are NOT in the world, you are still here in chat. ' +
    'Tell the player the join failed and that you can try again — one short line, in your own voice. Do not pretend you got in.]';
  // Anthropic requires strict role alternation; if the transcript already ends
  // on a user turn (e.g. the player typed something while the join was dying),
  // fold the note into it instead of appending a second user message.
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    last.content = `${last.content}\n${note}`;
  } else {
    messages.push({ role: 'user', content: note });
  }

  const { client, model } = await buildChatSdk();
  const res = await client.messages.create(
    { model, max_tokens: 200, system, messages: messages as never },
    { timeout: CHAT_TIMEOUT_MS },
  );
  const replyText = textOf(res.content);
  if (!replyText) return [];
  return persistReplies(characterId, replyText);
}

/**
 * Voice calls (260705): the call pipeline just went LIVE and the character has
 * no in-game session — run a short persona-voiced turn so the companion speaks
 * FIRST (like answering the phone), instead of dead air until the player talks.
 * Same ephemeral-system-note pattern as sendLaunchFailedTurn; the reply is
 * persisted (it is a real thing the companion said) and returned for the
 * caller to push, where the renderer speaks it via TTS.
 *
 * Registered in the same per-character `inflight` slot as sendChatMessage so a
 * player who starts talking immediately supersedes the greeting turn instead
 * of racing it (two replies interleaving on the call).
 */
export async function sendVoiceGreetingTurn(characterId: string): Promise<ChatMessage[]> {
  inflight.get(characterId)?.abort();
  const ctrl = new AbortController();
  inflight.set(characterId, ctrl);
  try {
    const prep = await prepareChatTurn(characterId, {
      openWorldDetected: false,
      inGame: false,
      voiceCall: true,
    });
    if (!prep) return [];
    const { system, messages } = prep;
    const note =
      '[System note — not the player speaking: the player just started a voice call with you ' +
      'and the line is live now. Greet them first, like answering the phone — one short line, ' +
      'in your own voice. Do not mention this note.]';
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content = `${last.content}\n${note}`;
    } else {
      messages.push({ role: 'user', content: note });
    }

    const { client, model } = await buildChatSdk();
    const res = await client.messages.create(
      { model, max_tokens: 200, system, messages: messages as never },
      { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
    );
    if (ctrl.signal.aborted || inflight.get(characterId) !== ctrl) return [];
    const replyText = textOf(res.content);
    if (!replyText) return [];
    return await persistReplies(characterId, replyText, { voice: true });
  } catch (err) {
    // Superseded by a real message (or a real failure) — the greeting is
    // best-effort either way; the call works without it.
    if (!isAbortError(err)) {
      console.warn(`[sei] voice greeting turn failed: ${(err as Error).message}`);
    }
    return [];
  } finally {
    if (inflight.get(characterId) === ctrl) inflight.delete(characterId);
  }
}

/**
 * Decide what a launch() tool call should do, WITHOUT side effects. The actual
 * summon is deferred to the caller (fired after the reply persists, task 2), so
 * this only reads the current LAN state and returns the model-facing note, the
 * launch descriptor, and whether a join should start.
 */
function resolveLaunch(
  game: string,
  deps: ChatDeps,
): { note: string; launch: NonNullable<ChatSendResult['launch']>; summon: boolean } {
  if (game !== 'minecraft') {
    return {
      note: `The game "${game}" is not available yet — only Minecraft can be launched right now. Tell the player it is coming soon.`,
      launch: { game, status: 'lan-not-open' },
      summon: false,
    };
  }
  const lan = deps.getLanState();
  if (lan.kind === 'open') {
    return {
      note:
        'You are on your way into the player\'s Minecraft world right now — tell them you\'re hopping in. ' +
        'Do NOT claim you have already arrived; you are still joining. Keep it to one short line.',
      launch: { game, status: 'summoning' },
      summon: true,
    };
  }
  return {
    note:
      'The player\'s Minecraft world is not open to LAN, so you cannot join yet. ' +
      'In Minecraft they need to pause the game (press Esc), click "Open to LAN", then "Start LAN World". ' +
      'Explain this to them in your own voice and ask them to do it, then you can hop in.',
    launch: { game, status: 'lan-not-open' },
    summon: false,
  };
}

export { readRecent } from './chatStore';
export const chatStoreApi = chatStore;
