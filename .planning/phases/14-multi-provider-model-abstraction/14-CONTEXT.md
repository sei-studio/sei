# Phase 14: Multi-Provider Model Abstraction - Context

**Gathered:** 2026-05-26
**Status:** Ready for planning
**Mode:** Auto-generated (user directive: "Do not ask any questions, add API support for other providers, as many as possible. Straightforward. Minimal")

<domain>
## Phase Boundary

Replace the hard-coded Anthropic call site in `src/bot/brain/orchestrator.js` with a provider-agnostic `LlmProvider` interface (`call`, `buildCachedSystem`, `setAuthToken`, `model`, `capabilities`). Ship adapters for as many providers as cleanly fit the same interface. Existing Anthropic + cloud-proxy path is preserved verbatim — anyone with an existing config keeps the current behavior.

User scope clamp ("straightforward, minimal") narrows the full ROADMAP phase 14 in three ways:

1. **No onboarding UI rework.** The list-vs-grid picker (success criterion 2) is deferred — `ProviderTiles.tsx` exists in the renderer but is not on the critical path for the bot loop. Multi-provider can ship without UI changes; the picker can be retrofitted in a follow-up.
2. **No CI $/hr benchmarks.** Per-provider golden tests at the unit level are skipped.
3. **No Zod re-validation of tool-call responses at adapter boundary.** Each adapter does best-effort JSON parsing of tool arguments. If a provider returns malformed JSON, the adapter throws, the loop's existing error handling logs and continues. Full Zod gate is a follow-up.

What IS in scope (still required for "the bot can complete a tool-use turn end-to-end against any provider"):

- `LlmProvider` interface with the same `call(...)` shape the orchestrator already consumes.
- Anthropic adapter (wraps existing `anthropicClient.js`).
- OpenAI-compatible adapter covering: OpenAI, Grok (x.ai), OpenRouter, DeepSeek, Mistral, Together, Groq, Fireworks (8 providers via one shared adapter; each gets its own baseURL).
- Gemini adapter (Google's native REST API).
- Ollama adapter (uses `/api/chat` NOT `/v1/chat/completions` per ROADMAP Pitfall 7).
- Factory `createLlmProvider(config)` that selects the right adapter from `config.llm.provider`.
- Config schema accepts new `llm.provider` + `llm.providers.<name>` blocks; defaults to `anthropic` so existing configs boot unchanged.
- Orchestrator + memory compactor + personaExpansion swap the `createAnthropicClient` import for `createLlmProvider`.

</domain>

<decisions>
## Implementation Decisions

### Locked

1. **Anthropic remains the default.** No config-file migration required — missing `llm.provider` defaults to `anthropic`.
2. **One OpenAI-compatible adapter, many providers.** OpenAI, Grok, OpenRouter, DeepSeek, Mistral, Together, Groq, Fireworks all share `/v1/chat/completions` with provider-specific `baseURL` + `apiKey`. Single code path, ~10 lines of routing.
3. **Ollama uses `/api/chat`.** Per Pitfall 7, the OpenAI-compat endpoint (`/v1/chat/completions`) silently drops tool calls under streaming. Ollama adapter is its own path.
4. **Non-Anthropic providers return `content: undefined`.** The orchestrator's `buildAssistantContent(resp)` already falls back to synthesizing from `text` + `toolUses` when `content` is empty. Thinking-block preservation is Anthropic-specific; other providers don't have it.
5. **Tool ID generation.** OpenAI/Gemini return their own IDs; for providers that don't (rare), the adapter synthesizes `toolu_${crypto.randomUUID()}` so the loop's tool_use_id pairing keeps working.
6. **Capabilities are a static descriptor per provider.** `{ vision: bool, cached: bool, local: bool }`. Used by Phase 15's `visualize` registration. Not exposed in UI in this phase.
7. **No streaming.** All adapters use non-streaming responses to match the existing call shape. Streaming can be retrofitted per provider later.
8. **`setAuthToken` is a no-op outside Anthropic cloudMode.** The other providers do not have a JWT rotation pump; their auth lives in static config.

### Claude's Discretion

- Per-provider prompt caching: Anthropic keeps `cache_control: ephemeral` on the last tool block (existing). OpenAI has auto-cached prefix (no client work). Gemini implicit caching (no client work). Others: not configured (sticky routing on OpenRouter is a fluff knob).
- Error mapping: each adapter throws a generic `Error(message)` with provider name embedded; orchestrator's catch arms see Errors uniformly.
- Logging: existing `logHaikuQuery`/`logHaikuResponse` keep firing — Anthropic adapter calls them; others call the same helpers (or no-op equivalents) so log shape stays uniform.

</decisions>

<code_context>
## Existing Code Insights

- `src/bot/brain/anthropicClient.js`: current call site, returns `{ toolUses, text, content, usage, stopReason }`. Stays. Wrapped by `anthropicProvider.js`.
- `src/bot/brain/orchestrator.js:274` instantiates via `createAnthropicClient(config)`. Replace with `createLlmProvider(config)`. `_anthropicOverride` test seam preserved (rename internal var, keep parameter name for back-compat).
- `src/bot/brain/orchestrator.js:386` calls `anthropic.buildCachedSystem(...)`. Must be on the provider interface.
- `src/bot/brain/memory/compactor.js`: takes the Anthropic client directly. Receives the provider instead — same `call(...)` shape works.
- `src/main/personaExpansion.ts`: also makes Haiku calls (cloud-proxy mode mirrors anthropicClient). Out of scope for this phase — that path stays Anthropic-only because the proxy is Anthropic-only.
- `src/bot/config.js`: extend `llm` schema with `provider` enum + per-provider config blocks.

</code_context>

<specifics>
## Specific Ideas

- File layout: new `src/bot/brain/llm/` directory.
  - `index.js` — `createLlmProvider(config, deps)` factory.
  - `anthropicProvider.js` — wraps `../anthropicClient.js`.
  - `openaiCompatProvider.js` — OpenAI, Grok, OpenRouter, DeepSeek, Mistral, Together, Groq, Fireworks.
  - `geminiProvider.js` — Google Gemini REST.
  - `ollamaProvider.js` — local `/api/chat`.
  - `messageMappers.js` — anthropic-shape ↔ openai-shape ↔ gemini-shape translation.
- Provider IDs: `anthropic`, `openai`, `gemini`, `grok`, `openrouter`, `ollama`, `deepseek`, `mistral`, `together`, `groq`, `fireworks` (11 total).

</specifics>

<deferred>
## Deferred Ideas

- Onboarding list-vs-grid picker UI.
- Per-provider prompt-caching observability (cache-hit-rate logs).
- $/hr CI benchmarks (golden tests per provider).
- Zod re-validation of tool-call response at adapter boundary.
- Stream-mode call surface.
- JWT rotation for cloud-routed non-Anthropic providers (not needed; the proxy is Anthropic-only).
- Capability chips in onboarding UI.

</deferred>
