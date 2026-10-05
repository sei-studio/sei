/**
 * Menu bar / tray setting, renderer side (261005): when the credit wall
 * offers it, and that every new string has its Chinese entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

(globalThis as unknown as { window: unknown }).window = { sei: {} };

const { shouldOfferWallPrompt, loadTraySettings, saveTraySettings } = await import('./traySettings');
const { ZH } = await import('./i18n/zh');

const view = { supported: true, enabled: false, openAtLogin: false, loginNeedsApproval: false, wallPromptSeen: false };

describe('shouldOfferWallPrompt', () => {
  it('offers once, only where supported and only while off', () => {
    expect(shouldOfferWallPrompt(view)).toBe(true);
    expect(shouldOfferWallPrompt({ ...view, wallPromptSeen: true })).toBe(false);
    expect(shouldOfferWallPrompt({ ...view, enabled: true })).toBe(false);
    expect(shouldOfferWallPrompt({ ...view, supported: false })).toBe(false);
    expect(shouldOfferWallPrompt(null)).toBe(false);
  });
});

describe('bridge calls on an older preload', () => {
  it('read as unsupported instead of throwing', async () => {
    expect(await loadTraySettings()).toBeNull();
    expect(await saveTraySettings({ enabled: true, source: 'settings' })).toBeNull();
  });
});

describe('tray copy', () => {
  const files = ['../components/WallTrayPrompt.tsx', '../components/settings/TraySettingsGroup.tsx'];
  const keys = files.flatMap((f) => {
    const src = readFileSync(path.join(__dirname, f), 'utf8');
    return [...src.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)+)\1/g)].map((m) => m[2].replace(/\\'/g, "'"));
  });

  it('finds the strings', () => {
    expect(keys.length).toBeGreaterThan(15);
  });

  it('has a Chinese entry for every string, and no em dash in either language', () => {
    for (const k of keys) {
      expect(ZH[k], k).toBeTruthy();
      expect(k).not.toMatch(/—/);
      expect(ZH[k]).not.toMatch(/—/);
    }
  });
});
