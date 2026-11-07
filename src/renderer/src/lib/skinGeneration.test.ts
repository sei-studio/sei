/**
 * 261027 lazy skins: the launch panel and profile copy. Every failure says
 * the companion still plays (with the simple skin), the button says it costs
 * credits, and nothing has a zh gap or an em dash.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SkinGenOutcome } from '@shared/ipc';

vi.mock('./ipcClient', () => ({ sei: {} }));

const { skinPrepLine, skinFailureLine, canGenerateSkin } = await import('./skinGeneration');
const { skinButtonResultLine } = await import('../components/SkinGenerateButton');
const { ZH } = await import('./i18n/zh');

const OUTCOMES: SkinGenOutcome[] = [
  'generated',
  'insufficient_credits',
  'daily_limit',
  'failed',
  'not_signed_in',
  'no_portrait',
  'not_allowed',
  'skipped',
];

/** Records the English keys asked for and fills {name}. */
function recorder(): { t: (k: string, v?: Record<string, string | number>) => string; keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    t: (k, v) => {
      keys.add(k);
      return k.replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? ''));
    },
  };
}

describe('launch panel skin line', () => {
  it('says the skin is being made while it runs, nothing when idle', () => {
    const { t } = recorder();
    expect(skinPrepLine({ kind: 'running' }, 'Nova', t)).toBe("Making Nova's Minecraft skin...");
    expect(skinPrepLine({ kind: 'idle' }, 'Nova', t)).toBeNull();
  });

  it('every billing or network failure says the companion still comes, with a simple skin', () => {
    const { t } = recorder();
    for (const o of ['insufficient_credits', 'daily_limit', 'failed'] as const) {
      expect(skinPrepLine({ kind: 'done', outcome: o }, 'Nova', t)).toMatch(/simple one for now/);
    }
    expect(skinPrepLine({ kind: 'done', outcome: 'generated' }, 'Nova', t)).toBeNull();
    expect(skinPrepLine({ kind: 'done', outcome: 'not_allowed' }, 'Nova', t)).toBeNull();
  });
});

describe('who may make a skin', () => {
  it('own companions only: not defaults, not other people\'s (World / shared) characters', () => {
    expect(canGenerateSkin({ is_default: false, owner: 'me' }, 'me')).toBe(true);
    expect(canGenerateSkin({ is_default: false, owner: null }, 'me')).toBe(true);
    expect(canGenerateSkin({ is_default: false, owner: null }, null)).toBe(true);
    expect(canGenerateSkin({ is_default: false, owner: 'someone' }, 'me')).toBe(false);
    expect(canGenerateSkin({ is_default: false, owner: 'someone' }, null)).toBe(false);
    expect(canGenerateSkin({ is_default: true, owner: null }, 'me')).toBe(false);
  });
});

describe('profile button result line', () => {
  it('a failed regenerate keeps the current skin', () => {
    const { t } = recorder();
    expect(skinButtonResultLine('insufficient_credits', 'Nova', t)).toMatch(/current skin stays/);
    expect(skinButtonResultLine('failed', 'Nova', t)).toMatch(/current skin stays/);
    expect(skinButtonResultLine('not_allowed', 'Nova', t)).toBe("Only Nova's creator can make their skin.");
  });
});

describe('copy hygiene', () => {
  it('every string has zh and no em dash, placeholders kept', () => {
    const { t, keys } = recorder();
    for (const o of OUTCOMES) {
      skinFailureLine(o, 'Nova', t);
      skinButtonResultLine(o, 'Nova', t);
    }
    skinPrepLine({ kind: 'running' }, 'Nova', t);
    for (const k of [
      'Generate Minecraft skin',
      'Regenerate skin',
      'Making skin...',
    ]) keys.add(k);
    expect(keys.size).toBeGreaterThan(8);
    for (const k of keys) {
      expect(ZH[k], k).toBeTruthy();
      expect(k).not.toContain('—');
      expect(ZH[k]).not.toContain('—');
      for (const ph of k.match(/\{\w+\}/g) ?? []) expect(ZH[k], k).toContain(ph);
    }
  });
});
