import { describe, expect, it, vi } from 'vitest';
import type { LlmCallParams, LlmResult } from '../llm/types';
import type { ChooseState } from './chooser';
import type { ActOption } from './perception';
import { buildStepContent, choiceFromResult, makeVerifier, parseVerdict, VisionChooser } from './visionChooser';

const frame = { data: 'AAAA', mime: 'image/jpeg' as const, width: 1280, height: 800, rect: { x: 0, y: 0, w: 1280, h: 800 }, capturedAt: 0 };
const state: ChooseState = {
  goal: 'open the settings',
  frame,
  perception: { state: 'Everything below is read from the screen.', options: [], richness: 1, focusedEditable: false, focusedSecure: false },
  step: 3,
  maxSteps: 40,
  timeLeftS: 100,
  notes: ['That action was refused: x.'],
  playerLines: ['the gear icon'],
};
const options = [
  { index: 0, kind: 'ax', label: 'click button "Settings"', action: { name: 'click', input: { x: 10, y: 10, button: 'left' } } },
  { index: 1, kind: 'done', label: 'DONE', action: { name: 'done', input: { summary: '' } } },
] as ActOption[];
const res = (toolUses: Array<{ name: string; input: Record<string, unknown> }>, text = ''): LlmResult => ({
  content: [],
  toolUses: toolUses.map((t, i) => ({ id: `t${i}`, ...t })),
  text,
  usage: { input_tokens: 100, output_tokens: 10 },
  stopReason: 'tool_use',
});

describe('buildStepContent', () => {
  it('has one text block then exactly one image', () => {
    const c = buildStepContent(state, options, [{ step: 1, action: 'click (1, 1)', ok: false, result: 'refused: x' }]);
    expect(c.map((b) => b.type)).toEqual(['text', 'image']);
    const t = String(c[0]!.text);
    expect(t).toMatch(/The player asked: "open the settings"/);
    expect(t).toMatch(/1\. click \(1, 1\): failed, refused: x/);
    expect(t).toMatch(/The player just said: "the gear icon"/);
    expect(t).toMatch(/0\. click button "Settings"/);
    expect(t).toMatch(/Step 3 of 40/);
    expect(t).not.toMatch(/—/);
  });
  it('says when there are no options', () => {
    expect(String(buildStepContent(state, [], [])[0]!.text)).toMatch(/no numbered options/);
  });
});

describe('choiceFromResult', () => {
  it('takes say plus the first action', () => {
    const c = choiceFromResult(res([{ name: 'say', input: { text: 'on it' } }, { name: 'click', input: { x: 5, y: 6 } }, { name: 'type', input: { text: 'x' } }]), options);
    expect(c.say).toBe('on it');
    expect(c.action).toEqual({ name: 'click', input: { x: 5, y: 6, button: 'left' } });
    expect(c.error).toMatch(/only the first action/);
  });
  it('maps choose to an index', () => {
    expect(choiceFromResult(res([{ name: 'choose', input: { index: 0 } }]), options).index).toBe(0);
    expect(choiceFromResult(res([{ name: 'choose', input: { index: 7 } }]), options).error).toMatch(/no option 7/);
  });
  it('reports no action', () => {
    expect(choiceFromResult(res([], 'hmm'), options)).toMatchObject({ error: 'no action was called', scratch: 'hmm' });
  });
});

describe('VisionChooser', () => {
  it('sends one stateless user message with the act tools and the anthropic extras', async () => {
    const call = vi.fn(async (_p: LlmCallParams) => res([{ name: 'done', input: { summary: 'ok' } }]));
    const v = new VisionChooser({ call, model: 'claude-sonnet-5', system: 'SYS', cache: true, anthropicExtra: { output_config: { effort: 'low' } } });
    const c1 = await v.choose(state, options, [], new AbortController().signal);
    await v.choose(state, options, [], new AbortController().signal);
    expect(c1.action?.name).toBe('done');
    const p = call.mock.calls[1]![0];
    expect(p.messages).toHaveLength(1);
    expect(p.tools!.map((t) => t.name)).toContain('choose');
    expect(p.anthropicExtra).toEqual({ output_config: { effort: 'low' } });
    expect(Array.isArray(p.system)).toBe(true);
  });
});

describe('completion check', () => {
  it('parses the forced verdict tool', () => {
    expect(parseVerdict(res([{ name: 'verdict', input: { achieved: true, why: 'the page is open' } }]))).toEqual({ achieved: true, why: 'the page is open' });
  });
  it('accepts a plain yes/no text answer and treats anything else as not achieved', () => {
    expect(parseVerdict(res([], 'No, the dialog is still open'))).toEqual({ achieved: false, why: 'the dialog is still open' });
    expect(parseVerdict(res([], 'maybe')).achieved).toBe(false);
  });
  it('forces the verdict tool with thinking off on Anthropic', async () => {
    const call = vi.fn(async (_p: LlmCallParams) => res([{ name: 'verdict', input: { achieved: false, why: 'not yet' } }]));
    const verify = makeVerifier({ call, model: 'claude-sonnet-5', anthropic: true });
    const v = await verify('open the settings', frame, new AbortController().signal);
    expect(v.achieved).toBe(false);
    const p = call.mock.calls[0]![0];
    expect(p.toolChoice).toEqual({ type: 'tool', name: 'verdict' });
    expect(p.anthropicExtra).toEqual({ thinking: { type: 'disabled' } });
    expect((p.messages[0]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['text', 'image']);
  });
});
