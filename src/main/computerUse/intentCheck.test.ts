import { describe, expect, it } from 'vitest';
import { createIntentCheck, INTENT_SYSTEM, intentPrompt, isCleanYes } from './intentCheck';
import type { LlmCallParams } from '../llm/types';

function fakeCall(reply: string | Error) {
  const seen: LlmCallParams[] = [];
  const call = async (p: LlmCallParams) => {
    seen.push(p);
    if (reply instanceof Error) throw reply;
    return { content: [], toolUses: [], text: reply, usage: {}, stopReason: 'end_turn' } as never;
  };
  return { call, seen };
}

describe('isCleanYes', () => {
  it.each(['yes', 'Yes', 'YES.', 'yes!', ' yes \n'])('yes: %j', (t) => expect(isCleanYes(t)).toBe(true));
  it.each(['no', 'yes, but', 'Yes. They are asking', 'probably yes', '', 'maybe', 'y'])('not yes: %j', (t) =>
    expect(isCleanYes(t)).toBe(false),
  );
});

describe('createIntentCheck', () => {
  it('sends only the utterance and the goal, to Haiku, and takes a clean yes', async () => {
    const f = fakeCall('yes');
    const check = createIntentCheck({ call: f.call });
    expect(await check('can you turn on dark mode', 'turn on dark mode', new AbortController().signal)).toBe(true);
    expect(f.seen).toHaveLength(1);
    const p = f.seen[0]!;
    expect(p.model).toBe('claude-haiku-4-5');
    expect(p.system).toBe(INTENT_SYSTEM);
    expect(p.tools).toBeUndefined();
    expect(p.messages).toEqual([{ role: 'user', content: intentPrompt('can you turn on dark mode', 'turn on dark mode') }]);
  });

  it('anything but a clean yes is no', async () => {
    for (const r of ['no', 'Yes, they are asking.', '']) {
      const f = fakeCall(r);
      expect(await createIntentCheck({ call: f.call })('delete it', 'delete the file', new AbortController().signal)).toBe(false);
    }
  });

  it('errors propagate (the gate treats them as no)', async () => {
    const f = fakeCall(new Error('503'));
    await expect(createIntentCheck({ call: f.call })('delete it', 'delete the file', new AbortController().signal)).rejects.toThrow('503');
  });

  it('never calls the model for an empty line', async () => {
    const f = fakeCall('yes');
    expect(await createIntentCheck({ call: f.call })('  ', 'delete the file', new AbortController().signal)).toBe(false);
    expect(f.seen).toHaveLength(0);
  });
});
