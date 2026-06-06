# 14-01 — Summary

**Plan:** [14-01-PLAN.md](./14-01-PLAN.md)
**Status:** Complete
**Date:** 2026-05-26

## What Shipped

A provider-agnostic `LlmProvider` interface and **13 provider adapters** routed through one factory. The orchestrator's call site (`src/bot/brain/orchestrator.js:274`) no longer binds to the Anthropic SDK; it asks `createLlmProvider(config)` for whichever adapter `config.llm.provider` selects.

### Providers shipped

| Provider     | Adapter                          | Capabilities           |
|--------------|----------------------------------|------------------------|
| `anthropic`  | `anthropicProvider.js`           | vision, cached         |
| `openai`     | `openaiCompatProvider.js` (kind) | vision, cached         |
| `gemini`     | `geminiProvider.js`              | vision, cached         |
| `grok`       | `openaiCompatProvider.js` (kind) | vision                 |
| `openrouter` | `openaiCompatProvider.js` (kind) | vision, cached         |
| `deepseek`   | `openaiCompatProvider.js` (kind) | —                      |
| `mistral`    | `openaiCompatProvider.js` (kind) | vision                 |
| `together`   | `openaiCompatProvider.js` (kind) | vision                 |
| `groq`       | `openaiCompatProvider.js` (kind) | —                      |
| `fireworks`  | `openaiCompatProvider.js` (kind) | vision                 |
| `cerebras`   | `openaiCompatProvider.js` (kind) | —                      |
| `perplexity` | `openaiCompatProvider.js` (kind) | —                      |
| `ollama`     | `ollamaProvider.js`              | local                  |

13 providers via 4 adapter files. The 10 OpenAI-compatible providers share one code path with provider-specific `baseURL` + bearer auth (DRY).

## Files

### New
- `src/bot/brain/llm/index.js` — factory + `SUPPORTED_PROVIDERS` list
- `src/bot/brain/llm/anthropicProvider.js`
- `src/bot/brain/llm/openaiCompatProvider.js`
- `src/bot/brain/llm/geminiProvider.js`
- `src/bot/brain/llm/ollamaProvider.js`
- `src/bot/brain/llm/messageMappers.js`
- `src/bot/brain/llm/index.test.js`
- `src/bot/brain/llm/messageMappers.test.js`

### Modified
- `src/bot/brain/orchestrator.js` — swapped `createAnthropicClient` import for `createLlmProvider`. `_anthropicOverride` test seam preserved (DI for verify harness).
- `src/bot/config.js` — extended `llm` schema with `provider` enum (13 values, default `anthropic`) + per-provider `providers.<name>` config blocks.

## Key Design Choices

1. **Default = `anthropic`.** Existing `config.json` files predating this phase boot unchanged; no migration step needed.
2. **One OpenAI-compat adapter, ten providers.** OpenAI/Grok/OpenRouter/DeepSeek/Mistral/Together/Groq/Fireworks/Cerebras/Perplexity share `/v1/chat/completions` with provider-specific bearer auth + baseURL. Single code path; baseURL routed in the factory.
3. **Ollama uses `/api/chat`, NOT `/v1/chat/completions`.** Per ROADMAP Pitfall 7 — Ollama's OpenAI-compat endpoint silently drops `tool_calls` under streaming. Native endpoint is reliable with `stream: false`.
4. **Non-Anthropic providers return `content: undefined`.** Orchestrator's `buildAssistantContent(resp)` already falls back to synthesizing from `text` + `toolUses` when `content` is missing. Anthropic's thinking-block preservation stays Anthropic-specific.
5. **Tool ID synthesis for providers without IDs.** Gemini, and Ollama for older versions, do not always return tool-call IDs — adapter synthesizes `toolu_${crypto.randomUUID()}` so the orchestrator's tool_use_id pairing keeps working.
6. **Gemini schema sanitization.** `additionalProperties` and `$schema` are stripped from input_schema before forwarding to Gemini (Gemini's parameters subset doesn't accept them).
7. **Per-adapter timeout via `AbortController`.** Each `fetch` call has its own controller; parent abort + per-call timeout both feed the same controller.
8. **`setAuthToken` is a no-op outside Anthropic cloud-proxy mode.** Only Anthropic's `cloudMode` has the JWT rotation pump; everywhere else, auth is static.

## What's NOT in This Phase

Per CONTEXT clamp ("minimal, straightforward, no questions"):
- No onboarding UI rework (list-vs-grid picker stays a follow-up).
- No CI golden tests / $/hr benchmarks.
- No Zod re-validation of tool-call response at adapter boundary.
- No per-provider prompt-caching observability (cache-hit-rate logs).
- No streaming.

These are tracked in the phase 14 CONTEXT.md `<deferred>` block.

## Verification

- `npx vitest run src/bot/brain/llm/` — **32/32 pass** (2 test files).
- `npx vitest run` (full project) — **427/427 pass**; 3 pre-existing Deno-only files fail to load under vitest (unrelated, jsr imports).
- `npx tsc --noEmit` — clean.
- `grep "from './anthropicClient.js'" src/bot/brain/orchestrator.js` — **0 hits** (orchestrator no longer imports the Anthropic SDK directly).
- Default config (no `llm.provider`) → factory returns Anthropic adapter; existing cloud-proxy + BYOK paths untouched.

## Caller Migration

Existing callers that constructed an Anthropic client by hand (memory compactor) keep working — the LlmProvider interface is a strict superset of the previous `{ call, buildCachedSystem, model, setAuthToken }` shape. No call-site changes needed.

To switch providers, a user edits `config.json`:

```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": { "api_key": "sk-...", "model": "gpt-4o-mini" }
    }
  }
}
```

…and the bot loop runs against OpenAI. Same shape for the other 12 providers.

## Done

PROV-01, PROV-02 (no-UI variant), PROV-07 (capabilities descriptor) — implementation complete. PROV-03/04 (caching tuning + Zod re-validation) deferred per scope clamp.
