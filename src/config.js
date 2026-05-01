import { z } from 'zod'
import { readFileSync } from 'fs'

export const ConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  auth: z.enum(['offline', 'microsoft']),
  username: z.string(),
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
  ollama: z.object({
    host: z.string().default('http://127.0.0.1:11434'),
    model: z.string().default('qwen3.5:7b-instruct'),                        // D-21: instruct variant ONLY
    timeout_ms: z.number().int().min(1000).default(30_000),
  }).default({}),
  llm: z.object({
    rate_limit_per_min: z.number().int().min(1).default(30),
    debounce_ms: z.number().int().min(0).default(500),
    max_hops: z.number().int().min(1).default(5),
    idle_fallback_ms: z.number().int().min(1000).default(10_000),
    // 'auto' = probe Ollama and use it; fall back to Haiku on failure (D-13/D-14).
    // 'api'  = force Haiku-as-executor for both layers; skip the Ollama probe entirely.
    executor: z.enum(['auto', 'api']).default('auto'),
  }).default({}),
})

export function loadConfig(path = './config.json') {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  // Allow ANTHROPIC_API_KEY env var to satisfy the required anthropic.api_key field.
  if (!raw.anthropic?.api_key) {
    raw.anthropic = { ...(raw.anthropic ?? {}), api_key: process.env.ANTHROPIC_API_KEY ?? '' }
  }
  return ConfigSchema.parse(raw)
}
