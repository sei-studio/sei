import { z } from 'zod';

/**
 * Character JSON shape stored at `<userData>/characters/<id>.json`.
 * Source: CONTEXT D-09, D-11, D-14 + PATTERNS §characterSchema.ts.
 */
export const CharacterSchema = z.object({
  id: z.string().min(1),                              // slug, kebab-case
  name: z.string().min(1),
  description: z.string().default(''),                // shown to user (D-47)
  persona_prompt: z.string().min(1),                  // sent to model (D-48)
  is_default: z.boolean().default(false),             // sui = true after migration (D-10)
  created: z.string(),                                // ISO timestamp, immutable (D-11)
  last_launched: z.string().nullable().default(null), // ISO or null (D-11)
  playtime_ms: z.number().int().min(0).default(0),    // accumulated (D-11)
  portrait_image: z.string().nullable().default(null),// optional override file (D-14)
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
