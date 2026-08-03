/**
 * Where the message-tail cache breakpoint goes.
 *
 * This is worth pinning because getting it wrong is invisible: the request
 * succeeds either way, the reply is identical, and the only symptom is a bill.
 * A breakpoint on content that is unique per turn pays the 1.25x write
 * multiplier forever and reads back nothing.
 */
import { describe, it, expect } from 'vitest';
import { markLastMessageCached, markMessageCached } from './chatPrompts';

type Msg = { role: 'user' | 'assistant'; content: unknown };
const cached = (m: Msg): boolean => {
  const c = m.content as Array<{ cache_control?: unknown }>;
  return Array.isArray(c) && !!c[c.length - 1]?.cache_control;
};

describe('markMessageCached', () => {
  it('marks the chosen message and no other', () => {
    const messages: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ];
    markMessageCached(messages, 1);
    expect(messages.map(cached)).toEqual([false, true, false]);
  });

  it('normalizes a string body so the breakpoint has a block to sit on', () => {
    const messages: Msg[] = [{ role: 'user', content: 'plain' }];
    markMessageCached(messages, 0);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('is a no-op out of range rather than throwing', () => {
    const messages: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }];
    expect(() => markMessageCached(messages, -1)).not.toThrow();
    expect(() => markMessageCached(messages, 9)).not.toThrow();
    expect(cached(messages[0])).toBe(false);
  });

  it('still backs markLastMessageCached unchanged', () => {
    const messages: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    markLastMessageCached(messages);
    expect(messages.map(cached)).toEqual([false, true]);
  });
});

describe('an image-per-turn surface (backseat)', () => {
  /**
   * The shape backseatService.runTurn builds: a stable transcript, then one
   * volatile message carrying a freshly composited grid. The breakpoint belongs
   * at the end of the transcript, NOT on the grid — that message never repeats,
   * so a breakpoint there is a guaranteed write with a guaranteed zero read,
   * while the transcript above it re-bills in full for want of one.
   */
  it('caches the transcript and leaves the grid as plain input', () => {
    const history: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'nice shot' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'thanks' }] },
    ];
    markMessageCached(history, history.length - 1);
    history.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '...' } },
        { type: 'text', text: '[System note ...]' },
      ],
    });

    expect(cached(history[history.length - 2])).toBe(true);
    expect(cached(history[history.length - 1])).toBe(false);
    // And exactly one breakpoint in the messages, so the other three stay
    // available to buildSystemBlocks. Anthropic allows four in total.
    expect(history.filter(cached)).toHaveLength(1);
  });
});
