import { z } from 'zod'
import { goTo } from './behaviors/pathfind.js'

/**
 * A closed action registry. Only explicitly registered actions can be executed.
 * Phase 2's movement LLM will call execute() with action name + args.
 * No code generation, no coordinate injection beyond registered action schemas.
 */
export function createRegistry() {
  /** @type {Map<string, { schema: z.ZodObject<any>, handler: Function }>} */
  const actions = new Map()

  return {
    /**
     * Register a new action with a Zod schema for its args.
     * @param {string} name
     * @param {z.ZodObject<any>} schema
     * @param {(args: any, bot: any, config: any) => Promise<any>} handler
     */
    register(name, schema, handler) {
      if (actions.has(name)) throw new Error(`Action '${name}' already registered`)
      actions.set(name, { schema, handler })
    },

    /**
     * Execute a registered action. Throws if name unknown or args fail schema.
     * @param {string} name
     * @param {unknown} args
     * @param {object} bot
     * @param {object} config
     */
    async execute(name, args, bot, config) {
      const entry = actions.get(name)
      if (!entry) throw new Error(`Unknown action: '${name}'. Registered: ${[...actions.keys()].join(', ')}`)
      const parsed = entry.schema.parse(args)
      return entry.handler(parsed, bot, config)
    },

    /** List registered action names (for Phase 2 system prompt construction). */
    list() {
      return [...actions.keys()]
    },

    /** Get Zod schema for a named action (for Phase 2 tool-call validation). */
    schema(name) {
      return actions.get(name)?.schema ?? null
    },
  }
}

export const ActionRegistry = createRegistry

/** Pre-built registry with all Phase 1 actions registered. */
export function createDefaultRegistry() {
  const registry = createRegistry()

  registry.register(
    'goTo',
    z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      range: z.number().min(0).default(1),
    }),
    async (args, bot, config) => {
      const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
      return goTo(bot, args.x, args.y, args.z, args.range, timeoutMs)
    }
  )

  registry.register(
    'setGoals',
    z.object({
      list: z.enum(['owner', 'self']),
      op:   z.enum(['add', 'remove']),
      goal: z.string().min(1),
    }),
    async (args, bot, config) => {
      const store = config?._goalStore
      if (!store) throw new Error('setGoals invoked without _goalStore in config')
      if (args.op === 'add')    return { ok: store.add(args.list, args.goal),    snapshot: store.snapshot() }
      if (args.op === 'remove') return { ok: store.remove(args.list, args.goal), snapshot: store.snapshot() }
    }
  )

  return registry
}
