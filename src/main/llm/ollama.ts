/**
 * Ollama local adapter — the native `/api/chat` route (NOT /v1/chat/completions:
 * Ollama's OpenAI-compat endpoint drops tool_calls under streaming, the same
 * pitfall the bot's adapter documents), stream:false. No API key. Non-streaming
 * v1: an onTextDelta sink gets the whole text at completion. Ollama has no
 * tool_choice; a forced tool rides the prompt note + JSON fallback parse.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderKind } from '../../shared/llmCatalog';
import { modelVision } from '../../shared/llmCatalog';
import type { LlmCallParams, LlmProvider, LlmResult, LlmToolUse } from './types';
import {
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAITools,
  flattenSystem,
  forcedToolPromptNote,
  normalizeOllamaStopReason,
  normalizeOllamaUsage,
  parseToolJsonFallback,
  synthesizeContent,
} from './messageMappers';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 30_000;
const KIND: ProviderKind = 'ollama';

export function createOllamaProvider(opts: {
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const { model } = opts;
  const baseUrl = opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function call(p: LlmCallParams): Promise<LlmResult> {
    let systemText = flattenSystem(p.system);
    if (p.toolChoice) systemText += forcedToolPromptNote(p.toolChoice.name);
    const body: Record<string, unknown> = {
      model,
      stream: false,
      options: {
        num_predict: p.maxTokens,
        ...(p.stopSequences?.length ? { stop: p.stopSequences } : {}),
      },
      messages: anthropicToOpenAIMessages(p.messages, systemText),
    };
    const tools = anthropicToolsToOpenAITools(p.tools);
    if (tools) body.tools = tools;

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (p.signal) {
      if (p.signal.aborted) controller.abort();
      else p.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (p.signal) p.signal.removeEventListener('abort', onParentAbort);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`ollama API ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      message?: { content?: unknown; tool_calls?: Array<Record<string, unknown>> };
      done_reason?: string | null;
    };
    const msg = data?.message ?? {};
    let text = typeof msg.content === 'string' ? msg.content : '';
    let toolUses: LlmToolUse[] = [];
    for (const call of msg.tool_calls ?? []) {
      // Ollama's arguments arrive as an OBJECT (not a JSON string like OpenAI).
      const fn = (call?.function ?? {}) as { name?: string; arguments?: unknown };
      const input =
        fn.arguments && typeof fn.arguments === 'object'
          ? (fn.arguments as Record<string, unknown>)
          : {};
      toolUses.push({ id: (call?.id as string) ?? `toolu_${randomUUID()}`, name: fn.name ?? '', input });
    }
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
      usage: normalizeOllamaUsage(data),
      stopReason: toolUses.length > 0 ? 'tool_use' : normalizeOllamaStopReason(data?.done_reason),
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
