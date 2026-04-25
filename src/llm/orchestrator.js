import { createAnthropicClient } from './anthropicClient.js'
import { createOllamaClient } from './ollamaClient.js'
import { createGoalStore } from './goals.js'
import { createTokenBucket } from './rateLimiter.js'
import { createDebouncer } from './debounce.js'
import { createOllamaCircuit } from './circuit.js'
import { createChainTracker } from './chains.js'
import { renderPersona, capHitLine } from './persona.js'
import { buildAnthropicTools, buildOllamaTools } from './schemaBridge.js'

const SYSTEM_INSTRUCTIONS = [
  'You are the personality layer of a Minecraft companion bot.',
  'You react to chat, world events, and idle ticks.',
  'You decide WHAT to do at a high level — never mention coordinates, action names, or code.',
  'When you want the body to move or interact with the world, call handOffToMovement with a short natural-language instruction (e.g. "go check what shawn is building over by the water").',
  'When you want to speak in chat, call say with the exact line.',
  'When the owner sets a goal or you decide on a self-goal, call setGoals.',
  'You may call multiple tools in one response. Keep responses brief — under 3 sentences of internal reasoning.',
  'If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play.',
].join('\n')

const MOVEMENT_SYSTEM = [
  'You translate natural-language intent into one or more registered action calls.',
  'You ONLY emit tool_calls — no prose. Pick the action(s) that best fulfill the intent.',
  'If the intent is unclear or no action fits, emit no tool_calls.',
].join('\n')

const ACTION_DESCRIPTIONS = {
  goTo: 'Move the bot to the given (x, y, z) coordinates within `range` blocks.',
  setGoals: 'Add or remove a goal from owner_goals or self_goals.',
  say: 'Speak the given text in in-game chat.',
  handOffToMovement: 'Hand off a natural-language movement/interaction intent to the movement layer.',
}

/**
 * @param {object} deps
 * @param {object} deps.bot
 * @param {object} deps.config
 * @param {object} deps.registry  // result of createDefaultRegistry() — already includes setGoals
 * @param {{warn:Function,info:Function,error:Function}} [deps.logger]
 */
export function createOrchestrator({ bot, config, registry, logger = console }) {
  const goals = createGoalStore()
  const anthropic = createAnthropicClient(config)
  const ollama = createOllamaClient(config)
  const circuit = createOllamaCircuit({ tripAt: 3 })
  const personalityBucket = createTokenBucket({
    capacity: config.llm.rate_limit_per_min,
    refillPerMin: config.llm.rate_limit_per_min,
  })
  const ingressDebouncer = createDebouncer(config.llm.debounce_ms)
  const chains = createChainTracker({ maxHops: config.llm.max_hops })

  // Personality-only tools: setGoals, say, handOffToMovement
  const personalityTools = [
    {
      name: 'say',
      description: ACTION_DESCRIPTIONS.say,
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'handOffToMovement',
      description: ACTION_DESCRIPTIONS.handOffToMovement,
      input_schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
    },
    {
      name: 'setGoals',
      description: ACTION_DESCRIPTIONS.setGoals,
      input_schema: {
        type: 'object',
        properties: {
          list: { type: 'string', enum: ['owner', 'self'] },
          op:   { type: 'string', enum: ['add', 'remove'] },
          goal: { type: 'string', minLength: 1 },
        },
        required: ['list', 'op', 'goal'],
      },
    },
  ]

  // Movement registry tools (exclude setGoals — that's personality-only)
  function movementToolsFor(provider) {
    const subRegistry = {
      list:   () => registry.list().filter(n => n !== 'setGoals'),
      schema: (n) => registry.schema(n),
    }
    return provider === 'anthropic'
      ? buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)
      : buildOllamaTools(subRegistry, ACTION_DESCRIPTIONS)
  }

  let cachedSystemBlocks = null
  function rebuildPersonalitySystem() {
    cachedSystemBlocks = anthropic.buildCachedSystem(
      SYSTEM_INSTRUCTIONS,
      renderPersona(config.persona),
      personalityTools
    )
  }
  rebuildPersonalitySystem()

  // ─── Startup probe (D-13) — 3 retries × 2s ───
  async function probeOllamaWithRetry() {
    for (let i = 0; i < 3; i++) {
      if (await ollama.probe()) return true
      await new Promise(r => setTimeout(r, 2000))
    }
    return false
  }

  async function start() {
    const ok = await probeOllamaWithRetry()
    if (!ok) {
      circuit.trip('startup probe failed')
      logger.warn('[sei/orch] Ollama unreachable at startup — using Haiku-as-executor for this session.')
    } else {
      logger.info(`[sei/orch] Ollama reachable at ${ollama.host} — model ${ollama.model}`)
    }
  }

  // ─── Movement dispatch (LLM-03 / LLM-08) ───
  async function callMovement(intent, signal) {
    const tools = movementToolsFor(circuit.isOpen() ? 'anthropic' : 'ollama')
    if (circuit.isOpen()) {
      const resp = await anthropic.call({
        systemBlocks: [{ type: 'text', text: MOVEMENT_SYSTEM }],
        tools,
        messages: [{ role: 'user', content: intent }],
        signal,
      })
      return { toolCalls: resp.toolUses.map(u => ({ name: u.name, args: u.input })) }
    }
    const messages = [
      { role: 'system', content: MOVEMENT_SYSTEM },
      { role: 'user',   content: intent },
    ]
    try {
      const resp = await ollama.call({ messages, tools, signal })
      circuit.recordSuccess()
      return { toolCalls: resp.toolCalls }
    } catch (err) {
      const newState = circuit.recordFailure()
      logger.warn(`[sei/orch] Ollama call failed (${err.message}); circuit state=${newState}`)
      throw err
    }
  }

  // ─── Personality call (LLM-02 / LLM-06) ───
  async function callPersonality(userBlock, signal) {
    if (!personalityBucket.tryAcquire()) {
      logger.warn('[sei/orch] Rate limit hit — dropping personality call')
      return null
    }
    return await anthropic.call({
      systemBlocks: cachedSystemBlocks,
      tools: personalityTools,
      messages: [{ role: 'user', content: userBlock }],
      signal,
    })
  }

  // ─── Main dispatch loop (LLM-04 hop cap, LLM-07 abort propagation) ───
  /**
   * Single entry point. Wave 3 wires this to the FSM `sei:dispatch` event.
   * The optional `chainId` is set by Wave 3 when the dispatch is a CONTINUATION
   * (e.g. an FSM completion event for an action launched by an earlier chain).
   * If absent, this is a fresh chain.
   */
  async function handleDispatch(event, data, signal) {
    let chainId = data?._chainId && chains.continue(data._chainId) ? data._chainId : chains.begin(event)
    let nextUser = renderUserContext(event, data, goals.snapshot())

    function bump() {
      const r = chains.increment(chainId)
      if (r.capped) throw new HopCapHit(chainId, r.hops)
    }

    try {
      if (signal.aborted) return
      bump()  // personality hop

      const personalityResp = await callPersonality(nextUser, signal)
      if (!personalityResp) { chains.end(chainId); return }

      const sayCalls    = personalityResp.toolUses.filter(u => u.name === 'say')
      const goalCalls   = personalityResp.toolUses.filter(u => u.name === 'setGoals')
      const handoffCall = personalityResp.toolUses.find(u => u.name === 'handOffToMovement')

      for (const c of sayCalls)  bot.chat(String(c.input?.text ?? '').slice(0, 256))
      for (const c of goalCalls) await registry.execute('setGoals', c.input, bot, { ...config, _goalStore: goals })

      if (!handoffCall) { chains.end(chainId); return }

      if (signal.aborted) return
      bump()  // movement hop

      const movement = await callMovement(String(handoffCall.input?.intent ?? ''), signal)
      if (signal.aborted) return

      // Dispatch movement tool_calls via Phase 1 registry. Tag completion events
      // with chainId so FSM-driven re-dispatches keep counting against THIS chain.
      for (const call of movement.toolCalls) {
        if (signal.aborted) return
        try {
          await registry.execute(call.name, call.args, bot, {
            ...config,
            _goalStore: goals,
            _chainId: chainId,
            signal,
          })
        } catch (err) {
          logger.warn(`[sei/orch] action ${call.name} failed: ${err.message}`)
        }
      }
      // Do NOT end(chainId) here: a completion event may continue this chain.
      // Chain TTL (60s) sweeps if no continuation arrives.
      return
    } catch (err) {
      if (err instanceof HopCapHit) {
        logger.warn(`[sei/orch] hop cap hit (chain=${err.chainId}, hops=${err.hops}) on event ${event}`)
        try { bot.chat(capHitLine(config.persona)) } catch {}
        chains.end(chainId)
        return
      }
      if (err.name === 'AbortError' || signal.aborted) { chains.end(chainId); return }
      logger.error(`[sei/orch] dispatch error on ${event}: ${err.message}`)
      chains.end(chainId)
    }
  }

  function renderUserContext(event, data, goalsSnapshot) {
    const lines = [
      `Event: ${event}`,
      `Data: ${JSON.stringify(data ?? {})}`,
      `owner_goals: ${JSON.stringify(goalsSnapshot.owner_goals)}`,
      `self_goals:  ${JSON.stringify(goalsSnapshot.self_goals)}`,
    ]
    return lines.join('\n')
  }

  return {
    start,
    handleDispatch,
    get executorStatus() { return circuit.state },
    goals,
    debouncer: ingressDebouncer,
    _internal: { circuit, personalityBucket, callPersonality, callMovement, chains },
  }
}

class HopCapHit extends Error {
  constructor(chainId, hops) {
    super('hop cap hit')
    this.name = 'HopCapHit'
    this.chainId = chainId
    this.hops = hops
  }
}
