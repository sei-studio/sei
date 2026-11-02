/**
 * Where the message-tail cache breakpoint goes.
 *
 * This is worth pinning because getting it wrong is invisible: the request
 * succeeds either way, the reply is identical, and the only symptom is a bill.
 * A breakpoint on content that is unique per turn pays the 1.25x write
 * multiplier forever and reads back nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  markLastMessageCached,
  markMessageCached,
  appendUncachedTail,
  buildSystemBlocks,
  clockTailNote,
} from './chatPrompts';
import { toMessages } from './transcript';
import type { ChatMessage } from '../../shared/ipc';

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

/**
 * The backseat transcript across two looks (261102). The companion speaks on
 * every look and the player mostly does not, so her lines are consecutive
 * companion rows that merge into ONE assistant message, and the breakpoint
 * sits on that message. What the next look can read back is everything up to
 * and including the block the breakpoint was on, so that block must come back
 * byte-identical. A growing string does not; one block per row does.
 */
describe('backseat transcript across looks (261102)', () => {
  const row = (i: number, text: string): ChatMessage =>
    ({ id: `c${i}`, role: 'companion', text, ts: 1_700_000_000_000 + i * 1000 }) as ChatMessage;
  /** One look as runTurn assembles it: history, breakpoint on its last message, then the grid turn. */
  const look = (history: ChatMessage[], appendOnly: boolean): Msg[] => {
    const messages = toMessages(history, appendOnly ? { appendOnly: true } : {}) as Msg[];
    markMessageCached(messages, messages.length - 1);
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '...' } },
        { type: 'text', text: '[look note]' },
      ],
    });
    return messages;
  };
  /** Content blocks in cache-prefix order with cache_control stripped (it is not part of the bytes). */
  const prefix = (ms: Msg[]): string[] =>
    ms.flatMap((m, i) => {
      const bs = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as object[]);
      return bs.map((b) => {
        const { cache_control: _cc, ...rest } = b as { cache_control?: unknown };
        return `${i}:${m.role}:${JSON.stringify(rest)}`;
      });
    });
  /** Index of the block carrying the breakpoint, in prefix() order. */
  const breakpointAt = (ms: Msg[]): number =>
    ms
      .flatMap((m) => (typeof m.content === 'string' ? [{}] : (m.content as Array<{ cache_control?: unknown }>)))
      .findIndex((b) => !!(b as { cache_control?: unknown }).cache_control);

  const lines = ['oh the boss is back', 'that dodge was clean', 'ok now heal', 'you got this'];

  it('reads back the previous look\'s cached transcript when one block per row', () => {
    for (let n = 1; n < lines.length; n++) {
      const a = look(lines.slice(0, n).map((t, i) => row(i, t)), true);
      const b = look(lines.slice(0, n + 1).map((t, i) => row(i, t)), true);
      const upTo = breakpointAt(a) + 1;
      expect(upTo).toBeGreaterThan(0);
      expect(prefix(b).slice(0, upTo)).toEqual(prefix(a).slice(0, upTo));
    }
  });

  it('the old string merge rewrote the block the breakpoint was on (the regression this pins)', () => {
    const a = look(lines.slice(0, 2).map((t, i) => row(i, t)), false);
    const b = look(lines.slice(0, 3).map((t, i) => row(i, t)), false);
    const upTo = breakpointAt(a) + 1;
    expect(prefix(b).slice(0, upTo)).not.toEqual(prefix(a).slice(0, upTo));
  });
});

describe('a voice call turn (261024)', () => {
  // Minimal args for a call's system prompt; only the status block matters here.
  const sysArgs = (clockInTail: boolean) =>
    ({
      persona: { source: 'p', expanded: 'A persona.' },
      name: 'Sui',
      preferredName: 'Ren',
      proactiveness: 1,
      punctuation: 'casual',
      memory: '- [1 Oct 2026, 10:00] a note',
      summary: 'A summary.',
      openWorldDetected: false,
      inGame: false,
      voiceCall: true,
      clockInTail,
    }) as Parameters<typeof buildSystemBlocks>[0];

  it('keeps the minute clock out of the system prompt when clockInTail is set', () => {
    const blocks = buildSystemBlocks(sysArgs(true));
    const status = blocks[blocks.length - 1].text;
    expect(status).not.toMatch(/\d{2}:\d{2}/);
    expect(status).toContain('the "now" stamp at the end of the latest message');
    // Typed chat (and every caller that does not opt in) keeps the live clock.
    const plain = buildSystemBlocks(sysArgs(false));
    expect(plain[plain.length - 1].text).toMatch(/The current date and time is .+\d{2}:\d{2}\./);
  });

  it('builds a byte-identical system prompt across a minute rollover', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 24, 10, 34, 50));
      const a = JSON.stringify(buildSystemBlocks(sysArgs(true)));
      vi.setSystemTime(new Date(2026, 9, 24, 10, 35, 5));
      const b = JSON.stringify(buildSystemBlocks(sysArgs(true)));
      expect(b).toBe(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the clock note after the breakpoint, so the cached prefix repeats next turn', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 24, 10, 34));
      const turn1: Msg[] = [
        { role: 'user', content: '[24 Oct 10:34] hey' },
      ];
      markLastMessageCached(turn1);
      appendUncachedTail(turn1, clockTailNote());
      const blocks = turn1[0].content as Array<{ text: string; cache_control?: unknown }>;
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: 'text', text: '[24 Oct 10:34] hey', cache_control: { type: 'ephemeral' } });
      expect(blocks[1].cache_control).toBeUndefined();
      expect(blocks[1].text).toBe('[now: Sat 24 Oct 2026, 10:34]');

      // Next turn the same row is rebuilt without the note: its cached block is
      // exactly what turn 1 wrote, so the read covers it.
      vi.setSystemTime(new Date(2026, 9, 24, 10, 35));
      const turn2: Msg[] = [
        { role: 'user', content: '[24 Oct 10:34] hey' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '[24 Oct 10:35] whats up' },
      ];
      markLastMessageCached(turn2);
      appendUncachedTail(turn2, clockTailNote());
      expect((turn2[0].content as string)).toBe((blocks[0] as { text: string }).text);
      expect(turn2.filter(cached)).toHaveLength(0); // the tail block is last, unmarked
      const last = turn2[2].content as Array<{ cache_control?: unknown; text: string }>;
      expect(last[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(last[1].text).toContain('10:35');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the note its own user turn when the transcript ends on the companion', () => {
    const messages: Msg[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    appendUncachedTail(messages, 'note');
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: 'user', content: 'note' });
    appendUncachedTail(messages, '');
    expect(messages).toHaveLength(3);
  });
});
