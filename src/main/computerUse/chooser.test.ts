import { describe, expect, it, vi } from 'vitest';
import { pickChooser, ProbabilityChooser, textChoiceNeedsVision, type Choice, type ChooseState, type Chooser } from './chooser';
import { buildJevChooser, buildJevRequest, JEV_DEFAULT_MODEL, JEV_URL, makeJevScore, parseJevResponse } from './jevChooser';
import type { ActOption, Perception } from './perception';

const fake = (name: string, textOnly: boolean): Chooser => ({
  name,
  model: name,
  textOnly,
  choose: async () => ({ latencyMs: 0 }),
});
const vision = fake('vision', false);
const text = fake('jev', true);
const perc = (richness: number, focusedEditable = false): Perception => ({
  state: '',
  options: [],
  richness,
  focusedEditable,
  focusedSecure: false,
});

describe('pickChooser', () => {
  it('uses vision without a text chooser', () => {
    expect(pickChooser({ vision, perception: perc(20), forceVision: false }).reason).toBe('no_text_chooser');
  });
  it('uses the text chooser when the options are rich', () => {
    expect(pickChooser({ text, vision, perception: perc(20), forceVision: false })).toMatchObject({ chooser: text, reason: 'text' });
  });
  it('falls back to vision for thin options (games, canvas)', () => {
    expect(pickChooser({ text, vision, perception: perc(2), forceVision: false })).toMatchObject({ chooser: vision, reason: 'thin' });
  });
  it('falls back to vision with no perception, when forced, or when typing is next', () => {
    expect(pickChooser({ text, vision, perception: null, forceVision: false }).reason).toBe('no_perception');
    expect(pickChooser({ text, vision, perception: perc(20), forceVision: true }).reason).toBe('forced');
    expect(pickChooser({ text, vision, perception: perc(20, true), forceVision: false }).reason).toBe('typing');
  });
});

describe('textChoiceNeedsVision', () => {
  const opts = [{ index: 0 }, { index: 1 }] as ActOption[];
  const c = (x: Partial<Choice>): Choice => ({ latencyMs: 0, ...x });
  it('accepts a confident choice', () => {
    expect(textChoiceNeedsVision(c({ index: 1, probs: [0.1, 0.9] }), opts)).toBe(false);
  });
  it('rejects low confidence, errors and out-of-range indexes', () => {
    expect(textChoiceNeedsVision(c({ index: 0, probs: [0.3, 0.29] }), opts)).toBe(true);
    expect(textChoiceNeedsVision(c({ error: 'x' }), opts)).toBe(true);
    expect(textChoiceNeedsVision(c({ index: 5 }), opts)).toBe(true);
    expect(textChoiceNeedsVision(c({}), opts)).toBe(true);
  });
});

describe('ProbabilityChooser', () => {
  const state = { goal: 'sign in', perception: { state: 'S' }, notes: ['N'], playerLines: ['the blue one'] } as unknown as ChooseState;
  const options = [{ label: 'a' }, { label: 'b' }, { label: 'c' }] as ActOption[];
  it('picks the argmax and passes goal, state, history and option labels to the scorer', async () => {
    const score = vi.fn(async () => ({ probs: [0.2, 0.7, 0.1] }));
    const ch = new ProbabilityChooser('oss', 'm', score);
    const r = await ch.choose(state, options, [{ step: 1, action: 'click', ok: true, result: 'ok' }], new AbortController().signal);
    expect(r.index).toBe(1);
    expect(r.probs).toEqual([0.2, 0.7, 0.1]);
    const arg = (score.mock.calls[0] as unknown as [{ goal: string; state: string; history: string[]; options: string[] }])[0];
    expect(arg.goal).toBe('sign in');
    expect(arg.options).toEqual(['a', 'b', 'c']);
    expect(arg.state).toMatch(/S\nN\nThe player said: "the blue one"/);
    expect(arg.history[0]).toMatch(/step 1: click/);
  });
  it('reports a length mismatch as an error', async () => {
    const ch = new ProbabilityChooser('oss', 'm', async () => ({ probs: [1] }));
    expect((await ch.choose(state, options, [], new AbortController().signal)).error).toMatch(/1 scores for 3/);
  });
});

describe('Jev', () => {
  const input = { goal: 'sign in', state: 'S', history: ['step 1: x'], options: ['click a', 'DONE'] };
  it('builds the systemone request with option keys', () => {
    const r = buildJevRequest(input);
    expect(r.model).toBe(JEV_DEFAULT_MODEL);
    expect(r.questions.next!.type).toBe('choice');
    expect(r.questions.next!.criteria).toEqual({ o0: 'click a', o1: 'DONE' });
    expect(r.questions.next!.instructions).toMatch(/sign in/);
    expect(r.state).toMatch(/Steps so far:\nstep 1: x/);
  });
  it('refuses empty and oversized menus', () => {
    expect(() => buildJevRequest({ ...input, options: [] })).toThrow(/no options/);
    expect(() => buildJevRequest({ ...input, options: Array(256).fill('x') })).toThrow(/max 255/);
  });
  it('parses probabilities in option order', () => {
    const body = { answers: { next: { type: 'choice', choice: 'o1', probabilities: { o0: 0.25, o1: 0.75 }, confidence: 0.75 } } };
    expect(parseJevResponse(body, 2)).toEqual([0.25, 0.75]);
  });
  it('falls back to one-hot on the choice', () => {
    expect(parseJevResponse({ answers: { next: { type: 'choice', choice: 'o0', confidence: 0.6 } } }, 2)).toEqual([0.6, 0]);
  });
  it('rejects malformed answers', () => {
    expect(() => parseJevResponse({}, 2)).toThrow(/malformed/);
    expect(() => parseJevResponse({ answers: { next: { type: 'choice', choice: 'o9' } } }, 2)).toThrow(/unknown option/);
  });
  it('posts with the bearer key and returns probs', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ answers: { next: { type: 'choice', choice: 'o0', probabilities: { o0: 0.9, o1: 0.1 } } } }), { status: 200 }));
    const score = makeJevScore({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const r = await score(input, new AbortController().signal);
    expect(r.probs).toEqual([0.9, 0.1]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
  it('is a stub (null) without SEI_JEV_API_KEY', () => {
    expect(buildJevChooser({})).toBeNull();
    const c = buildJevChooser({ SEI_JEV_API_KEY: 'x', SEI_JEV_MODEL: 'jev-latest' });
    expect(c?.name).toBe('jev');
    expect(c?.model).toBe('jev-latest');
    expect(c?.textOnly).toBe(true);
  });
});
