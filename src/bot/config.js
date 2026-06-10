import { z } from 'zod'
import { readFileSync } from 'fs'

// Brain-side config — game-agnostic. The persona, anthropic, llm, and memory
// branches live here; game-specific fields nest under `adapter.<kind>.*`.
//
// The top-level fields `host`, `port`, `auth`, `username`,
// `minecraft_version`, `pathfinder_timeout_ms`, `follow_range` are under
// `adapter.minecraft.*` (not top-level). No backwards-compat shim is provided
// per CLAUDE.md — existing config.json files MUST be updated (the CLI's `sei
// config` flow will rewrite them when re-run, or the loader auto-migrates
// legacy top-level keys at parse time below).

// Adapter sub-tree: minecraft fields. Keep names aligned with the
// pre-refactor top-level shape so call sites only need to update the
// access path, not the field names.
const MinecraftAdapterSchema = z.object({
  host: z.string(),
  port: z.number().int().min(0).optional(),
  auth: z.enum(['offline', 'microsoft']),
  username: z.string(),
  version: z.string().default('auto'),
  reconnect_delay_ms: z.number().int().min(0).default(5000),
  pathfinder_timeout_ms: z.number().int().min(1000).default(12000),
  follow_range: z.number().int().min(1).default(3),
})

const AdapterSchema = z.object({
  kind: z.literal('minecraft').default('minecraft'),
  minecraft: MinecraftAdapterSchema,
})

export const ConfigSchema = z.object({
  // chat_mode: 'chat' (default) — only `say()` lines reach Minecraft chat.
  // 'full' — assistant `text` (private scratch) ALSO reaches chat with a
  // `[think] ` prefix so the player can watch the bot's reasoning in real
  // time. Default keeps existing config.json files (which lack the field)
  // on the prior behavior.
  chat_mode: z.enum(['chat', 'full']).default('chat'),
  player_username: z.string(),
  // Friendly name the LLM addresses the player by. Substituted in chat events
  // and convo memory in place of the raw MC username so the bot never speaks
  // the player's gamertag. Falls back to player_username when empty.
  player_display_name: z.string().default(''),
  // 260516-0yw: `backstory` retired in favor of `expanded` — the LLM-generated
  // long-form persona prompt produced at character-save time by
  // src/main/personaExpansion.ts. No backwards-compat shim (per CLAUDE.md
  // "no backwards-compat hacks") — configs missing `persona.expanded` will
  // fail Zod parsing explicitly so the user re-saves the character in the GUI.
  persona: z.object({
    name: z.string().min(1),
    expanded: z.string(),
  }),
  anthropic: z.object({
    // Phase 13-15 (D-40 sub-delivery a): api_key is no longer strictly required
    // when `cloudMode` is set. The bot routes through the Sei proxy with the
    // Supabase JWT in `cloudMode.authToken` and the SDK is constructed with
    // `apiKey: null` (anthropicClient.js buildSdkOptions). BYOK callers still
    // need a non-empty key. The cross-field invariant is enforced via .refine.
    api_key: z.string().default(''),                                        // required by .refine when cloudMode absent
    model: z.string().default('claude-haiku-4-5'),                          // family alias → latest Haiku 4.5 snapshot (no dated pin to drift; see personaExpansion.ts EXPANSION_MODEL)
    // 260610: 20s → 12s. This budget is the player-visible worst-case
    // silence when the backend misbehaves (healthy calls run 1-3s; a slow
    // first call with a full cache write plus anthropicClient's one capped
    // rescue retry still fits comfortably).
    timeout_ms: z.number().int().min(1000).default(12_000),
    // Extended thinking budget. 0 disables. 1024 is the API minimum; thinking
    // adds latency to every call without changing what the model says aloud,
    // since assistant text blocks ARE the chat channel now (see orchestrator).
    // Default off; flip to 1024+ if you want a private scratchpad before tool
    // dispatch.
    thinking_budget_tokens: z.number().int().min(0).default(0),
    // When present, anthropicClient constructs the SDK with
    // {baseURL, authToken, apiKey:null} and routes through the cloud proxy.
    // baseURL points at the public proxy endpoint (https://api.sei.gg);
    // authToken is the user's Supabase access_token. Refresh via
    // anthropic.setAuthToken() from the bot's parentPort {type:'jwt'} handler.
    cloudMode: z.object({
      baseURL: z.string().url(),
      authToken: z.string().min(1),
    }).optional(),
  }).refine(
    (a) => a.cloudMode != null || (a.api_key != null && a.api_key.length > 0),
    { message: 'anthropic.api_key is required when cloudMode is not set' },
  ),
  llm: z.object({
    rate_limit_per_min: z.number().int().min(1).default(30),
    debounce_ms: z.number().int().min(0).default(500),
    max_hops: z.number().int().min(1).default(5),
    idle_fallback_ms: z.number().int().min(1000).default(60_000),
    // Phase 14: which provider services the bot loop. Defaults to 'anthropic'
    // so configs predating this phase still boot unchanged. The Anthropic
    // path also covers the Sei cloud proxy (`anthropic.cloudMode`).
    provider: z.enum([
      'anthropic', 'openai', 'gemini', 'grok', 'openrouter', 'ollama',
      'deepseek', 'mistral', 'together', 'groq', 'fireworks',
      'cerebras', 'perplexity',
    ]).default('anthropic'),
    // Per-provider config. Only the active provider's block is required to
    // be populated; the others can stay default-empty.
    providers: z.object({
      openai:     z.object({ api_key: z.string().default(''), model: z.string().default('gpt-4o-mini'),                                       base_url: z.string().url().optional() }).default({}),
      gemini:     z.object({ api_key: z.string().default(''), model: z.string().default('gemini-2.0-flash'),                                  base_url: z.string().url().optional() }).default({}),
      grok:       z.object({ api_key: z.string().default(''), model: z.string().default('grok-2-latest'),                                     base_url: z.string().url().optional() }).default({}),
      openrouter: z.object({ api_key: z.string().default(''), model: z.string().default('anthropic/claude-haiku-4-5'),                        base_url: z.string().url().optional() }).default({}),
      deepseek:   z.object({ api_key: z.string().default(''), model: z.string().default('deepseek-chat'),                                     base_url: z.string().url().optional() }).default({}),
      mistral:    z.object({ api_key: z.string().default(''), model: z.string().default('mistral-small-latest'),                              base_url: z.string().url().optional() }).default({}),
      together:   z.object({ api_key: z.string().default(''), model: z.string().default('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),       base_url: z.string().url().optional() }).default({}),
      groq:       z.object({ api_key: z.string().default(''), model: z.string().default('llama-3.3-70b-versatile'),                           base_url: z.string().url().optional() }).default({}),
      fireworks:  z.object({ api_key: z.string().default(''), model: z.string().default('accounts/fireworks/models/llama-v3p3-70b-instruct'), base_url: z.string().url().optional() }).default({}),
      cerebras:   z.object({ api_key: z.string().default(''), model: z.string().default('llama-3.3-70b'),                                     base_url: z.string().url().optional() }).default({}),
      perplexity: z.object({ api_key: z.string().default(''), model: z.string().default('sonar'),                                              base_url: z.string().url().optional() }).default({}),
      ollama:     z.object({ model: z.string().default('llama3.1'),                                                                            base_url: z.string().default('http://localhost:11434') }).default({}),
    }).default({}),
  }).default({}),
  // PLAYER.md tracks the other player's identity (uuid, mc_username, names).
  // MEMORY.md is the bot's append-only long-term memory written via
  // remember()/forget() and shown in full to every loop.
  memory: z.object({
    player_md_path: z.string().default('./memory/PLAYER.md'),
    memory_md_path: z.string().default('./memory/MEMORY.md'),
    iteration_cap: z.number().int().min(1).default(30),
    seed_memory_budget_bytes: z.number().int().min(256).default(8192),
    seed_player_budget_bytes: z.number().int().min(256).default(1024),
    spawn_settle_delay_ms: z.number().int().min(0).default(500),
    // MEMORY.md compaction trigger: after a successful remember(), if the
    // on-disk file exceeds this byte count, an async Haiku compaction is
    // fired (single-flight). Default sits below seed_memory_budget_bytes so
    // compaction runs before the seed-read truncation kicks in.
    compaction_trigger_bytes: z.number().int().min(512).default(4096),
  }).default({}),
  adapter: AdapterSchema,
})

/**
 * Hoist legacy top-level minecraft fields into adapter.minecraft.* if the
 * caller hasn't already supplied an `adapter` object. This is NOT a
 * backwards-compat shim — it is a one-shot migration applied at parse time
 * so the first run after upgrade still boots. The CLI's `sei config` flow
 * is expected to rewrite config.json with the new shape on next save.
 */
function migrateLegacyAdapterFields(raw) {
  if (raw.adapter && raw.adapter.minecraft) return raw
  const mc = {}
  const moveKey = (k, dst = k) => { if (raw[k] !== undefined) { mc[dst] = raw[k] } }
  moveKey('host')
  moveKey('port')
  moveKey('auth')
  moveKey('username')
  moveKey('minecraft_version', 'version')
  moveKey('reconnect_delay_ms')
  moveKey('pathfinder_timeout_ms')
  moveKey('follow_range')
  if (Object.keys(mc).length === 0) return raw
  return { ...raw, adapter: { kind: 'minecraft', minecraft: mc } }
}

export function loadConfig(path = './config.json', overrides = {}) {
  let raw = JSON.parse(readFileSync(path, 'utf-8'))
  // Allow ANTHROPIC_API_KEY env var to satisfy the required anthropic.api_key field.
  if (!raw.anthropic?.api_key) {
    raw.anthropic = { ...(raw.anthropic ?? {}), api_key: process.env.ANTHROPIC_API_KEY ?? '' }
  }
  raw = migrateLegacyAdapterFields(raw)
  if (overrides.host != null) {
    raw.adapter = raw.adapter ?? { kind: 'minecraft', minecraft: {} }
    raw.adapter.minecraft = { ...raw.adapter.minecraft, host: overrides.host }
  }
  if (overrides.port != null) {
    raw.adapter = raw.adapter ?? { kind: 'minecraft', minecraft: {} }
    raw.adapter.minecraft = { ...raw.adapter.minecraft, port: overrides.port }
  }
  return ConfigSchema.parse(raw)
}
