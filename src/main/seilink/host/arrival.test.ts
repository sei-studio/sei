/**
 * Her arrival on the desktop (261119): when the entrance plays, when she
 * waits for her look, and the seilink_entrance event.
 */
import { describe, expect, it } from 'vitest';
import { Arrival, LOOK_POLL_MS, type LookNow } from './arrival';
import { LINK_TIMEOUT_MS, REVEAL_WAIT_MS, type EntranceTrigger, type SeilinkArrival } from '../../../shared/seilinkEntrance';

function harness(trigger: EntranceTrigger, look: LookNow | null) {
  let now = 1_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: SeilinkArrival[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const h = {
    look,
    sent,
    events,
    a: null as unknown as Arrival,
    /** Advance the clock, firing due timers in order. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    modes: (): string[] => sent.map((s) => s.mode + (s.quiet ? '(quiet)' : '')),
    timerCount: (): number => timers.size,
  };
  h.a = new Arrival('c1', trigger, {
    look: () => h.look,
    send: (x) => sent.push(x),
    capture: (e, p) => events.push([e, p]),
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (t) => void timers.delete(t as number),
  });
  return h;
}

const READY: LookNow = { pending: false, look: 'ready' };
const PENDING: LookNow = { pending: true, look: 'unavailable' };

describe('her arrival', () => {
  it('a move-in with her look ready holds until the app steps aside, then she comes in', () => {
    const h = harness('move_in', READY);
    h.a.update();
    expect(h.modes()).toEqual(['hold']);
    h.a.revealed();
    expect(h.modes()).toEqual(['hold', 'enter']);
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    expect(h.events).toEqual([
      [
        'seilink_entrance',
        {
          character_id: 'c1',
          trigger: 'move_in',
          action: 'played',
          look: 'ready',
          waited: false,
          wait_ms: 0,
          timed_out: false,
          skipped: false,
          avatar_kind: 'facepack',
          reduced_motion: false,
        },
      ],
    ]);
    expect(h.timerCount()).toBe(0);
  });

  it('nothing is decided until her look can be told (the imported check)', () => {
    const h = harness('move_in', null);
    h.a.update();
    expect(h.sent).toEqual([]);
    h.look = READY;
    h.a.update();
    expect(h.modes()).toEqual(['hold']);
  });

  it('a move-in comes in anyway when the app never steps aside', () => {
    const h = harness('switch', READY);
    h.a.update();
    h.advance(REVEAL_WAIT_MS);
    expect(h.modes()).toEqual(['hold', 'enter']);
    expect(h.sent[1].trigger).toBe('switch');
  });

  it('the desktop showing after it was covered counts as stepping aside', () => {
    const h = harness('move_in', READY);
    h.a.update();
    h.a.coverage(false);
    expect(h.modes()).toEqual(['hold']);
    h.a.coverage(true);
    h.a.coverage(false);
    expect(h.modes()).toEqual(['hold', 'enter']);
  });

  it('waits for her look, then her look landing is her entrance; wait_ms is the wait', () => {
    const h = harness('move_in', PENDING);
    h.a.update();
    h.a.revealed();
    expect(h.modes()).toEqual(['wait']);
    expect(h.a.waiting()).toBe(true);
    expect(h.a.present()).toBe(false);
    h.advance(150_000);
    h.look = READY;
    h.a.update();
    expect(h.modes()).toEqual(['wait', 'enter']);
    h.advance(3_000);
    h.a.pageArrived({ played: true, reduced: true, kind: 'facepack' });
    expect(h.events[0][1]).toMatchObject({ action: 'played', look: 'arrived', waited: true, wait_ms: 150_000, timed_out: false, reduced_motion: true });
  });

  it('a missed push is caught by the poll while she waits, and the poll stops after', () => {
    const h = harness('restore', PENDING);
    h.a.update();
    expect(h.modes()).toEqual(['wait']);
    h.look = { pending: false, look: 'unavailable' };
    h.advance(LOOK_POLL_MS);
    expect(h.modes()).toEqual(['wait', 'enter']);
    h.a.pageArrived({ played: true, reduced: false, kind: 'cutout' });
    expect(h.events[0][1]).toMatchObject({ trigger: 'restore', look: 'unavailable', waited: true });
    expect(h.timerCount()).toBe(0);
  });

  it('a restore with her look ready is just there (no entrance)', () => {
    const h = harness('restore', READY);
    h.a.update();
    expect(h.modes()).toEqual(['show']);
    h.a.pageArrived({ played: false, reduced: false, kind: 'facepack' });
    expect(h.events[0][1]).toMatchObject({ trigger: 'restore', action: 'still', look: 'ready', waited: false });
  });

  it('the first link is shown by the intro; after a handoff (the app stepped aside first) she comes in on the desktop', () => {
    const a = harness('first_link', READY);
    a.a.update();
    expect(a.modes()).toEqual(['show']);
    const b = harness('first_link', PENDING);
    b.a.update();
    b.a.revealed();
    expect(b.modes()).toEqual(['wait']);
    b.look = READY;
    b.a.update();
    expect(b.modes()).toEqual(['wait', 'enter']);
  });

  it('past LINK_TIMEOUT_MS the line turns quiet and keeps waiting (never a failure)', () => {
    const h = harness('move_in', PENDING);
    h.a.update();
    h.a.revealed();
    h.advance(LINK_TIMEOUT_MS);
    expect(h.modes()).toEqual(['wait', 'wait(quiet)']);
    h.advance(60_000);
    h.look = READY;
    h.a.update();
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    expect(h.events[0][1]).toMatchObject({ look: 'arrived', timed_out: true, wait_ms: LINK_TIMEOUT_MS + 60_000 });
  });

  it('a click on the waiting line lets her in now with the look she has', () => {
    const h = harness('move_in', PENDING);
    h.a.update();
    expect(h.a.skip()).toBe(true);
    // A skip is the user asking for her: no wait for the app to step aside.
    expect(h.modes()).toEqual(['wait', 'enter']);
    expect(h.a.skip()).toBe(false);
    h.a.pageArrived({ played: true, reduced: false, kind: 'portrait' });
    expect(h.events[0][1]).toMatchObject({ look: 'skipped', skipped: true, waited: true, avatar_kind: 'portrait' });
  });

  it('a click is not a skip when she is not waiting', () => {
    const h = harness('move_in', READY);
    h.a.update();
    expect(h.a.skip()).toBe(false);
  });

  it('enter and show are final: a re-check of her look does not pull her back out', () => {
    const h = harness('move_in', READY);
    h.a.update();
    h.a.revealed();
    h.look = PENDING;
    h.a.update();
    expect(h.modes()).toEqual(['hold', 'enter']);
  });

  it('the session ending before she came in sends `ended` once, and the waiters hear false', async () => {
    const h = harness('move_in', PENDING);
    h.a.update();
    const w = h.a.whenArrived();
    h.advance(20_000);
    h.a.end();
    h.a.end();
    await expect(w).resolves.toBe(false);
    expect(h.events).toHaveLength(1);
    expect(h.events[0][1]).toMatchObject({ action: 'ended', look: 'waiting', waited: true, wait_ms: 20_000 });
    expect(h.events[0][1]).not.toHaveProperty('avatar_kind');
    expect(h.timerCount()).toBe(0);
    await expect(h.a.whenArrived()).resolves.toBe(false);
  });

  it('whenArrived resolves true once she is in; a page report out of turn is ignored', async () => {
    const h = harness('move_in', READY);
    h.a.update();
    const w = h.a.whenArrived();
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    expect(h.events).toHaveLength(0);
    h.a.revealed();
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    await expect(w).resolves.toBe(true);
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    h.a.end();
    expect(h.events).toHaveLength(1);
  });

  it('a page that reconnects after she came in is told to just show her', () => {
    const h = harness('move_in', READY);
    h.a.update();
    h.a.revealed();
    h.a.pageArrived({ played: true, reduced: false, kind: 'facepack' });
    h.a.resend();
    expect(h.sent[h.sent.length - 1]).toEqual({ mode: 'show', trigger: 'move_in' });
    expect(h.a.present()).toBe(true);
  });
});
