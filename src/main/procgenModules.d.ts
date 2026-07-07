/**
 * 260703 procgen — ambient type shims for the two sibling `file:` packages the
 * unique-companion pipeline consumes. Neither ships a `.d.ts`; these minimal
 * declarations give the main-process build enough surface to typecheck the
 * `castSoul` / `characterToSkin` call sites without pulling untyped JS into the
 * program. Runtime behavior is unaffected — see soulcaster/README.md and
 * img2skin/src/pipeline.js for the authoritative contracts.
 */

declare module 'soulcaster' {
  export interface SoulcasterLlmArgs {
    system: string;
    user: string;
    maxTokens?: number;
  }
  export function castSoul(args: {
    gender: string;
    /** Relationship dynamic key (soulcaster DYNAMICS) or null to free-roll. */
    dynamic?: string | null;
    userProfile?: unknown;
    /** ElevenLabs voice ids already used by the caller's other characters —
     * excluded from the Stage 1 voice roll so roster voices rarely collide. */
    takenVoiceIds?: string[];
    llm: (a: SoulcasterLlmArgs) => Promise<string>;
    rng?: () => number;
  }): Promise<{ sheet: unknown; rolled: unknown }>;
  export function rollFields(args?: unknown): {
    combat: unknown;
    heritage: string;
    voice: { id: string; label: string; vibe: string };
    [k: string]: unknown;
  };
  /** Zod schema for the character sheet — only the `safeParse` surface the
   *  main-process caller (castSoulViaProxy) uses is declared here. */
  export const CharacterSheetSchema: {
    safeParse(data: unknown):
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: { message: string } };
  };
  /** Strip markdown fences + isolate the outermost JSON object from model text. */
  export function stripFences(text: string): string;
  /** Curated ElevenLabs voice pool (voices.js). */
  export const VOICES: Array<{
    id: string;
    owner: string | null;
    label: string;
    gender: 'female' | 'male' | 'neutral';
    age: 'young' | 'adult' | 'elder';
    tags: string[];
    vibe: string;
  }>;
  /** Stage 1 voice roll — used directly for legacy-character fallback assignment. */
  export function rollVoice(
    character: { gender: string; age: number; background: string; personality_seeds: string[] },
    opts?: { takenVoiceIds?: string[]; rng?: () => number },
  ): { id: string; label: string; vibe: string };
  export function mulberry32(seed: number): () => number;
  /** Relationship-dynamics table; keys must mirror COMPANION_DYNAMICS (characterSchema). */
  export const DYNAMICS: Record<string, { label: string; hint: string; seed_pool: string[] }>;
}

declare module 'img2skin/src/pipeline.js' {
  export function characterToSkin(
    characterImage: string,
    outSkin: string,
    opts?: {
      variant?: 'wide' | 'slim' | 'classic';
      branch?: 'panel' | 'atlas' | 'fallback';
      mockAtlas?: string | null;
      keepRaw?: boolean;
    },
  ): Promise<{
    skin: string;
    preview: string;
    branch: string;
    valid: boolean;
    [key: string]: unknown;
  }>;
}
