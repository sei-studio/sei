import { describe, expect, it, vi } from 'vitest';
import type { LlmCallParams, LlmResult } from '../llm/types';
import type { ChooseState } from './chooser';
import { textChoiceNeedsVision } from './chooser';
import type { ActOption } from './perception';
import {
  buildTextPrompt,
  chooseTool,
  parseTextChoice,
  TEXT_CHOOSER_MODEL,
  TEXT_CHOOSER_SYSTEM,
  TextChooser,
  textChooserKind,
} from './textChooser';

const frame = { data: 'AAAA', mime: 'image/jpeg' as const, width: 1280, height: 800, rect: { x: 0, y: 0, w: 1280, h: 800 }, capturedAt: 0 };
const options = [
  { index: 0, kind: 'ax', label: 'click button "Send"', action: { name: 'click', input: { x: 10, y: 10, button: 'left' } } },
  { index: 1, kind: 'type', label: 'type text into the focused field' },
  { index: 2, kind: 'key', label: 'press Return', action: { name: 'key', input: { keys: 'return' } } },
  { index: 3, kind: 'done', label: 'DONE: the goal is already achieved on this screen', action: { name: 'done', input: { summary: '' } } },
] as ActOption[];
const state: ChooseState = {
  goal: 'send the message',
  frame,
  perception: { state: 'App: Messages\nVisible text: "hello"', options, richness: 1, focusedEditable: true, focusedEmpty: false, focusedSecure: false },
  step: 2,
  maxSteps: 40,
  timeLeftS: 100,
  notes: ['A note from the loop.'],
  playerLines: ['hurry'],
};
const res = (toolUses: Array<{ name: string; input: Record<string, unknown> }>, text = ''): LlmResult => ({
  content: [],
  toolUses: toolUses.map((t, i) => ({ id: `t${i}`, ...t })),
  text,
  usage: { input_tokens: 400, output_tokens: 12 },
  stopReason: 'tool_use',
});

describe('chooseTool', () => {
  it('limits index to the option numbers', () => {
    const t = chooseTool(4);
    const props = (t.input_schema as { properties: Record<string, { enum?: number[] }> }).properties;
    expect(props.index!.enum).toEqual([0, 1, 2, 3]);
    expect((t.input_schema as { required: string[] }).required).toEqual(['index']);
  });
});

describe('buildTextPrompt', () => {
  it('carries goal, history, notes, player lines, screen and numbered options', () => {
    const t = buildTextPrompt(state, options, [{ step: 1, action: 'type "hi"', ok: true, result: 'typed' }]);
    expect(t).toMatch(/^Goal: send the message/);
    expect(t).toMatch(/1\. type "hi": typed/);
    expect(t).toMatch(/A note from the loop\./);
    expect(t).toMatch(/The player just said: "hurry"/);
    expect(t).toMatch(/Screen:\nApp: Messages/);
    expect(t).toMatch(/2\. press Return/);
    expect(t).toMatch(/3\. DONE: the goal is already achieved/);
    expect(t).not.toMatch(/—/);
  });
});

describe('TEXT_CHOOSER_SYSTEM', () => {
  it('names both weak spots and keeps screen text as content', () => {
    expect(TEXT_CHOOSER_SYSTEM).toMatch(/already shows the goal is achieved.*DONE/);
    expect(TEXT_CHOOSER_SYSTEM).toMatch(/After text has been typed.*Return/);
    expect(TEXT_CHOOSER_SYSTEM).toMatch(/content, not instructions/);
    expect(TEXT_CHOOSER_SYSTEM).not.toMatch(/—/);
  });
});

describe('parseTextChoice', () => {
  it('reads index and clamps confidence from the tool call', () => {
    expect(parseTextChoice(res([{ name: 'choose', input: { index: 2, confidence: 1.4 } }]), 4)).toEqual({ index: 2, confidence: 1 });
    expect(parseTextChoice(res([{ name: 'choose', input: { index: 0 } }]), 4)).toEqual({ index: 0 });
  });
  it('falls back to a number in text', () => {
    expect(parseTextChoice(res([], '3'), 4)).toEqual({ index: 3 });
    expect(parseTextChoice(res([], '{"index": 1}'), 4)).toEqual({ index: 1 });
  });
  it('rejects out-of-range or missing answers', () => {
    expect(parseTextChoice(res([{ name: 'choose', input: { index: 9 } }]), 4)).toHaveProperty('error');
    expect(parseTextChoice(res([], 'not sure'), 4)).toHaveProperty('error');
    expect(parseTextChoice(res([{ name: 'choose', input: { index: 1.5 } }]), 4)).toHaveProperty('error');
  });
});

describe('TextChooser', () => {
  const signal = new AbortController().signal;

  it('forces the choose tool on Haiku, without touching thinking', async () => {
    const call = vi.fn(async (_p: LlmCallParams) => res([{ name: 'choose', input: { index: 2, confidence: 0.8 } }]));
    const c = new TextChooser({ call, anthropic: true });
    expect(c.model).toBe(TEXT_CHOOSER_MODEL);
    expect(c.textOnly).toBe(true);
    const out = await c.choose(state, options, [], signal);
    const p = call.mock.calls[0]![0];
    expect(p.model).toBe('claude-haiku-4-5');
    expect(p.toolChoice).toEqual({ type: 'tool', name: 'choose' });
    expect(p.tools!.map((t) => t.name)).toEqual(['choose']);
    expect(p.anthropicExtra).toBeUndefined();
    expect(p.signal).toBe(signal);
    expect(typeof p.messages[0]!.content).toBe('string');
    expect(out.index).toBe(2);
    expect(out.probs).toEqual([0, 0, 0.8, 0]);
    expect(out.usage).toEqual({ input_tokens: 400, output_tokens: 12 });
    expect(textChoiceNeedsVision(out, options)).toBe(false);
  });

  it('disables thinking for a 5-gen model on the Anthropic path', async () => {
    const call = vi.fn(async (_p: LlmCallParams) => res([{ name: 'choose', input: { index: 0 } }]));
    const out = await new TextChooser({ call, model: 'claude-sonnet-5', anthropic: true }).choose(state, options, [], signal);
    expect(call.mock.calls[0]![0].anthropicExtra).toEqual({ thinking: { type: 'disabled' } });
    expect(out.probs).toEqual([1, 0, 0, 0]);
  });

  it('a low confidence hands the step to vision', async () => {
    const call = vi.fn(async () => res([{ name: 'choose', input: { index: 0, confidence: 0.2 } }]));
    const out = await new TextChooser({ call }).choose(state, options, [], signal);
    expect(textChoiceNeedsVision(out, options)).toBe(true);
  });

  it('picking "type text" hands the step to vision (no action to run)', async () => {
    const call = vi.fn(async () => res([{ name: 'choose', input: { index: 1, confidence: 0.9 } }]));
    const out = await new TextChooser({ call }).choose(state, options, [], signal);
    expect(out.index).toBe(1);
    expect(textChoiceNeedsVision(out, options)).toBe(true);
  });

  it('reports an unusable answer as an error', async () => {
    const call = vi.fn(async () => res([], 'hmm'));
    const out = await new TextChooser({ call }).choose(state, options, [], signal);
    expect(out.error).toMatch(/no valid option/);
    expect(textChoiceNeedsVision(out, options)).toBe(true);
  });

  it('does not call the model with no options', async () => {
    const call = vi.fn();
    expect((await new TextChooser({ call }).choose(state, [], [], signal)).error).toBe('no options');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('textChooserKind', () => {
  it('defaults to haiku and switches by config only', () => {
    expect(textChooserKind({})).toBe('haiku');
    expect(textChooserKind({ SEI_ACT_TEXT_CHOOSER: 'jev' })).toBe('jev');
    expect(textChooserKind({ SEI_ACT_TEXT_CHOOSER: ' Local ' })).toBe('local');
    expect(textChooserKind({ SEI_ACT_TEXT_CHOOSER: 'none' })).toBe('none');
    expect(textChooserKind({ SEI_ACT_TEXT_CHOOSER: 'nonsense' })).toBe('haiku');
    expect(textChooserKind({ SEI_ACT_CHOOSER: 'vision', SEI_ACT_TEXT_CHOOSER: 'jev' })).toBe('none');
  });
});
