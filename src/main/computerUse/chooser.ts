/**
 * 260925 backseat act: the Chooser seam.
 *
 *   choose(state, options, history) -> { index, probs? } | { action }
 *
 * A chooser picks ONE next action per step: either an index into the
 * numbered options that perception built for this frame, or a direct action
 * (a click at image px, typed text, a key combo). The loop owns execution,
 * scope, caps, stall detection and abort; a chooser owns nothing but its
 * call.
 *
 * Implementations:
 *   - VisionChooser (visionChooser.ts): Claude through the main LLM layer,
 *     single frame + options. The default, and the fallback for every step
 *     the text chooser cannot handle.
 *   - ProbabilityChooser (below): any model that scores a text prompt against
 *     a list of option strings and returns probabilities. JevChooser is one
 *     (jevChooser.ts). An open-source scorer being evaluated plugs in the
 *     same way, by providing a ScoreFn.
 *
 *   - TextChooser (textChooser.ts): Claude Haiku 4.5 in text mode over the
 *     same numbered options, forced tool call with the index. The default
 *     text chooser (research 260925: 11/11 on the synthetic set, ~0.8 s).
 *   - LocalChooser: NOT implemented. The seam for an on-device scorer
 *     (SemIf + Qwen on MLX) is ScoreFn below; wrap it in ProbabilityChooser
 *     and add a case to actSession's text chooser switch.
 *
 * pickChooser() decides per step which one runs.
 */
import type { LlmUsage } from '../llm/types';
import type { ParsedAction } from './actions';
import type { ActOption, Perception } from './perception';
import type { Frame } from './types';

export interface ChooseState {
  goal: string;
  frame: Frame;
  /** Null when AX/OCR were not available this step. */
  perception: Perception | null;
  step: number;
  maxSteps: number;
  timeLeftS: number;
  /** Loop notes for this step (a refused action, a stall, a failed completion check). */
  notes: string[];
  /** What the player said since the last step, verbatim. */
  playerLines: string[];
}

export interface HistoryEntry {
  step: number;
  /** describeAction() of what ran, or the option label. */
  action: string;
  ok: boolean;
  /** Short result or refusal reason. */
  result: string;
}

export interface Choice {
  /** An index into `options`. */
  index?: number;
  /** Probabilities per option, same order, when the chooser has them. */
  probs?: number[];
  /** A direct action instead of an option. */
  action?: ParsedAction;
  /** A line to say out loud this step (vision chooser only). */
  say?: string;
  /** Private notes (logged, never spoken). */
  scratch?: string;
  /** The chooser answered with something unusable (logged and fed back as a note). */
  error?: string;
  usage?: LlmUsage;
  latencyMs: number;
}

export interface Chooser {
  readonly name: string;
  readonly model: string;
  /** True for choosers that only read text (cannot type, cannot see pixels). */
  readonly textOnly: boolean;
  choose(state: ChooseState, options: ActOption[], history: HistoryEntry[], signal: AbortSignal): Promise<Choice>;
}

/** Per-step selection policy knobs. */
export interface PickPolicy {
  /** Fewer AX+OCR options than this and the step goes to vision. */
  minRichness: number;
  /** A text choice whose top probability is below this is redone by vision. */
  minConfidence: number;
}

export const DEFAULT_PICK_POLICY: PickPolicy = { minRichness: 3, minConfidence: 0.35 };

export type PickReason = 'no_text_chooser' | 'forced' | 'no_perception' | 'thin' | 'typing' | 'text';

/** Which chooser runs this step, and why (logged). */
export function pickChooser(p: {
  text?: Chooser | null;
  vision: Chooser;
  perception: Perception | null;
  forceVision: boolean;
  policy?: PickPolicy;
}): { chooser: Chooser; reason: PickReason } {
  const pol = p.policy ?? DEFAULT_PICK_POLICY;
  if (!p.text) return { chooser: p.vision, reason: 'no_text_chooser' };
  if (p.forceVision) return { chooser: p.vision, reason: 'forced' };
  if (!p.perception) return { chooser: p.vision, reason: 'no_perception' };
  if (p.perception.richness < pol.minRichness) return { chooser: p.vision, reason: 'thin' };
  // A text chooser cannot produce text to type. An EMPTY focused field means
  // typing is next; a filled one may mean submitting (the text chooser has
  // "press Return" and a `type` option that hands the step to vision).
  if (p.perception.focusedEditable && p.perception.focusedEmpty) return { chooser: p.vision, reason: 'typing' };
  return { chooser: p.text, reason: 'text' };
}

/** A text choice that should be redone by the vision chooser (low confidence, unusable, or "type text"). */
export function textChoiceNeedsVision(c: Choice, options: ActOption[], policy: PickPolicy = DEFAULT_PICK_POLICY): boolean {
  if (c.error) return true;
  if (c.index === undefined || c.index < 0 || c.index >= options.length) return true;
  if (!options[c.index]!.action) return true;
  if (c.probs && c.probs.length) {
    const top = Math.max(...c.probs);
    if (top < policy.minConfidence) return true;
  }
  return false;
}

/**
 * A model that scores options: given a prompt (goal + state + recent
 * history) and N option strings, return N probabilities.
 */
export type ScoreFn = (
  input: { goal: string; state: string; history: string[]; options: string[] },
  signal: AbortSignal,
) => Promise<{ probs: number[]; usage?: LlmUsage }>;

export class ProbabilityChooser implements Chooser {
  readonly textOnly = true;
  constructor(
    readonly name: string,
    readonly model: string,
    private score: ScoreFn,
    private historyLines = 8,
  ) {}

  async choose(state: ChooseState, options: ActOption[], history: HistoryEntry[], signal: AbortSignal): Promise<Choice> {
    const t0 = Date.now();
    if (!options.length) return { error: 'no options', latencyMs: 0 };
    const hist = history.slice(-this.historyLines).map((h) => `step ${h.step}: ${h.action} (${h.ok ? 'ok' : 'failed'}: ${h.result})`);
    const stateText = [state.perception?.state ?? '', ...state.notes, ...state.playerLines.map((l) => `The player said: "${l}"`)]
      .filter(Boolean)
      .join('\n');
    const { probs, usage } = await this.score(
      { goal: state.goal, state: stateText, history: hist, options: options.map((o) => o.label) },
      signal,
    );
    if (probs.length !== options.length) return { error: `scorer returned ${probs.length} scores for ${options.length} options`, latencyMs: Date.now() - t0 };
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[best]!) best = i;
    return { index: best, probs, usage, latencyMs: Date.now() - t0, scratch: `${this.name} picked ${best} p=${probs[best]!.toFixed(2)}` };
  }
}
