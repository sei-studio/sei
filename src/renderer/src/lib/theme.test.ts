/**
 * 261123: the main window starts in the remembered theme mode, so the boot
 * splash index.html painted keeps its theme until config has been read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOT_THEME_KEY, rememberBootTheme, rememberedBootTheme } from './theme';

function stubPage(search: string, stored: Record<string, string> = {}): Record<string, string> {
  vi.stubGlobal('location', { search });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in stored ? stored[k] : null),
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  });
  return stored;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('boot theme', () => {
  it('round-trips the mode the user picked', () => {
    const stored = stubPage('');
    rememberBootTheme('acorn');
    expect(stored[BOOT_THEME_KEY]).toBe('acorn');
    expect(rememberedBootTheme()).toBe('acorn');
  });

  it("falls back to 'system' with nothing usable stored", () => {
    stubPage('');
    expect(rememberedBootTheme()).toBe('system');
    stubPage('', { [BOOT_THEME_KEY]: 'junk' });
    expect(rememberedBootTheme()).toBe('system');
    vi.unstubAllGlobals();
    expect(rememberedBootTheme()).toBe('system');
  });

  it("leaves other windows (query string) on 'system'", () => {
    stubPage('?overlay=1', { [BOOT_THEME_KEY]: 'midnight' });
    expect(rememberedBootTheme()).toBe('system');
  });

  it('survives a throwing localStorage', () => {
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(rememberedBootTheme()).toBe('system');
    expect(() => rememberBootTheme('ice')).not.toThrow();
  });

  it('is the ui store default, so the mount does not apply system before config', async () => {
    stubPage('', { [BOOT_THEME_KEY]: 'midnight' });
    const { useUiStore } = await import('./stores/useUiStore');
    expect(useUiStore.getState().themeMode).toBe('midnight');
  });
});
