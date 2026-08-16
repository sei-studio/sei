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
