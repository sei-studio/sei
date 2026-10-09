/**
 * Ollama vision capability, asked of Ollama itself (261010).
 *
 * POST {base}/api/show {model} answers `capabilities: ["completion",
 * "vision", "tools", "thinking", ...]` for the exact model the user pulled,
 * which no name heuristic can match: users pick arbitrary tags (qwen2.5vl:3b,
 * gemma3:4b, hf.co/... GGUFs with or without a projector). When the probe
 * cannot answer (Ollama not running, a build that predates `capabilities`),
 * this falls back to the catalog's name heuristic.
 *
 * Successful answers are cached briefly per base+model, so the capability
 * push, the list, and a session-start gate in quick succession cost one
 * request. Failures are never cached: the user may start Ollama a moment
 * later.
 */
import { modelVision, type VisionVerdict } from '../../shared/llmCatalog';

const SHOW_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { verdict: VisionVerdict; at: number }>();

/** Test hook. */
export function clearOllamaVisionCache(): void {
  cache.clear();
}

/**
 * Ollama's own verdict, or null when it could not say (unreachable, error
 * status, no `capabilities` field).
 */
export async function probeOllamaVision(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<VisionVerdict | null> {
  const key = `${baseUrl}|${model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHOW_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { capabilities?: unknown };
    if (!Array.isArray(data?.capabilities)) return null;
    const verdict: VisionVerdict = data.capabilities.includes('vision') ? 'yes' : 'no';
    cache.set(key, { verdict, at: Date.now() });
    return verdict;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama's verdict when it can give one, else the name heuristic. Never throws. */
export async function ollamaModelVision(
  baseUrl: string,
  model: string,
  fetchImpl?: typeof fetch,
): Promise<VisionVerdict> {
  return (await probeOllamaVision(baseUrl, model, fetchImpl)) ?? modelVision('ollama', model);
}
