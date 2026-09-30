/**
 * SetupStepper (260909): static renders over fixed step data.
 *   1. setup mode opens on the first step that is not done.
 *   2. help mode opens on step 1 even when later steps are the open ones.
 *   3. every step done: the last step shows (setup mode closes itself via
 *      useSetupWindow, which the panels test), with its check.
 *   4. the count, the dots and the Back/Next labels render; Back is
 *      disabled on the first step.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = { sei: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
});

async function render(done: boolean[], mode: 'setup' | 'help'): Promise<string> {
  const { SetupStepper } = await import('./SetupStepper');
  const steps = done.map((d, i) => ({ id: `s${i + 1}`, title: `Title ${i + 1}`, done: d, body: React.createElement('span', null, `Body ${i + 1}`) }));
  return renderToStaticMarkup(React.createElement(SetupStepper, { steps, mode, onClose: () => undefined, label: 'steps' }));
}

describe('SetupStepper', () => {
  it('Test 1: setup mode opens on the first open step', async () => {
    const html = await render([true, false, false], 'setup');
    expect(html).toContain('data-step="s2"');
    expect(html).toContain('Body 2');
    expect(html).not.toContain('Body 1');
    expect(html).toContain('Step 2 of 3');
  });

  it('Test 2: help mode opens on step 1', async () => {
    const html = await render([true, true, false], 'help');
    expect(html).toContain('data-step="s1"');
    expect(html).toContain('✓ Title 1');
    expect(html).toContain('Step 1 of 3');
  });

  it('Test 3: everything done shows the last step, checked', async () => {
    const html = await render([true, true, true], 'setup');
    expect(html).toContain('data-step="s3"');
    expect(html).toContain('✓ Title 3');
  });

  it('Test 4: nav chrome; Back is disabled on the first step', async () => {
    const html = await render([false, false], 'setup');
    expect(html).toContain('>Back<');
    expect(html).toContain('>Next<');
    expect(html).toContain('aria-label="Close"');
    expect(html.match(/<button[^>]*disabled=""[^>]*>Back</)).not.toBeNull();
  });
});
