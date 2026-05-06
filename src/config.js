import { z } from 'zod'
import { readFileSync } from 'fs'

export const ConfigSchema = z.object({
  host: z.string(),
  auth: z.enum(['offline', 'microsoft']),
  username: z.string(),
  // chat_mode: 'chat' (default) — only `say()` lines reach Minecraft chat.
  // 'full' — assistant `text` (private scratch) ALSO reaches chat with a
  // `[think] ` prefix so the owner can watch the bot's reasoning in real
  // time. Default keeps existing config.json files (which lack the field)
  // on the prior behavior.
  chat_mode: z.enum(['chat', 'full']).default('chat'),
  owner_username: z.string(),
  minecraft_version: z.string().default('auto'),
  reconnect_delay_ms: z.number().int().min(0).default(5000),
  pathfinder_timeout_ms: z.number().int().min(1000).default(12000),
  follow_range: z.number().int().min(1).default(3),
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
})

export function loadConfig(path = './config.json', overrides = {}) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  // Allow ANTHROPIC_API_KEY env var to satisfy the required anthropic.api_key field.
  if (!raw.anthropic?.api_key) {
    raw.anthropic = { ...(raw.anthropic ?? {}), api_key: process.env.ANTHROPIC_API_KEY ?? '' }
  }
  if (overrides.host != null) raw.host = overrides.host
  return ConfigSchema.parse(raw)
}
