import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => [], getLocale: () => 'en-US' } }));
vi.mock('./configStore', () => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }));

import { shouldSwitchToZh } from './localeDetect';

describe('shouldSwitchToZh', () => {
  it('switches when ui_language is unset and the primary system language is Chinese', () => {
    expect(shouldSwitchToZh(undefined, ['zh-CN', 'en-US'])).toBe(true);
    expect(shouldSwitchToZh(undefined, ['zh-Hans-CN'])).toBe(true);
    expect(shouldSwitchToZh(undefined, ['zh-TW'])).toBe(true);
    expect(shouldSwitchToZh(undefined, ['ZH-HK'])).toBe(true);
  });

  it('never overrides an explicit choice, either value', () => {
    expect(shouldSwitchToZh('en', ['zh-CN'])).toBe(false);
    expect(shouldSwitchToZh('zh', ['zh-CN'])).toBe(false);
  });

  it('stays English for every non-Chinese locale', () => {
    expect(shouldSwitchToZh(undefined, ['en-US'])).toBe(false);
    expect(shouldSwitchToZh(undefined, ['ja-JP'])).toBe(false);
    expect(shouldSwitchToZh(undefined, ['ko-KR', 'zh-CN'])).toBe(false); // primary wins
    expect(shouldSwitchToZh(undefined, [])).toBe(false);
  });
});
