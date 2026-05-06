import { z } from 'zod'

/**
 * A closed action registry. Only explicitly registered actions can be executed.
 * Game-agnostic: this module is consumed by both the brain (which lists/schemas
 * tools for the LLM) and adapters (which register their concrete handlers).
 *
 * Adapter implementations live next to their behaviors (e.g.
 * src/adapter/minecraft/registry.js exports createDefaultRegistry() that
 * pre-populates the minecraft action set).
 */
export function createRegistry() {
  /** @type {Map<string, { schema: z.ZodObject<any>, handler: Function, description?: string }>} */
  const actions = new Map()

  return {
    /**
     * Register a new action with a Zod schema for its args.
     * @param {string} name
     * @param {z.ZodObject<any>} schema
     * @param {(args: any, bot: any, config: any) => Promise<any>} handler
     * @param {string} [description]
     */
    register(name, schema, handler, description = '') {
      if (actions.has(name)) throw new Error(`Action '${name}' already registered`)
      actions.set(name, { schema, handler, description })
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

    /** List registered action names (for system prompt construction). */
    list() {
      return [...actions.keys()]
    },

    /** Get Zod schema for a named action (for tool-call validation). */
    schema(name) {
      return actions.get(name)?.schema ?? null
    },

    /** Get free-text description for a named action (for tool-call rendering). */
    description(name) {
      return actions.get(name)?.description ?? ''
    },
  }
}

export const ActionRegistry = createRegistry
