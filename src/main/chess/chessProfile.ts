/**
 * Chess profile: how strong (and in what style) a character plays.
 *
 * Auto-derived from the persona by a one-off LLM call on the first chess game
 * (the paper's "Soulcaster" layer), stored on the character at
 * metadata.chess, and user-adjustable in custom character creation. The
 * stored shape is the source of truth; the CCE engine derives every skill
 * parameter from elo unless overridden here.
 */
import { z } from 'zod';
import { getCharacter, patchCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';

export const ChessProfileSchema = z.object({
  elo: z.number().int().min(400).max(2000),
  /** Freeform playstyle note surfaced to the in-game LLM (not the engine). */
  styleNote: z.string().max(400).default(''),
  source: z.enum(['auto', 'user']).default('auto'),
});
export type ChessProfile = z.infer<typeof ChessProfileSchema>;

/** Neutral default when derivation fails: casual-club beginner-plus. */
const FALLBACK: ChessProfile = { elo: 900, styleNote: '', source: 'auto' };

export function readStoredProfile(metadata: Record<string, unknown> | undefined): ChessProfile | null {
  const parsed = ChessProfileSchema.safeParse(metadata?.chess);
  return parsed.success ? parsed.data : null;
}

const PROFILE_TOOL = {
  name: 'set_chess_profile',
  description: 'Record the chess profile you derived from the character description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      elo: {
        type: 'number',
        description:
          'Playing strength, 400 to 2000. 400-700: barely knows the rules, hangs pieces constantly. ' +
          '800-1100: casual player, basic tactics, frequent blunders. 1200-1500: club player, solid ' +
          'fundamentals. 1600-2000: strong, sharp, punishes mistakes. Most characters land between 600 and 1400; ' +
          'reserve 1600+ for characters explicitly framed as brilliant, analytical, or chess-adjacent.',
      },
      styleNote: {
        type: 'string',
        description:
          'One or two sentences on HOW they play, in plain language: aggressive or cautious, ' +
          'shows off or grinds, favorite pieces, how they handle losing. Derived from personality, not chess skill.',
      },
    },
    required: ['elo', 'styleNote'],
  },
};

/**
 * Get the character's chess profile, deriving and persisting one on first use.
 * Never throws: a failed derivation returns (and stores) the fallback so the
 * game can always start.
 */
export async function getOrCreateChessProfile(characterId: string): Promise<ChessProfile> {
  const character = await getCharacter(characterId);
  if (!character) return FALLBACK;
  const stored = readStoredProfile(character.metadata as Record<string, unknown>);
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
          'You map a game companion character description to a chess-playing profile. ' +
          'Read the persona and decide how strong this character would plausibly be at chess and how they would play. ' +
          'Anchor strength in the persona: intelligence, patience, competitiveness, chaos. ' +
          'Call set_chess_profile exactly once.',
        tools: [PROFILE_TOOL],
        tool_choice: { type: 'tool', name: 'set_chess_profile' },
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
      const input = toolUse.input as { elo?: number; styleNote?: string };
      const parsed = ChessProfileSchema.safeParse({
        elo: Math.round(Number(input.elo)),
        styleNote: String(input.styleNote ?? '').trim(),
        source: 'auto',
      });
      if (parsed.success) profile = parsed.data;
    }
  } catch (err) {
    console.warn(`[sei/chess] profile derivation failed, using fallback: ${(err as Error).message}`);
  }

  try {
    await patchCharacter(characterId, (c) => ({
      ...c,
      metadata: { ...c.metadata, chess: profile },
    }));
  } catch (err) {
    console.warn(`[sei/chess] profile persist failed: ${(err as Error).message}`);
  }
  console.log(`[sei/chess] profile for ${character.name}: elo=${profile.elo} (${profile.source})`);
  return profile;
}
