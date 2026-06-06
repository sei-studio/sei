// Anthropic adapter — thin wrapper around the existing anthropicClient.js so
// orchestrator imports flow through the provider factory instead of binding
// directly to the SDK. Preserves cloud-proxy mode + setAuthToken rotation
// hook + cache_control prompt-cache marker.

import { createAnthropicClient } from '../anthropicClient.js'

const CAPABILITIES = { vision: true, cached: true, local: false }

export function createAnthropicProvider(config) {
  const client = createAnthropicClient(config)
  return {
    call: client.call,
    buildCachedSystem: client.buildCachedSystem,
    setAuthToken: client.setAuthToken,
    // WR-05 follow-up: live cloud↔local routing swap. Only the Anthropic
    // provider implements this — other providers (OpenAI-compat, Gemini,
    // Ollama) have no cloud-proxy concept, so the orchestrator calls it with
    // optional chaining and they no-op.
    setBackend: client.setBackend,
    get model() { return client.model },
    capabilities: CAPABILITIES,
    kind: 'anthropic',
  }
}
