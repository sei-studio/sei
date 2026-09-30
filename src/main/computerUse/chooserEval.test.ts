import { describe, expect, it } from 'vitest';
import evalSet from './__fixtures__/chooser-eval.json';

/**
 * Shape checks for the text chooser eval seed (run the eval itself with
 * `npx tsx scripts/act-chooser-eval.ts`). The two weak spots from the 260925
 * research must stay covered as the set grows.
 */
interface EvalCase {
  id: string;
  source: string;
  tags: string[];
  goal: string;
  state: string;
  options: string[];
  correct: number[];
  history?: Array<{ step: number; action: string; ok: boolean; result: string }>;
}
const cases = evalSet.cases as EvalCase[];
const DONE = 'DONE: the goal is already achieved on this screen';

describe('chooser eval fixture', () => {
  it('has unique ids and valid answers', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.goal.trim(), c.id).not.toBe('');
      expect(c.state.trim(), c.id).not.toBe('');
      expect(c.correct.length, c.id).toBeGreaterThan(0);
      for (const i of c.correct) expect(c.options[i], `${c.id} correct ${i}`).toBeDefined();
      expect(new Set(c.options).size, `${c.id} duplicate labels`).toBe(c.options.length);
    }
  });

  it('every case offers DONE and GIVE_UP, in the loop\'s wording', () => {
    for (const c of cases) {
      expect(c.options, c.id).toContain(DONE);
      expect(c.options.some((o) => o.startsWith('GIVE_UP:')), c.id).toBe(true);
    }
  });

  it('covers "already done" and "press Return after typing"', () => {
    const done = cases.filter((c) => c.tags.includes('already-done'));
    expect(done.length).toBeGreaterThanOrEqual(2);
    for (const c of done) expect(c.correct.map((i) => c.options[i])).toEqual([DONE]);
    const ret = cases.filter((c) => c.tags.includes('return-after-typing'));
    expect(ret.length).toBeGreaterThanOrEqual(1);
    for (const c of ret) expect(c.correct.every((i) => /press Return/.test(c.options[i]!))).toBe(true);
  });

  it('includes a long list and a real AX-derived case', () => {
    expect(cases.some((c) => c.options.length >= 30)).toBe(true);
    expect(cases.some((c) => c.source.startsWith('ax-fixture'))).toBe(true);
  });
});
