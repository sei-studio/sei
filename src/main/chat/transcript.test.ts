/**
 * The voice-call transcript window (261024). The window's first row is the
 * start of the cached transcript prefix, so it must stay put across turns and
 * only move in whole steps, counted on absolute transcript positions.
 */
import { describe, it, expect } from 'vitest';
import { toMessages, voiceWindowStart } from './transcript';
import type { ChatMessage } from '../../shared/ipc';

/** A transcript of `n` alternating user/companion rows; row text = absolute position. */
function rows(n: number, from = 0): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${from + i}`,
    role: (from + i) % 2 === 0 ? 'user' : 'companion',
    text: String(from + i),
    ts: 1_700_000_000_000 + (from + i) * 1000,
  })) as ChatMessage[];
}

/** Absolute position of the first row the window keeps. */
const firstKept = (h: ChatMessage[], base: number): number => Number(h[voiceWindowStart(h, base, 10, 10)].text);

describe('voiceWindowStart', () => {
  it('sends everything while the history is within the cap', () => {
    for (let n = 0; n <= 10; n++) expect(voiceWindowStart(rows(n), 0, 10, 10)).toBe(0);
  });

  it('keeps between cap and cap + step - 1 rows', () => {
    for (let n = 10; n < 200; n++) {
      const h = rows(n);
      const kept = n - voiceWindowStart(h, 0, 10, 10);
      expect(kept).toBeGreaterThanOrEqual(10);
      expect(kept).toBeLessThanOrEqual(19);
    }
  });

  it('holds the same first row for step turns in a row, then jumps by step', () => {
    const starts = Array.from({ length: 40 }, (_, i) => firstKept(rows(10 + i), 0));
    expect(starts.slice(0, 10).every((s) => s === 0)).toBe(true);
    expect(starts.slice(10, 20).every((s) => s === 10)).toBe(true);
    expect(starts.slice(20, 30).every((s) => s === 20)).toBe(true);
  });

  it('stays on the same absolute row when a fold drops a batch from the front', () => {
    for (let n = 60; n < 150; n++) {
      // Before the fold: the whole transcript. After: the first 50 rows are summarized.
      expect(firstKept(rows(n - 50, 50), 50)).toBe(firstKept(rows(n), 0));
    }
  });

  it('does not slide when the tail is capped at a constant length (folds failing)', () => {
    // readWindow caps the tail at the newest 150 rows, so history.length stays
    // 150 while its front (base) advances by one each turn.
    const starts: number[] = [];
    for (let total = 200; total < 230; total++) {
      const base = total - 150;
      starts.push(firstKept(rows(150, base), base));
    }
    // One distinct start per 10 turns, each a multiple of the step.
    expect(new Set(starts).size).toBeLessThanOrEqual(4);
    for (const s of starts) expect(s % 10).toBe(0);
    for (let i = 1; i < starts.length; i++) {
      const changed = starts[i] !== starts[i - 1];
      if (changed) expect(starts[i] - starts[i - 1]).toBe(10);
    }
  });

  it('counts only user/companion rows, and keeps system rows inside the window', () => {
    const h = rows(25);
    // A play row in the middle of the window.
    h.splice(20, 0, { id: 'p', role: 'system', text: 'played', ts: 0, event: { kind: 'play' } } as unknown as ChatMessage);
    const start = voiceWindowStart(h, 0, 10, 10);
    const kept = h.slice(start);
    expect(kept[0].text).toBe('10');
    expect(kept.filter((m) => m.role !== 'system')).toHaveLength(15);
    expect(kept.some((m) => m.role === 'system')).toBe(true);
  });

  it('treats a step below 1 as 1 (the old sliding window)', () => {
    expect(firstKept(rows(25), 0)).toBe(10);
    const h = rows(25);
    expect(Number(h[voiceWindowStart(h, 0, 10, 0)].text)).toBe(15);
  });
});

/**
 * toMessages appendOnly (261102, backseat). The model must read the same text
 * either way; what changes is that appending a row never edits an earlier
 * block, so a cache breakpoint on the last history message stays readable.
 */
describe('toMessages appendOnly', () => {
  type Msg = { role: 'user' | 'assistant'; content: unknown };
  const row = (i: number, role: 'user' | 'companion', text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id: `r${i}`, role, text, ts: 1_700_000_000_000 + i * 1000, ...extra }) as ChatMessage;
  /** The text the model reads: blocks of one message joined with no separator (Anthropic). */
  const flat = (ms: Msg[]) =>
    ms.map((m) => ({
      role: m.role,
      text: typeof m.content === 'string' ? m.content : (m.content as Array<{ text: string }>).map((b) => b.text).join(''),
    }));
  /** Every content block in order, as the cache prefix sees it. */
  const blocks = (ms: Msg[]): string[] =>
    ms.flatMap((m, i) =>
      (typeof m.content === 'string' ? [m.content] : (m.content as Array<{ text: string }>).map((b) => b.text)).map(
        (t) => `${i}:${m.role}:${t}`,
      ),
    );

  // A backseat-shaped transcript: the companion talks on every look, the
  // player now and then, a finished play session and a web lookup in between.
  const history: ChatMessage[] = [
    row(0, 'companion', 'oh the boss is back'),
    row(1, 'companion', 'that dodge was clean'),
    row(2, 'user', 'thanks lol'),
    row(3, 'companion', 'ok now heal'),
    row(4, 'companion', 'it says level 12', { lookup: { queries: ['boss level'] } } as Partial<ChatMessage>),
    row(5, 'companion', 'you got this'),
    { id: 'p', role: 'system', text: 'You played Minecraft for 10 minutes.', ts: 1_700_000_006_000, event: { kind: 'play' } } as ChatMessage,
    row(7, 'user', 'back'),
    row(8, 'user', 'did you miss me'),
    row(9, 'companion', 'always'),
  ];

  it('reads exactly the same text as the default string merge', () => {
    for (let n = 1; n <= history.length; n++) {
      const h = history.slice(0, n);
      expect(flat(toMessages(h, { appendOnly: true }))).toEqual(flat(toMessages(h)));
    }
  });

  it('leaves the default (chat, call) output unchanged: plain strings', () => {
    const ms = toMessages(history);
    expect(ms.every((m) => typeof m.content === 'string')).toBe(true);
    expect(ms[1]).toEqual({ role: 'assistant', content: 'oh the boss is back\nthat dodge was clean' });
  });

  it('keeps roles alternating and starting on the user', () => {
    const ms = toMessages(history, { appendOnly: true });
    expect(ms[0].role).toBe('user');
    ms.forEach((m, i) => i > 0 && expect(m.role).not.toBe(ms[i - 1].role));
  });

  it('only ever appends blocks when a row is added, never edits one', () => {
    for (let n = 1; n < history.length; n++) {
      const before = blocks(toMessages(history.slice(0, n), { appendOnly: true }));
      const after = blocks(toMessages(history.slice(0, n + 1), { appendOnly: true }));
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });

  it('the default merge does edit the last block, which is the cache bug it avoids', () => {
    const before = blocks(toMessages(history.slice(0, 1)));
    const after = blocks(toMessages(history.slice(0, 2)));
    expect(after.slice(0, before.length)).not.toEqual(before);
  });
});

// 261113 (v0.7 consistency D1): a play row carries what happened in it.
describe('play row story', () => {
  const play = (event: Record<string, unknown>): ChatMessage =>
    ({ id: 'p', role: 'system', text: 'You and Sui played Minecraft for 30 minutes.', ts: 1_700_000_000_000, event: { kind: 'play', ...event } }) as unknown as ChatMessage;

  it('reads the recap inside the shared-history note', () => {
    const [m] = toMessages([play({ recap: 'a creeper took the roof' })]);
    expect(String(m.content)).toContain('[Shared history: You and Sui played Minecraft for 30 minutes.');
    expect(String(m.content)).toMatch(/Your own recap of it afterwards: a creeper took the roof\]$/);
  });

  it('reads the last lines when there is no recap, and nothing extra on an old row', () => {
    expect(String(toMessages([play({ lines: [{ who: 'player', text: 'night' }] })])[0].content)).toContain('The last things said in the game: Player: "night"');
    expect(String(toMessages([play({})])[0].content)).toMatch(/not a plan\.\]$/);
  });
});
