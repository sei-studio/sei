/**
 * Onboarding step analytics (261005). Pure: no React, no bridge. OnboardApp
 * derives a step key from its phase and feeds it to an OnboardStepTracker,
 * which emits `onboarding_step {step, index, action, ms_in_step, path,
 * skipped_creation}`: a `view` when a step opens and one of
 * `complete | skip | back` when it closes.
 *
 * Why: of 16 installs in the 261005 retention window, 5 did nothing after the
 * first onboarding screens and the only onboarding event was
 * `onboarding_completed`, so WHERE people stopped was unknowable.
 *
 * `index` is the step's place in ONBOARD_STEPS, a canonical order across all
 * branches (a funnel can sort on it). It is not "the Nth screen this person
 * saw": branches skip whole ranges. A move to a LOWER index is a `back` unless
 * the caller marks it otherwise (the two forward moves that land earlier in
 * the list, re-asking "are you new" after a returning sign-in made a new
 * account and retrying a failed setup, are marked `complete`).
 *
 * Shape only: step names, enums and durations. Never the typed name, email,
 * answers or any free text.
 */

export const ONBOARD_STEPS = [
  'intro',
  'hey',
  'run_place',
  'are_you_new',
  'welcome_back',
  'name',
  'name_ack',
  'attribution',
  'job',
  'skip_confirm',
  'five_qs',
  'q_dynamics',
  'q_age',
  'q_art',
  'q_gender',
  'all_done',
  'dots',
  'ahh',
  'skipped_third',
  'auth_form',
  'auth_code',
  'auth_oauth_wait',
  'auth_region_blocked',
  'auth_tos',
  'no_account',
  'local_key',
  'local_model',
  'local_stt',
  'local_tts',
  'setup',
  'setup_error',
  'welcome_existing',
  'ready',
] as const;

export type OnboardStep = (typeof ONBOARD_STEPS)[number];

export type OnboardStepAction = 'view' | 'complete' | 'skip' | 'back';

/** Script line id (OnboardApp's LineId) → step name. */
export const LINE_STEPS: Record<string, OnboardStep> = {
  hey: 'hey',
  runPlace: 'run_place',
  newQ: 'are_you_new',
  welcomeBack: 'welcome_back',
  nameQ: 'name',
  iSee: 'name_ack',
  heardQ: 'attribution',
  job: 'job',
  skipConfirm: 'skip_confirm',
  fiveQs: 'five_qs',
  qDyn: 'q_dynamics',
  qAge: 'q_age',
  qArt: 'q_art',
  qGender: 'q_gender',
  allDone: 'all_done',
  dots: 'dots',
  ahh: 'ahh',
  skippedThird: 'skipped_third',
  noAccount: 'no_account',
  ready: 'ready',
};

export type AuthSubStep = 'form' | 'code' | 'oauth_wait' | 'region_blocked';
export type LocalSubStep = 'key' | 'model' | 'stt' | 'tts';

/** The minimal phase shape stepFor needs (mirrors OnboardApp's Phase). */
export type StepPhase =
  | { k: 'intro' }
  | { k: 'line'; id: string }
  | { k: 'walkoff' }
  | { k: 'auth' }
  | { k: 'local-setup' }
  | { k: 'setup' }
  | { k: 'welcome-existing' }
  | { k: 'return' }
  | { k: 'no-account' }
  | { k: 'fade' };

/**
 * The step a phase shows, or null for a transition that shows nothing of its
 * own (walk-off, walk-back-in, the closing fade): null keeps the previous step
 * open, so its time includes the transition that follows it.
 */
export function stepFor(
  phase: StepPhase,
  sub: { needsTos: boolean; auth: AuthSubStep; local: LocalSubStep; setupError: boolean },
): OnboardStep | null {
  switch (phase.k) {
    case 'intro':
      return 'intro';
    case 'line':
      return LINE_STEPS[phase.id] ?? null;
    case 'auth':
      return sub.needsTos ? 'auth_tos' : (`auth_${sub.auth}` as OnboardStep);
    case 'local-setup':
      return `local_${sub.local}` as OnboardStep;
    case 'setup':
      return sub.setupError ? 'setup_error' : 'setup';
    case 'welcome-existing':
      return 'welcome_existing';
    default:
      return null;
  }
}

export function stepIndex(step: OnboardStep): number {
  return ONBOARD_STEPS.indexOf(step);
}

/** How the step being left was left. An explicit mark wins; otherwise a move
 * to an earlier step is `back` and anything else is `complete`. */
export function leaveAction(
  from: OnboardStep,
  to: OnboardStep | null,
  marked: Exclude<OnboardStepAction, 'view'> | null,
): Exclude<OnboardStepAction, 'view'> {
  if (marked) return marked;
  if (to !== null && stepIndex(to) < stepIndex(from)) return 'back';
  return 'complete';
}

type Scalar = string | number | boolean | null;
export type TrackFn = (event: string, props: Record<string, Scalar>) => void;

export interface OnboardContext {
  /** 'new' | 'returning' branch, plus whether creation was skipped. */
  path: string;
  skipped_creation: boolean;
}

/**
 * Emits onboarding_step events for a sequence of step keys. Owned by one
 * OnboardApp mount. Never throws (every emit is guarded).
 */
export class OnboardStepTracker {
  private current: OnboardStep | null = null;
  private enteredAt = 0;
  private marked: Exclude<OnboardStepAction, 'view'> | null = null;
  private readonly startedAt: number;
  private viewed = 0;
  private ended = false;

  constructor(
    private readonly track: TrackFn,
    private readonly now: () => number,
    private readonly context: () => OnboardContext,
  ) {
    this.startedAt = now();
  }

  /** Mark how the CURRENT step is about to be left (a Skip button, a retry). */
  mark(action: Exclude<OnboardStepAction, 'view'>): void {
    this.marked = action;
  }

  /** The visible step changed. null = a transition; the current step stays open. */
  enter(step: OnboardStep | null): void {
    if (this.ended || step === null || step === this.current) return;
    const from = this.current;
    if (from !== null) this.emit(from, leaveAction(from, step, this.marked), this.now() - this.enteredAt);
    this.marked = null;
    this.current = step;
    this.enteredAt = this.now();
    this.viewed += 1;
    this.emit(step, 'view', 0);
  }

  /** Onboarding finished: close the open step and stop. */
  finish(action: Exclude<OnboardStepAction, 'view'> = 'complete'): void {
    if (this.ended) return;
    if (this.current !== null) this.emit(this.current, this.marked ?? action, this.now() - this.enteredAt);
    this.ended = true;
  }

  /** Total time since this tracker was created. */
  msInOnboarding(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  get stepsViewed(): number {
    return this.viewed;
  }

  get currentStep(): OnboardStep | null {
    return this.current;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * The view went away before onboarding finished (unmount). Emits
   * `onboarding_abandoned` with the step it stopped on. A quit is reported by
   * main instead (it outlives the renderer); see src/main/onboardingFunnel.ts.
   */
  abandon(trigger: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.current === null) return;
    try {
      const ctx = this.context();
      this.track('onboarding_abandoned', {
        step: this.current,
        index: stepIndex(this.current),
        ms_in_step: Math.max(0, this.now() - this.enteredAt),
        ms_in_onboarding: this.msInOnboarding(),
        steps_viewed: this.viewed,
        path: ctx.path,
        skipped_creation: ctx.skipped_creation,
        trigger,
      });
    } catch {
      /* analytics is never load-bearing */
    }
  }

  private emit(step: OnboardStep, action: OnboardStepAction, ms: number): void {
    try {
      const ctx = this.context();
      this.track('onboarding_step', {
        step,
        index: stepIndex(step),
        action,
        ms_in_step: Math.max(0, ms),
        path: ctx.path,
        skipped_creation: ctx.skipped_creation,
      });
    } catch {
      /* analytics is never load-bearing */
    }
  }
}
