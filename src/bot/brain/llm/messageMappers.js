// Translation between Anthropic's request/response shape (which the orchestrator
// natively emits/consumes) and the OpenAI Chat Completions + Google Gemini
// REST shapes. Pure functions, no I/O.

import { randomUUID } from 'crypto'

// ─── Anthropic system blocks → flat system string ──────────────────────
// systemBlocks: [{type:'text', text, cache_control?}]
export function flattenSystemBlocks(systemBlocks) {
  if (!Array.isArray(systemBlocks)) return ''
  return systemBlocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n')
}

// ─── Anthropic messages → OpenAI messages ─────────────────────────────
//
// Anthropic msg.content can be `string` or an Array of blocks:
//   {type:'text', text}
//   {type:'tool_use', id, name, input}
//   {type:'tool_result', tool_use_id, content, is_error?}
//   {type:'thinking', ...}  (dropped — Anthropic-only)
export function anthropicToOpenAIMessages(messages, systemText) {
  const out = []
  if (systemText) out.push({ role: 'system', content: systemText })
  for (const msg of messages) {
    if (msg.role === 'user') {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }]
      // Split tool_results out — they become separate {role:'tool'} messages
      // in OpenAI's protocol. Any text blocks coalesce into one user message.
      // VIS-02: an `image` block (provider-neutral {type:'image',source:{...}})
      // becomes an `image_url` data-URL part. When any image is present the
      // user message MUST use the multimodal ARRAY content form — OpenAI/Ollama
      // reject an image on a plain-string content, and an image NEVER rides a
      // {role:'tool'} result message (Pitfall 4).
      const textParts = []
      const imageParts = []
      const toolResults = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'text') textParts.push(blk.text)
        else if (blk.type === 'tool_result') toolResults.push(blk)
        else if (blk.type === 'image') {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${blk.source.media_type};base64,${blk.source.data}` },
          })
        }
      }
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        })
      }
      if (imageParts.length > 0) {
        // Multimodal array form: text parts (if any) before image parts.
        const arr = [
          ...textParts.map(text => ({ type: 'text', text })),
          ...imageParts,
        ]
        out.push({ role: 'user', content: arr })
      } else if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n\n') })
      }
    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }]
      const textParts = []
      const toolCalls = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'text') textParts.push(blk.text)
        else if (blk.type === 'tool_use') {
          toolCalls.push({
            id: blk.id,
            type: 'function',
            function: { name: blk.name, arguments: JSON.stringify(blk.input ?? {}) },
          })
        }
      }
      const m = { role: 'assistant', content: textParts.join('') || null }
      if (toolCalls.length > 0) m.tool_calls = toolCalls
      out.push(m)
    }
  }
  return out
}

export function anthropicToolsToOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined
  if (tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

// ─── OpenAI response → Anthropic-shape response ───────────────────────
export function openAIResponseToAnthropic(resp) {
  const choice = resp?.choices?.[0]
  const msg = choice?.message ?? {}
  const text = typeof msg.content === 'string' ? msg.content : ''
  const toolUses = []
  for (const call of msg.tool_calls ?? []) {
    if (call?.type !== 'function' && call?.function == null) continue
    const fn = call.function ?? {}
    let input = {}
    try { input = fn.arguments ? JSON.parse(fn.arguments) : {} } catch { input = { _raw: fn.arguments } }
    toolUses.push({ id: call.id ?? `toolu_${randomUUID()}`, name: fn.name, input })
  }
  return {
    toolUses,
    text,
    content: undefined,
    usage: resp?.usage,
    stopReason: choice?.finish_reason ?? 'end_turn',
  }
}

// ─── Anthropic schema → Gemini-friendly schema ────────────────────────
// Gemini's v1beta `functionDeclarations.parameters` is a JSON Schema subset.
// Strip every field Gemini explicitly rejects (the Zod-emitted JSON Schema
// often includes `default`, `additionalProperties`, `$schema`, refs).
// Conservative denylist of fields seen in zod-to-json-schema output that
// Gemini does not accept; keep everything else (type, properties, items,
// required, enum, description, nullable, minimum, maximum, minItems, etc.).
const GEMINI_REJECTED_FIELDS = new Set([
  '$schema', '$ref', '$id',
  'additionalProperties', 'unevaluatedProperties',
  'default', 'examples', 'definitions',
  'oneOf', 'anyOf', 'allOf', 'not',
  'patternProperties', 'dependencies',
])
function sanitizeForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini)
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_REJECTED_FIELDS.has(k)) continue
    out[k] = sanitizeForGemini(v)
  }
  return out
}

export function anthropicToolsToGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      parameters: sanitizeForGemini(t.input_schema ?? { type: 'object', properties: {} }),
    })),
  }]
}

// ─── Anthropic messages → Gemini contents ─────────────────────────────
//
// Pre-pass: walk every assistant turn and build an `id → name` map for each
// tool_use block. Anthropic `tool_result` blocks only carry `tool_use_id`,
// but Gemini's `functionResponse.name` must match the prior `functionCall.name`.
// Without this map we'd send the raw id (e.g. `toolu_<uuid>`) as the name and
// Gemini would 400 (or silently drop the result) on multi-iteration loops.
export function anthropicToGeminiContents(messages) {
  const idToName = new Map()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const blk of blocks) {
      if (blk?.type === 'tool_use' && blk.id && blk.name) {
        idToName.set(blk.id, blk.name)
      }
    }
  }
  const out = []
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }]
    if (msg.role === 'user') {
      const parts = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'text') parts.push({ text: blk.text })
        else if (blk.type === 'tool_result') {
          const responseObj = typeof blk.content === 'string'
            ? { result: blk.content }
            : (blk.content ?? { result: '' })
          parts.push({
            functionResponse: {
              name: idToName.get(blk.tool_use_id) ?? blk.tool_use_name ?? 'tool',
              response: responseObj,
            },
          })
        }
        // VIS-02: provider-neutral image block -> Gemini inline_data part. Lands
        // ONLY on a user turn (Pitfall 4 — never inside a functionResponse).
        else if (blk.type === 'image') {
          parts.push({
            inline_data: { mime_type: blk.source.media_type, data: blk.source.data },
          })
        }
      }
      if (parts.length > 0) out.push({ role: 'user', parts })
    } else if (msg.role === 'assistant') {
      const parts = []
      for (const blk of blocks) {
        if (!blk) continue
        if (blk.type === 'text') parts.push({ text: blk.text })
        else if (blk.type === 'tool_use') {
          parts.push({ functionCall: { name: blk.name, args: blk.input ?? {} } })
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts })
    }
  }
  return out
}

// ─── Gemini response → Anthropic-shape response ───────────────────────
export function geminiResponseToAnthropic(resp) {
  const cand = resp?.candidates?.[0]
  const parts = cand?.content?.parts ?? []
  let text = ''
  const toolUses = []
  for (const p of parts) {
    if (!p) continue
    if (typeof p.text === 'string') text += p.text
    if (p.functionCall) {
      toolUses.push({
        id: `toolu_${randomUUID()}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      })
    }
  }
  return {
    toolUses,
    text,
    content: undefined,
    usage: resp?.usageMetadata,
    stopReason: cand?.finishReason ?? 'STOP',
  }
}
