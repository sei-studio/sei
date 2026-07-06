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
    llm: (a: SoulcasterLlmArgs) => Promise<string>;
    rng?: () => number;
  }): Promise<{ sheet: unknown; rolled: unknown }>;
  export function rollFields(args?: unknown): unknown;
  export const CharacterSheetSchema: unknown;
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
