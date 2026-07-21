/**
 * Connect 4 profile: how strong (and in what style) a character plays.
 *
 * Cloned from src/main/chess/chessProfile.ts. Auto-derived from the persona
 * by a one-off LLM call on the first game, stored on the character at
 * metadata.connect4, and user-adjustable later. When derivation fails, a
 * character that already has a chess profile (metadata.chess) falls back to
 * a strength mapped from its chess elo, so the two games agree about how
 * sharp the character is.
 */
import { z } from 'zod';
import { getCharacter, patchCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';

export const Connect4ProfileSchema = z.object({
  /** Playing strength 1-5 (engine depth + noise + blunder rate). */
  strength: z.number().int().min(1).max(5),
  /** Freeform playstyle note surfaced to the in-game LLM (not the engine). */
  styleNote: z.string().max(400).default(''),
  source: z.enum(['auto', 'user']).default('auto'),
});
export type Connect4Profile = z.infer<typeof Connect4ProfileSchema>;

/** Neutral default when derivation fails and no chess profile exists. */
const NEUTRAL: Connect4Profile = { strength: 2, styleNote: '', source: 'auto' };

export function readStoredProfile(
  metadata: Record<string, unknown> | undefined,
): Connect4Profile | null {
  const parsed = Connect4ProfileSchema.safeParse(metadata?.connect4);
  return parsed.success ? parsed.data : null;
}

/** Map a chess elo (400-2000) onto the 1-5 connect4 strength ladder. */
export function strengthFromChessElo(elo: number): number {
  if (elo <= 650) return 1;
  if (elo <= 950) return 2;
  if (elo <= 1300) return 3;
  if (elo <= 1650) return 4;
  return 5;
}

/** Chess-derived fallback (same character, same brain) or the neutral one. */
function fallbackFor(metadata: Record<string, unknown> | undefined): Connect4Profile {
  const chess = metadata?.chess as { elo?: number; styleNote?: string } | undefined;
  if (chess && typeof chess.elo === 'number') {
    return {
      strength: strengthFromChessElo(chess.elo),
      styleNote: typeof chess.styleNote === 'string' ? chess.styleNote.slice(0, 400) : '',
      source: 'auto',
    };
  }
  return NEUTRAL;
}

const PROFILE_TOOL = {
  name: 'set_connect4_profile',
  description: 'Record the Connect 4 profile you derived from the character description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      strength: {
        type: 'number',
        description:
          'Playing strength, 1 to 5. 1: barely tracks the board, misses obvious wins and blocks. ' +
          '2: casual, spots simple threats, still blunders. 3: solid, blocks reliably, plans a move ahead. ' +
          '4: sharp, sets up double threats. 5: near-perfect tactician. Most characters land at 2 or 3; ' +
          'reserve 5 for characters explicitly framed as brilliant, analytical, or games-obsessed.',
      },
      styleNote: {
        type: 'string',
        description:
          'One or two sentences on HOW they play, in plain language: aggressive stacking or patient ' +
          'blocking, shows off or grinds, how they handle losing. Derived from personality, not skill.',
      },
    },
    required: ['strength', 'styleNote'],
  },
};

/**
 * Get the character's Connect 4 profile, deriving and persisting one on first
 * use. Never throws: a failed derivation returns (and stores) the fallback so
 * the game can always start.
 */
export async function getOrCreateConnect4Profile(characterId: string): Promise<Connect4Profile> {
  const character = await getCharacter(characterId);
  if (!character) return NEUTRAL;
  const metadata = character.metadata as Record<string, unknown>;
  const stored = readStoredProfile(metadata);
  if (stored) return stored;

  let profile = fallbackFor(metadata);
  try {
    const { client, model } = await buildChatSdk();
    const persona = character.persona.expanded || character.persona.source;
    const res = await client.messages.create(
      {
        model,
        max_tokens: 300,
        system:
          'You map a game companion character description to a Connect 4 playing profile. ' +
          'Read the persona and decide how strong this character would plausibly be at Connect 4 and how they would play. ' +
          'Anchor strength in the persona: intelligence, patience, competitiveness, chaos. ' +
          'Call set_connect4_profile exactly once.',
        tools: [PROFILE_TOOL],
        tool_choice: { type: 'tool', name: 'set_connect4_profile' },
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
      const input = toolUse.input as { strength?: number; styleNote?: string };
      const parsed = Connect4ProfileSchema.safeParse({
        strength: Math.round(Number(input.strength)),
        styleNote: String(input.styleNote ?? '').trim(),
        source: 'auto',
      });
      if (parsed.success) profile = parsed.data;
    }
  } catch (err) {
    console.warn(
      `[sei/connect4] profile derivation failed, using fallback: ${(err as Error).message}`,
    );
  }

  try {
    await patchCharacter(characterId, (c) => ({
      ...c,
      metadata: { ...c.metadata, connect4: profile },
    }));
  } catch (err) {
    console.warn(`[sei/connect4] profile persist failed: ${(err as Error).message}`);
  }
  console.log(
    `[sei/connect4] profile for ${character.name}: strength=${profile.strength} (${profile.source})`,
  );
  return profile;
}
