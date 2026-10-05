import { describe, expect, it } from 'vitest';
import {
  LINE_STEPS,
  ONBOARD_STEPS,
  OnboardStepTracker,
  leaveAction,
  stepFor,
  stepIndex,
} from './onboardSteps';

const SUB = { needsTos: false, auth: 'form', local: 'key', setupError: false } as const;

function harness(ctx = { path: 'new', skipped_creation: false }) {
  let t = 1000;
  const events: Array<{ event: string; props: Record<string, unknown> }> = [];
  const tracker = new OnboardStepTracker(
    (event, props) => events.push({ event, props }),
    () => t,
    () => ctx,
  );
  return {
    tracker,
    events,
    tick: (ms: number) => {
      t += ms;
    },
    steps: () => events.filter((e) => e.event === 'onboarding_step').map((e) => `${e.props.step}:${e.props.action}`),
  };
}

describe('step names', () => {
  it('every script line maps to a known step, and names are unique snake_case', () => {
    for (const step of Object.values(LINE_STEPS)) expect(ONBOARD_STEPS).toContain(step);
    expect(new Set(ONBOARD_STEPS).size).toBe(ONBOARD_STEPS.length);
    for (const s of ONBOARD_STEPS) expect(s).toMatch(/^[a-z][a-z_]*$/);
  });

  it('stepFor maps phases and panel sub-screens; transitions are null', () => {
    expect(stepFor({ k: 'intro' }, SUB)).toBe('intro');
    expect(stepFor({ k: 'line', id: 'qDyn' }, SUB)).toBe('q_dynamics');
    expect(stepFor({ k: 'auth' }, { ...SUB, auth: 'code' })).toBe('auth_code');
    expect(stepFor({ k: 'auth' }, { ...SUB, auth: 'code', needsTos: true })).toBe('auth_tos');
    expect(stepFor({ k: 'local-setup' }, { ...SUB, local: 'stt' })).toBe('local_stt');
    expect(stepFor({ k: 'setup' }, { ...SUB, setupError: true })).toBe('setup_error');
    expect(stepFor({ k: 'welcome-existing' }, SUB)).toBe('welcome_existing');
    for (const k of ['walkoff', 'return', 'no-account', 'fade'] as const) expect(stepFor({ k }, SUB)).toBeNull();
  });

  it('leaveAction: explicit mark wins, an earlier step is back, else complete', () => {
    expect(leaveAction('name', 'are_you_new', null)).toBe('back');
    expect(leaveAction('name', 'name_ack', null)).toBe('complete');
    expect(leaveAction('no_account', 'are_you_new', 'complete')).toBe('complete');
    expect(leaveAction('job', 'skip_confirm', 'skip')).toBe('skip');
    expect(stepIndex('intro')).toBe(0);
  });
});

describe('OnboardStepTracker', () => {
  it('emits view on enter and the leave action with time in step', () => {
    const h = harness();
    h.tracker.enter('hey');
    h.tick(1500);
    h.tracker.enter('run_place');
    h.tick(10);
    h.tracker.enter('hey');
    expect(h.steps()).toEqual(['hey:view', 'hey:complete', 'run_place:view', 'run_place:back', 'hey:view']);
    const left = h.events[1].props;
    expect(left).toMatchObject({ step: 'hey', index: stepIndex('hey'), ms_in_step: 1500, path: 'new', skipped_creation: false });
  });

  it('null and repeated keys keep the open step (transitions, StrictMode double effects)', () => {
    const h = harness();
    h.tracker.enter('skipped_third');
    h.tracker.enter(null);
    h.tracker.enter('skipped_third');
    h.tick(3000);
    h.tracker.enter('auth_form');
    expect(h.steps()).toEqual(['skipped_third:view', 'skipped_third:complete', 'auth_form:view']);
    expect(h.events[1].props.ms_in_step).toBe(3000);
  });

  it('a mark applies to the next leave only', () => {
    const h = harness();
    h.tracker.enter('job');
    h.tracker.mark('skip');
    h.tracker.enter('skip_confirm');
    h.tracker.enter('auth_form');
    expect(h.steps()).toEqual(['job:view', 'job:skip', 'skip_confirm:view', 'skip_confirm:complete', 'auth_form:view']);
  });

  it('finish closes the open step and silences everything after', () => {
    const h = harness();
    h.tracker.enter('ready');
    h.tick(200);
    h.tracker.finish('complete');
    h.tracker.enter('intro');
    h.tracker.abandon('left_view');
    expect(h.steps()).toEqual(['ready:view', 'ready:complete']);
    expect(h.events.some((e) => e.event === 'onboarding_abandoned')).toBe(false);
  });

  it('abandon reports where it stopped, once', () => {
    const h = harness({ path: 'byok', skipped_creation: true });
    h.tracker.enter('intro');
    h.tick(100);
    h.tracker.enter('local_key');
    h.tick(400);
    h.tracker.abandon('left_view');
    h.tracker.abandon('left_view');
    const ab = h.events.filter((e) => e.event === 'onboarding_abandoned');
    expect(ab).toHaveLength(1);
    expect(ab[0].props).toMatchObject({
      step: 'local_key',
      ms_in_step: 400,
      ms_in_onboarding: 500,
      steps_viewed: 2,
      path: 'byok',
      skipped_creation: true,
      trigger: 'left_view',
    });
  });

  it('a throwing track never escapes', () => {
    const tracker = new OnboardStepTracker(
      () => {
        throw new Error('bridge gone');
      },
      () => 0,
      () => ({ path: 'new', skipped_creation: false }),
    );
    expect(() => {
      tracker.enter('intro');
      tracker.finish();
    }).not.toThrow();
  });
});
