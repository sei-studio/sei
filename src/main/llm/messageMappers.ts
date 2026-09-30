/**
 * Anthropic-shape <-> OpenAI / Gemini / Ollama wire-shape translation for the
 * main-process LLM layer. TypeScript port of src/bot/brain/llm/messageMappers.js
 * (do NOT import the bot's JS from main), extended with what main needs:
 * stopReason/usage normalization, synthesized assistant content, forced
 * tool_choice mapping, and a JSON fallback parser for providers that cannot
 * force a tool call.
 *
 * cache_control markers are STRIPPED implicitly: the mappers only ever read
 * type/text/tool fields, so the markers the mark*Cached helpers write onto the
 * shared message arrays never reach a non-Anthropic wire. Block order is
 * preserved for implicit prefix caching.
 *
 * Pure functions, no I/O.
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmToolDef, LlmToolUse, LlmUsage } from './types';

// ── Anthropic system → flat system string ─────────────────────────────────
export function flattenSystem(system: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (system == null) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n');
}

interface AnyBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { media_type?: string; data?: string };
}

function contentBlocks(content: unknown): AnyBlock[] {
  if (Array.isArray(content)) return content as AnyBlock[];
  return [{ type: 'text', text: String(content ?? '') }];
}

// ── Anthropic messages → OpenAI messages ──────────────────────────────────
//
// tool_result user blocks split out into separate {role:'tool'} messages;
// an image block becomes an image_url data-URL part, which forces the user
// message into the multimodal ARRAY content form (OpenAI rejects an image on
// plain-string content, and an image never rides a tool message).
export function anthropicToOpenAIMessages(
  messages: LlmMessage[],
  systemText: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemText) out.push({ role: 'system', content: systemText });
  for (const msg of messages) {
    const blocks = contentBlocks(msg.content);
    if (msg.role === 'user') {
      const textParts: string[] = [];
      const imageParts: Array<Record<string, unknown>> = [];
      const toolResults: AnyBlock[] = [];
      for (const blk of blocks) {
        if (!blk) continue;
        if (blk.type === 'text') textParts.push(blk.text ?? '');
        else if (blk.type === 'tool_result') toolResults.push(blk);
        else if (blk.type === 'image' && blk.source) {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${blk.source.media_type};base64,${blk.source.data}` },
          });
        }
      }
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? ''),
        });
      }
      if (imageParts.length > 0) {
        out.push({
          role: 'user',
          content: [...textParts.map((text) => ({ type: 'text', text })), ...imageParts],
        });
      } else if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n\n') });
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const blk of blocks) {
        if (!blk) continue;
        if (blk.type === 'text') textParts.push(blk.text ?? '');
        else if (blk.type === 'tool_use') {
          toolCalls.push({
            id: blk.id,
            type: 'function',
            function: { name: blk.name, arguments: JSON.stringify(blk.input ?? {}) },
          });
        }
      }
      const m: Record<string, unknown> = { role: 'assistant', content: textParts.join('') || null };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      out.push(m);
    }
  }
  return out;
}

export function anthropicToolsToOpenAITools(
  tools: LlmToolDef[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Anthropic forced tool_choice → OpenAI's function form. */
export function toolChoiceToOpenAI(tc: { type: 'tool'; name: string }): Record<string, unknown> {
  return { type: 'function', function: { name: tc.name } };
}

// ── Synthesized anthropic-shaped assistant content ────────────────────────
export function synthesizeContent(text: string, toolUses: LlmToolUse[]): Anthropic.Messages.ContentBlock[] {
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const tu of toolUses) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
  return blocks as Anthropic.Messages.ContentBlock[];
}

// ── stopReason normalization ──────────────────────────────────────────────
export function normalizeOpenAIStopReason(finishReason: string | null | undefined): string | null {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': case 'function_call': return 'tool_use';
    case undefined: case null: return null;
    default: return finishReason;
  }
}

export function normalizeGeminiStopReason(finishReason: string | null | undefined): string | null {
  switch (finishReason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case undefined: case null: return null;
    default: return finishReason;
  }
}

export function normalizeOllamaStopReason(doneReason: string | null | undefined): string | null {
  switch (doneReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case undefined: case null: return null;
    default: return doneReason;
  }
}

// ── usage normalization ───────────────────────────────────────────────────
export function normalizeOpenAIUsage(usage: unknown): LlmUsage {
  const u = (usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

export function normalizeGeminiUsage(usageMetadata: unknown): LlmUsage {
  const u = (usageMetadata ?? {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  return {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0,
    cache_read_input_tokens: u.cachedContentTokenCount ?? 0,
    cache_creation_input_tokens: 0,
  };
}

export function normalizeOllamaUsage(data: unknown): LlmUsage {
  const d = (data ?? {}) as { prompt_eval_count?: number; eval_count?: number };
  return {
    input_tokens: d.prompt_eval_count ?? 0,
    output_tokens: d.eval_count ?? 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

// ── OpenAI response tool_calls → LlmToolUse[] ─────────────────────────────
// OpenAI's `arguments` is a JSON string (Draw!'s 120-point pen arrays must
// survive the round trip; JSON.parse handles them). An unparseable payload is
// preserved under `_raw` rather than dropped.
export function openAIToolCallsToUses(toolCalls: unknown): LlmToolUse[] {
  const out: LlmToolUse[] = [];
  for (const call of (toolCalls as Array<Record<string, unknown>> | undefined) ?? []) {
    const fn = (call?.function ?? null) as { name?: string; arguments?: unknown } | null;
    if (call?.type !== 'function' && fn == null) continue;
    let input: Record<string, unknown> = {};
    const args = fn?.arguments;
    if (typeof args === 'string' && args) {
      try { input = JSON.parse(args) as Record<string, unknown>; } catch { input = { _raw: args }; }
    } else if (args && typeof args === 'object') {
      input = args as Record<string, unknown>;
    }
    out.push({ id: (call?.id as string) ?? `toolu_${randomUUID()}`, name: fn?.name ?? '', input });
  }
  return out;
}

// ── Anthropic schema → Gemini-friendly schema ─────────────────────────────
// Strip every field Gemini's functionDeclarations.parameters rejects (the
// zod-emitted JSON Schema often includes default/additionalProperties/$schema).
const GEMINI_REJECTED_FIELDS = new Set([
  '$schema', '$ref', '$id',
  'additionalProperties', 'unevaluatedProperties',
  'default', 'examples', 'definitions',
  'oneOf', 'anyOf', 'allOf', 'not',
  'patternProperties', 'dependencies',
]);
export function sanitizeForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_REJECTED_FIELDS.has(k)) continue;
    out[k] = sanitizeForGemini(v);
  }
  return out;
}

export function anthropicToolsToGeminiTools(tools: LlmToolDef[] | undefined): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: sanitizeForGemini(t.input_schema ?? { type: 'object', properties: {} }),
    })),
  }];
}

// ── Anthropic messages → Gemini contents ──────────────────────────────────
// Pre-pass builds id → name for every assistant tool_use, because Gemini's
// functionResponse.name must match the prior functionCall.name while Anthropic
// tool_result blocks only carry tool_use_id.
export function anthropicToGeminiContents(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const blk of Array.isArray(msg.content) ? (msg.content as AnyBlock[]) : []) {
      if (blk?.type === 'tool_use' && blk.id && blk.name) idToName.set(blk.id, blk.name);
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const blocks = contentBlocks(msg.content);
    if (msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = [];
      for (const blk of blocks) {
        if (!blk) continue;
        if (blk.type === 'text') parts.push({ text: blk.text });
        else if (blk.type === 'tool_result') {
          const responseObj = typeof blk.content === 'string'
            ? { result: blk.content }
            : ((blk.content as Record<string, unknown> | undefined) ?? { result: '' });
          parts.push({
            functionResponse: {
              name: idToName.get(blk.tool_use_id ?? '') ?? 'tool',
              response: responseObj,
            },
          });
        } else if (blk.type === 'image' && blk.source) {
          parts.push({ inline_data: { mime_type: blk.source.media_type, data: blk.source.data } });
        }
      }
      if (parts.length > 0) out.push({ role: 'user', parts });
    } else if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      for (const blk of blocks) {
        if (!blk) continue;
        if (blk.type === 'text') parts.push({ text: blk.text });
        else if (blk.type === 'tool_use') parts.push({ functionCall: { name: blk.name, args: blk.input ?? {} } });
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
    }
  }
  return out;
}

export function geminiPartsToResult(resp: unknown): { text: string; toolUses: LlmToolUse[] } {
  const cand = (resp as { candidates?: Array<{ content?: { parts?: unknown[] } }> })?.candidates?.[0];
  const parts = (cand?.content?.parts ?? []) as Array<{ text?: unknown; functionCall?: { name?: string; args?: unknown } }>;
  let text = '';
  const toolUses: LlmToolUse[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p.text === 'string') text += p.text;
    if (p.functionCall) {
      toolUses.push({
        id: `toolu_${randomUUID()}`,
        name: p.functionCall.name ?? '',
        input: (p.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
  }
  return { text, toolUses };
}

// ── Forced-tool fallback parse ────────────────────────────────────────────
/**
 * The prompt appended to the system text when a provider cannot force a tool
 * call: tells the model to answer with ONLY the tool's input JSON.
 */
export function forcedToolPromptNote(toolName: string): string {
  return (
    `\n\nYou MUST answer by calling the tool "${toolName}" exactly once. ` +
    `If you cannot call tools, output ONLY a single JSON object matching the tool's input schema, with no prose, no markdown fences, and nothing else.`
  );
}

/**
 * Parse a tool-shaped JSON object out of free text (forced-tool fallback for
 * providers without tool_choice support, and the belt-and-braces recovery when
 * a forced call comes back as text anyway). Tolerates markdown fences and
 * surrounding prose; returns null when no JSON object parses.
 */
export function parseToolJsonFallback(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = unfenced.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Text blocks of an anthropic-shaped content array, joined '' and trimmed. */
export function textOfContent(content: Array<{ type?: string; text?: string }>): string {
  return content
    .map((b) => (b?.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
}
