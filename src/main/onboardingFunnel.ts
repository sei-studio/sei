/**
 * `onboarding_abandoned` on quit (261005).
 *
 * The renderer reports each onboarding screen (`onboarding_step`, see
 * src/renderer/src/onboard/onboardSteps.ts) and can report leaving the view,
 * but a QUIT kills the renderer before it can say anything. Main outlives it,
 * so main watches the renderer's onboarding events as they pass through the
 * analytics:track handler and, at before-quit (ahead of the flush), sends
 * `onboarding_abandoned` for an onboarding that viewed a step and never
 * completed. On macOS a closed last window leaves the app resident and the
 * onboarding view gone, which is the same thing for this funnel.
 *
 * Pure apart from its module state; `now` and `capture` are passed in.
 */

type Scalar = string | number | boolean | null;

interface FunnelState {
  step: string;
  index: number | null;
  path: string | null;
  skippedCreation: boolean | null;
  startedAt: number;
  enteredAt: number;
  stepsViewed: number;
}

let state: FunnelState | null = null;
/** Completed (or abandoned) this run: later step views (the post-setup
 * "ready" line) must not reopen the funnel, except a brand-new run from the
 * first screen (a sign-out and a fresh onboarding in the same process). */
let closed = false;

/** Feed every renderer analytics event through here. Never throws. */
export function observeOnboardingEvent(
  event: string,
  props: Record<string, Scalar> | undefined,
  now: number = Date.now(),
): void {
  try {
    if (event === 'onboarding_completed' || event === 'onboarding_abandoned') {
      state = null;
      closed = true;
      return;
    }
    if (event !== 'onboarding_step' || !props || props.action !== 'view') return;
    const step = typeof props.step === 'string' ? props.step : null;
    if (!step) return;
    if (closed) {
      if (step !== 'intro') return;
      closed = false;
    }
    state = {
      step,
      index: typeof props.index === 'number' ? props.index : null,
      path: typeof props.path === 'string' ? props.path : null,
      skippedCreation: typeof props.skipped_creation === 'boolean' ? props.skipped_creation : null,
      startedAt: state?.startedAt ?? now,
      enteredAt: now,
      stepsViewed: (state?.stepsViewed ?? 0) + 1,
    };
  } catch {
    /* analytics is never load-bearing */
  }
}

/**
 * The abandonment event's props for an onboarding in progress, or null. Clears
 * the state, so a quit after a window close reports once.
 */
export function takeOnboardingAbandonment(trigger: 'quit' | 'window_closed', now: number = Date.now()): Record<string, Scalar> | null {
  if (!state) return null;
  const s = state;
  state = null;
  closed = true;
  return {
    step: s.step,
    index: s.index,
    ms_in_step: Math.max(0, now - s.enteredAt),
    ms_in_onboarding: Math.max(0, now - s.startedAt),
    steps_viewed: s.stepsViewed,
    path: s.path,
    skipped_creation: s.skippedCreation,
    trigger,
  };
}

/** Send `onboarding_abandoned` if an onboarding is in progress. Never throws. */
export function reportOnboardingAbandoned(
  trigger: 'quit' | 'window_closed',
  capture: (event: string, props: Record<string, Scalar>) => void,
): void {
  try {
    const props = takeOnboardingAbandonment(trigger);
    if (props) capture('onboarding_abandoned', props);
  } catch {
    /* analytics is never load-bearing */
  }
}

/** Test seam. */
export function _resetOnboardingFunnelForTests(): void {
  state = null;
  closed = false;
}
