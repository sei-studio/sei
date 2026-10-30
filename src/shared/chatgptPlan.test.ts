/**
 * 261017 (issue #46): the model catalog parser and default pick, against the
 * plan route shape and the platform list shape the same URL returns for an
 * API key (seen live on 261017).
 */
import { describe, expect, it } from 'vitest';
import { CHATGPT_HELP_URL, isResponsesChatModelId, parseChatgptModels, pickDefaultChatgptModel, pickReasoningEffort } from './chatgptPlan';

describe('parseChatgptModels', () => {
  it('plan catalog: keeps visibility "list" in server order', () => {
    const list = parseChatgptModels({
      models: [
        { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], input_modalities: ['text', 'image'] },
        { slug: 'hidden', visibility: 'hide' },
        { slug: 'gpt-6-luna', visibility: 'list' },
      ],
    });
    expect(list.map((m) => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-luna']);
    expect(list[0]).toMatchObject({ display_name: 'GPT-6 Sol', reasoning_levels: ['low', 'high'], accepts_images: true });
    expect(list[1]).toMatchObject({ display_name: 'gpt-6-luna', accepts_images: null });
  });

  it('platform list: keeps chat models, drops audio/image/embedding/snapshot ids', () => {
    const ids = ['gpt-3.5-turbo-0125', 'tts-1', 'gpt-5.4-2026-03-05', 'gpt-5.6-luna', 'text-embedding-3-small', 'gpt-realtime', 'gpt-image-1', 'gpt-6-luna', 'o1-pro', 'gpt-4o-mini-transcribe', 'dall-e-3', 'gpt-6-luna'];
    const list = parseChatgptModels({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'system' })) });
    expect(list.map((m) => m.slug)).toEqual(['gpt-3.5-turbo-0125', 'gpt-5.6-luna', 'gpt-6-luna', 'o1-pro']);
    expect(list.every((m) => m.reasoning_levels.length === 0 && m.accepts_images === null)).toBe(true);
    expect(isResponsesChatModelId('gpt-5-codex')).toBe(false);
  });

  it('unknown shapes return []', () => {
    expect(parseChatgptModels(null)).toEqual([]);
    expect(parseChatgptModels({ foo: 1 })).toEqual([]);
  });
});

describe('pickDefaultChatgptModel', () => {
  it('picks the NEWEST efficient tier, whatever the listed order', () => {
    const slugs = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol'];
    expect(pickDefaultChatgptModel(slugs.map((slug) => ({ slug })))).toBe('gpt-6-luna');
  });

  it('falls back to mini, then nano, then the first model', () => {
    expect(pickDefaultChatgptModel([{ slug: 'gpt-5-nano' }, { slug: 'gpt-5-mini' }, { slug: 'gpt-5.4-mini' }])).toBe('gpt-5.4-mini');
    expect(pickDefaultChatgptModel([{ slug: 'o1-pro' }])).toBe('o1-pro');
    expect(pickDefaultChatgptModel([])).toBe('gpt-6-luna');
  });
});

describe('pickReasoningEffort', () => {
  it('prefers low (gpt-6-luna accepts none/low/medium/high/xhigh/max, not minimal)', () => {
    expect(pickReasoningEffort(['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('low');
    expect(pickReasoningEffort([])).toBeNull();
  });
});

describe('CHATGPT_HELP_URL', () => {
  it('opens the specific Help Center article, not the help.openai.com homepage', () => {
    const url = new URL(CHATGPT_HELP_URL);
    expect(url.hostname).toBe('help.openai.com');
    expect(url.pathname).toMatch(/^\/en\/articles\/20001542-using-your-chatgpt-plan-in-other-apps-and-sites$/);
  });
});
