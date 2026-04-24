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
})

export function loadConfig(path = './config.json') {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  return ConfigSchema.parse(raw)
}
