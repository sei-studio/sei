/**
 * The "Use ChatGPT plan" switch intent is one-shot (261029 review): it waits
 * only while something is still loading and is dropped once the plan turns
 * out not to be ready, so a declined plan never leaves it set.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatgptStatus } from '@shared/chatgptPlan';
vi.mock('./ipcClient', () => ({ sei: {} }));

const { chatgptPlanIntentStep } = await import('./chatgptPlanIntent');

const status = (signedIn: boolean, planEnabled: boolean): ChatgptStatus => ({
  accounts: [{ id: 'a1', email: null, label: 'ChatGPT account', signedIn, planEnabled }],
  activeId: 'a1',
  signingIn: false,
  usageLimited: false,
  blockedCode: null,
  welcomeSeen: true,
  models: [],
});

describe('chatgptPlanIntentStep', () => {
  it('waits while config, plan status or backend mode are still loading', () => {
    expect(chatgptPlanIntentStep(false, status(true, true), 'local')).toBe('wait');
    expect(chatgptPlanIntentStep(true, null, 'local')).toBe('wait');
    expect(chatgptPlanIntentStep(true, status(true, true), null)).toBe('wait');
  });

  it('drops the intent when the plan is not ready (plan use declined, or signed out)', () => {
    expect(chatgptPlanIntentStep(true, status(true, false), 'cloud-proxy')).toBe('drop');
    expect(chatgptPlanIntentStep(true, status(false, true), 'local')).toBe('drop');
  });

  it('runs the switch through the backend-specific path when ready', () => {
    expect(chatgptPlanIntentStep(true, status(true, true), 'cloud-proxy')).toBe('confirm-cloud');
    expect(chatgptPlanIntentStep(true, status(true, true), 'local')).toBe('pick-local');
  });
});
