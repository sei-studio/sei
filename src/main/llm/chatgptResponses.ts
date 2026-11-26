/**
 * 261017 (issue #46): the ChatGPT-plan adapter for the main-process LLM layer
 * (chat, voice one-shots, folds, compactions, chess, Draw!, backseat,
 * persona expansion). Speaks the Responses API through the wire module the
 * bot shares (src/bot/brain/llm/responsesWire.js), so both layers send the
 * exact request contract the plan route enforces.
 *
 * Per call:
 *   1. the session's latches first (usage limit / not eligible): fail fast,
 *      no request (no retry storm);
 *   2. a fresh access token from main's session (refresh is single-flight
 *      there);
 *   3. one streamed POST /v1/responses; a pre-stream 401 forces one refresh
 *      and ONE retry, never more;
 *   4. a terminal plan answer is reported to the session, which latches it
 *      and pushes the status the renderer turns into the usage-limit dialog.
 *
 * Fields the route rejects are never sent, so `maxTokens` (max_output_tokens)
 * and `stopSequences` are not on the wire. Both are enforced on OUR side,
 * inside the stream (createStreamGate): text deltas are forwarded only up to
 * the first stop sequence (a held-back tail covers a stop split across
 * deltas), so a fabricated "\nPlayer:" line is never shown or spoken, and the
 * stream is cut once the text passes a character cap derived from maxTokens.
 *
 * Timeout: an idle timer armed at `timeoutMs` and re-armed on every received
 * chunk (the Responses stream opens with response.created at once, so this is
 * a first-byte + stall timeout, not a cap on a healthy long answer).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { CHATGPT_RESPONSES_URL } from '../../shared/chatgptPlan';
import type { VisionVerdict } from '../../shared/llmCatalog';
// The shared wire format (plain JS, imported like other bot helpers).
import { buildResponsesBody, normalizeResponsesUsage, retried401Error, streamResponses } from '../../bot/brain/llm/responsesWire.js';
import type { ChatgptSession } from '../chatgptPlan/session';
import { parseToolJsonFallback, synthesizeContent } from './messageMappers';
import { requestDeadline, timeoutOr } from './timeout';
import type { LlmCallParams, LlmProvider, LlmResult, LlmToolUse } from './types';

const DEFAULT_TIMEOUT_MS = 45_000;

/** Cut text at the first stop sequence (the route has no `stop` field). */
export function applyStopSequences(text: string, stops: readonly string[] | undefined): { text: string; stopped: boolean } {
  if (!stops?.length) return { text, stopped: false };
  let cut = -1;
  for (const s of stops) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut < 0 ? { text, stopped: false } : { text: text.slice(0, cut), stopped: true };
}

/** Rough chars-per-token for the client-side length cap (English-ish text). */
export const CHARS_PER_TOKEN = 4;

/** The text cap mirroring `maxTokens` (the route has no max_output_tokens). */
export function charCapFor(maxTokens: number | undefined): number {
  return typeof maxTokens === 'number' && maxTokens > 0 ? Math.max(4, Math.ceil(maxTokens * CHARS_PER_TOKEN)) : Infinity;
}

/**
 * Streaming gate for stop sequences and the length cap. `push` takes each
 * text delta; text is forwarded only once it cannot be the start of a stop
 * sequence, and never past the first stop or the cap. On a cut, `onCut`
 * fires once (the caller aborts the stream) and later deltas are ignored.
 * `flush` forwards the held-back tail when the stream ended without a cut.
 */
export function createStreamGate(opts: {
  stops?: readonly string[];
  maxChars: number;
  forward?: (d: string) => unknown;
  onCut: () => void;
}): {
  push: (d: string) => Promise<void>;
  flush: () => Promise<void>;
  readonly text: string;
  readonly cut: null | 'stop' | 'length';
} {
  const stops = (opts.stops ?? []).filter((x) => !!x);
  const holdBack = stops.reduce((m, x) => Math.max(m, x.length - 1), 0);
  let text = '';
  let forwarded = 0;
  let cut: null | 'stop' | 'length' = null;
  const send = async (upTo: number): Promise<void> => {
    if (upTo <= forwarded) return;
    const piece = text.slice(forwarded, upTo);
    forwarded = upTo;
    if (opts.forward) await opts.forward(piece);
  };
  const finish = async (kind: 'stop' | 'length', at: number): Promise<void> => {
    cut = kind;
    text = text.slice(0, at);
    await send(text.length);
    opts.onCut();
  };
  return {
    async push(d: string) {
      if (cut) return;
      text += d;
      const s = applyStopSequences(text, stops);
      if (s.stopped) return finish('stop', s.text.length);
      if (text.length >= opts.maxChars) return finish('length', opts.maxChars);
      await send(text.length - holdBack);
    },
    async flush() {
      if (!cut) await send(text.length);
    },
    get text() {
      return text;
    },
    get cut() {
      return cut;
    },
  };
}

export function createChatgptProvider(opts: {
  model: string;
  reasoningEffort?: string | null;
  vision: VisionVerdict;
  session: ChatgptSession;
  fetchImpl?: typeof fetch;
  url?: string;
}): LlmProvider {
  const { model, session } = opts;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const url = opts.url ?? CHATGPT_RESPONSES_URL;

  async function once(p: LlmCallParams, token: string, signal: AbortSignal, onChunk: () => void): Promise<LlmResult> {
    const body = buildResponsesBody({
      model,
      system: p.system,
      messages: p.messages,
      tools: p.tools,
      toolChoice: p.toolChoice,
      reasoningEffort: opts.reasoningEffort ?? null,
    });
    // The stream is cut on our side (stop sequence or length cap) through
    // its own controller, so a cut never reads as the caller's cancel.
    const inner = new AbortController();
    const onOuter = (): void => inner.abort();
    if (signal.aborted) inner.abort();
    else signal.addEventListener('abort', onOuter, { once: true });
    const gate = createStreamGate({
      stops: p.stopSequences,
      maxChars: charCapFor(p.maxTokens),
      forward: p.onTextDelta ? (d: string) => p.onTextDelta!(d) : undefined,
      onCut: () => inner.abort(),
    });
    const calls: LlmToolUse[] = [];
    // The last usage any event carried, for a stream we cut before
    // response.completed (that is where usage normally arrives).
    let seenUsage: unknown = undefined;
    let sawText = false;
    let r: { text: string; toolUses: LlmToolUse[]; usage: LlmResult['usage']; stopReason: string | null };
    try {
      r = (await streamResponses({
        fetchImpl,
        url,
        token,
        body,
        signal: inner.signal,
        onChunk,
        onTextDelta: (d: string) => {
          if (d && !sawText) {
            sawText = true;
            p.onFirstToken?.();
          }
          return gate.push(d);
        },
        onEvent: (ev: { response?: { usage?: unknown } } | null) => {
          if (ev?.response?.usage) seenUsage = ev.response.usage;
        },
        onCall: (c) => {
          calls.push(c as LlmToolUse);
        },
      })) as typeof r;
    } catch (err) {
      // Our own cut ended the stream early: what was kept IS the answer.
      if (!gate.cut || signal.aborted) throw err;
      r = { text: '', toolUses: calls, usage: normalizeResponsesUsage(seenUsage), stopReason: null };
    } finally {
      signal.removeEventListener('abort', onOuter);
    }
    await gate.flush();

    let text = r.text;
    let toolUses = r.toolUses;
    let stopReason = r.stopReason;
    if (gate.cut) {
      text = gate.text.trim();
      stopReason = gate.cut === 'stop' ? 'stop_sequence' : 'max_tokens';
    } else {
      const stopped = applyStopSequences(text, p.stopSequences);
      if (stopped.stopped) {
        text = stopped.text.trim();
        stopReason = 'stop_sequence';
      }
    }
    if (p.toolChoice && toolUses.length === 0 && text) {
      const input = parseToolJsonFallback(text);
      if (input) {
        toolUses = [{ id: `toolu_fallback_${Date.now()}`, name: p.toolChoice.name, input }];
        text = '';
        stopReason = 'tool_use';
      }
    }
    const content = synthesizeContent(text, toolUses);
    if (p.onContentBlock) {
      for (const blk of content) {
        try { p.onContentBlock(blk as Anthropic.Messages.ContentBlock); } catch { /* sink errors never break a call */ }
      }
    }
    return { content, toolUses, text, usage: r.usage, stopReason };
  }

  async function call(p: LlmCallParams): Promise<LlmResult> {
    session.assertUsable();
    const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (p.signal) {
      if (p.signal.aborted) controller.abort();
      else p.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const deadline = requestDeadline(controller, timeoutMs);
    const rearm = (): void => deadline.rearm();
    try {
      let tok = await session.getAccessToken();
      try {
        return await once(p, tok.token, controller.signal, rearm);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'CHATGPT_AUTH') throw err;
        // One forced refresh + one retry. A 401 on the retry means the
        // sign-in itself is refused: terminal, latched by the session, and
        // the player is asked to sign in again (no loop every turn).
        const used = tok.token;
        tok = await session.getAccessToken({ force: true });
        // The forced refresh changed nothing (earliest_refresh_at): a retry
        // would send the same token, and a second 401 would prove nothing.
        if (tok.token === used) throw err;
        deadline.rearm();
        try {
          return await once(p, tok.token, controller.signal, rearm);
        } catch (again) {
          if ((again as { code?: string })?.code === 'CHATGPT_AUTH') throw retried401Error(again);
          throw again;
        }
      }
    } catch (err) {
      session.reportError(err);
      throw timeoutOr(err, deadline, p.signal, 'ChatGPT', timeoutMs);
    } finally {
      deadline.clear();
      if (p.signal) p.signal.removeEventListener('abort', onParentAbort);
    }
  }

  return {
    call,
    backend: 'local',
    kind: 'chatgpt',
    model,
    vision: opts.vision,
    streaming: true,
  };
}
