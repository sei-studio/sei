import { describe, it, expect } from 'vitest'
import {
  flattenSystemBlocks,
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAITools,
  openAIResponseToAnthropic,
  anthropicToolsToGeminiTools,
  anthropicToGeminiContents,
  geminiResponseToAnthropic,
} from './messageMappers.js'

describe('flattenSystemBlocks', () => {
  it('joins text blocks with blank line', () => {
    expect(flattenSystemBlocks([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ])).toBe('A\n\nB')
  })
  it('returns empty string for non-array', () => {
    expect(flattenSystemBlocks(undefined)).toBe('')
  })
})

describe('anthropicToOpenAIMessages', () => {
  it('prepends system, coalesces user text blocks, splits tool_result into tool messages', () => {
    const out = anthropicToOpenAIMessages([
      { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]},
      { role: 'assistant', content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'call_1', name: 'go', input: { x: 1 } },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
        { type: 'text', text: 'next' },
      ]},
    ], 'SYSTEM')
    expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' })
    expect(out[1]).toEqual({ role: 'user', content: 'hello\n\nworld' })
    expect(out[2].role).toBe('assistant')
    expect(out[2].content).toBe('hi')
    expect(out[2].tool_calls).toEqual([{
      id: 'call_1', type: 'function',
      function: { name: 'go', arguments: JSON.stringify({ x: 1 }) },
    }])
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' })
    expect(out[4]).toEqual({ role: 'user', content: 'next' })
  })
})

describe('anthropicToolsToOpenAITools', () => {
  it('wraps each as function', () => {
    expect(anthropicToolsToOpenAITools([
      { name: 'go', description: 'move', input_schema: { type: 'object', properties: { x: { type: 'number' } } } },
    ])).toEqual([{
      type: 'function',
      function: { name: 'go', description: 'move', parameters: { type: 'object', properties: { x: { type: 'number' } } } },
    }])
  })
  it('returns undefined for empty', () => {
    expect(anthropicToolsToOpenAITools([])).toBeUndefined()
  })
})

describe('openAIResponseToAnthropic', () => {
  it('parses text + tool_calls', () => {
    const out = openAIResponseToAnthropic({
      choices: [{
        message: {
          content: 'hi',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'go', arguments: '{"x":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { total_tokens: 10 },
    })
    expect(out.text).toBe('hi')
    expect(out.toolUses).toEqual([{ id: 'c1', name: 'go', input: { x: 1 } }])
    expect(out.stopReason).toBe('tool_calls')
    expect(out.usage).toEqual({ total_tokens: 10 })
  })
  it('synthesizes toolu_ id when missing', () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'go', arguments: '{}' } }] } }],
    })
    expect(out.toolUses[0].id).toMatch(/^toolu_/)
  })
  it('stashes raw arguments on parse failure', () => {
    const out = openAIResponseToAnthropic({
      choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'go', arguments: '{broken' } }] } }],
    })
    expect(out.toolUses[0].input).toEqual({ _raw: '{broken' })
  })
})

describe('Gemini mappers', () => {
  it('wraps tools in functionDeclarations and strips additionalProperties', () => {
    const out = anthropicToolsToGeminiTools([{
      name: 'go',
      description: 'move',
      input_schema: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false, $schema: 'foo' },
    }])
    expect(out).toEqual([{
      functionDeclarations: [{
        name: 'go',
        description: 'move',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
      }],
    }])
  })

  it('maps assistant tool_use → functionCall and user tool_result → functionResponse', () => {
    const out = anthropicToGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'go', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
    expect(out[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    expect(out[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'go', args: { x: 1 } } }] })
    expect(out[2].role).toBe('user')
    // functionResponse.name MUST be the original tool name ('go'), not the id.
    // Gemini 400s if the name doesn't match a prior functionCall.
    expect(out[2].parts[0].functionResponse.name).toBe('go')
    expect(out[2].parts[0].functionResponse.response).toEqual({ result: 'ok' })
  })

  it('rejects deep schema fields Gemini does not accept (default, oneOf, $ref, definitions)', () => {
    const out = anthropicToolsToGeminiTools([{
      name: 'go',
      description: 'move',
      input_schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          x: { type: 'number', default: 0 },
          y: { oneOf: [{ type: 'number' }, { type: 'string' }] },
        },
        additionalProperties: false,
        definitions: { foo: { type: 'object' } },
      },
    }])
    const params = out[0].functionDeclarations[0].parameters
    expect(params.$schema).toBeUndefined()
    expect(params.additionalProperties).toBeUndefined()
    expect(params.definitions).toBeUndefined()
    expect(params.properties.x.default).toBeUndefined()
    expect(params.properties.y.oneOf).toBeUndefined()
    // Allowed fields preserved.
    expect(params.type).toBe('object')
    expect(params.properties.x.type).toBe('number')
  })

  it('parses Gemini response back to anthropic shape', () => {
    const out = geminiResponseToAnthropic({
      candidates: [{
        content: { parts: [{ text: 'hello ' }, { functionCall: { name: 'go', args: { x: 1 } } }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 10 },
    })
    expect(out.text).toBe('hello ')
    expect(out.toolUses).toHaveLength(1)
    expect(out.toolUses[0].name).toBe('go')
    expect(out.toolUses[0].input).toEqual({ x: 1 })
    expect(out.stopReason).toBe('STOP')
  })
})
