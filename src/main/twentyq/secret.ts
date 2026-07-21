/**
 * Keeper-mode secret picker: what the character is thinking of.
 *
 * Follows the chessProfile/connect4Profile one-off shape (forced tool call,
 * never-throw fallback) but is per-ROUND, not persisted: every keeper round
 * draws a fresh secret. The secret is chosen main-side and stays main-side;
 * the renderer only ever sees it in a finished round's result.
 */
import type { Character } from '../../shared/characterSchema';
import { buildChatSdk, CHAT_TIMEOUT_MS } from '../chat/sdk';

/**
 * Concrete, broadly-known fallbacks used when the pick call fails. Kept dull
 * on purpose; the LLM path is where persona flavor comes from.
 */
const FALLBACK_SECRETS = [
  'a lighthouse',
  'a jellyfish',
  'a trampoline',
  'a volcano',
  'a snowman',
  'a submarine',
  'a cactus',
  'a windmill',
  'a hot air balloon',
  'a beehive',
  'a drawbridge',
  'a tumbleweed',
];

const SECRET_TOOL = {
  name: 'set_secret',
  description: 'Record the thing this character is secretly thinking of for a round of 20 Questions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      secret: {
        type: 'string',
        description:
          'The secret thing, as a short noun phrase of one to four words (for example "a lighthouse", ' +
          '"a rubber duck", "the moon"). It must be a concrete, broadly known thing a stranger could ' +
          'reach with yes/no questions. Lightly flavored by the character is good; obscure trivia is not.',
      },
    },
    required: ['secret'],
  },
};

function fallbackSecret(exclude: string[]): string {
  const used = new Set(exclude.map((s) => s.toLowerCase()));
  const open = FALLBACK_SECRETS.filter((s) => !used.has(s.toLowerCase()));
  const pool = open.length > 0 ? open : FALLBACK_SECRETS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Pick a secret for a keeper round, seeded by the persona. Never throws; any
 * failure falls back to a stock pick so the round can always start.
 * `priorSecrets` are this session's earlier rounds (avoid repeats).
 */
export async function generateSecret(character: Character, priorSecrets: string[]): Promise<string> {
  try {
    const { client, model } = await buildChatSdk();
    const persona = character.persona.expanded || character.persona.source;
    const avoid =
      priorSecrets.length > 0
        ? `\n\nAlready used this session (do not repeat): ${priorSecrets.join('; ')}.`
        : '';
    const res = await client.messages.create(
      {
        model,
        max_tokens: 200,
        system:
          'You pick the secret for a round of 20 Questions where a game companion character is the one hiding it. ' +
          'Choose ONE concrete thing that is interesting to guess at, genuinely reachable with yes/no questions, ' +
          'and broadly known (no niche trivia, no people the player may not know). Let the character description ' +
          'tilt the pick toward things that character would think of. Never anything sexual, gory, hateful, or ' +
          'otherwise inappropriate; keep it family friendly. Call set_secret exactly once.',
        tools: [SECRET_TOOL],
        tool_choice: { type: 'tool', name: 'set_secret' },
        messages: [
          {
            role: 'user',
            content: `Character name: ${character.name}\n\nPersona:\n${persona.slice(0, 3000)}${avoid}`,
          },
        ],
      },
      { timeout: CHAT_TIMEOUT_MS },
    );
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      const raw = String((toolUse.input as { secret?: unknown })?.secret ?? '').trim();
      const cleaned = raw.replace(/\s+/g, ' ').slice(0, 60);
      if (cleaned.length >= 2 && !priorSecrets.some((s) => s.toLowerCase() === cleaned.toLowerCase())) {
        return cleaned;
      }
    }
  } catch (err) {
    console.warn(`[sei/twentyq] secret pick failed, using fallback: ${(err as Error).message}`);
  }
  return fallbackSecret(priorSecrets);
}
