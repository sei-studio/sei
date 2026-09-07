// 260816 (china-compat W2): map the supervisor's init `llm` section onto the
// bot's ConfigSchema shape, BEFORE ConfigSchema.parse fills defaults.
//
// Why this exists: UserConfig.provider + provider_config (written by the
// Settings picker) were read by NOTHING — botSupervisor's init payload
// carried no llm config, so `llm:` was omitted from rawConfig and Zod
// defaulted every bot session to Anthropic regardless of the picker. Main now
// ships `{provider, model?, base_url?, api_key}` for local (BYOK) sessions
// and this pure function (tested in llmInit.test.js) folds it in.
//
// Rules, mirroring the other init bridges (chat_language, punctuation):
// junk falls to the schema default instead of failing the whole parse, and
// cloud-proxy sessions are NEVER rerouted — cloudMode always means the
// Anthropic proxy path.

import { LLM_PROVIDER_KINDS } from './config.js'

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

const validUrl = (v) => {
  const s = nonEmpty(v)
  if (!s) return null
  try {
    // eslint-disable-next-line no-new
    new URL(s)
    return s
  } catch {
    // A junk base_url would fail ConfigSchema's z.string().url() and crash
    // the summon; dropping it falls back to the provider's default base.
    return null
  }
}

/**
 * @param {object} rawConfig  pre-parse config (mutated copy is returned)
 * @param {object|undefined} llm  init payload section:
 *        { provider, model?, base_url?, api_key? } | undefined
 * @param {string} apiKey  the top-level init apiKey (BYOK key; back-compat
 *        field — also the fallback when llm.api_key is absent)
 * @returns {object} rawConfig with `llm`/`anthropic` sections applied
 */
export function applyLlmInit(rawConfig, llm, apiKey) {
  const out = { ...rawConfig }
  // Cloud-proxy sessions stay on the Anthropic+cloudMode path unconditionally.
  if (out.anthropic?.cloudMode) return out
  if (!llm || typeof llm !== 'object') return out
  const provider = typeof llm.provider === 'string' ? llm.provider : ''
  // Unknown provider (older bot vs newer main): fall to the anthropic
  // default rather than failing ConfigSchema.parse.
  if (!LLM_PROVIDER_KINDS.includes(provider)) return out

  const model = nonEmpty(llm.model)
  const baseUrl = validUrl(llm.base_url)
  const key = nonEmpty(llm.api_key) ?? nonEmpty(apiKey) ?? ''

  if (provider === 'anthropic') {
    // The default path; the only meaningful override is the model. The key
    // already rides rawConfig.anthropic.api_key.
    if (model) out.anthropic = { ...out.anthropic, model }
    return out
  }

  const pcfg = {
    ...(provider === 'ollama' ? {} : { api_key: key }), // ollama has no key field
    ...(model ? { model } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  }
  out.llm = { provider, providers: { [provider]: pcfg } }
  return out
}

/**
 * 260828 (BYOK-switch fix): apply a mid-session `{type:'backend-switch'}`
 * descriptor onto the PARSED, live config — the runtime sibling of
 * applyLlmInit above, which only runs pre-parse at init time.
 *
 * MUTATES `config` in place (the orchestrator, adapter and providers all hold
 * the same reference; a copy would leave them reading stale routing) and
 * returns the provider kind now selected, so the caller (orchestrator
 * setBackend) can decide whether the live provider instance must be rebuilt
 * through the factory or can be flipped in place.
 *
 * Rules:
 * - `backend.cloudMode` (local→cloud): cloud ALWAYS rides the
 *   anthropic+cloudMode path — config.llm.provider is forced back to
 *   'anthropic' (a local session may have been running any provider).
 * - local (`backend.api_key` + optional `backend.llm`): cloudMode is cleared,
 *   the key applied, and the llm section folded in with the same
 *   junk-tolerance as applyLlmInit (unknown provider / junk base_url fall to
 *   the anthropic default / provider default base rather than throwing —
 *   there is no ConfigSchema.parse safety net at runtime).
 * - Unlike applyLlmInit, providers are MERGED (never replaced wholesale):
 *   the parsed config.llm carries live knobs (rate_limit_per_min, max_hops,
 *   every other provider's defaults) that must survive the switch.
 *
 * @param {object} config  the PARSED live config (mutated)
 * @param {{cloudMode?:{baseURL:string,authToken:string}, api_key?:string,
 *          llm?:{provider?:string,model?:string,base_url?:string,api_key?:string}}} backend
 * @returns {string} the provider kind now in effect ('anthropic' | 'openai' | ...)
 */
export function applyLlmSwitch(config, backend) {
  if (backend && backend.cloudMode) {
    config.anthropic.cloudMode = {
      baseURL: backend.cloudMode.baseURL,
      authToken: backend.cloudMode.authToken,
    }
    config.anthropic.api_key = ''
    if (config.llm) config.llm.provider = 'anthropic'
    return 'anthropic'
  }

  // local / BYOK
  delete config.anthropic.cloudMode
  const topKey = nonEmpty(backend && backend.api_key) ?? ''
  config.anthropic.api_key = topKey

  const llm = backend && typeof backend.llm === 'object' ? backend.llm : null
  const provider =
    llm && typeof llm.provider === 'string' && LLM_PROVIDER_KINDS.includes(llm.provider)
      ? llm.provider
      : 'anthropic'
  const model = llm ? nonEmpty(llm.model) : null
  const baseUrl = llm ? validUrl(llm.base_url) : null
  const key = (llm ? nonEmpty(llm.api_key) : null) ?? topKey

  if (provider === 'anthropic') {
    if (config.llm) config.llm.provider = 'anthropic'
    if (model) config.anthropic.model = model
    return 'anthropic'
  }

  if (!config.llm) config.llm = { provider, providers: {} }
  if (!config.llm.providers) config.llm.providers = {}
  config.llm.provider = provider
  const prev = config.llm.providers[provider] ?? {}
  config.llm.providers[provider] = {
    ...prev,
    ...(provider === 'ollama' ? {} : { api_key: key }), // ollama has no key field
    ...(model ? { model } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  }
  return provider
}
