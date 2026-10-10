import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOnboardingFunnelForTests,
  observeOnboardingEvent,
  reportOnboardingAbandoned,
  takeOnboardingAbandonment,
} from './onboardingFunnel';

const view = (step: string, index: number, extra: Record<string, string | number | boolean | null> = {}) => ({
  step,
  index,
  action: 'view',
  ms_in_step: 0,
  path: 'new',
  skipped_creation: false,
  ...extra,
});

describe('onboardingFunnel', () => {
  beforeEach(() => _resetOnboardingFunnelForTests());

  it('nothing viewed: a quit reports nothing', () => {
    expect(takeOnboardingAbandonment('quit', 0)).toBeNull();
  });

  it('reports the last viewed step, with time in step and in onboarding', () => {
    observeOnboardingEvent('onboarding_step', view('intro', 0), 1000);
    observeOnboardingEvent('onboarding_step', { ...view('intro', 0), action: 'complete' }, 4000);
    observeOnboardingEvent('onboarding_step', view('name', 5, { path: 'new' }), 4000);
    expect(takeOnboardingAbandonment('quit', 10_000)).toEqual({
      step: 'name',
      index: 5,
      ms_in_step: 6000,
      ms_in_onboarding: 9000,
      steps_viewed: 2,
      path: 'new',
      skipped_creation: false,
      trigger: 'quit',
    });
    // Once.
    expect(takeOnboardingAbandonment('quit', 11_000)).toBeNull();
  });

  it('completed onboarding is never reported, even when later steps are viewed', () => {
    observeOnboardingEvent('onboarding_step', view('setup', 29), 0);
    observeOnboardingEvent('onboarding_completed', { path: 'new' }, 10);
    observeOnboardingEvent('onboarding_step', view('ready', 32), 20);
    expect(takeOnboardingAbandonment('quit', 30)).toBeNull();
  });

  it('a fresh run from the first screen reopens it', () => {
    observeOnboardingEvent('onboarding_completed', { path: 'returning' }, 0);
    observeOnboardingEvent('onboarding_step', view('intro', 0), 100);
    expect(takeOnboardingAbandonment('window_closed', 200)).toMatchObject({ step: 'intro', trigger: 'window_closed' });
  });

  it('the renderer reporting its own abandonment closes it', () => {
    observeOnboardingEvent('onboarding_step', view('auth_form', 19), 0);
    observeOnboardingEvent('onboarding_abandoned', { trigger: 'left_view' }, 5);
    expect(takeOnboardingAbandonment('quit', 10)).toBeNull();
  });

  it('ignores other events and malformed props', () => {
    observeOnboardingEvent('chat_session_ended', { duration_ms: 5 }, 0);
    observeOnboardingEvent('onboarding_step', undefined, 0);
    observeOnboardingEvent('onboarding_step', { action: 'view', step: 7 }, 0);
    expect(takeOnboardingAbandonment('quit', 1)).toBeNull();
  });

  it('reportOnboardingAbandoned captures through the given function', () => {
    const capture = vi.fn();
    observeOnboardingEvent('onboarding_step', view('q_age', 12));
    reportOnboardingAbandoned('quit', capture);
    expect(capture).toHaveBeenCalledWith('onboarding_abandoned', expect.objectContaining({ step: 'q_age', trigger: 'quit' }));
    reportOnboardingAbandoned('quit', capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
