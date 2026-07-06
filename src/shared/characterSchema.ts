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
/**
 * 260703 procgen: how a companion entered the user's library.
 *   - 'unique' — system-generated ("Meet your unique companion"): soulcaster-1
 *                sheet + generated portrait/skin. Cloud-stored from birth,
 *                NOT editable (remove / reset-memory only).
 *   - 'custom' — user-created from scratch (the classic AddCharacter wizard).
 *                Fully editable. All pre-existing characters default here.
 *   - 'world'  — a public character invited from the World tab (foreign-owned
 *                or a bundled default). Not editable.
 */
export const CharacterKindSchema = z.enum(['unique', 'custom', 'world']);
export type CharacterKind = z.infer<typeof CharacterKindSchema>;

/** 260703 procgen: the Home grid is a fixed set of companion slots. */
export const MAX_COMPANION_SLOTS = 4;

/**
 * 260705: daily character-creation cap (rolling 24h, ALL backends — BYOK
 * included). Deliberately equals MAX_COMPANION_SLOTS: with only 4 Home slots,
 * more than 4 creations/day is create-delete churn, and each creation burns
 * real upstream spend (persona expansion, portrait, skin panel). Enforced
 * locally in main (characterStore.checkCreateQuota / recordCreation — the
 * renderer's CreationLimitModal keys off it); the proxy's persona_daily /
 * image_daily / skin_daily buckets stay the server-side abuse backstops.
 * The proxy's skinDailyGate (SKIN_DAILY_LIMIT) mirrors this value — update
 * both together.
 */
export const MAX_CREATIONS_PER_DAY = 4;

/** Server-assigned public tag: 4 chars, A-Z / 0-9 (cloud `characters.public_id`). */
export const PUBLIC_ID_REGEX = /^[A-Z0-9]{4}$/;

export const CharacterSchema = z.object({
  // D-23: UUID v4 is canonical. Slug-based ids are LEGACY and rejected at the
  // boundary — Plan 11-05 (slug→UUID migration) rewrites existing local rows.
  // No backward-compat shim (CLAUDE.md: no backwards-compat hacks).
  id: z.string().uuid({ message: 'characterId must be a UUID v4' }),
  // 260703 procgen: origin discriminator (see CharacterKindSchema). Optional +
  // default 'custom' so every pre-existing character JSON round-trips unchanged.
  kind: CharacterKindSchema.optional().default('custom'),
  // 260703 procgen: server-assigned 4-char public tag ([A-Z0-9]{4}), mirrored
  // from the cloud row after the first upsert. Null for characters that have
  // never been stored on cloud. NEVER minted client-side.
  public_id: z.string().regex(PUBLIC_ID_REGEX).nullable().optional().default(null),
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
  // Last in-app chat interaction (ISO or absent). Device-local like
  // last_launched (never mirrored to cloud); optional so existing character
  // literals need not set it. Combined with last_launched for the card's
  // "last active" date + ordering. Stamped only on a successful reply.
  last_chatted: z.string().nullable().optional(),
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
 * 260703 procgen: answers from the first-sign-in questionnaire, used as the
 * generation seed for 'unique' companions. Stored locally in
 * UserConfig.user_profile AND mirrored to the cloud `user_preferences` table
 * (own-only RLS) so a re-install / second device skips the questionnaire.
 * All fields nullable: null = not answered yet.
 */
/**
 * 260705: relationship dynamics — what the user is looking for in a companion.
 * Keys mirror soulcaster's DYNAMICS table (src/tables.js there); each biases
 * the personality roll and the sheet's `player_dynamic` for one cast.
 */
export const COMPANION_DYNAMICS = [
  'partner-in-crime',
  'caretaker',
  'protege',
  'chill-friend',
  'challenger',
] as const;
export const CompanionDynamicSchema = z.enum(COMPANION_DYNAMICS);
export type CompanionDynamic = z.infer<typeof CompanionDynamicSchema>;

export const UserPreferencesSchema = z.object({
  /** Preferred companion age band (companion's age, not the user's). */
  companion_age_range: z
    .enum(['young-adult', 'adult', 'mature', 'elder', 'timeless'])
    .nullable()
    .default(null),
  /** Preferred art style for generated portraits. */
  art_style: z.enum(['chibi', 'anime', 'celshaded', 'cartoon', '3d']).nullable().default(null),
  /**
   * 260705: RANKED relationship dynamics from the questionnaire ("rank what
   * you're looking for"). Array order IS the ranking: the user's first unique
   * cast uses [0], the second [1], and so on (see resolveDynamic in
   * src/main/uniqueGeneration.ts). Partial rankings are fine — casts past the
   * end of the list free-roll. `[]` = the user explicitly chose "Surprise me";
   * null = never asked (profiles completed before this question existed).
   */
  companion_dynamics: z.array(CompanionDynamicSchema).nullable().default(null),
  /** ISO timestamp when the questionnaire was completed; null = pending. */
  completed_at: z.string().nullable().default(null),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * 260706: partial questionnaire update — what prefs:save accepts. Only the
 * ANSWER fields are settable (completed_at is stamped main-side on every
 * save, so device-vs-cloud recency comparisons in resolvePrefs stay honest).
 * Omitted keys leave the stored answer untouched; the merge happens in main
 * against a fresh config read (TOCTOU-safe), never against a renderer
 * snapshot.
 */
export const UserPreferencesPatchSchema = UserPreferencesSchema.pick({
  companion_age_range: true,
  art_style: true,
  companion_dynamics: true,
}).partial();
export type UserPreferencesPatch = z.infer<typeof UserPreferencesPatchSchema>;

/**
 * The individually answerable questionnaire questions, in ASK ORDER (the
 * ProfileQuestionsScreen renders its steps in this order). `null` means
 * unanswered — note companion_dynamics uses `[]` for an explicit "Surprise
 * me", which counts as answered.
 */
export const PREF_QUESTIONS = ['companion_age_range', 'companion_dynamics', 'art_style'] as const;
export type PrefQuestion = (typeof PREF_QUESTIONS)[number];

/**
 * Which questions the given profile has NOT answered yet. Drives the
 * "ask only what's missing" flows: a questionnaire completed before a new
 * question shipped (or abandoned partway) re-asks just the gaps — at
 * onboarding, and again when the user taps "Meet my companion".
 */
export function missingPrefQuestions(profile: UserPreferences | null | undefined): PrefQuestion[] {
  if (!profile) return [...PREF_QUESTIONS];
  return PREF_QUESTIONS.filter((q) => profile[q] == null);
}

/**
 * The in-game Minecraft username a summoned bot connects under: the per-persona
 * `username` when set, else the persona `name` sanitized to MC's constraints
 * ([A-Za-z0-9_], ≤16 chars, non-empty → 'Sei'). Mirrors the bot's own
 * derivation in src/bot/index.js (`sanitizeMcName`) so callers in main and
 * renderer compute the SAME name the bot will actually use — used by the
 * multi-summon duplicate-name guard (two bots can't share a username; the
 * server kicks the second with `multiplayer.disconnect.name_taken`).
 */
export function effectiveMcUsername(c: Pick<Character, 'username' | 'name'>): string {
  const u = (c.username ?? '').trim();
  if (u) return u;
  const cleaned = String(c.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return cleaned || 'Sei';
}

/**
 * The SINGLE membership rule for "does this character occupy a Home companion
 * slot". Shared by the renderer's Home/IconRail filter (isHomeCharacter in
 * src/renderer/src/lib/homeLibrary.ts) AND the main-process slot counter
 * (libraryCharacterCount in src/main/uniqueGeneration.ts) so the visible grid
 * and the slot guard can never diverge (a divergence rejects chars:save on a
 * visibly non-full grid, or vice versa).
 *
 * Rule:
 *   - bundled defaults (is_default) → shown only when invited into a slot
 *     (addedDefaultIds);
 *   - signed in: own / legacy null-owner chars shown; foreign-owned chars
 *     (owner set, !== current user) shown only when added from World
 *     (addedWorldIds);
 *   - signed out: only legacy null-owner chars shown — a cached copy of
 *     someone else's public character (owner stamped) can't be a party member
 *     because a signed-out user can't invite from World.
 */
export function countsAsHomeSlot(
  c: Pick<Character, 'id' | 'is_default' | 'owner'>,
  opts: { currentUserId: string | null; addedDefaultIds: Set<string>; addedWorldIds: Set<string> },
): boolean {
  if (c.is_default === true) {
    return opts.addedDefaultIds.has(c.id);
  }
  if (opts.currentUserId) {
    if (c.owner != null && c.owner !== opts.currentUserId) {
      return opts.addedWorldIds.has(c.id);
    }
    return true;
  }
  return c.owner == null;
}

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
  /**
   * In-app chat user profile picture — a portrait path ref ('_user.png'),
   * resolved via the sei-portrait:// protocol like character portraits. Used as
   * the player's avatar in the Discord-style chat. Must NOT be a data: URL
   * (same boundary as character portrait_image). Null/absent = no picture.
   */
  profile_picture: z
    .string()
    .refine((v) => !v.startsWith('data:'), { message: 'profile_picture must be a path reference, not a data URL' })
    .nullable()
    .optional()
    .default(null),
  /**
   * 260617: ISO timestamp until which cloud (trial) play is daily-rate-limited
   * (the proxy's $5/day spend cap). Set when a live session hits the cap; the
   * summon gate refuses to fork until it elapses, then clears it. Cleared early
   * by the renderer when a subscription goes active so a paid upgrade unblocks
   * immediately. Absent / null = not limited. Optional (not defaulted) so the
   * many manual UserConfig literals don't all need to spell it out.
   */
  daily_limited_until: z.string().nullable().optional(),
  /**
   * 260705: ISO timestamps of recent character creations, pruned to the
   * rolling 24h window on every write. Drives the MAX_CREATIONS_PER_DAY cap
   * (characterStore.checkCreateQuota / recordCreation). Local-first so the
   * cap covers BYOK users too (no server bucket exists for them). Optional
   * (not defaulted) so the many manual UserConfig literals don't all need to
   * spell it out; absent ≡ [].
   */
  creation_times: z.array(z.string()).optional(),
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
   * 260703: who last set `ai_backend_kind`.
   *   - 'default' → a sign-in/onboarding/boot default (or a pre-existing config
   *                 from before this field). Sign-in may re-assert the cloud
   *                 default over it.
   *   - 'user'    → an explicit user action (the Settings ACCOUNT MODE switch /
   *                 the API-key setup modal, via proxy:configure →
   *                 apiKeyStore.setAiBackendKind). Sign-in defaults MUST NOT
   *                 stomp it — a user who deliberately chose BYOK stays on BYOK
   *                 across sign-out/sign-in cycles.
   * Written only by apiKeyStore; read by the cloud-default helpers there.
   */
  ai_backend_kind_source: z.enum(['default', 'user']).optional().default('default'),
  /**
   * ui-A7: developer console (LogsBar) visibility. Off by default —
   * shipping users almost never need the raw bot log. Settings exposes a
   * toggle that flips this and App.tsx gates `<LogsBar />` on it.
   */
  dev_console_visible: z.boolean().optional().default(false),
  /**
   * "Realistic typing" (Appearance & feel). When on, the companion pauses to
   * "read" your message before the typing indicator appears (scaled to your
   * message length at a fast-reader speed), then keeps the indicator up for a
   * stretch proportional to each reply bubble at a fast-typist speed. The same
   * pacing is bridged to the in-game Minecraft bot (botSupervisor →
   * config.realistic_typing). Off makes replies appear as soon as the model
   * returns. Default on for a more human feel; `.optional().default(true)`
   * keeps existing config.json files (which lack the field) on the new default.
   */
  realistic_typing: z.boolean().optional().default(true),
  /**
   * "Call captions" (Appearance & feel, 260705). When on, the voice-call
   * screen shows the two live caption lines (companion's last spoken line +
   * your last transcribed utterance). Off by default — a call should feel
   * like audio, not subtitles; captions are an accessibility/debugging aid.
   */
  call_captions: z.boolean().optional().default(false),
  /**
   * 260705: the chat presence side panel is OPEN by default; closing it is a
   * sticky preference that survives companion switches and app restarts
   * (hydrated into useUiStore.chatPanelHidden like realistic_typing).
   */
  chat_panel_hidden: z.boolean().optional().default(false),
  /**
   * Onboarding skin-setup gate. Set true when the user finishes the name/API
   * onboarding step, cleared when they finish OR skip the dedicated skin-setup
   * page. While true, the app routes to `{ kind: 'skin-setup' }` instead of home
   * on launch — this is what makes the skin-setup step resumable if the user
   * quits mid-setup. `.optional().default(false)` keeps existing config.json
   * files (and the first-summon nudge path for users who predate this step)
   * backward-compatible — they're treated as not-pending and never forced in.
   */
  skin_setup_pending: z.boolean().optional().default(false),
  /**
   * Bundled defaults (sui / lyra / clawd) the user has "removed from library".
   * The on-disk JSON for these chars stays so the World tab can still surface
   * them as system-authored entries, but they're hidden from Home + IconRail
   * and the per-character page swaps Summon for "Add to library" which
   * removes the id from this array.
   */
  removed_default_ids: z.array(z.string().uuid()).optional().default([]),
  /**
   * 260703 procgen: bundled defaults the user has EXPLICITLY invited into a
   * Home slot. Semantics inverted from removed_default_ids — defaults now live
   * in the World tab and are hidden from Home unless listed here. The old
   * removed_default_ids field is retained (harmless) but no longer consulted
   * by the Home grid.
   */
  added_default_ids: z.array(z.string().uuid()).optional().default([]),
  /**
   * One-shot idempotency marker for the added_default_ids backfill migration
   * (src/main/migration.ts runAddedDefaultsBackfill). The Home visibility model
   * inverted from removed_default_ids (shown unless removed) to added_default_ids
   * (hidden unless invited); the backfill seeds added_default_ids with any
   * locally-present is_default characters on the first boot after upgrade so a
   * pre-existing user's already-seeded Sui/Lyra/Clawd stay on Home instead of
   * vanishing. Fresh installs have no local is_default copies, so the backfill
   * adds nothing and simply flips this true. `.optional().default(false)` keeps
   * existing config.json files backward-compatible.
   */
  added_defaults_backfilled: z.boolean().optional().default(false),
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
   * 260706 — local mirror of the once-per-account feedback reward. Flipped
   * true when the proxy reports the reward granted OR already claimed, so the
   * Playtime screen's reward banner retires and the standing "Submit feedback"
   * button takes its place. Server-side the claim stays authoritative (partial
   * unique index on ledger_grants), so a stale false here can never double-grant.
   */
  feedback_reward_claimed: z.boolean().optional().default(false),
  /**
   * Looking (vision) mode — how the companion sees the world:
   *   'off'        — never looks; plays from world data only. No look()/explore()
   *                  pictures and no automatic views.
   *   'on-demand'  — the model can call look() / explore() when it needs to; it
   *                  never receives a view it did not ask for.
   *   'continuous' — everything 'on-demand' offers PLUS an automatic view is fed
   *                  in as it plays.
   * Settings writes this through the existing saveConfig IPC (switching ON the
   * automatic views — 'continuous' — is gated behind the cost confirm popup,
   * D-06); main bridges it into the forked bot's `config.vision.mode` at summon
   * time (botSupervisor → bot init payload → src/bot/index.js ConfigSchema
   * build). Persistent and always editable; a non-VLM provider simply skips
   * pictures at runtime.
   *
   * MIGRATION: the pre-simplification values 'passive' and 'active' (both of
   * which streamed automatic views) collapse to 'continuous'. configStore parses
   * with .parse() — it THROWS on an unknown enum — so the remap must happen here,
   * before validation, or existing configs would fail to load.
   */
  vision_mode: z
    .preprocess(
      (v) => (v === 'passive' || v === 'active' ? 'continuous' : v),
      z.enum(['off', 'on-demand', 'continuous']),
    )
    .optional()
    .default('on-demand'),
  /**
   * Cumulative bot playtime for THIS profile, in ms, summed across every
   * character's session. Accumulated at session-end in botSupervisor (alongside
   * the per-character `playtime_ms`) so the total survives a character being
   * deleted — a deleted character's time is already folded in here. Drives the
   * "played Xh Ym" figure in the UsageBar tooltip. Profile-scoped because
   * config.json lives under the active profile root (paths.configPath()).
   */
  total_playtime_ms: z.number().int().min(0).optional().default(0),
  /**
   * One-time guard: true once `total_playtime_ms` has been seeded from the sum
   * of existing characters' `playtime_ms` (so historical time counts even
   * though it predates the cumulative total). Set by backfillTotalPlaytimeOnce
   * at startup; fresh installs set it true in onboarding (nothing to backfill).
   */
  total_playtime_backfilled: z.boolean().optional().default(false),
  /**
   * 260703 procgen: first-sign-in questionnaire answers (see UserPreferencesSchema).
   * Local cache of the cloud `user_preferences` row; the cloud copy wins on
   * sign-in when both exist. Defaults to all-null (questionnaire pending).
   */
  user_profile: UserPreferencesSchema.optional().default({
    companion_age_range: null,
    art_style: null,
    companion_dynamics: null,
    completed_at: null,
  }),
  /**
   * 260706: relationship dynamics already granted to a unique cast on this
   * device. Each RANKED preference is granted at most once, top pick first
   * (resolveDynamic in src/main/uniqueGeneration.ts); once the list is
   * exhausted — or was never ranked — casts roll a random dynamic, which is
   * NOT recorded here. Appended under the config file lock after a cast
   * saves (configStore.updateConfig). Device-local by design: deliberately
   * not mirrored to the cloud prefs row.
   */
  dynamics_granted: z.array(CompanionDynamicSchema).default([]),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
