/**
 * Tests for the dedicated skin-setup onboarding step (SkinSetupScreen).
 *
 * Project convention (no @testing-library/react installed): exercise the source
 * contract via grep-style checks across the files that wire the step together.
 * Mirrors CharactersScreen.test.tsx / ReceiptScreen.test.tsx.
 *
 * Invariants under test:
 *   1. SkinSetupScreen exists and reuses the wizard step machine inline.
 *   2. It finalizes by clearing UserConfig.skin_setup_pending and routing to
 *      home on the World tab (and offers a "Skip for now").
 *   3. The `skin-setup` view exists in the UI store's View union.
 *   4. UserConfigSchema carries the `skin_setup_pending` gate.
 *   5. OnboardingScreen sets skin_setup_pending on a fresh submit and routes to
 *      the skin-setup step (not straight home).
 *   6. App.tsx renders SkinSetupScreen, hides the IconRail for it, suppresses the
 *      global wizard modal there, and resumes the step while skin_setup_pending.
 *   7. SetupWizardModal exports the reusable WizardStepMachine.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error node module under renderer tsconfig
import { readFileSync } from 'node:fs';
// @ts-expect-error node module under renderer tsconfig
import { fileURLToPath } from 'node:url';
// @ts-expect-error node module under renderer tsconfig
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const r = (...p: string[]): string => readFileSync(resolve(REPO_ROOT, ...p), 'utf-8');

const SCREEN = r('src', 'renderer', 'src', 'screens', 'SkinSetupScreen.tsx');
const STORE = r('src', 'renderer', 'src', 'lib', 'stores', 'useUiStore.ts');
const SCHEMA = r('src', 'shared', 'characterSchema.ts');
const ONBOARD = r('src', 'renderer', 'src', 'screens', 'OnboardingScreen.tsx');
const APP = r('src', 'renderer', 'src', 'App.tsx');
const WIZARD = r('src', 'renderer', 'src', 'components', 'SetupWizardModal.tsx');

describe('SkinSetupScreen — dedicated onboarding step', () => {
  it('Test 1: screen exists and renders the wizard step machine inline', () => {
    expect(/export\s+function\s+SkinSetupScreen\s*\(/.test(SCREEN)).toBe(true);
    expect(SCREEN.includes('WizardStepMachine')).toBe(true);
    expect(SCREEN.includes('openWizard(false)')).toBe(true);
  });

  it('Test 2: finalize clears skin_setup_pending and routes to the Home tab + offers skip', () => {
    expect(SCREEN.includes('skin_setup_pending: false')).toBe(true);
    expect(SCREEN.includes("setHomeTab('home')")).toBe(true);
    expect(SCREEN.includes("navigate({ kind: 'home' })")).toBe(true);
    expect(SCREEN.includes('Skip for now')).toBe(true);
  });

  it('Test 3: View union carries the skin-setup view', () => {
    expect(STORE.includes("kind: 'skin-setup'")).toBe(true);
  });

  it('Test 4: UserConfigSchema carries the skin_setup_pending gate', () => {
    expect(/skin_setup_pending:\s*z\.boolean\(\)/.test(SCHEMA)).toBe(true);
  });

  it('Test 5: OnboardingScreen sets the gate and routes to the skin-setup step', () => {
    expect(ONBOARD.includes('skin_setup_pending: !isReonboard')).toBe(true);
    expect(ONBOARD.includes("navigate({ kind: 'skin-setup' })")).toBe(true);
  });

  it('Test 6: App.tsx renders, isolates, and resumes the step', () => {
    expect(APP.includes('<SkinSetupScreen />')).toBe(true);
    // IconRail hidden for the full-page step — now via the shared `railHidden`
    // flag (which includes 'skin-setup'); the rail is gated on `!railHidden`.
    expect(/const railHidden =[\s\S]*?'skin-setup'/.test(APP)).toBe(true);
    expect(APP.includes('!railHidden ? <IconRail />')).toBe(true);
    // Global wizard modal suppressed while the page drives it inline.
    expect(APP.includes("view.kind !== 'skin-setup' ? <SetupWizardModal />")).toBe(true);
    // Resume routing keys on skin_setup_pending.
    expect(APP.includes('skin_setup_pending === true')).toBe(true);
    expect(APP.includes("navigate({ kind: 'skin-setup' })")).toBe(true);
  });

  it('Test 7: SetupWizardModal exports the reusable WizardStepMachine', () => {
    expect(/export\s+function\s+WizardStepMachine\s*\(/.test(WIZARD)).toBe(true);
  });
});
