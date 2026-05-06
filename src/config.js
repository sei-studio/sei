import { z } from 'zod'
import { readFileSync } from 'fs'

// Brain-side config — game-agnostic. The persona, anthropic, llm, and memory
// branches live here; game-specific fields nest under `adapter.<kind>.*`.
//
// BREAKING (Plan 03.1-02): the old top-level fields `host`, `port`, `auth`,
// `username`, `minecraft_version`, `pathfinder_timeout_ms`, `follow_range`
// have moved under `adapter.minecraft.*`. No backwards-compat shim is
// provided per CLAUDE.md — existing config.json files MUST be updated
// (the CLI's `sei config` flow will rewrite them when re-run, or the
// loader auto-migrates legacy top-level keys at parse time below).

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
  // `[think] ` prefix so the owner can watch the bot's reasoning in real
  // time. Default keeps existing config.json files (which lack the field)
  // on the prior behavior.
  chat_mode: z.enum(['chat', 'full']).default('chat'),
  owner_username: z.string(),
  persona: z.object({
    name: z.string().min(1),                                                // PERS-01
    backstory: z.string(),                                                  // PERS-02
    tone: z.enum(['friendly', 'sarcastic', 'serious', 'curious']),          // PERS-03
  }),
  anthropic: z.object({
    api_key: z.string().min(1),                                             // required; no default
    model: z.string().default('claude-haiku-4-5-20251001'),                 // D-20: Haiku 3 RETIRED
    timeout_ms: z.number().int().min(1000).default(20_000),
  }),
  llm: z.object({
    rate_limit_per_min: z.number().int().min(1).default(30),
    debounce_ms: z.number().int().min(0).default(500),
    max_hops: z.number().int().min(1).default(5),
    idle_fallback_ms: z.number().int().min(1000).default(60_000),
  }).default({}),
  // Phase 3 D-59: full memory: block. Paths default to project root; budgets
  // are byte-budgets (not token-budgets, per D-50). spawn_settle_delay_ms
  // covers Pitfall 2 (bot.players populates a few ticks after spawn).
  memory: z.object({
    owner_md_path: z.string().default('./memory/OWNER.md'),
    diary_md_path: z.string().default('./memory/DIARY.md'),
    iteration_cap: z.number().int().min(1).default(30),
    loop_batch_loop_count_cap: z.number().int().min(1).default(10),
    loop_batch_context_cap_bytes: z.number().int().min(1024).default(32768),
    sessions_per_consolidation: z.number().int().min(1).default(4),
    diary_size_cap_bytes: z.number().int().min(1024).default(204800),
    seed_diary_budget_bytes: z.number().int().min(256).default(3072),
    seed_owner_budget_bytes: z.number().int().min(256).default(1024),
    spawn_settle_delay_ms: z.number().int().min(0).default(500),
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
