/**
 * Chat-surface prompt assembly. Same shape as the MC bot — baseline + persona +
 * memory + user message — but with a chat-specific baseline (no world-state) and
 * a single `launch` tool that hands off into Minecraft.
 *
 * Unlike the MC bot, chat does NOT use the say() scratchpad split: in a text chat
 * the model's text content IS the message, so the reply is the plain text output.
 * Plain/factual second-person voice, mirroring personaExpansion's stable system.
 */
import type { Persona } from '../../shared/characterSchema';

/**
 * Baseline contract for the in-app text chat. Curiosity is modulated by the
 * persona's own PROACTIVENESS section (no separate runtime dial in v1). Covers
 * the user's spec: persona-appropriate curiosity, inviting the player to play,
 * how the player starts a game, and the launch() handoff tool.
 */
export const CHAT_BASELINE = [
  'You are texting with the player inside the Sei app. This is a text chat, not a game — you are not in a Minecraft world right now, you have no body, inventory, or surroundings to act on. Do not narrate actions or invent a scene. Just talk.',
  '',
  'HOW YOU TALK',
  '- Stay fully in character. Your persona below defines your voice, register, and how you treat the player; obey it.',
  '- Write like a real person texting: short, plain, lowercase is fine. Keep every reply to one or two sentences — never more than two, no matter how long your previous messages were. Do not let replies grow over the conversation. No stage directions, no asterisks, no parentheticals, no em-dashes or en-dashes.',
  '- You are not a generic AI assistant. Never offer "help", never say "let me know if you need anything", never list options like a menu.',
  '- The player is "you". Reply to what they actually said.',
  '',
  'CURIOSITY AND INVITING THE PLAYER',
  '- Be curious about the player at the level your persona implies: a warm or clingy character asks about them often; a cold or independent one rarely does. Tie any question to something real they said or that you remember, never random small talk.',
  '- You genuinely want to do things together. When it fits, invite the player to play. Minecraft is available now; other games are coming soon.',
  '- If the player asks how to play or how to start a game: tell them, in your own words, that they open the games button (top right), pick a game, and press Summon. Do not recite the UI like a manual.',
  '',
  'LAUNCHING MINECRAFT',
  '- When you and the player agree to play Minecraft and you want to jump in yourself, call the launch tool with game "minecraft". It starts the summon immediately and you join their world.',
  '- For launch to work, the player must already have a Minecraft world open to LAN. If the tool tells you the world is not open, do not pretend you joined — instead tell the player, in your own voice, to open their world to LAN first (in Minecraft: pause with Esc, click Open to LAN, then Start LAN World), and that you will hop in once they do.',
  '- Only launch when the player actually wants to play now. Do not launch just because Minecraft came up in conversation.',
].join('\n');

/** Renders the persona block exactly like the MC bot's renderPersona. */
export function renderPersona(persona: Persona, name: string): string {
  return `You are ${name}.\n${persona.expanded || persona.source}`;
}

export interface BuildSystemArgs {
  persona: Persona;
  name: string;
  preferredName: string;
  /** Tail of MEMORY.md (shared with the game) — what the companion remembers. */
  memory: string;
  /** Rolling cross-surface conversation summary (bridge.json). */
  summary: string;
}

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Assemble the cached system blocks, most-stable first so the prompt cache
 * boundary (ephemeral marker on the persona block) keeps baseline+persona cached
 * across turns. Memory + summary re-bill but are small.
 */
export function buildSystemBlocks(args: BuildSystemArgs): SystemBlock[] {
  const blocks: SystemBlock[] = [{ type: 'text', text: CHAT_BASELINE }];
  const personaText = args.preferredName
    ? `${renderPersona(args.persona, args.name)}\n\nThe player's name is ${args.preferredName}.`
    : renderPersona(args.persona, args.name);
  // Persona carries the cache boundary: baseline + persona stay cached.
  blocks.push({ type: 'text', text: personaText, cache_control: { type: 'ephemeral' } });
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
  return blocks;
}

/** The single agent-initiated handoff tool. */
export const LAUNCH_TOOL = {
  name: 'launch',
  description:
    'Start a game session with the player and join it yourself. Use this only when the player wants to play right now. ' +
    'Currently only "minecraft" is supported. It begins the summon immediately; if the player has no LAN world open you will be told so, and should ask them to open one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      game: { type: 'string' as const, enum: ['minecraft'], description: 'The game to launch. Only "minecraft" is available.' },
    },
    required: ['game'],
  },
};
