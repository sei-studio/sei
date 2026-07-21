/**
 * Watch profile: how a character behaves while watching the player's screen.
 *
 * Auto-derived from the persona by a one-off LLM call on the first screen-share
 * session (same shape as src/main/chess/chessProfile.ts), stored on the
 * character at metadata.watch, user-adjustable later. The stored shape is the
 * source of truth; the prompt reads hype + styleNote verbatim.
 */
import { z } from 'zod';
import { getCharacter, patchCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';

export const WatchProfileSchema = z.object({
  /** 1 = near-silent observer, 5 = loud hype couch partner. */
  hype: z.number().int().min(1).max(5),
  /** Freeform note on HOW they watch, surfaced to the in-session LLM. */
  styleNote: z.string().max(400).default(''),
  source: z.enum(['auto', 'user']).default('auto'),
});
export type WatchProfile = z.infer<typeof WatchProfileSchema>;

/** Neutral default when derivation fails: an even-keeled couch partner. */
const FALLBACK: WatchProfile = { hype: 3, styleNote: '', source: 'auto' };

export function readStoredWatchProfile(
  metadata: Record<string, unknown> | undefined,
): WatchProfile | null {
  const parsed = WatchProfileSchema.safeParse(metadata?.watch);
  return parsed.success ? parsed.data : null;
}

const PROFILE_TOOL = {
  name: 'set_watch_profile',
  description: 'Record the screen-watching profile you derived from the character description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      hype: {
        type: 'number',
        description:
          'How vocal they are while watching someone play, 1 to 5. 1: near-silent, a rare dry line. ' +
          '2: reserved, comments only on real moments. 3: normal couch partner. 4: talkative, quick to react. ' +
          '5: loud hype, big reactions. Most characters land 2 to 4.',
      },
      styleNote: {
        type: 'string',
        description:
          'One or two sentences on HOW they watch, in plain language: what they notice, whether they tease or ' +
          'cheer, how they handle the player failing, any signature habits. Derived from personality.',
      },
    },
    required: ['hype', 'styleNote'],
  },
};

/**
 * Get the character's watch profile, deriving and persisting one on first use.
 * Never throws: a failed derivation returns (and stores) the fallback so the
 * session can always start.
 */
export async function getOrCreateWatchProfile(characterId: string): Promise<WatchProfile> {
  const character = await getCharacter(characterId);
  if (!character) return FALLBACK;
  const stored = readStoredWatchProfile(character.metadata as Record<string, unknown>);
  if (stored) return stored;

  let profile = FALLBACK;
  try {
    const { client, model } = await buildChatSdk();
    const persona = character.persona.expanded || character.persona.source;
    const res = await client.messages.create(
      {
        model,
        max_tokens: 300,
        system:
          'You map a game companion character description to a screen-watching profile: how this character ' +
          'behaves while sitting next to the player watching them play a game. Anchor it in the persona: ' +
          'energy, humor, patience, competitiveness. Call set_watch_profile exactly once.',
        tools: [PROFILE_TOOL],
        tool_choice: { type: 'tool', name: 'set_watch_profile' },
        messages: [
          {
            role: 'user',
            content: `Character name: ${character.name}\n\nPersona:\n${persona.slice(0, 4000)}`,
          },
        ],
      },
      { timeout: CHAT_TIMEOUT_MS },
    );
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      const input = toolUse.input as { hype?: number; styleNote?: string };
      const parsed = WatchProfileSchema.safeParse({
        hype: Math.round(Number(input.hype)),
        styleNote: String(input.styleNote ?? '').trim(),
        source: 'auto',
      });
      if (parsed.success) profile = parsed.data;
    }
  } catch (err) {
    console.warn(`[sei/watch] profile derivation failed, using fallback: ${(err as Error).message}`);
  }

  try {
    await patchCharacter(characterId, (c) => ({
      ...c,
      metadata: { ...c.metadata, watch: profile },
    }));
  } catch (err) {
    console.warn(`[sei/watch] profile persist failed: ${(err as Error).message}`);
  }
  console.log(`[sei/watch] profile for ${character.name}: hype=${profile.hype} (${profile.source})`);
  return profile;
}
