/**
 * Mapper tests for the main-process LLM layer (china-compat W1): the
 * anthropic-shape -> OpenAI/Gemini round trips the tool loops depend on,
 * cache_control stripping, image normalization, stop/usage normalization,
 * synthesized content, and the forced-tool JSON fallback parse.
 */
import { describe, it, expect } from 'vitest';
import {
  anthropicToGeminiContents,
  anthropicToOpenAIMessages,
  anthropicToolsToGeminiTools,
  anthropicToolsToOpenAITools,
  flattenSystem,
  forcedToolPromptNote,
  normalizeGeminiStopReason,
  normalizeOllamaStopReason,
  normalizeOpenAIStopReason,
  normalizeOpenAIUsage,
  openAIToolCallsToUses,
  parseToolJsonFallback,
  sanitizeForGemini,
  synthesizeContent,
  textOfContent,
  toolChoiceToOpenAI,
} from './messageMappers';

describe('flattenSystem', () => {
  it('joins text blocks in order and drops cache_control silently', () => {
    const s = flattenSystem([
      { type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } } as never,
      { type: 'text', text: 'contract' },
    ]);
    expect(s).toBe('persona\n\ncontract');
  });

  it('passes a plain string through', () => {
    expect(flattenSystem('sys')).toBe('sys');
  });
});

describe('anthropicToOpenAIMessages', () => {
  it('round-trips a tool loop: tool_use out, tool_result back as role:tool', () => {
    const messages = [
      { role: 'user' as const, content: 'do the thing' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'tu_1', name: 'play', input: { move: 'e4' } },
        ],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'You play e4.' }],
      },
    ];
    const out = anthropicToOpenAIMessages(messages, 'sys');
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]).toEqual({ role: 'user', content: 'do the thing' });
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'on it',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'play', arguments: '{"move":"e4"}' } }],
    });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'You play e4.' });
  });

  it('ignores cache_control markers written by the mark*Cached helpers', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text', text: 'latest', cache_control: { type: 'ephemeral' } }],
      },
    ];
    const out = anthropicToOpenAIMessages(messages, '');
    expect(out).toEqual([{ role: 'user', content: 'latest' }]);
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });

  it('normalizes an image block to a data-URL part and forces array content', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ];
    const out = anthropicToOpenAIMessages(messages, '');
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('large pen-style point arrays survive the arguments JSON round trip', () => {
    const points = Array.from({ length: 120 }, (_, i) => ({ x: i, y: i * 2 }));
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 'tu_pen', name: 'pen', input: { intent: 'outline', points } }],
      },
    ];
    const out = anthropicToOpenAIMessages(messages, '');
    const call = (out[0] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0];
    const parsed = JSON.parse(call.function.arguments) as { points: Array<{ x: number; y: number }> };
    expect(parsed.points).toHaveLength(120);
    expect(parsed.points[119]).toEqual({ x: 119, y: 238 });
  });
});

describe('tools + tool_choice mapping', () => {
  it('maps anthropic tools to OpenAI function tools', () => {
    const t = anthropicToolsToOpenAITools([
      { name: 'play', description: 'move', input_schema: { type: 'object', properties: { move: { type: 'string' } } } },
    ]);
    expect(t).toEqual([
      {
        type: 'function',
        function: { name: 'play', description: 'move', parameters: { type: 'object', properties: { move: { type: 'string' } } } },
      },
    ]);
  });

  it('maps a forced tool_choice to the function form', () => {
    expect(toolChoiceToOpenAI({ type: 'tool', name: 'set_chess_profile' })).toEqual({
      type: 'function',
      function: { name: 'set_chess_profile' },
    });
  });
});

describe('openAIToolCallsToUses', () => {
  it('parses JSON-string arguments and preserves ids', () => {
    const uses = openAIToolCallsToUses([
      { id: 'call_1', type: 'function', function: { name: 'play', arguments: '{"move":"Nf3"}' } },
    ]);
    expect(uses).toEqual([{ id: 'call_1', name: 'play', input: { move: 'Nf3' } }]);
  });

  it('keeps unparseable arguments under _raw instead of dropping the call', () => {
    const uses = openAIToolCallsToUses([
      { id: 'call_2', type: 'function', function: { name: 'play', arguments: '{broken' } },
    ]);
    expect(uses[0].input).toEqual({ _raw: '{broken' });
  });
});

describe('synthesizeContent', () => {
  it('builds an anthropic-shaped assistant array a tool loop can push back', () => {
    const content = synthesizeContent('sure.', [{ id: 'tu_9', name: 'remember', input: { text: 'x' } }]);
    expect(content).toEqual([
      { type: 'text', text: 'sure.' },
      { type: 'tool_use', id: 'tu_9', name: 'remember', input: { text: 'x' } },
    ]);
    expect(textOfContent(content as never)).toBe('sure.');
    // And it survives the mapper round trip.
    const out = anthropicToOpenAIMessages([{ role: 'assistant', content }], '');
    expect((out[0] as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
  });
});

describe('stop/usage normalization', () => {
  it('normalizes stop reasons across providers', () => {
    expect(normalizeOpenAIStopReason('length')).toBe('max_tokens');
    expect(normalizeOpenAIStopReason('stop')).toBe('end_turn');
    expect(normalizeOpenAIStopReason('tool_calls')).toBe('tool_use');
    expect(normalizeGeminiStopReason('MAX_TOKENS')).toBe('max_tokens');
    expect(normalizeGeminiStopReason('STOP')).toBe('end_turn');
    expect(normalizeOllamaStopReason('length')).toBe('max_tokens');
    expect(normalizeOllamaStopReason('stop')).toBe('end_turn');
  });

  it('normalizes OpenAI usage to the anthropic key names', () => {
    expect(
      normalizeOpenAIUsage({ prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } }),
    ).toEqual({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 });
  });
});

describe('gemini mapping', () => {
  it('reconstructs functionResponse names from prior tool_use ids', () => {
    const contents = anthropicToGeminiContents([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'play', input: { move: 'e4' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'done' }] },
    ]);
    expect(contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'play', response: { result: 'done' } } }],
    });
  });

  it('normalizes an image block to inline_data', () => {
    const contents = anthropicToGeminiContents([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BB' } }],
      },
    ]);
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'BB' } }],
    });
  });

  it('strips rejected schema fields recursively', () => {
    const clean = sanitizeForGemini({
      type: 'object',
      additionalProperties: false,
      $schema: 'x',
      properties: { a: { type: 'string', default: 'y' } },
    }) as Record<string, unknown>;
    expect(clean).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    const tools = anthropicToolsToGeminiTools([{ name: 't', input_schema: { type: 'object', default: 1 } }]);
    expect(JSON.stringify(tools)).not.toContain('default');
  });
});

describe('forced-tool JSON fallback', () => {
  it('parses a bare JSON object', () => {
    expect(parseToolJsonFallback('{"elo": 900, "styleNote": "cautious"}')).toEqual({
      elo: 900,
      styleNote: 'cautious',
    });
  });

  it('parses through markdown fences and surrounding prose', () => {
    const text = 'Here is the profile:\n```json\n{"elo": 1200, "styleNote": "sharp"}\n```\nDone.';
    expect(parseToolJsonFallback(text)).toEqual({ elo: 1200, styleNote: 'sharp' });
  });

  it('returns null for prose with no object', () => {
    expect(parseToolJsonFallback('no json here')).toBeNull();
  });

  it('the prompt note names the tool', () => {
    expect(forcedToolPromptNote('set_chess_profile')).toContain('"set_chess_profile"');
  });
});
