// src/bot/adapter/sts2/registry.js: the brain's single game tool, act().
// The moves themselves are whatever the game registered at this decision
// point (Neuro SDK actions/register + actions/force), so the tool list stays
// fixed (prompt cache friendly) while the snapshot's YOUR MOVE block carries
// the live list. The handler sends one move and returns the game's answer
// (types.js: executeAction returns a string; failures start with "failed:").

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { SEI_ACT_DESCRIPTION } from './prompts.js'

const Scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])
const ArgValue = z.union([Scalar, z.array(Scalar).max(40)])

export const ACT_SCHEMA = z.object({
  action: z.string().min(1).max(80).transform((s) => s.trim()),
  args: z.record(ArgValue).optional().default({}),
})

export const VERB_NAMES = ['act']

/**
 * @param {{ run: (action: string, args: object, opts: { signal?: AbortSignal|null }) => Promise<string> }} deps
 */
export function createSts2Registry({ run }) {
  const registry = createRegistry()
  registry.register(
    'act',
    ACT_SCHEMA,
    async (args, _bot, config) => {
      const signal = config?.signal ?? null
      try {
        return await run(args.action, args.args ?? {}, { signal })
      } catch (err) {
        if (signal?.aborted || /aborted/.test(String(err?.message))) return 'aborted'
        return `failed: ${err?.message ?? err}`
      }
    },
    SEI_ACT_DESCRIPTION,
  )
  return registry
}
