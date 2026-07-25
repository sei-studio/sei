/**
 * Tests for UsageBar — the weekly-allowance usage bar (260724).
 *
 * Project convention (no @testing-library/react installed): exercise the
 * source contract via grep-style checks plus a module-import smoke. Mirrors
 * IconRail.test.tsx.
 *
 * Invariants under test:
 *   1. Exports a UsageBar function symbol.
 *   2. Feeds usage_pct from the store into PercentBar and turns it red when
 *      the weekly allowance is spent.
 *   3. No estimates and no money: no playtime plumbing, no dollar helpers.
 *   4. A quiet refresh affordance is wired (RefreshIcon + refresh()).
 *   5. The tooltip reports time actually PLAYED, never time remaining.
 *   6. CSS module defines the row layout (.root / .barWrap).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('UsageBar (weekly-allowance usage bar)', () => {
  it('Test 1: exports the UsageBar function', async () => {
    const mod = await import('./UsageBar');
    expect(typeof mod.UsageBar).toBe('function');
  });

  it('Test 2: feeds usage_pct into PercentBar (the usage % progress bar)', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes("from './PercentBar'")).toBe(true);
    expect(source.includes('s.usage_pct')).toBe(true);
    // A failed snapshot must not present the placeholder zeros as account
    // truth (260710): the bar empties and the copy says to try again.
    expect(source.includes('value={snapshotFailed ? 0 : usagePct}')).toBe(true);
    expect(source.includes('s.snapshotFailed')).toBe(true);
  });

  it('Test 2b: the bar goes red once the weekly allowance is spent', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('s.over_limit')).toBe(true);
    expect(source.includes('overLimit=')).toBe(true);
  });

  it('Test 3: no playtime estimate and no money plumbing rides the bar', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    // 260724: playtimeEstimate.ts is deleted; the weekly model meters an
    // allowance, so there is no "~Xh left" figure to derive.
    expect(source.includes('tokensRemainingToPlaytime')).toBe(false);
    expect(source.includes('VISION_MULTIPLIER')).toBe(false);
    expect(source.includes('remaining_tokens')).toBe(false);
    // No dollar figures: those live only on the plan cards, the top up
    // packages and the legally required purchase disclosures.
    expect(source.includes('used_usd')).toBe(false);
    expect(source.includes('total_usd')).toBe(false);
  });

  it('Test 4: a quiet refresh affordance is wired', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('RefreshIcon')).toBe(true);
    expect(source.includes('s.refresh')).toBe(true);
    expect(source.includes('aria-label=')).toBe(true);
  });

  it('Test 5: the bar tooltip reports time PLAYED, never time remaining', () => {
    const source = readFileSync(TSX_PATH, 'utf-8');
    expect(source.includes('usageTooltip(')).toBe(true);
    expect(source.includes('data-tip={tooltip}')).toBe(true);
    expect(source.includes('total_playtime_ms')).toBe(true);
    // Never render a raw token count, raw micros, or a "left" estimate.
    expect(source.includes('µ$')).toBe(false);
    expect(/~\$\{?[A-Za-z]*h? ?left/.test(source)).toBe(false);
    expect(source.includes("'left'")).toBe(false);
  });

  it('Test 8: the tooltip helper formats time played', async () => {
    const { formatPlayed, usageTooltip } = await import('./UsageBar');
    expect(formatPlayed(11_820_000)).toBe('3h 17m'); // 3h17m
    expect(formatPlayed(0)).toBe('0h 0m');
    expect(formatPlayed(45 * 60_000)).toBe('0h 45m');
    expect(usageTooltip(11_820_000)).toBe('Played 3h 17m total');
    expect(usageTooltip(0)).toBe('Played 0h 0m total');
  });

  it('Test 6: CSS module defines the row layout', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css.includes('.root')).toBe(true);
    expect(css.includes('.barWrap')).toBe(true);
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
