/**
 * OpenAI-compatible adapter for the main-process LLM layer: openai, grok,
 * openrouter, deepseek, qwen (DashScope compatible mode) + the grandfathered
 * set (mistral, together, groq, fireworks, cerebras, perplexity). All speak
 * `/chat/completions` with bearer auth.
 *
 * Beyond the bot's adapter this one adds:
 *   - SSE streaming when onTextDelta is given: text deltas surface as they
 *     arrive; tool_call deltas are BUFFERED per index and parsed once complete.
 *   - stopSequences → `stop`.
 *   - forced tool_choice → {type:'function', function:{name}}, with a
 *     JSON-parse fallback when the model answers in text anyway.
 *   - DeepSeek: DEEPSEEK_EXTRA_BODY (thinking disabled — V4 thinking mode
 *     requires reasoning_content round-trips that plain OpenAI-compat clients
 *     strip) and the FIRST_TOKEN_TIMEOUT_FLOOR_MS floor (DeepSeek QUEUES under
 *     load instead of 429ing; a stalled request must never be fast-retried,
 *     and this adapter never retries anything).
 *
 * Timeout semantics: the timer is armed at max(caller timeout, per-provider
 * floor) and RE-ARMED on every received chunk while streaming, so it acts as
 * a first-token/idle timeout rather than cutting off a healthy long stream.
 */
import type { ProviderKind } from '../../shared/llmCatalog';
import { DEEPSEEK_EXTRA_BODY, FIRST_TOKEN_TIMEOUT_FLOOR_MS, modelVision } from '../../shared/llmCatalog';
import type { LlmCallParams, LlmProvider, LlmResult, LlmToolUse } from './types';
import {
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAITools,
  flattenSystem,
  forcedToolPromptNote,
  normalizeOpenAIStopReason,
  normalizeOpenAIUsage,
  openAIToolCallsToUses,
  parseToolJsonFallback,
  synthesizeContent,
  toolChoiceToOpenAI,
} from './messageMappers';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Effective wall/idle timeout for one request. Exported for tests. */
export function effectiveTimeoutMs(kind: ProviderKind, requested: number | undefined): number {
  return Math.max(requested ?? DEFAULT_TIMEOUT_MS, FIRST_TOKEN_TIMEOUT_FLOOR_MS[kind] ?? 0);
}

/** Request body for one call. Exported for tests (deepseek extra body, stop mapping). */
export function buildRequestBody(
  kind: ProviderKind,
  model: string,
  p: LlmCallParams,
  stream: boolean,
): Record<string, unknown> {
  let systemText = flattenSystem(p.system);
  // Forced tool_choice rides the request AND the prompt: the note costs
  // little and covers compat providers that accept the field but ignore it.
  if (p.toolChoice) systemText += forcedToolPromptNote(p.toolChoice.name);
  const body: Record<string, unknown> = {
    model,
    max_tokens: p.maxTokens,
    messages: anthropicToOpenAIMessages(p.messages, systemText),
  };
  const tools = anthropicToolsToOpenAITools(p.tools);
  if (tools) body.tools = tools;
  if (p.toolChoice) body.tool_choice = toolChoiceToOpenAI(p.toolChoice);
  if (p.stopSequences?.length) body.stop = p.stopSequences;
  if (stream) body.stream = true;
  if (kind === 'deepseek') Object.assign(body, DEEPSEEK_EXTRA_BODY);
  return body;
}

interface SseState {
  text: string;
  toolBuf: Map<number, { id?: string; name?: string; args: string }>;
  finishReason: string | null;
  usage: unknown;
}

/**
 * Fold one parsed SSE chunk (already JSON) into the accumulator, returning the
 * text delta (if any) so the caller can forward it. Exported for tests.
 */
export function foldSseChunk(state: SseState, chunk: unknown): string | null {
  const c = chunk as {
    choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string | null }>;
    usage?: unknown;
  };
  if (c?.usage) state.usage = c.usage;
  const choice = c?.choices?.[0];
  if (!choice) return null;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (!delta) return null;
  for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
    const index = typeof tc.index === 'number' ? tc.index : 0;
    const buf = state.toolBuf.get(index) ?? { args: '' };
    if (typeof tc.id === 'string' && tc.id) buf.id = tc.id;
    const fn = tc.function as { name?: string; arguments?: string } | undefined;
    // Names arrive whole in the first delta (arguments are the streamed part).
    if (fn?.name && !buf.name) buf.name = fn.name;
    if (typeof fn?.arguments === 'string') buf.args += fn.arguments;
    state.toolBuf.set(index, buf);
  }
  if (typeof delta.content === 'string' && delta.content) {
    state.text += delta.content;
    return delta.content;
  }
  return null;
}

/** Drain the buffered tool_call deltas into LlmToolUse[]. Exported for tests. */
export function drainSseToolCalls(state: SseState): LlmToolUse[] {
  const calls = [...state.toolBuf.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
    id: v.id,
    type: 'function',
    function: { name: v.name ?? '', arguments: v.args },
  }));
  return openAIToolCallsToUses(calls);
}

export function createOpenAICompatProvider(opts: {
  kind: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const { kind, apiKey, baseUrl, model } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function call(p: LlmCallParams): Promise<LlmResult> {
    const wantStream = typeof p.onTextDelta === 'function';
    const body = buildRequestBody(kind, model, p, wantStream);
    const timeoutMs = effectiveTimeoutMs(kind, p.timeoutMs);

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (p.signal) {
      if (p.signal.aborted) controller.abort();
      else p.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    const rearm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };

    try {
      const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`${kind} API ${resp.status}: ${text.slice(0, 500)}`);
      }

      let text: string;
      let toolUses: LlmToolUse[];
      let usage: LlmResult['usage'];
      let stopReason: string | null;

      if (wantStream && resp.body) {
        const state: SseState = { text: '', toolBuf: new Map(), finishReason: null, usage: null };
        const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rearm();
          buf += decoder.decode(value, { stream: true });
          // SSE events are newline-delimited `data: {...}` lines.
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let chunk: unknown;
            try { chunk = JSON.parse(payload); } catch { continue; }
            const delta = foldSseChunk(state, chunk);
            if (delta) await p.onTextDelta!(delta);
          }
        }
        text = state.text;
        toolUses = drainSseToolCalls(state);
        usage = normalizeOpenAIUsage(state.usage);
        stopReason = normalizeOpenAIStopReason(state.finishReason);
      } else {
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string | null }>;
          usage?: unknown;
        };
        const choice = data?.choices?.[0];
        const msg = choice?.message ?? {};
        text = typeof msg.content === 'string' ? msg.content : '';
        toolUses = openAIToolCallsToUses(msg.tool_calls);
        usage = normalizeOpenAIUsage(data?.usage);
        stopReason = normalizeOpenAIStopReason(choice?.finish_reason);
        // Non-streaming with a delta sink (should not happen here, but keep
        // the contract: the sink always sees the text).
        if (p.onTextDelta && text) await p.onTextDelta(text);
      }

      // Forced-tool fallback: the provider accepted tool_choice but answered
      // in prose anyway (or ignored the field). Parse the tool-shaped JSON
      // out of the text so the caller still gets its tool call.
      if (p.toolChoice && toolUses.length === 0 && text) {
        const input = parseToolJsonFallback(text);
        if (input) {
          toolUses = [{ id: `toolu_fallback_${Date.now()}`, name: p.toolChoice.name, input }];
          text = '';
        }
      }

      const trimmed = text.trim();
      return {
        content: synthesizeContent(trimmed, toolUses),
        toolUses,
        text: trimmed,
        usage,
        stopReason: toolUses.length > 0 && stopReason === null ? 'tool_use' : stopReason,
      };
    } finally {
      clearTimeout(timer);
      if (p.signal) p.signal.removeEventListener('abort', onParentAbort);
    }
  }

  return {
    call,
    backend: 'local',
    kind,
    model,
    vision: modelVision(kind, model),
    streaming: true,
  };
}
