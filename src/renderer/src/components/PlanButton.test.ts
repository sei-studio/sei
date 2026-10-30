/**
 * Tests for PlanButton, the big buy / upgrade button on the plan surfaces
 * (261023). Grep-style source checks, the project convention (no
 * @testing-library/react installed).
 *
 * Invariants:
 *   P.1 — reduced motion drops the lift, press and shine but keeps the colour
 *         transitions.
 *   P.2 — every checkout entry point renders a PlanButton: the plan cards, the
 *         credit packs and the usage-limit popup.
 *   P.3 — the recommended badge only shows on an upgrade target, so a Party
 *         subscriber's own card never reads "Recommended".
 *   P.4 — new labels have a zh translation.
 *   P.5 — flat and borderless (Shawn, 261027): no top highlight, no gradient
 *         band, no shadow under the primary, no border line on either kind.
 *   P.6 — the primary carries the old Summon glint (ef346069 .deployBtn), on a
 *         1.8s loop (261027, was 3.4s) scaled by --flux, moved by transform,
 *         and not on a disabled button. Every glint shares one phase (Shawn,
 *         261027: the plan buttons sweep together), no offset class.
 *   P.7 — the primary fill is its own --plan-cta token family (the old
 *         Summon blue), set in every theme and falling back to --accent.
 *         On midnight the global accent itself is brighter (261027), so the
 *         plan tokens point at it; ice keeps its calmer global accent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf-8');

const CSS = read('PlanButton.module.css');
const CREDITS = read('../screens/CreditsScreen.tsx');
const TOPUP = read('TopUpModal.tsx');
const HARDSTOP = read('HardStopModal.tsx');
const TOKENS = read('../styles/tokens.css');
const PLANBUTTON = read('PlanButton.tsx');
const ZH = read('../lib/i18n/zh/screens-b.ts') + read('../lib/i18n/zh/modals.ts');

describe('PlanButton', () => {
  it('P.1 reduced motion removes movement and the shine', () => {
    const idx = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(idx).toBeGreaterThan(-1);
    const block = CSS.slice(idx);
    expect(block).toMatch(/transform:\s*none/);
    expect(block).toMatch(/\.primary::after\s*\{\s*display:\s*none/);
    expect(block).toMatch(/background-color 180ms/);
  });

  it('P.2 every checkout entry point uses PlanButton', () => {
    expect(CREDITS).toMatch(/<PlanButton[\s\S]*?onClick=\{\(\) => handlePlanSelect\(card\.tier/);
    expect(TOPUP).toMatch(/<PlanButton[\s\S]*?Buy for \{price\}/);
    expect(HARDSTOP).toMatch(/<PlanButton[^>]*onClick=\{handleUpgrade\}/);
    expect(HARDSTOP).toMatch(/<PlanButton[^>]*onClick=\{handleTopUp\}/);
  });

  it('P.3 the recommended badge is gated on an upgrade', () => {
    expect(CREDITS).toMatch(/card\.tier === RECOMMENDED_TIER && isUpgrade/);
  });

  it('P.4 new labels are translated to zh', () => {
    for (const key of ['Get {name}', 'Upgrade to {name}', 'Resume {name}', 'Recommended', 'Buy for {price}']) {
      expect(ZH).toContain(`'${key}':`);
    }
  });

  it('P.5 no top highlight, gradient band, shadow or border line', () => {
    const noReducedMotion = CSS.slice(0, CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(noReducedMotion).not.toMatch(/box-shadow/);
    expect(noReducedMotion).not.toMatch(/border-color/);
    expect(noReducedMotion).not.toMatch(/filter:/);
    // The only gradient left is the glint inside .primary::after.
    const gradients = noReducedMotion.match(/linear-gradient/g) ?? [];
    expect(gradients).toHaveLength(1);
    expect(noReducedMotion).toMatch(/\.primary::after\s*\{[^}]*linear-gradient/);
  });

  it('P.6 the old Summon glint loops on the primary', () => {
    expect(CSS).toMatch(/\.primary::after\s*\{[^}]*animation:\s*plan-glint calc\(1\.8s \/ var\(--flux, 1\)\)/);
    const keyframes = CSS.slice(CSS.indexOf('@keyframes plan-glint'));
    expect(keyframes).toMatch(/0%,\s*45%\s*\{\s*transform: translateX\(-115%\)/);
    expect(keyframes).toMatch(/92%,\s*100%\s*\{\s*transform: translateX\(250%\)/);
    expect(keyframes.slice(0, keyframes.indexOf('}\n}'))).not.toMatch(/left:/);
    expect(CSS).toMatch(/\.primary:disabled::after\s*\{\s*display:\s*none/);
    // In sync: no per-button delay anywhere, and each glint is pinned to the
    // document timeline's zero so a button that mounts later joins the phase.
    expect(CSS).not.toMatch(/animation-delay/);
    expect(CSS).not.toMatch(/glintOffset/);
    expect(CREDITS + TOPUP).not.toMatch(/glintOffset/);
    expect(PLANBUTTON).toMatch(/animationName\.includes\('plan-glint'\)\) a\.startTime = 0/);
  });

  it('P.7 the primary uses its own --plan-cta fill, per theme', () => {
    expect(CSS).toMatch(/\.primary\s*\{[^}]*background-color:\s*var\(--plan-cta, var\(--accent\)\)/);
    expect(CSS).toMatch(/\.primary\s*\{[^}]*color:\s*var\(--plan-cta-text, var\(--accent-text\)\)/);
    const blocks = TOKENS.split(/(?=:root\[data-theme=")/).slice(1);
    const themes = blocks.map((b) => /data-theme="(\w+)"/.exec(b)?.[1]);
    expect(themes).toEqual(['ice', 'midnight', 'acorn', 'mint']);
    for (const b of blocks) {
      for (const tok of ['--plan-cta:', '--plan-cta-strong:', '--plan-cta-text:']) expect(b).toContain(tok);
    }
    // Midnight's global accent is the brighter middle blue (261027), and the
    // plan buttons follow it there.
    expect(blocks[1]).toMatch(/--accent:\s*#76a6f0/);
    expect(blocks[1]).toMatch(/--plan-cta:\s*var\(--accent\)/);
    // Ice keeps the calmer global accent; only its plan buttons are brighter.
    expect(blocks[0]).toMatch(/--plan-cta:\s*#3f7fd6/);
    expect(blocks[0]).toMatch(/--accent:\s*#3f6fc4/);
  });
});
