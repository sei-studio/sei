/**
 * china-compat W9 — the renderer vision gate: the shared reason copy and the
 * three entry points that must lock on a confident 'no' and NEVER on
 * 'unknown' (BYOK Anthropic before any capability fetch must not lose
 * backseat or Draw!).
 *
 * The helper is exercised directly; the components are pinned grep-style
 * (project convention, no @testing-library/react — mirrors IconRail.test.tsx
 * and UsageBar.test.tsx).
 *
 * Invariants under test:
 *   1. visionBlocked locks only on 'no'.
 *   2. visionGateReason names the model when known and degrades without one;
 *      no em dashes in the copy.
 *   3. GamesPickerModal locks the Draw! tile (dimmed, disabled, reason shown)
 *      instead of hiding it.
 *   4. ChatTopBar disables the Backseat button with the reason as its title.
 *   5. CallControls disables the share pill with the reason, but never blocks
 *      STOPPING an already-running share.
 *   6. Both stores map the main-side backstop tokens to the same copy.
 *   7. Every reason string has a zh dictionary entry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { visionBlocked, visionGateReason, type Translate } from './visionGate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf-8');

/** English-identity translator, like the app with lang 'en'. */
const t: Translate = (en, params) => {
  let out = en;
  for (const [k, v] of Object.entries(params ?? {})) out = out.split(`{${k}}`).join(String(v));
  return out;
};

describe('visionBlocked', () => {
  it("Test 1: locks only on 'no' — 'unknown' must stay usable", () => {
    expect(visionBlocked('no')).toBe(true);
    expect(visionBlocked('yes')).toBe(false);
    expect(visionBlocked('unknown')).toBe(false);
  });
});

describe('visionGateReason', () => {
  it('Test 2: names the model when known', () => {
    expect(visionGateReason(t, 'draw', 'deepseek-v4-flash')).toBe(
      'Draw! needs a model that can see images. Your current model (deepseek-v4-flash) does not support vision.',
    );
    expect(visionGateReason(t, 'backseat', 'deepseek-v4-flash')).toBe(
      'Screen sharing needs a model that can see images. Your current model (deepseek-v4-flash) does not support vision.',
    );
  });

  it('Test 2b: degrades gracefully without a model name', () => {
    expect(visionGateReason(t, 'draw', null)).toBe(
      'Draw! needs a model that can see images. Your current model does not support vision.',
    );
    expect(visionGateReason(t, 'backseat', null)).toBe(
      'Screen sharing needs a model that can see images. Your current model does not support vision.',
    );
  });

  it('Test 2c: no em dashes in the user-facing copy', () => {
    for (const surface of ['draw', 'backseat'] as const) {
      expect(visionGateReason(t, surface, 'm')).not.toContain('—');
      expect(visionGateReason(t, surface, null)).not.toContain('—');
    }
  });
});

describe('GamesPickerModal locks the Draw! tile', () => {
  const source = read('../components/GamesPickerModal.tsx');

  it('Test 3: reads llmVision + llmModel and locks only the draw tile', () => {
    expect(source.includes('s.llmVision')).toBe(true);
    expect(source.includes('s.llmModel')).toBe(true);
    expect(source.includes("g.id === 'draw' && drawVisionLocked")).toBe(true);
  });

  it('Test 3b: the locked tile is dimmed and disabled, never hidden', () => {
    expect(source.includes('styles.tileLocked')).toBe(true);
    expect(source.includes('disabled={!g.available || visionLocked}')).toBe(true);
  });

  it('Test 3c: the reason rides the existing info popup', () => {
    expect(source.includes("visionGateReason(t, 'draw', llmModel)")).toBe(true);
  });
});

describe('ChatTopBar disables the Backseat button', () => {
  const source = read('../components/ChatTopBar.tsx');

  it('Test 4: gated on visionBlocked with the reason as the title', () => {
    expect(source.includes('visionBlocked(useUiStore((s) => s.llmVision))')).toBe(true);
    expect(source.includes("visionGateReason(t, 'backseat', llmModel)")).toBe(true);
    expect(source.includes('disabled={backseatBlocked}')).toBe(true);
    expect(source.includes('title={backseatReason ?? undefined}')).toBe(true);
  });
});

describe('CallControls disables the share pill', () => {
  const source = read('../components/call/CallControls.tsx');

  it('Test 5: gated on visionBlocked; stopping a live share is never blocked', () => {
    expect(source.includes('visionBlocked(useUiStore((s) => s.llmVision))')).toBe(true);
    expect(source.includes('startingShare || shareVisionBlocked')).toBe(true);
    // The reason only arms while NOT sharing, so the stop path stays live.
    expect(source.includes('shareVisionBlocked && !sharing')).toBe(true);
  });
});

describe('store error mapping (the main-side backstops surface as the same copy)', () => {
  it('Test 6: useDrawStore maps DRAW_LLM_NO_VISION', () => {
    const source = read('./stores/useDrawStore.ts');
    expect(source.includes('DRAW_ERR_NO_VISION')).toBe(true);
    expect(source.includes("visionGateReason(t, 'draw'")).toBe(true);
  });

  it('Test 6b: useBackseatStore maps LLM_NO_VISION', () => {
    const source = read('./stores/useBackseatStore.ts');
    expect(source.includes("msg.includes('LLM_NO_VISION')")).toBe(true);
    expect(source.includes("visionGateReason(t, 'backseat'")).toBe(true);
  });
});

describe('zh dictionary coverage', () => {
  it('Test 7: every reason string has a zh entry', async () => {
    const { ZH } = await import('./i18n/zh');
    const keys = [
      'Draw! needs a model that can see images. Your current model ({model}) does not support vision.',
      'Draw! needs a model that can see images. Your current model does not support vision.',
      'Screen sharing needs a model that can see images. Your current model ({model}) does not support vision.',
      'Screen sharing needs a model that can see images. Your current model does not support vision.',
    ];
    for (const key of keys) {
      expect(ZH[key], `missing zh entry for: ${key}`).toBeTruthy();
      expect(ZH[key]).not.toContain('—');
    }
    // {model} must survive translation verbatim (dictionary rule).
    expect(ZH[keys[0]]).toContain('{model}');
    expect(ZH[keys[2]]).toContain('{model}');
  });
});
