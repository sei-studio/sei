/**
 * 260925 backseat act: the act loop. One action per step:
 *
 *   capture (full frame, thumb for change detection, OCR when perceiving)
 *   -> perceive (AX tree + OCR -> state text + numbered options)
 *   -> pick a chooser (text when the options are rich, else vision)
 *   -> choose (an option index, or a direct action)
 *   -> guards (blocked combos, password field, scope)
 *   -> helper
 *
 * until the goal is verified done, the chooser gives up, the screen stops
 * changing, a cap is hit, or the player stops it.
 *
 * DONE is not trusted: a separate vision check on the current frame must
 * agree ("is <goal> achieved? yes/no + why"). If it does not, the loop
 * carries on with the reason as a note, on the vision chooser.
 *
 * Stall: when the frame thumbnail has not changed across `stallActions`
 * input actions, the first time the loop re-perceives and forces the vision
 * chooser with a note; the second time it gives up.
 *
 * Abort discipline (the 260617 stop-button lesson): ONE session controller.
 * Every await runs under it through `abortable`, so the model call, the
 * capture, AX and the helper action all end the moment it fires. Stop,
 * the kill hotkey, the overlay pill, a new control() call, the time cap and
 * ANY player mouse or keyboard input abort it. The helper's in-flight action
 * is cancelled and `releaseAll` runs in `finally`, so nothing stays held.
 * Nothing else preempts the loop (the 260619 livelock lesson).
 */
import { abortable, isAbortError, sleep } from './abortable';
import { describeAction, INPUT_ACTIONS, toHelperCommand, type ActionTouch, type ParsedAction } from './actions';
import {
  DEFAULT_PICK_POLICY,
  pickChooser,
  textChoiceNeedsVision,
  type Choice,
  type ChooseState,
  type Chooser,
  type HistoryEntry,
  type PickPolicy,
  type PickReason,
} from './chooser';
import type { InputExecutor } from './inputHelper';
import type { ActOption, Perception } from './perception';
import type { ScopeResult } from './scope';
import type { AxNode, Frame } from './types';
import type { Verifier } from './visionChooser';

export interface ActLimits {
  maxSteps: number;
  maxMs: number;
  /** Scope refusals before giving up. */
  maxScopeRefusals: number;
  /** Chooser failures (no action, bad input) in a row before giving up. */
  maxChooserErrors: number;
  /** Failed completion checks before giving up. */
  maxVerifyFails: number;
  /** Input actions with no visible change that count as one stall. */
  stallActions: number;
  /** Mean absolute thumbnail difference (0..255) below which the screen counts as unchanged. */
  stallDiff: number;
  /** Let the UI settle after an input action, before the next screenshot. */
  settleMs: number;
}

export const DEFAULT_LIMITS: ActLimits = {
  maxSteps: 40,
  maxMs: 120_000,
  maxScopeRefusals: 3,
  maxChooserErrors: 3,
  maxVerifyFails: 3,
  stallActions: 3,
  stallDiff: 1.5,
  settleMs: 300,
};

/** Caps from env, on top of the defaults (40 steps, 120 s). */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ActLimits> {
  const out: Partial<ActLimits> = {};
  const steps = Number(env.SEI_ACT_MAX_STEPS);
  if (Number.isInteger(steps) && steps > 0 && steps <= 500) out.maxSteps = steps;
  const secs = Number(env.SEI_ACT_MAX_SECONDS);
  if (Number.isFinite(secs) && secs > 0 && secs <= 3600) out.maxMs = Math.round(secs * 1000);
  return out;
}

export type StopReason =
  | 'done'
  | 'gave_up'
  | 'stalled'
  | 'scope'
  | 'step_cap'
  | 'time_cap'
  | 'stopped'
  | 'user_input'
  | 'replaced'
  | 'error';

/** The status the backseat conversation sees. */
export type ControlStatus = 'done' | 'gave_up' | 'timeout' | 'aborted';

export function statusFor(reason: StopReason): ControlStatus {
  switch (reason) {
    case 'done':
      return 'done';
    case 'gave_up':
    case 'stalled':
    case 'scope':
      return 'gave_up';
    case 'step_cap':
    case 'time_cap':
      return 'timeout';
    default:
      return 'aborted';
  }
}

export interface StepTiming {
  step: number;
  chooser: string;
  pick: PickReason | 'fallback';
  captureMs: number;
  perceiveMs: number;
  modelMs: number;
  verifyMs: number;
  actionMs: number;
  totalMs: number;
  action: string;
  options: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ActOutcome {
  reason: StopReason;
  status: ControlStatus;
  steps: number;
  elapsedMs: number;
  /** One line for the backseat conversation. */
  summary: string;
  error?: string;
  timings: StepTiming[];
  history: HistoryEntry[];
  /** The last frame captured (the completion turn shows it to the companion). */
  lastFrame?: Frame;
}

export type ActEvent =
  | { type: 'step'; timing: StepTiming; scratch: string }
  | { type: 'say'; text: string }
  | { type: 'action'; step: number; action: string; ok: boolean; result: string; ms: number }
  | { type: 'verify'; achieved: boolean; why: string; ms: number }
  | { type: 'log'; msg: string };

export interface ActEnv {
  goal: string;
  executor: InputExecutor;
  vision: Chooser;
  /** Optional text chooser (Jev); null runs every step on vision. */
  text?: Chooser | null;
  verify: Verifier;
  /** A fresh frame of the target, with `thumb`, and `ocr` when `withOcr`. */
  capture(withOcr: boolean, signal: AbortSignal): Promise<Frame>;
  /** AX + OCR -> options. Absent or throwing = vision only this step. */
  perceive?(frame: Frame, signal: AbortSignal): Promise<Perception | null>;
  /** Scope check against the screen as it is now. */
  scope(touch: ActionTouch, signal: AbortSignal): Promise<ScopeResult>;
  /** The element with keyboard focus (AX), for the password-field guard. */
  focused?(signal: AbortSignal): Promise<AxNode | null>;
  onEvent(e: ActEvent): void;
  policy?: PickPolicy;
  now?: () => number;
}

/** Mean absolute difference of two hex grayscale thumbnails, or Infinity when not comparable. */
export function thumbDiff(a: string | undefined, b: string | undefined): number {
  if (!a || !b || a.length !== b.length || a.length % 2) return Infinity;
  let sum = 0;
  const n = a.length / 2;
  for (let i = 0; i < a.length; i += 2) sum += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
  return sum / n;
}

const SUMMARY_MAX = 200;
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SUMMARY_MAX ? t.slice(0, SUMMARY_MAX - 3) + '...' : t;
}

export class ActRun {
  private readonly limits: ActLimits;
  private readonly session = new AbortController();
  private stopReason: StopReason = 'stopped';
  private stopDetail = '';
  private started = false;
  private ended = false;
  private playerLines: string[] = [];

  constructor(
    private readonly env: ActEnv,
    limits: Partial<ActLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  get signal(): AbortSignal {
    return this.session.signal;
  }

  get running(): boolean {
    return this.started && !this.ended;
  }

  /** Stop now. Aborts the model call, the capture and the helper action. The first reason wins. */
  stop(reason: StopReason = 'stopped', detail = ''): void {
    if (this.ended || this.session.signal.aborted) return;
    this.stopReason = reason;
    this.stopDetail = detail;
    this.session.abort(reason);
    void this.env.executor.cancel().catch(() => {});
    void this.env.executor.releaseAll().catch(() => {});
  }

  /** A line the player said while the loop runs: context for the next step. */
  addPlayerLine(text: string): void {
    const t = text.trim();
    if (t) this.playerLines.push(t);
  }

  async run(): Promise<ActOutcome> {
    if (this.started) throw new Error('ActRun.run called twice');
    this.started = true;
    const env = this.env;
    const L = this.limits;
    const policy = env.policy ?? DEFAULT_PICK_POLICY;
    const signal = this.session.signal;
    const t0 = this.now();
    const timings: StepTiming[] = [];
    const history: HistoryEntry[] = [];
    let steps = 0;
    let notes: string[] = [];
    let forceVision = false;
    let scopeRefusals = 0;
    let chooserErrors = 0;
    let verifyFails = 0;
    let stallStrikes = 0;
    let unchangedActions = 0;
    let prevThumb: string | undefined;
    let actedSincePrev = false;
    let lastFrame: Frame | undefined;

    const end = (reason: StopReason, summary: string, error?: string): ActOutcome => ({
      reason,
      status: statusFor(reason),
      steps,
      elapsedMs: this.now() - t0,
      summary: oneLine(summary),
      ...(error ? { error } : {}),
      timings,
      history,
      lastFrame,
    });
    const stopSummary = (): string => {
      switch (this.stopReason) {
        case 'user_input':
          return `The player took over the mouse or keyboard${this.stopDetail ? ` (${this.stopDetail})` : ''}, so I stopped.`;
        case 'time_cap':
          return `Ran out of time after ${steps} steps.`;
        case 'replaced':
          return 'Stopped to start the new request instead.';
        default:
          return `Stopped by the player${this.stopDetail ? ` (${this.stopDetail})` : ''}.`;
      }
    };

    const timeCap = setTimeout(() => this.stop('time_cap'), L.maxMs);
    const unsubscribe = env.executor.onUserInput((e) =>
      this.stop('user_input', e.kind === 'key' ? 'keyboard' : 'mouse'),
    );
    try {
      await abortable(env.executor.watch(true), signal).catch((e) => {
        if (isAbortError(e)) throw e;
        env.onEvent({ type: 'log', msg: `watch failed: ${String(e)}` });
      });

      for (;;) {
        if (signal.aborted) return end(this.stopReason, stopSummary());
        if (steps >= L.maxSteps) return end('step_cap', `Used all ${L.maxSteps} steps without finishing.`);
        const s0 = this.now();

        // 1. Capture.
        const wantPerception = !!env.perceive;
        const frame = await abortable(env.capture(wantPerception, signal), signal);
        lastFrame = frame;
        const s1 = this.now();

        // 2. Stall detection on the thumbnail.
        if (actedSincePrev) {
          const d = thumbDiff(prevThumb, frame.thumb);
          if (d < L.stallDiff) unchangedActions += 1;
          else unchangedActions = 0;
        }
        prevThumb = frame.thumb;
        actedSincePrev = false;
        if (unchangedActions >= L.stallActions) {
          stallStrikes += 1;
          unchangedActions = 0;
          env.onEvent({ type: 'log', msg: `stall ${stallStrikes}: ${L.stallActions} actions with no visible change` });
          if (stallStrikes >= 2) return end('stalled', `The screen stopped responding to what I did, so I gave up after ${steps} steps.`);
          notes.push(`The last ${L.stallActions} actions did not change the screen. Look again and try something different.`);
          forceVision = true;
        }

        // 3. Perceive.
        let perception: Perception | null = null;
        if (env.perceive) {
          try {
            perception = await abortable(env.perceive(frame, signal), signal);
          } catch (e) {
            if (isAbortError(e) || signal.aborted) throw e;
            env.onEvent({ type: 'log', msg: `perceive failed: ${String(e)}` });
          }
        }
        const options: ActOption[] = perception?.options ?? [];
        const s2 = this.now();

        // 4. Choose.
        steps += 1;
        const state: ChooseState = {
          goal: env.goal,
          frame,
          perception,
          step: steps,
          maxSteps: L.maxSteps,
          timeLeftS: (L.maxMs - (this.now() - t0)) / 1000,
          notes,
          playerLines: this.playerLines.splice(0),
        };
        notes = [];
        const picked = pickChooser({ text: env.text, vision: env.vision, perception, forceVision, policy });
        forceVision = false;
        let chooser = picked.chooser;
        let pick: StepTiming['pick'] = picked.reason;
        let choice: Choice;
        if (chooser.textOnly) {
          try {
            choice = await abortable(chooser.choose(state, options, history, signal), signal);
          } catch (e) {
            if (isAbortError(e) || signal.aborted) throw e;
            choice = { error: e instanceof Error ? e.message : String(e), latencyMs: this.now() - s2 };
          }
          if (textChoiceNeedsVision(choice, options, policy)) {
            env.onEvent({ type: 'log', msg: `text chooser ${chooser.name} unsure (${choice.error ?? `p=${Math.max(...(choice.probs ?? [0])).toFixed(2)}`}), asking vision` });
            chooser = env.vision;
            pick = 'fallback';
            choice = await abortable(chooser.choose(state, options, history, signal), signal);
          }
        } else {
          choice = await abortable(chooser.choose(state, options, history, signal), signal);
        }
        const s3 = this.now();

        if (choice.say) env.onEvent({ type: 'say', text: choice.say });
        const action: ParsedAction | undefined =
          choice.index !== undefined ? options[choice.index]?.action : choice.action;
        const label = choice.index !== undefined ? `option ${choice.index} (${options[choice.index]?.label ?? '?'})` : action ? describeAction(action) : 'nothing';

        const timing: StepTiming = {
          step: steps,
          chooser: chooser.name,
          pick,
          captureMs: s1 - s0,
          perceiveMs: s2 - s1,
          modelMs: s3 - s2,
          verifyMs: 0,
          actionMs: 0,
          totalMs: 0,
          action: label,
          options: options.length,
          inputTokens: choice.usage?.input_tokens,
          outputTokens: choice.usage?.output_tokens,
        };
        timings.push(timing);
        const finishStep = (ok: boolean, result: string, ms = 0) => {
          history.push({ step: steps, action: label, ok, result });
          env.onEvent({ type: 'action', step: steps, action: label, ok, result, ms });
          timing.totalMs = this.now() - s0;
          env.onEvent({ type: 'step', timing, scratch: choice.scratch ?? '' });
        };

        if (!action) {
          chooserErrors += 1;
          finishStep(false, choice.error ?? 'no action');
          if (chooserErrors >= L.maxChooserErrors) {
            return end('error', `Could not work out what to do next.`, choice.error ?? 'no action');
          }
          notes.push(`Your last reply did not give a usable action (${choice.error ?? 'no action'}). Call exactly one action.`);
          forceVision = true;
          continue;
        }
        chooserErrors = 0;
        if (choice.error) notes.push(`Note: ${choice.error}.`);

        // 5. Terminal actions.
        if (action.name === 'give_up') {
          finishStep(true, 'gave up');
          return end('gave_up', action.input.reason || 'Gave up.');
        }
        if (action.name === 'done') {
          const v0 = this.now();
          const v = await abortable(env.verify(env.goal, frame, signal), signal);
          timing.verifyMs = this.now() - v0;
          env.onEvent({ type: 'verify', achieved: v.achieved, why: v.why, ms: timing.verifyMs });
          if (v.achieved) {
            finishStep(true, 'verified done');
            return end('done', action.input.summary || v.why || 'Done.');
          }
          verifyFails += 1;
          finishStep(false, `the check says it is not finished: ${v.why}`);
          if (verifyFails >= L.maxVerifyFails) return end('gave_up', `Thought it was done ${verifyFails} times but it was not: ${v.why}`);
          notes.push(`You called done, but a check of the screenshot says the goal is not achieved yet: ${v.why} Keep going.`);
          forceVision = true;
          continue;
        }
        if (action.name === 'wait') {
          const w0 = this.now();
          await sleep(action.input.ms, signal);
          timing.actionMs = this.now() - w0;
          finishStep(true, 'waited', timing.actionMs);
          continue;
        }
        if (!INPUT_ACTIONS.has(action.name)) {
          finishStep(false, `${action.name} is not an action`);
          forceVision = true;
          continue;
        }

        // 6. Guards.
        const m = toHelperCommand(action, frame);
        if (!m.ok) {
          finishStep(false, m.error);
          notes.push(`That action was not run: ${m.error}.`);
          forceVision = true;
          continue;
        }
        if (m.touch.typing && env.focused) {
          const f = await abortable(env.focused(signal), signal).catch((e) => {
            if (isAbortError(e) || signal.aborted) throw e;
            return null;
          });
          if (f?.subrole === 'AXSecureTextField') {
            finishStep(false, 'refused: keyboard focus is in a password field');
            return end('gave_up', 'It needs a password typed in, and that is for the player to do.');
          }
        }
        const sc = await abortable(env.scope(m.touch, signal), signal);
        if (!sc.ok) {
          scopeRefusals += 1;
          finishStep(false, `refused: ${sc.reason}`);
          if (scopeRefusals >= L.maxScopeRefusals) return end('scope', `Kept trying to act outside what was shared: ${sc.reason}.`);
          notes.push(`That action was refused: ${sc.reason}.`);
          forceVision = true;
          continue;
        }

        // 7. Act.
        const a0 = this.now();
        try {
          await env.executor.act(m.command, signal);
        } catch (e) {
          if (isAbortError(e) || signal.aborted) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          timing.actionMs = this.now() - a0;
          finishStep(false, `failed: ${msg}`, timing.actionMs);
          forceVision = true;
          continue;
        }
        timing.actionMs = this.now() - a0;
        actedSincePrev = true;
        finishStep(true, 'ok', timing.actionMs);
        if (L.settleMs > 0) await sleep(L.settleMs, signal);
      }
    } catch (e) {
      if (isAbortError(e) || signal.aborted) return end(this.stopReason, stopSummary());
      const msg = e instanceof Error ? e.message : String(e);
      return end('error', `Something went wrong: ${msg}`, msg);
    } finally {
      clearTimeout(timeCap);
      this.ended = true;
      unsubscribe();
      // Always let go, whatever path got here.
      await env.executor.cancel().catch(() => {});
      await env.executor.releaseAll().catch(() => {});
      await env.executor.watch(false).catch(() => {});
    }
  }
}
