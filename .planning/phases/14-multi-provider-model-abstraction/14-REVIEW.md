---
phase: 14-multi-provider-model-abstraction
reviewed: 2026-05-26T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src/bot/brain/llm/index.js
  - src/bot/brain/llm/anthropicProvider.js
  - src/bot/brain/llm/openaiCompatProvider.js
  - src/bot/brain/llm/geminiProvider.js
  - src/bot/brain/llm/ollamaProvider.js
  - src/bot/brain/llm/messageMappers.js
  - src/bot/brain/orchestrator.js
  - src/bot/config.js
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: findings
---

# Phase 14: Code Review Report

**Status:** issues_found
**Depth:** standard

## Summary

Provider abstraction is structurally sound: factory routes correctly, adapters share the agreed `{toolUses, text, content, usage, stopReason}` shape, abort/timeout plumbing is consistent, and `_anthropicOverride` test seam is preserved. No security issues (API keys are not logged; bearer auth used over TLS; Gemini key in query string is the documented Google pattern). The Ollama `/api/chat` decision is honored. Several correctness bugs and minor quality issues below.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: SUPPORTED_PROVIDERS order mismatch breaks factory comparison

**File:** `src/bot/brain/llm/index.js:33-38`
**Issue:** `SUPPORTED_PROVIDERS` is correct in count, but the Zod enum at `src/bot/config.js:90-94` lists 13 providers. The exported list is only used for the error message in `createLlmProvider`, so this is cosmetic — but `cerebras` and `perplexity` are listed in `OPENAI_COMPAT` and in the config enum, while the planning doc (`14-CONTEXT.md`) and `index.js` docstring still say "8 providers via one shared adapter." Discrepancy between code (10 OpenAI-compat) and docs (8). Not a bug, but the inline comment on line 18 is stale.
**Fix:** Update the comment on `index.js:18` to "10 providers share..." or trim cerebras/perplexity if they were not intended for this phase.

### WR-02: Gemini `tool_result` loses function name across multi-turn loops

**File:** `src/bot/brain/llm/messageMappers.js:141-156`
**Issue:** Anthropic `tool_result` blocks only carry `tool_use_id` (no `tool_use_name`). The Gemini `functionResponse` payload requires `name` to match a previously emitted `functionCall.name`. The fallback chain `blk.tool_use_name ?? blk.tool_use_id ?? 'tool'` will substitute the **tool_use_id** (e.g. `toolu_<uuid>`) for the function name, which does not match any prior `functionCall.name`. Gemini may 400 on tool-use turns ≥2, or silently drop the result. Comment claims "Gemini's protocol doesn't enforce a name match" — this is not reliably true across Gemini model versions.
**Fix:** Either (a) maintain a `Map<tool_use_id, function_name>` while walking `messages` (the prior assistant turn's `tool_use` blocks have both `id` and `name`), and rewrite the `functionResponse.name` using that map; or (b) document the limitation explicitly and ship a follow-up to track id→name mapping. Option (a) is ~6 lines and self-contained.

### WR-03: OpenAI assistant `content` becomes `null` when only text is present

**File:** `src/bot/brain/llm/messageMappers.js:64`
**Issue:** `const m = { role: 'assistant', content: textParts.join('') || null }`. When `textParts` is empty AND there are no `tool_calls`, the assistant message has `content: null` and no `tool_calls`. OpenAI rejects such messages (`content` must be a string or `tool_calls` must be present). This happens if the orchestrator ever appends an assistant turn that only contained `thinking` blocks (Anthropic-only, dropped during translation). Less likely in practice because thinking is off by default, but configurable via `anthropic.thinking_budget_tokens` and the assistant content array round-trips through this mapper on multi-iteration turns.
**Fix:** Coerce to empty string instead of null, or skip the assistant message entirely when both `textParts` and `toolCalls` are empty.

### WR-04: `sanitizeForGemini` strips fields needed by recent Gemini API

**File:** `src/bot/brain/llm/messageMappers.js:109-118`
**Issue:** The sanitizer unconditionally strips `$schema` and `additionalProperties` from every nested object. Recent Gemini (`v1beta`) accepts a subset of JSON Schema including `enum`, `items`, `required`, `nullable`. The current sanitizer keeps those, which is fine. However it also passes through fields Gemini explicitly rejects, e.g. `format` for non-string types, `default`, `oneOf/anyOf/allOf` for some endpoints. If any tool schema uses `default` (which Zod often emits via `schemaBridge.js`), Gemini will 400 with `Invalid JSON payload received. Unknown name "default"`. Worth confirming by inspecting one tool's `input_schema`.
**Fix:** Either expand the strip list to include common Zod-emitted fields (`default`, `examples`, `$ref`), or add an allow-list approach (keep only `type`, `properties`, `items`, `required`, `enum`, `description`, `nullable`).

## Info

### IN-01: Provider config defaults are loose for local providers

**File:** `src/bot/config.js:109`
**Issue:** `ollama` schema uses `base_url: z.string().default(...)` without `.url()` validation (correctly, since `http://localhost:11434` is valid). However, the rest use `base_url: z.string().url().optional()`. Inconsistent. Minor.
**Fix:** Acceptable as-is; consider documenting the divergence.

### IN-02: Default timeout sourced from `anthropic.timeout_ms` for all providers

**File:** `src/bot/brain/llm/openaiCompatProvider.js:52`, `geminiProvider.js:19`, `ollamaProvider.js:19`
**Issue:** Non-Anthropic adapters all read `config.anthropic?.timeout_ms ?? 20_000`. Works, but couples non-Anthropic defaults to the Anthropic config branch. A `config.llm.timeout_ms` would be the cleaner location.
**Fix:** Out of scope per "minimal." Document and defer.

### IN-03: `kind` field exposed on provider object is not in the interface contract

**File:** `src/bot/brain/llm/anthropicProvider.js:18`, others
**Issue:** `kind: 'anthropic'` is returned but the interface in `index.js:5-11` does not list it. Useful for debugging but undocumented. No bug.
**Fix:** Add `kind` to the documented interface in `index.js` header comment, or remove if not consumed.

---

_Reviewed: 2026-05-26_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
