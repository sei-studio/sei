// 261008: request rules for the Haiku 5 family, applied at every place the
// app builds an Anthropic Messages request (the bot's anthropicClient.call,
// main's llm/anthropic.ts provider, the BYOK key test, the dev-only direct
// clients). Main imports this file directly (plain ESM, no Electron), so the
// rules live in one place for both processes.
//
// Why each rule exists (measured in docs/haiku55-game-sim-2026-10-08.md and
// scripts/remember-eval.ts):
//   - Haiku 5 turns adaptive thinking ON when a request has no `thinking`
//     field (Haiku 4.5 never thought unless asked). Every companion surface
//     sizes max_tokens for a spoken line (160-1024), and with thinking on 5.5
//     spent that budget thinking: empty Backseat turns, chess move turns with
//     no play(), chat and voice turns cut off at max_tokens, and TTFT went
//     from about 0.5s to 1.2-2.3s. So thinking is disabled unless the caller
//     asked for adaptive thinking explicitly.
//   - A fixed budget (`{type:'enabled', budget_tokens}`) returns HTTP 400 on
//     Haiku 5. The only sender is the bot's dev knob
//     anthropic.thinking_budget_tokens (default 0, off); a fixed budget is
//     turned into thinking disabled, so the companion stays thinking-off on
//     every path.
//   - `temperature`, `top_p` and `top_k` return HTTP 400 on Haiku 5. Nothing
//     on a Haiku path sends them today; they are removed so one never can.
//   - An assistant message at the end of `messages` (prefill) returns HTTP
//     400 on Haiku 5. Nothing sends one today; a trailing assistant turn is
//     removed so a future caller degrades to an unprefilled turn instead of a
//     failed one.
//
// Other models (Haiku 4.5, Sonnet, non-Anthropic) are returned untouched.

/** True for any Haiku 5.x id, alias or dated snapshot ("claude-haiku-5-5", "claude-haiku-5-5-20260930"). */
export function isHaiku5Model(model) {
  return typeof model === 'string' && /^claude-haiku-5(?:[-.]|$)/.test(model)
}

const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k']

/**
 * Apply the Haiku 5 request rules to a Messages API request body. MUTATES
 * and returns `req` (callers build a fresh object per call). Returns the same
 * object for every other model, unchanged.
 *
 * @param {Record<string, any>} req  a Messages API body (model, messages, thinking, ...)
 * @returns {Record<string, any>}
 */
export function applyAnthropicModelDefaults(req) {
  if (!req || !isHaiku5Model(req.model)) return req
  const t = req.thinking
  if (t === undefined || t === null || (typeof t === 'object' && t.type === 'enabled')) {
    req.thinking = { type: 'disabled' }
  }
  for (const k of SAMPLING_PARAMS) {
    if (k in req) delete req[k]
  }
  if (Array.isArray(req.messages) && req.messages.length > 1) {
    while (req.messages.length > 1 && req.messages[req.messages.length - 1]?.role === 'assistant') {
      req.messages = req.messages.slice(0, -1)
    }
  }
  return req
}
