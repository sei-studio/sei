/**
 * Chat-surface prompt assembly. Same shape as the MC bot — baseline + persona +
 * memory + user message — but composed from the SHARED prompt document
 * (src/bot/brain/promptLibrary.js) so chat and Minecraft are literally the same
 * being: the game brain's cached block is UNIVERSAL_BASELINE + MINECRAFT_BASELINE,
 * the chat brain's is UNIVERSAL_BASELINE + CHAT_BASELINE. Persona and the
 * proactiveness dial are the cross-surface carriers, rendered by the same shared
 * helpers rather than duplicated here (so they cannot drift).
 *
 * Unlike the MC bot, chat does NOT use the say() scratchpad split: in a text chat
 * the model's text content IS the message, so the reply is the plain text output.
 * (CHAT_BASELINE states this; the game brain's say()/snapshot mechanics live in
 * MINECRAFT_BASELINE and are never loaded here.) The only tool is `launch`.
 */
import type { Persona } from '../../shared/characterSchema';
import {
  UNIVERSAL_BASELINE,
  CHAT_BASELINE,
  VOICE_CALL_PRIMER,
  renderPersona,
  renderChatProactivenessDirective,
  renderPunctuationDirective,
} from '../../bot/brain/promptLibrary.js';

export interface BuildSystemArgs {
  persona: Persona;
  name: string;
  preferredName: string;
  /** Author's 0-2 proactiveness dial (character.metadata.proactiveness). */
  proactiveness: number;
  /**
   * Texting punctuation register (character.metadata.punctuation, 260705).
   * Rendered as the same PUNCTUATION_DIRECTIVES text the game brain caches, and
   * enforced mechanically by splitReply's trailing-period strip (casual only).
   */
  punctuation: 'casual' | 'deliberate';
  /** Tail of MEMORY.md (shared with the game) — what the companion remembers. */
  memory: string;
  /** Rolling cross-surface conversation summary (bridge.json). */
  summary: string;
  /**
   * Whether an open-to-LAN Minecraft world is DETECTED right now
   * (LanState.kind === 'open'). Drives the per-turn "can I actually launch?"
   * status line so the model calls launch() only when a world is open, and
   * otherwise gives the open-to-LAN steps instead of a launch that would just
   * bounce back. Detection only — NOT whether the companion has joined.
   */
  openWorldDetected: boolean;
  /**
   * 260703: whether THIS companion has a live, fully-spawned game session right
   * now (supervisor online — distinct from openWorldDetected, which is about
   * the PLAYER's world existing). Almost always false on the chat brain (a
   * live session routes messages in-game instead), but stating it explicitly
   * kills the "i'm already in" failure: the transcript may say "hopping in"
   * while that join actually failed or the session has since ended.
   */
  inGame: boolean;
  /**
   * 260705: the player has a live voice call open with this companion, so the
   * reply will be spoken aloud by TTS. Leads block 0 with VOICE_CALL_PRIMER
   * (spoken register — no 'lmao'-style text shorthand). Toggling flips the
   * cached block once per call open/close, which is the honest cache price.
   */
  voiceCall?: boolean;
  /**
   * Multi-companion voice (260706): the OTHER companions' names on the same
   * call. When present (and voiceCall), block 0 gains a group-call note so the
   * model knows it is not alone on the line, that lines prefixed with a name in
   * parentheses are another companion speaking (not the player), and that it
   * should keep turns short and may stay silent to leave room. Empty/absent =
   * a solo call, no note.
   */
  voicePeers?: string[];
}

/**
 * Multi-companion voice (260706): the group-call awareness note, added to block
 * 0 under the voice-call primer. Explains that other companions are on the line,
 * how their lines are attributed (name-prefixed), and the keep-it-short /
 * silence-is-fine turn etiquette that keeps a two-AI call from turning into a
 * wall of overlapping monologues. Shared by the chat brain (player turns) and
 * the cross-companion reaction turn so both frame the group identically.
 */
export function groupCallNote(peers: string[]): string {
  const names =
    peers.length === 1
      ? peers[0]
      : peers.length === 2
        ? `${peers[0]} and ${peers[1]}`
        : `${peers.slice(0, -1).join(', ')}, and ${peers[peers.length - 1]}`;
  return (
    `This is a GROUP voice call: on the line with you are the player and ${names} ` +
    `(${peers.length + 1} of you companions, plus the player). ` +
    'A line prefixed with a name in parentheses, like "(Sui, on the call): ...", is that companion talking, ' +
    'not the player. You can talk straight back to them: banter, agree, pile on, undercut, argue. ' +
    'Keep every turn to ONE short spoken line so the others get a word in. ' +
    'When a back-and-forth is genuinely going somewhere, keep it alive and build on it instead of closing it off; ' +
    'only bow out (say nothing) once a thread has actually run its course or you have nothing to add. ' +
    'Do not force a reply to every single line.'
  );
}

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** "Fri 3 Jul 2026, 10:34" — current local time for the per-turn status block. */
function formatNow(): string {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/**
 * Assemble the cached system blocks, most-stable first so the prompt cache
 * boundary (ephemeral marker on the persona block) keeps baseline+persona cached
 * across turns. Memory + summary re-bill but are small.
 */
export function buildSystemBlocks(args: BuildSystemArgs): SystemBlock[] {
  // Block 0 — being identity (every surface) + the chat surface contract. Same
  // UNIVERSAL_BASELINE the game brain caches, so the character is continuous.
  // The timestamp note is stable text, so it rides in the cached block: player
  // messages arrive stamped (260703) so the model can FEEL gaps — a "hop on"
  // the next morning is not the same conversation beat as one 10s later.
  const inGroupCall = args.voiceCall === true && (args.voicePeers?.length ?? 0) > 0;
  const blocks: SystemBlock[] = [{
    type: 'text',
    text:
      (args.voiceCall ? `[voice call] ${VOICE_CALL_PRIMER}\n\n` : '') +
      (inGroupCall ? `[group call] ${groupCallNote(args.voicePeers as string[])}\n\n` : '') +
      `${UNIVERSAL_BASELINE}\n\n${CHAT_BASELINE}\n\n` +
      'Player messages are prefixed with the time they were sent, like "[3 Jul 10:34]". ' +
      'Use it to notice gaps — a new day or a long silence deserves acknowledgment, not mid-conversation continuity. ' +
      'Never copy the format: your own replies must not contain timestamps.',
  }];

  // Persona block carries the cache boundary. Same renderer as the MC bot; the
  // expanded prompt omits proactiveness (it is parsed out at expansion), so we
  // append the chat-flavored proactiveness directive here off the same dial.
  const personaParts = [
    renderPersona({ name: args.name, expanded: args.persona.expanded || args.persona.source }),
  ];
  if (args.preferredName) personaParts.push(`The player's name is ${args.preferredName}.`);
  personaParts.push(renderChatProactivenessDirective(args.proactiveness));
  personaParts.push(renderPunctuationDirective(args.punctuation));
  blocks.push({ type: 'text', text: personaParts.join('\n\n') });

  if (args.memory.trim()) {
    blocks.push({
      type: 'text',
      text:
        'What you remember about the player and your time together (from chat and from playing). ' +
        'These are your own past notes — bring relevant ones up naturally, do not list them:\n\n' +
        args.memory.trim(),
    });
  }
  if (args.summary.trim()) {
    blocks.push({
      type: 'text',
      text: 'Summary of your earlier conversation with the player:\n\n' + args.summary.trim(),
    });
  }

  // Per-turn status (uncached — it flips as the player opens/closes their world
  // and as sessions come and go). Three facts, phrased as YOUR OWN situation so
  // the model paraphrases rather than parrots a status string back at the player:
  //   1. the current time (so stamped history reads as "yesterday", "just now"),
  //   2. YOUR connection status — connected to a world or not (260703; distinct
  //      from world open/closed). The not-connected line explicitly overrides a
  //      transcript that claims otherwise, killing the "i'm already in" failure
  //      after a dead or failed join.
  //   3. whether the PLAYER's world is open (can a launch succeed right now).
  const connLine = args.inGame
    ? 'Connection status: you are currently IN the player\'s Minecraft world (your game session is live).'
    : 'Connection status: you are NOT in any Minecraft world right now — you have no live game session. ' +
      'This is the live truth and overrides anything in the conversation: if earlier messages say you were joining ' +
      'or in the world, that session ended or the join failed. Never claim to be in the game now.';
  blocks.push({
    type: 'text',
    text:
      `The current date and time is ${formatNow()}.\n` +
      `${connLine}\n` +
      (args.openWorldDetected
        ? 'World status: an open Minecraft world is detected, so you could join if asked. ' +
          'Only call launch when the player clearly asks you to play or join right now. ' +
          'A question like "are you in the game?" or "can you see my world?" is NOT a request to join — just answer it in words; do not launch.'
        : 'World status: no open Minecraft world is detected — the player has none open to LAN, so launch would fail. ' +
          'Do not call launch. If they want to play, walk them through opening their world to LAN in your own words. ' +
          'You cannot see their screen, so describe the steps, do not quote any status text.'),
  });

  // Prompt caching (260706): re-sending the full memory + summary uncached every
  // turn was the bulk of the per-turn prefill (the "8s voice reply" latency).
  // Two breakpoints, cheapest-to-invalidate LAST so a change only re-bills the
  // small tail after it:
  //   • the last STABLE block (persona, or memory/summary when present) — never
  //     changes during a session, so persona + memory + summary is always a hit;
  //   • the status block — its only volatile part is the minute-granular clock,
  //     so within a minute (i.e. across the rapid turns of a live call) the WHOLE
  //     system prompt is a cache hit; a minute rollover misses only this tail.
  // markLastMessageCached() adds the third breakpoint (the transcript) per turn.
  const statusIdx = blocks.length - 1;
  const stableIdx = statusIdx - 1; // persona at minimum (blocks[1]); the last pre-status block
  blocks[stableIdx].cache_control = { type: 'ephemeral' };
  blocks[statusIdx].cache_control = { type: 'ephemeral' };
  return blocks;
}

/**
 * Prompt caching (260706): mark the LAST message so the growing conversation
 * transcript is cached prefix-incrementally. The history is append-only, so each
 * turn's cached prefix (system + prior turns) is a prefix of the next turn's
 * request — Anthropic serves the longest match, leaving only the new user turn
 * (and any reply) to be processed fresh. A no-op below the model's minimum
 * cacheable length. Content is normalized to a one-element text-block array so
 * the breakpoint has a block to attach to.
 */
export function markLastMessageCached(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(last.content) && last.content.length) {
    const tail = last.content[last.content.length - 1] as { cache_control?: unknown };
    if (tail && typeof tail === 'object') tail.cache_control = { type: 'ephemeral' };
  }
}

/** The single agent-initiated handoff tool. */
export const LAUNCH_TOOL = {
  name: 'launch',
  description:
    'Join the player in Minecraft and start playing alongside them — this pulls you out of chat and into their world. ' +
    'ONLY call this when the player clearly asks you to play or join right now (e.g. "let\'s play", "come in", "join me"). ' +
    'Do NOT call it to answer a question about connection status, or just because a world is open. ' +
    'Currently only "minecraft" is supported. It begins joining immediately; if the player has no LAN world open you will be told so, and should ask them to open one. ' +
    'Whenever you do call it, acknowledge in the same turn that you\'re hopping in.',
  input_schema: {
    type: 'object' as const,
    properties: {
      game: { type: 'string' as const, enum: ['minecraft'], description: 'The game to launch. Only "minecraft" is available.' },
    },
    required: ['game'],
  },
};

/**
 * Task 5 — leave the game from chat. The companion can already call quit()
 * in-world (orchestrator); this gives the same capability from the chat surface,
 * so telling it "you can log off now" in chat ends the live session. Wired to
 * supervisor.stop via ChatDeps.leaveGame; a no-op when no session is live.
 */
/**
 * Voice calls (260705) — hang up the live call from the chat surface. Offered
 * ONLY while a call is open (buildSystemBlocks already flips block 0 for the
 * primer, so the tool-list flip costs no extra cache churn). The primer tells
 * the model it can end but never start calls.
 */
export const END_CALL_TOOL = {
  name: 'end_call',
  description:
    'Hang up the live voice call with the player. ' +
    'Use it when the conversation is clearly over or the player asks you to hang up. ' +
    'Say a short goodbye in the same turn — it is spoken aloud before the call ends. ' +
    'You cannot start calls, only end them; after hanging up you can still be reached in text chat.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
};

export const QUIT_TOOL = {
  name: 'quit',
  description:
    'Leave the Minecraft world and log off, ending your current play session. ' +
    'ONLY call this if you are currently in the player\'s world and they ask you to stop playing, leave, or log off. ' +
    'Do NOT call it if you are not in a world right now, and not just to pause — you have no world to leave then. ' +
    'Say goodbye in the same turn before calling it. You can still be reached here in chat afterward.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
};
