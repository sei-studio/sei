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
import { requestDeadline, timeoutOr } from './timeout';
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
/**
 * Local floor (260915). The chat surfaces pass CHAT_TIMEOUT_MS (30s), sized for
 * a cloud API. A local model on a machine without a usable GPU evaluates a
 * multi-thousand-token Sei prompt at tens of tokens per second, so the first
 * turn (cold load + full prompt eval) routinely takes longer than that while
 * the 1-token settings connection test still answers in seconds: the reply
 * was aborted mid-generation and the companion just stopped "typing". The
 * caller's abort signal (a newer send superseding this turn) still cuts a
 * long generation short, so a longer ceiling costs nothing interactively.
 * Exported for testing.
 */
export const LOCAL_TIMEOUT_FLOOR_MS = 120_000;
export function effectiveTimeoutMs(requested: number | undefined): number {
  return Math.max(requested ?? DEFAULT_TIMEOUT_MS, LOCAL_TIMEOUT_FLOOR_MS);
}
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
      // Thinking OFF (260915). Ollama turns thinking ON by default for every
      // model that supports it (qwen3, deepseek-r1, gemma4, ...) and the
      // reasoning is charged against num_predict. The chat surfaces run
      // 200-token turns, so the model spent the budget in message.thinking and
      // handed back an EMPTY content, which every turn runner reads as
      // "nothing to say": the live report (Discord, 260915) was qwen3 behind
      // Ollama "typing... then radio silence" on text AND calls, while the
      // settings connection test (1 token) passed. Measured on qwen3:1.7b with
      // a Sei-shaped prompt: thinking took 100-170 of the 200 tokens and 5x the
      // latency (on a CPU-only box that alone crosses CHAT_TIMEOUT_MS); with
      // think:false the same turn is 15-50 tokens. Ollama accepts `think` on
      // models without the capability too (verified on qwen2.5 and qwen3-vl
      // instruct), so it is sent unconditionally.
      think: false,
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
    const timeoutMs = effectiveTimeoutMs(p.timeoutMs);
    const deadline = requestDeadline(controller, timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw timeoutOr(err, deadline, p.signal, 'ollama', timeoutMs);
    } finally {
      deadline.clear();
      if (p.signal) p.signal.removeEventListener('abort', onParentAbort);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`ollama API ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = (await resp.json()) as {
      message?: { content?: unknown; thinking?: unknown; tool_calls?: Array<Record<string, unknown>> };
      done_reason?: string | null;
    };
    const msg = data?.message ?? {};
    let text = typeof msg.content === 'string' ? msg.content : '';
    // Diagnostic for the failure mode `think: false` exists to prevent: if a
    // model still reasons and the reply came back empty, say so in the log
    // instead of letting the turn vanish as a silent "no reply".
    if (!text.trim() && typeof msg.thinking === 'string' && msg.thinking.trim()) {
      console.warn(
        `[sei] ollama ${model}: empty reply with ${msg.thinking.length} chars of thinking ` +
          `(done_reason=${data?.done_reason ?? '?'}); the token budget went to reasoning`,
      );
    }
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
