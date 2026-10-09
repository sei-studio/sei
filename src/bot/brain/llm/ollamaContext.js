// Ollama context window (num_ctx) sizing for the bot (261010). MIRRORS
// src/main/llm/ollamaContext.ts (this process cannot import main's TS;
// src/bot/llmCatalogSync.test.js pins the two together). The header there has
// the measurements; in short: Ollama runs a 4096-token window by default on
// GPUs under 24 GiB and silently drops the FRONT of a longer prompt, and the
// Minecraft system prompt alone is about 12,000 tokens, so the model played
// with no persona, rules or tool definitions in view.

export const OLLAMA_CTX_MIN = 8192
export const OLLAMA_CTX_MAX = 32768
const CTX_STEP = 4096
const CTX_MARGIN = 512
export const OLLAMA_IMAGE_TOKENS = 1600
const PS_TIMEOUT_MS = 800

/** Rough, high-side token count for an /api/chat request (see the TS mirror). */
export function estimateOllamaPromptTokens(req) {
  let ascii = 0
  let other = 0
  let images = 0
  const count = (s) => {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++
      else other++
    }
  }
  for (const m of req?.messages ?? []) {
    if (Array.isArray(m?.images)) images += m.images.length
    const { images: _drop, ...rest } = m ?? {}
    count(JSON.stringify(rest))
  }
  if (req?.tools?.length) count(JSON.stringify(req.tools))
  return Math.ceil(ascii / 3.5) + other + images * OLLAMA_IMAGE_TOKENS
}

export function neededNumCtx(promptTokens, maxTokens) {
  const need = promptTokens + (maxTokens ?? 1024) + CTX_MARGIN
  const rounded = Math.ceil(need / CTX_STEP) * CTX_STEP
  return Math.min(OLLAMA_CTX_MAX, Math.max(OLLAMA_CTX_MIN, rounded))
}

const asked = new Map()

/** Test hook. */
export function clearOllamaContextState() {
  asked.clear()
}

function withLatestTag(name) {
  const n = String(name || '').trim().toLowerCase()
  return n.lastIndexOf(':') > n.lastIndexOf('/') ? n : `${n}:latest`
}

/** Context the model is loaded with now (GET /api/ps), or null. Never throws. */
export async function loadedContextLength(baseURL, model, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PS_TIMEOUT_MS)
  timer.unref?.()
  try {
    const resp = await fetchImpl(`${baseURL}/api/ps`, { method: 'GET', signal: controller.signal })
    if (!resp?.ok) return null
    const data = await resp.json()
    const want = withLatestTag(model)
    const hit = (data?.models ?? []).find((m) => withLatestTag(m?.model ?? m?.name ?? '') === want)
    const n = Number(hit?.context_length)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** num_ctx for one request: sized, sticky per model, reusing a big-enough loaded context. */
export async function chooseOllamaNumCtx({ baseURL, model, promptTokens, maxTokens, fetchImpl }) {
  const key = `${baseURL}|${model}`
  const target = Math.max(neededNumCtx(promptTokens, maxTokens), asked.get(key) ?? 0)
  const loaded = await loadedContextLength(baseURL, model, fetchImpl)
  const numCtx = loaded != null && loaded >= target ? loaded : target
  asked.set(key, Math.max(asked.get(key) ?? 0, Math.min(numCtx, OLLAMA_CTX_MAX)))
  return numCtx
}
