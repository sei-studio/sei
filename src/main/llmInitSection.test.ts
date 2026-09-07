// 260828: pins the shared llm-section builder used by BOTH bot credential
// paths (summon init payload AND the mid-session backend-switch message).
// See src/main/llmInitSection.ts for why the two paths must agree.

import { describe, it, expect } from 'vitest';
import { buildLlmInitSection } from './llmInitSection';
import { DEFAULT_MODELS } from '../shared/llmCatalog';

describe('buildLlmInitSection', () => {
  it('defaults to anthropic with the catalog model when nothing is configured', () => {
    expect(buildLlmInitSection({}, 'sk-key')).toEqual({
      provider: 'anthropic',
      api_key: 'sk-key',
      model: DEFAULT_MODELS.anthropic,
    });
  });

  it('carries the configured provider, model and base_url override', () => {
    const out = buildLlmInitSection(
      {
        provider: 'qwen',
        provider_config: {
          qwen: { model: 'qwen3-vl', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
        },
      },
      'qk',
    );
    expect(out).toEqual({
      provider: 'qwen',
      api_key: 'qk',
      model: 'qwen3-vl',
      base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
  });

  it('falls back to the catalog default model when the provider block has none', () => {
    const out = buildLlmInitSection({ provider: 'grok', provider_config: {} }, 'gk');
    expect(out.model).toBe(DEFAULT_MODELS.grok);
    expect(out.base_url).toBeUndefined();
  });

  it('blank model / base_url strings are treated as absent', () => {
    const out = buildLlmInitSection(
      { provider: 'openai', provider_config: { openai: { model: '  ', base_url: '' } } },
      'ok',
    );
    expect(out.model).toBe(DEFAULT_MODELS.openai);
    expect(out.base_url).toBeUndefined();
  });

  it('ollama ships with an empty key (keyless provider)', () => {
    const out = buildLlmInitSection({ provider: 'ollama' }, '');
    expect(out).toEqual({ provider: 'ollama', api_key: '', model: DEFAULT_MODELS.ollama });
  });
});
