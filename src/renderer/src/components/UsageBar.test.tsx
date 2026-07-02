/**
 * Tests for UsageBar — 260602-hbr.
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style checks plus a module-import smoke. Mirrors
 * IconRail.test.tsx.
 *
 * Invariants under test:
 *   1. Exports a UsageBar function symbol + an ESTIMATE_TOOLTIP string that
 *      says the figure is only an estimate.
 *   2. Feeds usage_pct from the store into PercentBar (the usage % bar).
 *   3. Derives the "~Xh left" estimate from remaining_tokens via the flat
 *      tokensRemainingToPlaytime() multiplier — no tokens_per_min plumbing.
 *   4. Wires the estimate tooltip (title + aria-label) and renders {display}.
 *   5. PROXY-05: no raw token/dollar COUNTS surfaced (percent + time only).
 *   6. CSS module defines the row layout (.root / .barWrap / .estimate).
 */

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error node module under renderer tsconfig
import { readFileSync } from 'node:fs';
// @ts-expect-error node module under renderer tsconfig
import { fileURLToPath } from 'node:url';
// @ts-expect-error node module under renderer tsconfig
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_PATH = resolve(__dirname, 'UsageBar.tsx');
const CSS_PATH = resolve(__dirname, 'UsageBar.module.css');
const PERCENT_BAR_CSS_PATH = resolve(__dirname, 'PercentBar.module.css');

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    sei: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

describe('UsageBar (260602-hbr usage-percent bar)', () => {
  it('Test 1: exports UsageBar function + an estimate-disclaimer tooltip', async () => {
    const mod = await import('./UsageBar');
    expect(typeof mod.UsageBar).toBe('function');
    expect(mod.ESTIMATE_TOOLTIP.toLowerCase()).toContain('estimate');
    expect(mod.ESTIMATE_TOOLTIP.toLowerCase()).toContain('actual playtime can vary');
  });

  it('Test 2: feeds usage_pct into PercentBar (the usage % progress bar)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes("from './PercentBar'")).toBe(true);
    expect(source.includes('s.usage_pct')).toBe(true);
    expect(source.includes('value={usagePct}')).toBe(true);
  });

  it('Test 3: derives the estimate from remaining_tokens via the flat rate (+ D-07 vision shrink)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('s.remaining_tokens')).toBe(true);
    // The estimate is derived from remaining_tokens via tokensRemainingToPlaytime.
    // Phase 15 (D-07): the second arg is now a `rate` that shrinks via
    // VISION_MULTIPLIER when Looking is 'continuous' (read from vision_mode), and
    // equals the flat DEFAULT_TOKENS_PER_MIN otherwise — no regression.
    expect(source.includes('tokensRemainingToPlaytime(remainingTokens, rate)')).toBe(true);
    expect(source.includes('VISION_MULTIPLIER')).toBe(true);
    expect(source.includes('vision_mode')).toBe(true);
    // No per-user tokens_per_min plumbing reaches the component.
    expect(source.includes('tokens_per_min')).toBe(false);
  });

  it('Test 4: estimate tooltip + rendered display string are wired', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('title={ESTIMATE_TOOLTIP}')).toBe(true);
    expect(source.includes('aria-label=')).toBe(true);
    expect(source.includes('{display}')).toBe(true);
  });

  it('Test 5: bar tooltip shows $used/$total + played time (260615 owner-approved PROXY-05 exception)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // The bar (barWrap) now carries a usageTooltip with $used/$total + played.
    expect(source.includes('usageTooltip(')).toBe(true);
    expect(source.includes('data-tip={tooltip}')).toBe(true);
    expect(source.includes('s.used_usd')).toBe(true);
    expect(source.includes('total_playtime_ms')).toBe(true);
    // Still never render a raw token count or raw micros into the markup.
    expect(source.includes('{remainingTokens}')).toBe(false);
    expect(source.includes('µ$')).toBe(false);
  });

  it('Test 8: usage-tooltip helpers format dollars + played time', async () => {
    const { formatUsd, formatPlayed, usageTooltip } = await import('./UsageBar');
    expect(formatUsd(1.2)).toBe('$1.20');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('$—');
    expect(formatPlayed(11_820_000)).toBe('3h 17m'); // 3h17m
    expect(formatPlayed(0)).toBe('0h 0m');
    expect(formatPlayed(45 * 60_000)).toBe('0h 45m');
    expect(usageTooltip(1.2, 5, 11_820_000)).toBe('$1.20/$5.00 used, played 3h 17m');
    expect(usageTooltip(undefined, undefined, 0)).toBe('$—/$— used, played 0h 0m');
  });

  it('Test 6: CSS module defines the row layout', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.root')).toBe(true);
    expect(css.includes('.barWrap')).toBe(true);
    expect(css.includes('.estimate')).toBe(true);
    expect(css.includes('display: flex')).toBe(true);
  });

  it('Test 7: 260602-uv9 — PercentBar track is visibly distinct (inset var(--border) outline)', () => {
    // The unused portion of the usage bar must read against the page background
    // in both themes. PercentBar .root carries a 1px inset var(--border) outline
    // and an elevated theme-token track. Strip comment-body lines (start with
    // ' *') so we only match real CSS, mirroring the plan's verify grep.
    const css = readFileSync(PERCENT_BAR_CSS_PATH, 'utf-8');
    const cssNoCommentBody = css
      .split('\n')
      .filter((line: string) => !/^\s*\*/.test(line))
      .join('\n');
    expect(cssNoCommentBody.includes('var(--border)')).toBe(true);
    expect(cssNoCommentBody.includes('inset 0 0 0 1px var(--border)')).toBe(true);
    // Track tone uses a real theme token (no raw hex; the undefined --bg-2 is gone).
    expect(cssNoCommentBody.includes('var(--surface-2)')).toBe(true);
    expect(cssNoCommentBody.includes('var(--bg-2)')).toBe(false);
    // No raw hex anywhere in the file (theme tokens only).
    expect(/#[0-9a-fA-F]{3,8}\b/.test(cssNoCommentBody)).toBe(false);
  });
});
