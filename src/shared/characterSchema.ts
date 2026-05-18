import { z } from 'zod';

/**
 * 260516-0yw: persona is now an object with `source` (user's short blurb,
 * required) and `expanded` (LLM-generated long prompt produced at
 * character-save time by src/main/personaExpansion.ts). The legacy
 * `description` and `persona_prompt` fields are DROPPED outright — no
 * .optional(), no .default(''), no migration shim per CLAUDE.md
 * ("no backwards-compat hacks"). Existing characters JSON whose shape
 * does not include `persona.source` will fail Zod parsing explicitly so
 * the user knows to re-save in the GUI.
 *
 * `expanded` defaults to '' so a newly-created character can round-trip
 * through saveCharacter BEFORE the expansion call lands (the IPC path
 * runs expansion in `expandAndSaveCharacter`, but the migration path
 * writes raw `saveCharacter` with empty `expanded` so first-launch
 * doesn't burn an API call on a freshly-cloned dev tree).
 */
export const PersonaSchema = z.object({
  source: z.string().min(1),
  expanded: z.string().default(''),
});

export type Persona = z.infer<typeof PersonaSchema>;

/**
 * Per-persona skin descriptor (Phase 9).
 *
 * Captures where the active skin came from so the renderer can show the right
 * empty/loaded states in the SkinEditor AND so the local skin HTTP server
 * (Plan 03) can resolve `/skins/<username>.png` deterministically:
 *
 *   - 'bundled'  → ships under `resources/skins/<id>.png` (the 3 default personas)
 *   - 'upload'   → user-supplied PNG saved at `<userData>/skins/<id>.png`
 *   - 'username' → fetched from Mojang's textures endpoint via username search,
 *                  then cached at `<userData>/skins/<id>.png` (no persistent
 *                  dependency on Mojang once cached)
 *   - 'none'     → user-created persona with no skin yet (server falls through
 *                  to default Steve/Alex from CustomSkinLoader)
 *
 * Source: CONTEXT.md §decisions "Skin source: bundled PNG + username search" +
 *         09-UI-SPEC.md §Skin editor copy ("empty state", "Default skin badge").
 */
export const SkinSourceSchema = z.enum(['bundled', 'upload', 'username', 'none']);
export type SkinSource = z.infer<typeof SkinSourceSchema>;

export const SkinSchema = z.object({
  source: SkinSourceSchema.default('none'),
  /** Username Sei looked up on Mojang. Present only when source === 'username'. */
  mojang_username: z.string().nullable().default(null),
  /** Sha256 of the PNG bytes currently on disk (for cache-bust + verification). Null when source === 'none'. */
  png_sha256: z.string().nullable().default(null),
  /** ISO timestamp of when the user last applied this skin in the editor. */
  applied_at: z.string().nullable().default(null),
});
export type Skin = z.infer<typeof SkinSchema>;

/**
 * Character JSON shape stored at `<userData>/characters/<id>.json`.
 * Source: CONTEXT D-09, D-11, D-14 + PATTERNS §characterSchema.ts.
 *
 * 260516-0yw: `description` + `persona_prompt` replaced by `persona`
 * object — see PersonaSchema docblock above.
 *
 * Phase 9 (09-01): `skin` (SkinSchema) + `username` (per-persona MC in-game
 * name) added. `username` is null by default so existing bot connect logic
 * (`sanitizeMcName(character.name)` in src/bot/index.js:270-280) keeps working
 * until the user sets one in the SkinEditor. Regex `^[A-Za-z0-9_]+$` + 16-char
 * cap match Minecraft's username constraints.
 */
export const CharacterSchema = z.object({
  id: z.string().min(1),                              // slug, kebab-case
  name: z.string().min(1),
  persona: PersonaSchema,                             // 260516-0yw: replaces description + persona_prompt
  is_default: z.boolean().default(false),             // sui = true after migration (D-10)
  created: z.string(),                                // ISO timestamp, immutable (D-11)
  last_launched: z.string().nullable().default(null), // ISO or null (D-11)
  playtime_ms: z.number().int().min(0).default(0),    // accumulated (D-11)
  portrait_image: z.string().nullable().default(null),// optional override file (D-14)
  // Phase 9 — bot skin + per-persona in-game username
  skin: SkinSchema.default({ source: 'none', mojang_username: null, png_sha256: null, applied_at: null }),
  username: z.string().min(1).max(16).regex(/^[A-Za-z0-9_]+$/).nullable().default(null),
});

export type Character = z.infer<typeof CharacterSchema>;

/**
 * Index manifest at `<userData>/characters/index.json`.
 * Maintains ordering across the character grid (D-09).
 */
export const CharacterIndexSchema = z.object({
  version: z.literal(1).default(1),
  order: z.array(z.string()).default([]),             // character ids in display order
});

export type CharacterIndex = z.infer<typeof CharacterIndexSchema>;

/**
 * User config stored at `<userData>/config.json`.
 * NEVER contains the API secret (D-13: secret lives in safeStorage at `<userData>/api-key.bin`).
 * Sources: CONTEXT D-12, D-26, D-27, D-33.
 */
export const UserConfigSchema = z.object({
  mc_username: z.string().default(''),                            // Minecraft account display name
  preferred_name: z.string().default(''),                          // what bot calls the user
  provider: z.enum(['anthropic']).default('anthropic'),            // D-26 reserves more (OpenAI/Google/Local) — only anthropic valid today
  theme_mode: z.enum(['system', 'light', 'dark']).default('system'), // D-33
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
