/**
 * Google Gemini adapter — v1beta generateContent REST, key in the query
 * string, non-streaming v1 (an onTextDelta sink gets the whole text once the
 * response lands; voice sentences arriving at hop end is the accepted
 * degradation). Schema sanitize + tool_result idToName reconstruction live in
 * messageMappers. Forced tool_choice maps to function_calling_config mode ANY.
 */
import type { ProviderKind } from '../../shared/llmCatalog';
import { modelVision } from '../../shared/llmCatalog';
import type { LlmCallParams, LlmProvider, LlmResult } from './types';
import {
  anthropicToGeminiContents,
  anthropicToolsToGeminiTools,
  flattenSystem,
  geminiPartsToResult,
  normalizeGeminiStopReason,
  normalizeGeminiUsage,
  parseToolJsonFallback,
  synthesizeContent,
} from './messageMappers';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 30_000;
const KIND: ProviderKind = 'gemini';

export function createGeminiProvider(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const { apiKey, model } = opts;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function call(p: LlmCallParams): Promise<LlmResult> {
    const systemText = flattenSystem(p.system);
    const body: Record<string, unknown> = {
      contents: anthropicToGeminiContents(p.messages),
      generationConfig: {
        maxOutputTokens: p.maxTokens,
        ...(p.stopSequences?.length ? { stopSequences: p.stopSequences } : {}),
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    const tools = anthropicToolsToGeminiTools(p.tools);
    if (tools) body.tools = tools;
    if (p.toolChoice) {
      body.tool_config = {
        function_calling_config: { mode: 'ANY', allowed_function_names: [p.toolChoice.name] },
      };
    }

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (p.signal) {
      if (p.signal.aborted) controller.abort();
      else p.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetchImpl(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
      if (p.signal) p.signal.removeEventListener('abort', onParentAbort);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`gemini API ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      candidates?: Array<{ finishReason?: string | null }>;
      usageMetadata?: unknown;
    };
    let { text, toolUses } = geminiPartsToResult(data);
    if (p.toolChoice && toolUses.length === 0 && text) {
      const input = parseToolJsonFallback(text);
      if (input) {
        toolUses = [{ id: `toolu_fallback_${Date.now()}`, name: p.toolChoice.name, input }];
        text = '';
      }
    }
    const trimmed = text.trim();
    if (p.onTextDelta && trimmed) await p.onTextDelta(trimmed);
    return {
      content: synthesizeContent(trimmed, toolUses),
      toolUses,
      text: trimmed,
      usage: normalizeGeminiUsage(data?.usageMetadata),
      stopReason:
        toolUses.length > 0
          ? 'tool_use'
          : normalizeGeminiStopReason(data?.candidates?.[0]?.finishReason),
    };
  }

  return {
    call,
    backend: 'local',
    kind: KIND,
    model,
    vision: modelVision(KIND, model),
    streaming: false,
  };
}
