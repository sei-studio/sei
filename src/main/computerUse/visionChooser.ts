/**
 * 260925 backseat act: the vision chooser (Claude via the main LLM layer, so
 * cloud, Anthropic BYOK and other vision BYOK providers run the same code)
 * and the completion check.
 *
 * STATELESS per step: one user message with the goal, a text summary of the
 * steps so far, loop notes, the player's new lines, the perception state and
 * numbered options (when there are any), and ONE image, the current frame.
 * No screenshot history is resent, so the cost of a step does not grow with
 * the run, and a step that fails or is aborted leaves nothing to repair.
 *
 * The system prompt and tool list are identical every step, so with `cache`
 * on they are read back from the prompt cache.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCallParams, LlmResult, LlmToolDef } from '../llm/types';
import { ACT_TOOLS, parseAction, type ParsedAction } from './actions';
import { buildVerifyText, VERIFY_SYSTEM } from './actPrompt';
import type { Choice, ChooseState, Chooser, HistoryEntry } from './chooser';
import { formatOptions, type ActOption } from './perception';
import type { Frame } from './types';

export type LlmCall = (p: LlmCallParams) => Promise<LlmResult>;

export interface VisionChooserOptions {
  call: LlmCall;
  model: string;
  system: string;
  tools?: LlmToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Anthropic-only request fields (thinking / output_config). */
  anthropicExtra?: Record<string, unknown>;
  /** Add cache_control on the system prompt (Anthropic honors it; others strip it). */
  cache?: boolean;
  /** History lines to include (most recent). */
  historyLines?: number;
}

type Block = Record<string, unknown>;

export function historyText(history: HistoryEntry[], keep: number): string {
  if (!history.length) return 'Nothing done yet.';
  const shown = history.slice(-keep);
  const lines = shown.map((h) => `${h.step}. ${h.action}: ${h.ok ? h.result || 'done' : `failed, ${h.result}`}`);
  if (history.length > shown.length) lines.unshift(`(${history.length - shown.length} earlier steps not shown)`);
  return lines.join('\n');
}

/** The user message for one step (exported for tests). */
export function buildStepContent(state: ChooseState, options: ActOption[], history: HistoryEntry[], keep = 12): Block[] {
  const lines: string[] = [];
  lines.push(`The player asked: "${state.goal.trim()}"`);
  lines.push(`Steps so far:\n${historyText(history, keep)}`);
  for (const n of state.notes) lines.push(n);
  for (const l of state.playerLines) lines.push(`The player just said: "${l}"`);
  if (state.perception) lines.push(state.perception.state);
  if (options.length) lines.push(`Numbered options for this screenshot (use choose):\n${formatOptions(options)}`);
  else lines.push('There are no numbered options this step. Use the screenshot.');
  lines.push(
    `Step ${state.step} of ${state.maxSteps}, about ${Math.max(0, Math.round(state.timeLeftS))} s left. The screenshot is ${state.frame.width}x${state.frame.height} px.`,
  );
  return [
    { type: 'text', text: lines.join('\n\n') },
    { type: 'image', source: { type: 'base64', media_type: state.frame.mime, data: state.frame.data } },
  ];
}

/** Map a model response to a Choice: first say, first non-say action. */
export function choiceFromResult(res: Pick<LlmResult, 'toolUses' | 'text'>, options: ActOption[]): Omit<Choice, 'latencyMs'> {
  let say: string | undefined;
  let action: ParsedAction | undefined;
  let index: number | undefined;
  const errors: string[] = [];
  let extra = 0;
  for (const t of res.toolUses) {
    const p = parseAction(t.name, t.input);
    if (!p.ok) {
      errors.push(`${t.name}: ${p.error}`);
      continue;
    }
    if (p.action.name === 'say') {
      say ??= p.action.input.text;
      continue;
    }
    if (action || index !== undefined) {
      extra += 1;
      continue;
    }
    if (p.action.name === 'choose') {
      if (p.action.input.index >= options.length) {
        errors.push(`choose: there is no option ${p.action.input.index}`);
        continue;
      }
      index = p.action.input.index;
    } else {
      action = p.action;
    }
  }
  const out: Omit<Choice, 'latencyMs'> = { scratch: res.text };
  if (say) out.say = say;
  if (index !== undefined) out.index = index;
  if (action) out.action = action;
  const notes = [...errors];
  if (extra) notes.push(`only the first action runs each step, ${extra} more ignored`);
  if (index === undefined && !action) notes.unshift(errors.length ? '' : 'no action was called');
  const msg = notes.filter(Boolean).join('; ');
  if (msg) out.error = msg;
  return out;
}

export class VisionChooser implements Chooser {
  readonly name = 'vision';
  readonly textOnly = false;
  readonly model: string;

  constructor(private o: VisionChooserOptions) {
    this.model = o.model;
  }

  async choose(state: ChooseState, options: ActOption[], history: HistoryEntry[], signal: AbortSignal): Promise<Choice> {
    const system: string | Anthropic.TextBlockParam[] = this.o.cache
      ? [{ type: 'text', text: this.o.system, cache_control: { type: 'ephemeral' } }]
      : this.o.system;
    const t0 = Date.now();
    const res = await this.o.call({
      model: this.o.model,
      maxTokens: this.o.maxTokens ?? 1024,
      system,
      tools: this.o.tools ?? ACT_TOOLS,
      messages: [{ role: 'user', content: buildStepContent(state, options, history, this.o.historyLines) }],
      timeoutMs: this.o.timeoutMs ?? 45000,
      signal,
      ...(this.o.anthropicExtra ? { anthropicExtra: this.o.anthropicExtra } : {}),
    });
    return { ...choiceFromResult(res, options), usage: res.usage, latencyMs: Date.now() - t0 };
  }
}

// ── Completion check ────────────────────────────────────────────────────────

export const VERDICT_TOOL: LlmToolDef = {
  name: 'verdict',
  description: 'Report whether the task is achieved in the screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      achieved: { type: 'boolean' },
      why: { type: 'string', description: 'One short sentence.' },
    },
    required: ['achieved', 'why'],
  },
};

export interface Verdict {
  achieved: boolean;
  why: string;
  latencyMs: number;
}

export type Verifier = (goal: string, frame: Frame, signal: AbortSignal) => Promise<Verdict>;

/**
 * One vision call on the final frame: "is <goal> achieved? yes/no + why".
 * Forced tool call, thinking off (Anthropic rejects forced tool_choice with
 * thinking on). An unparseable answer counts as NOT achieved.
 */
export function makeVerifier(o: { call: LlmCall; model: string; timeoutMs?: number; anthropic?: boolean }): Verifier {
  return async (goal, frame, signal) => {
    const t0 = Date.now();
    const res = await o.call({
      model: o.model,
      maxTokens: 300,
      system: VERIFY_SYSTEM,
      tools: [VERDICT_TOOL],
      toolChoice: { type: 'tool', name: 'verdict' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildVerifyText(goal) },
            { type: 'image', source: { type: 'base64', media_type: frame.mime, data: frame.data } },
          ],
        },
      ],
      timeoutMs: o.timeoutMs ?? 30000,
      signal,
      ...(o.anthropic ? { anthropicExtra: { thinking: { type: 'disabled' } } } : {}),
    });
    return { ...parseVerdict(res), latencyMs: Date.now() - t0 };
  };
}

export function parseVerdict(res: Pick<LlmResult, 'toolUses' | 'text'>): { achieved: boolean; why: string } {
  const t = res.toolUses.find((u) => u.name === 'verdict');
  if (t && typeof t.input.achieved === 'boolean') {
    return { achieved: t.input.achieved, why: String(t.input.why ?? '').slice(0, 300) };
  }
  // Providers without forced tool_choice may answer in text.
  const m = /^\s*(yes|no)\b[\s,.:-]*(.*)$/is.exec(res.text ?? '');
  if (m) return { achieved: m[1]!.toLowerCase() === 'yes', why: m[2]!.trim().slice(0, 300) };
  return { achieved: false, why: 'the completion check gave no clear answer' };
}
