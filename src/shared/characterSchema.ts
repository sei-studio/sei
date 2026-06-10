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
 * Per-persona skin descriptor.
 *
 * Captures where the active skin came from so the renderer can show the right
 * empty/loaded states in the SkinEditor AND so the local skin HTTP server
 * can resolve `/skins/<username>.png` deterministically:
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
 *         UI spec for skin editor copy ("empty state", "Default skin badge").
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
 * `skin` (SkinSchema) + `username` (per-persona MC in-game name): `username`
 * is null by default so existing bot connect logic
 * (`sanitizeMcName(character.name)` in src/bot/index.js) keeps working until
 * the user sets one in the SkinEditor. Regex `^[A-Za-z0-9_]+$` + 16-char cap
 * match Minecraft's username constraints.
 */
export const CharacterSchema = z.object({
  // D-23: UUID v4 is canonical. Slug-based ids are LEGACY and rejected at the
  // boundary — Plan 11-05 (slug→UUID migration) rewrites existing local rows.
  // No backward-compat shim (CLAUDE.md: no backwards-compat hacks).
  id: z.string().uuid({ message: 'characterId must be a UUID v4' }),
  name: z.string().min(1),
  persona: PersonaSchema,                             // 260516-0yw: replaces description + persona_prompt
  is_default: z.boolean().default(false),             // sui = true after migration (D-10)
  // D-16: every newly-created signed-in character defaults to shared=true.
  // Signed-out and legacy local-only chars use shared=false (no cloud row).
  shared: z.boolean().default(true),
  // D-23: human-readable label carried over from pre-UUID era; not unique.
  // Bundled defaults populate this with 'sui'/'lyra'/'clawd'.
  slug: z.string().nullable().default(null),
  // D-24: forward-compat escape hatch for fields added later without a SQL migration.
  metadata: z.record(z.unknown()).default({}),
  created: z.string(),                                // ISO timestamp, immutable (D-11)
  last_launched: z.string().nullable().default(null), // ISO or null (D-11)
  playtime_ms: z.number().int().min(0).default(0),    // accumulated (D-11)
  // D-28: portrait_image is a path reference (e.g., '<uuid>.png') or null.
  // Plan 11-06 added a refinement REJECTING legacy data URLs at the IPC
  // boundary — Plan 11-05 migration decodes any on-disk data URLs into files
  // BEFORE this refinement applies, so existing characters round-trip safely
  // through Zod. New characters can never reintroduce a data URL because
  // PortraitImagePicker no longer produces one (D-28 + Pitfall 2).
  portrait_image: z
    .string()
    .refine((v) => !v.startsWith('data:'), {
      message: 'portrait_image must be a path reference, not a data URL (D-28 + Pitfall 2)',
    })
    .nullable()
    .default(null),
  // Bot skin + per-persona in-game username
  skin: SkinSchema.default({ source: 'none', mojang_username: null, png_sha256: null, applied_at: null }),
  username: z.string().min(1).max(16).regex(/^[A-Za-z0-9_]+$/).nullable().default(null),
  // ITEM 13 (quick/260523-t8d): owner UUID matches cloud `characters.owner` column.
  // null/undefined for local-only characters that never round-tripped through cloud.
  // Used by the renderer's view-only guard on CharacterPage to disable edits on
  // characters whose owner !== current authenticated user. Conservative default:
  // when null/undefined we never treat the character as foreign-owned (only a
  // positive UUID mismatch against authState.user.id triggers viewOnly).
  owner: z.string().uuid().nullable().optional(),
  /**
   * Watermark of the cloud row's `updated_at` (the value we last pulled into
   * this local cache). Lets the cache-on-demand refresh on the Characters page
   * detect when the upstream author — or a bundled default's system row — has
   * shipped a newer version, and re-pull the whole stored set (prompt / image /
   * description) without re-downloading on every open. Null/undefined for
   * local-only characters that never round-tripped through cloud, and for
   * caches written before this field existed (which the next open backfills).
   * NEVER uploaded — the cloud trigger owns the source `updated_at`.
   */
  cloud_updated_at: z.string().nullable().optional(),
  /**
   * Human-facing description (NOT prompted to the LLM). Separate from
   * persona.source — the persona is the model's voice/personality input,
   * the description is what other players read on a World card and on
   * CharacterPage. Required when a character is shared=true (the World tab
   * needs SOMETHING readable); allowed empty/null for private characters.
   * Round-trips through the cloud row's `metadata.description` JSONB key
   * (no dedicated column to avoid a SQL migration for v1.0). Optional in
   * the schema so existing character objects + tests don't have to be
   * updated en masse; readers should treat undefined as null.
   */
  description: z.string().nullable().optional(),
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
  // ui-A1: Phase 14 widened the LLM provider matrix to 13 backends — the
  // factory in src/bot/brain/llm/index.js (`SUPPORTED_PROVIDERS`) is the
  // canonical list. Anthropic remains the default for backward-compat with
  // existing config.json files. The 10 OpenAI-compatible providers share a
  // single adapter w/ provider-specific baseURL; gemini + ollama have their
  // own adapters.
  provider: z
    .enum([
      'anthropic',
      'openai',
      'gemini',
      'ollama',
      'grok',
      'openrouter',
      'deepseek',
      'mistral',
      'together',
      'groq',
      'fireworks',
      'cerebras',
      'perplexity',
    ])
    .default('anthropic'),
  /**
   * ui-A1: optional per-provider overrides (base_url / model). Defaults to
   * `{}` so existing config.json files round-trip through Zod unchanged.
   * The bot's createLlmProvider factory already reads these values out of
   * `config.llm.providers.<kind>.{api_key, base_url, model}`; this field is
   * the renderer-side persistence surface (Settings tile picker writes
   * here when a non-default base_url / model is configured).
   */
  provider_config: z.record(z.unknown()).optional().default({}),
  theme_mode: z.enum(['system', 'light', 'dark']).default('system'), // D-33
  /** Plan 07: Linux basic_text safeStorage warning Banner dismissal (Pitfall A2). */
  linuxBasicTextWarnDismissed: z.boolean().default(false),
  /**
   * Phase 13 — Plan 13-02 (PROXY-11, D-57). Which AI backend is active:
   *   - 'local'       → BYOK; bot calls Anthropic directly with the user's
   *                     on-disk api-key.bin. NO credits UI surfaces in the
   *                     renderer.
   *   - 'cloud-proxy' → Sei's Fly.io proxy gates Anthropic. Renderer shows
   *                     the pricing icon, credits screen, hard-stop modal.
   *
   * D-57: this field is the SINGLE source of truth for credits-UI visibility.
   * apiKeyStore.{getAiBackendKind,setAiBackendKind} are the only legitimate
   * readers/writers — every UI gate reads from a renderer-store value that
   * shadows this, never via duplicated logic.
   *
   * `.optional().default('local')` keeps existing config.json files
   * backward-compatible (same pattern theme_mode used when it was
   * introduced) and ensures pre-Phase-13 users see no behavior change.
   *
   * B4: prior sibling `browse_enabled` flag was removed — the World
   * (formerly Browse) tab is always available.
   */
  ai_backend_kind: z.enum(['local', 'cloud-proxy']).optional().default('local'),
  /**
   * ui-A7: developer console (LogsBar) visibility. Off by default —
   * shipping users almost never need the raw bot log. Settings exposes a
   * toggle that flips this and App.tsx gates `<LogsBar />` on it.
   */
  dev_console_visible: z.boolean().optional().default(false),
  /**
   * Bundled defaults (sui / lyra / clawd) the user has "removed from library".
   * The on-disk JSON for these chars stays so the World tab can still surface
   * them as system-authored entries, but they're hidden from Home + IconRail
   * and the per-character page swaps Summon for "Add to library" which
   * removes the id from this array.
   */
  removed_default_ids: z.array(z.string().uuid()).optional().default([]),
  /**
   * Foreign-owned characters the user added to their library from the World
   * tab. HomeGrid + IconRail otherwise hide chars where owner !== currentUserId
   * (per the Mine/World split); this list opts those characters back into the
   * user's Home view after an explicit "+ Add to Mine" click. Defaults follow
   * a different path (removed_default_ids above).
   */
  added_world_ids: z.array(z.string().uuid()).optional().default([]),
  /**
   * One-shot first-login marker. False until the Home screen renders the
   * "Welcome to Sei, <name>!" greeting for the very first time, then flipped
   * true so every subsequent app open shows "Welcome back, <name>!" instead.
   * Profile-scoped (config.json is per-account), so it tracks first login
   * per user. `.optional().default(false)` keeps existing config.json files
   * backward-compatible — pre-existing users get one "Welcome to Sei" on the
   * first open after upgrade, which is harmless.
   */
  has_been_welcomed: z.boolean().optional().default(false),
  /**
   * Phase 15 (D-04/D-05) — the user-facing in-game-vision auto-render toggle.
   * The Settings screen (15-05) writes this through the existing saveConfig IPC,
   * gated behind a confirm popup (D-06). It is the SINGLE renderer-side persistence
   * surface for the cost feature; main bridges it into the forked bot's
   * `config.vision.auto_render` at summon time (botSupervisor → bot init payload →
   * src/bot/index.js ConfigSchema build). Default false (auto-render OFF, VIS-04).
   * `.optional().default(false)` keeps existing config.json files backward-
   * compatible — same pattern dev_console_visible used when it was introduced.
   */
  vision_auto_render: z.boolean().optional().default(false),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
