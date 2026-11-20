/** Playtime opens on the tab that matches the current setup (261110). */
import { describe, expect, it } from 'vitest';
import { PLAYTIME_TABS, isActiveSetupTab, playtimeTabForSetup } from './playtimeTabs';

describe('playtimeTabForSetup', () => {
  it('cloud is Sei; local is ChatGPT on the plan, else My keys', () => {
    expect(playtimeTabForSetup('cloud-proxy', 'chatgpt')).toBe('sei');
    expect(playtimeTabForSetup('local', 'chatgpt')).toBe('chatgpt');
    expect(playtimeTabForSetup('local', 'anthropic')).toBe('mykeys');
    expect(playtimeTabForSetup('local', 'ollama')).toBe('mykeys');
    expect(playtimeTabForSetup('local', null)).toBe('mykeys');
  });
  it('a backend main has not reported yet opens Sei', () => {
    expect(playtimeTabForSetup(null, 'chatgpt')).toBe('sei');
    expect(playtimeTabForSetup(undefined, undefined)).toBe('sei');
  });
});

describe('isActiveSetupTab', () => {
  it('exactly one tab is active once the backend is known', () => {
    for (const [backend, provider] of [
      ['cloud-proxy', 'anthropic'],
      ['local', 'chatgpt'],
      ['local', 'deepseek'],
    ] as const) {
      expect(PLAYTIME_TABS.filter((t) => isActiveSetupTab(t, backend, provider))).toHaveLength(1);
    }
  });
  it('none is active while the backend is unknown (no dashboard claims a mode)', () => {
    expect(PLAYTIME_TABS.some((t) => isActiveSetupTab(t, null, 'chatgpt'))).toBe(false);
  });
});
