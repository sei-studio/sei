/**
 * Ollama context window (num_ctx) sizing (261010).
 *
 * Ollama runs every model with a default context of 4096 tokens on machines
 * with under 24 GiB of VRAM (docs.ollama.com/context-length), and Sei never
 * set `num_ctx`. A prompt longer than that is NOT rejected: Ollama keeps the
 * tail and silently drops the front, which is where the system prompt (persona,
 * rules, tool definitions) lives. Measured on Ollama 0.40.2: the Minecraft
 * bot's first turn is about 12,000 tokens and Ollama evaluated 2,050 of them;
 * a canary placed at the start of the system prompt was gone while one at the
 * end survived. The model was answering with no persona and no tools in view,
 * and it got worse as the history grew ("works a short while, then craps
 * itself").
 *
 * So every request now carries a num_ctx sized to the prompt:
 *   - estimate the prompt from its characters (deliberately on the high side)
 *     plus a fixed cost per image, add the reply budget and a margin;
 *   - round up to a multiple of 4096, between OLLAMA_CTX_MIN and OLLAMA_CTX_MAX;
 *   - never go below what this process already asked for on the same model
 *     (a changed num_ctx makes Ollama reload the model, so it must not bounce
 *     between sizes turn to turn);
 *   - if Ollama already holds the model loaded with a context at least that
 *     big (the user's own OLLAMA_CONTEXT_LENGTH or app slider, or another Sei
 *     surface), reuse that exact size so nothing reloads.
 *
 * OLLAMA_CTX_MAX keeps the KV cache of a 4-8B model inside a 12 GB GPU next to
 * its weights; past it Ollama trims the oldest messages, which is the right
 * thing to lose. The bot carries a mirror (src/bot/brain/llm/ollamaContext.js,
 * pinned by src/bot/llmCatalogSync.test.js).
 */

export const OLLAMA_CTX_MIN = 8192;
export const OLLAMA_CTX_MAX = 32768;
const CTX_STEP = 4096;
/** Reply budget headroom on top of num_predict, plus the chat template's own tokens. */
const CTX_MARGIN = 512;
/**
 * Tokens one image costs. Varies by model and resolution (gemma3 256, llava
 * 576, qwen2.5vl about 1,000-1,300 for a 1280x720 frame), so this is the high
 * end.
 */
export const OLLAMA_IMAGE_TOKENS = 1600;
const PS_TIMEOUT_MS = 800;

/**
 * Rough token count for an Ollama /api/chat request: ASCII at 3.5 characters a
 * token (measured 4.5 on the Minecraft prompt, so this over-counts by about a
 * quarter), anything else at one token a character (CJK), images at
 * OLLAMA_IMAGE_TOKENS. Image payloads are not counted as text.
 */
export function estimateOllamaPromptTokens(req: { messages?: unknown[]; tools?: unknown[] }): number {
  let ascii = 0;
  let other = 0;
  let images = 0;
  const count = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++;
      else other++;
    }
  };
  for (const m of req.messages ?? []) {
    const msg = m as { images?: unknown[] } & Record<string, unknown>;
    if (Array.isArray(msg.images)) images += msg.images.length;
    const { images: _drop, ...rest } = msg;
    count(JSON.stringify(rest));
  }
  if (req.tools?.length) count(JSON.stringify(req.tools));
  return Math.ceil(ascii / 3.5) + other + images * OLLAMA_IMAGE_TOKENS;
}

/** The context size this request needs, rounded and clamped (before stickiness). */
export function neededNumCtx(promptTokens: number, maxTokens: number | undefined): number {
  const need = promptTokens + (maxTokens ?? 1024) + CTX_MARGIN;
  const rounded = Math.ceil(need / CTX_STEP) * CTX_STEP;
  return Math.min(OLLAMA_CTX_MAX, Math.max(OLLAMA_CTX_MIN, rounded));
}

/** Largest num_ctx this process has asked for, per base|model. */
const asked = new Map<string, number>();

/** Test hook. */
export function clearOllamaContextState(): void {
  asked.clear();
}

/**
 * The context the model is loaded with right now (GET /api/ps), or null when
 * it is not loaded, Ollama is too old to say, or the call fails. Never throws.
 */
export async function loadedContextLength(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PS_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${baseUrl}/api/ps`, { method: 'GET', signal: controller.signal });
    if (!resp?.ok) return null;
    const data = (await resp.json()) as { models?: Array<{ name?: string; model?: string; context_length?: unknown }> };
    const want = withLatestTag(model);
    const hit = (data?.models ?? []).find((m) => withLatestTag(m?.model ?? m?.name ?? '') === want);
    const n = Number(hit?.context_length);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama names `llama3.1` and `llama3.1:latest` the same model. */
function withLatestTag(name: string): string {
  const n = name.trim().toLowerCase();
  return n.lastIndexOf(':') > n.lastIndexOf('/') ? n : `${n}:latest`;
}

/**
 * num_ctx for one request. See the header for the rules. Never throws; a
 * failed /api/ps just means no reuse.
 */
export async function chooseOllamaNumCtx(opts: {
  baseUrl: string;
  model: string;
  promptTokens: number;
  maxTokens: number | undefined;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const key = `${opts.baseUrl}|${opts.model}`;
  const target = Math.max(neededNumCtx(opts.promptTokens, opts.maxTokens), asked.get(key) ?? 0);
  const loaded = await loadedContextLength(opts.baseUrl, opts.model, opts.fetchImpl);
  const numCtx = loaded != null && loaded >= target ? loaded : target;
  asked.set(key, Math.max(asked.get(key) ?? 0, Math.min(numCtx, OLLAMA_CTX_MAX)));
  return numCtx;
}
