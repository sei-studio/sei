/** 261031 (T278): channel, send gate, device id + bucket, provider props, purchase detection. */
import { describe, expect, it } from 'vitest';
import {
  analyticsDeviceId,
  analyticsSendAllowed,
  detectPurchase,
  devAnalyticsFlag,
  deviceRolloutBucket,
  modelFamily,
  parseBakedChannel,
  providerProps,
  resolveChannel,
  uuidv7,
} from './analyticsContext';

describe('channel', () => {
  it('parses only the tagged baked values', () => {
    expect(parseBakedChannel('sei-channel=stable')).toBe('stable');
    expect(parseBakedChannel('sei-channel=beta')).toBe('beta');
    expect(parseBakedChannel('stable')).toBe('');
    expect(parseBakedChannel('sei-channel=nightly')).toBe('');
    expect(parseBakedChannel(undefined)).toBe('');
  });

  it('unpackaged is dev whatever was baked', () => {
    expect(resolveChannel({ packaged: false, baked: 'stable', version: '0.7.0' })).toBe('dev');
  });

  it('packaged without a baked channel is test (local dist, spike and dry-run builds)', () => {
    expect(resolveChannel({ packaged: true, baked: '', version: '0.7.0' })).toBe('test');
    expect(resolveChannel({ packaged: true, baked: '', version: '0.6.92' })).toBe('test');
  });

  it('a baked channel cannot claim stable for a prerelease', () => {
    expect(resolveChannel({ packaged: true, baked: 'stable', version: '0.7.0' })).toBe('stable');
    expect(resolveChannel({ packaged: true, baked: 'stable', version: '0.7.0-beta.2' })).toBe('beta');
    expect(resolveChannel({ packaged: true, baked: 'beta', version: '0.7.0-beta.2' })).toBe('beta');
    expect(resolveChannel({ packaged: true, baked: 'beta', version: '0.7.0' })).toBe('test');
    expect(resolveChannel({ packaged: true, baked: 'stable', version: '0.7.0-rc.1' })).toBe('test');
  });
});

describe('send gate (dev-build suppression)', () => {
  it('only stable and beta send by default', () => {
    expect(analyticsSendAllowed('stable', false)).toBe(true);
    expect(analyticsSendAllowed('beta', false)).toBe(true);
    expect(analyticsSendAllowed('dev', false)).toBe(false);
    expect(analyticsSendAllowed('test', false)).toBe(false);
  });

  it('SEI_ANALYTICS_DEV=1 lets a dev or test build send', () => {
    expect(devAnalyticsFlag({ SEI_ANALYTICS_DEV: '1' })).toBe(true);
    expect(devAnalyticsFlag({ SEI_ANALYTICS_DEV: 'true' })).toBe(true);
    expect(devAnalyticsFlag({ SEI_ANALYTICS_DEV: '0' })).toBe(false);
    expect(devAnalyticsFlag({})).toBe(false);
    expect(analyticsSendAllowed('dev', true)).toBe(true);
  });
});

describe('device id and rollout bucket', () => {
  const raw = '3b241101-e2bb-4255-8caf-4136c566a962';

  it('is a stable 32-hex hash, never the raw id', () => {
    const id = analyticsDeviceId(raw);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toBe(analyticsDeviceId(raw.toUpperCase()));
    expect(id).not.toContain(raw.replace(/-/g, '').slice(0, 12));
    expect(analyticsDeviceId('another')).not.toBe(id);
  });

  it('bucket is 0..99, stable per device, and spread across devices', () => {
    expect(deviceRolloutBucket(raw)).toBe(deviceRolloutBucket(raw));
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const b = deviceRolloutBucket(`device-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
      buckets.add(b);
    }
    expect(buckets.size).toBeGreaterThan(90);
  });

  it('uuidv7 is version 7 and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
  });
});

describe('provider props', () => {
  const defaults = { anthropic: 'claude-haiku-4-5', openai: 'gpt-5-mini', ollama: 'qwen3:8b', chatgpt: 'gpt-5' };

  it('cloud is cloud whatever the config says', () => {
    expect(providerProps('cloud-proxy', true, { provider: 'ollama' }, defaults)).toEqual({
      ai_provider: 'cloud',
      llm_provider: 'sei_cloud',
      model_family: 'claude',
    });
  });

  it('local splits into chatgpt, ollama and byok instead of "local"', () => {
    expect(providerProps('local', true, { provider: 'chatgpt' }, defaults).ai_provider).toBe('chatgpt');
    expect(providerProps('local', true, { provider: 'ollama', provider_config: { ollama: { model: 'llama3.1:8b' } } }, defaults)).toEqual({
      ai_provider: 'ollama',
      llm_provider: 'ollama',
      model_family: 'llama',
    });
    expect(providerProps('local', true, { provider: 'openai' }, defaults)).toEqual({
      ai_provider: 'byok',
      llm_provider: 'openai',
      model_family: 'gpt',
    });
    expect(providerProps('local', true, null, defaults)).toMatchObject({ ai_provider: 'byok', llm_provider: 'anthropic', model_family: 'claude' });
  });

  it('not onboarded is unset; a junk provider name never ships', () => {
    expect(providerProps('local', false, { provider: 'openai' }, defaults).ai_provider).toBe('unset');
    expect(providerProps('local', true, { provider: 'My Secret Host!' }, defaults).llm_provider).toBe('anthropic');
  });

  it('model family is a closed enum, never the raw model name', () => {
    expect(modelFamily('gpt-oss:20b')).toBe('gpt_oss');
    expect(modelFamily('openai/gpt-4.1')).toBe('gpt');
    expect(modelFamily('o3-mini')).toBe('gpt');
    expect(modelFamily('qwen3:8b')).toBe('qwen');
    expect(modelFamily('deepseek-r1:14b')).toBe('deepseek');
    expect(modelFamily('gemma3:4b')).toBe('gemma');
    expect(modelFamily('my-custom-finetune-bob')).toBe('other');
    expect(modelFamily('')).toBeNull();
  });
});

describe('detectPurchase', () => {
  const snap = (plan: 'free' | 'quest' | 'party', extraTotal = 0, userId = 'u1') => ({ userId, plan, extraTotal });

  it('needs a baseline of the same account', () => {
    expect(detectPurchase(null, snap('quest'))).toBeNull();
    expect(detectPurchase(snap('free', 0, 'u0'), snap('quest'))).toBeNull();
  });

  it('free to paid is a subscription, a higher tier an upgrade', () => {
    expect(detectPurchase(snap('free'), snap('quest'))).toEqual({ kind: 'subscription', tier: 'quest', from_tier: 'free' });
    expect(detectPurchase(snap('quest'), snap('party'))).toEqual({ kind: 'upgrade', tier: 'party', from_tier: 'quest' });
  });

  it('a grown top-up total is a top-up; a downgrade or no change is nothing', () => {
    expect(detectPurchase(snap('quest', 100), snap('quest', 600))).toEqual({
      kind: 'topup',
      tier: 'quest',
      from_tier: 'quest',
      credits_added: 500,
    });
    expect(detectPurchase(snap('party'), snap('quest'))).toBeNull();
    expect(detectPurchase(snap('quest', 600), snap('quest', 600))).toBeNull();
    expect(detectPurchase(snap('quest', 600), snap('quest', 100))).toBeNull();
  });

  it('a tier rise out of past_due or unpaid is a recovered payment, not a purchase', () => {
    const failing = (status: string) => ({ ...snap('free'), status });
    expect(detectPurchase(failing('past_due'), { ...snap('quest'), status: 'active' })).toBeNull();
    expect(detectPurchase(failing('unpaid'), { ...snap('quest'), status: 'active' })).toBeNull();
    // An expired subscription bought again is a new one.
    expect(detectPurchase(failing('expired'), { ...snap('quest'), status: 'active' })).toMatchObject({ kind: 'subscription' });
    // A top-up during past_due still counts.
    expect(detectPurchase({ ...failing('past_due'), extraTotal: 0 }, { ...snap('free', 500), status: 'past_due' })).toMatchObject({
      kind: 'topup',
      credits_added: 500,
    });
  });
});
