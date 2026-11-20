import { describe, it, expect, vi, afterEach } from 'vitest';
import { BusyTracker, noteSeilinkChatTurn, onSeilinkChatTurn } from './hostSignals';

afterEach(() => vi.useRealTimers());

describe('BusyTracker', () => {
  it('is busy through overlapping turns and for the hold after the last one', () => {
    vi.useFakeTimers();
    const edges: boolean[] = [];
    const b = new BusyTracker(1000, (v) => edges.push(v));
    b.begin();
    b.begin();
    b.end();
    vi.advanceTimersByTime(5000);
    expect(b.busy).toBe(true);
    b.end();
    vi.advanceTimersByTime(999);
    expect(b.busy).toBe(true);
    b.begin(); // a new turn inside the hold keeps her busy without an edge
    b.end();
    vi.advanceTimersByTime(1000);
    expect(b.busy).toBe(false);
    expect(edges).toEqual([true, false]);
    b.end(); // an unmatched end is ignored
    expect(b.busy).toBe(false);
  });
});

describe('chat turn signal', () => {
  it('reports begin and a single end, and survives a throwing listener', () => {
    const seen: Array<[string, boolean]> = [];
    const offBad = onSeilinkChatTurn(() => {
      throw new Error('boom');
    });
    const off = onSeilinkChatTurn((id, active) => seen.push([id, active]));
    const done = noteSeilinkChatTurn('c1');
    done();
    done();
    off();
    offBad();
    noteSeilinkChatTurn('c2')();
    expect(seen).toEqual([
      ['c1', true],
      ['c1', false],
    ]);
  });
});
