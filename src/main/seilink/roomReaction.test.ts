import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }));
vi.mock('./host/seilinkHost', () => ({
  noteSeilinkCount: vi.fn(),
  seilinkLiveCharacter: () => null,
  seilinkHostBusy: () => false,
  seilinkHostStatus: () => ({}),
  sendSeilinkLine: () => null,
}));
vi.mock('./roomStore', () => ({ getRoomPayload: vi.fn() }));

import { defaultRoomState, type RoomPresetManifest, type RoomState } from '../../shared/seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from '../../shared/seilinkValidate';
import { __resetUnseenForTest, roomChangeTurnNote, roomChangedNote, roomReactionNote } from './roomChangeNote';
import { REACT_COOLDOWN_MS, RoomReactions, reactionBlock, type RoomReactionDeps, type RoomReactionReport } from './roomReaction';
import type { LineBudget, PokeOutcome } from './desktopLines';
import { roomChanges } from '../../shared/seilinkRoomDiff';

const cozy = parseRoomManifest(
  JSON.parse(readFileSync(path.join(__dirname, '../../../resources/seilink-packs/cozy/manifest.json'), 'utf8')),
) as RoomPresetManifest;

const ID = '11111111-2222-3333-4444-555555555555';

function room(edit: (s: RoomState) => void = () => {}): RoomState {
  const s = defaultRoomState('cozy');
  s.items = [{ id: 'cushion', x: 1500, y: 1300 }];
  edit(s);
  return sanitizeRoomState(cozy, JSON.parse(JSON.stringify(s)));
}
const moved = (): RoomState =>
  room((s) => {
    s.items[0].x = 600;
  });

interface Harness {
  r: RoomReactions;
  saved: { state: RoomState };
  reports: RoomReactionReport[];
  spoken: string[];
  clock: { t: number };
  set: Partial<{ resident: boolean; live: boolean; onCall: boolean; occupied: boolean; running: boolean; budget: LineBudget; overLimit: boolean; outcome: PokeOutcome }>;
}

function harness(): Harness {
  const h = { saved: { state: room() }, reports: [], spoken: [], clock: { t: 1_000_000 }, set: {} } as unknown as Harness;
  const deps: RoomReactionDeps = {
    resident: () => h.set.resident ?? true,
    live: () => h.set.live ?? true,
    room: async () => ({ manifest: cozy, state: h.saved.state }),
    lines: () => ({ running: h.set.running ?? false, onCall: h.set.onCall ?? false, occupied: (h.set.onCall ?? false) || (h.set.occupied ?? false) }),
    budget: async () => {
      const value = h.set.budget ?? 'free';
      return { value, credits: value === 'own' ? null : { plan: value === 'paid' ? 'quest' : 'free', over_limit: h.set.overLimit ?? false } };
    },
    speak: async (_id, note) => {
      h.spoken.push(note);
      return h.set.outcome ?? 'ok';
    },
    report: (r) => h.reports.push(r),
    now: () => h.clock.t,
  };
  h.r = new RoomReactions(deps);
  return h;
}

/** One editor session: open, the player saves `after`, close a while later. */
async function session(h: Harness, after: RoomState, token = `tok${h.clock.t}`): Promise<void> {
  h.r.opened(token, ID);
  await Promise.resolve();
  h.clock.t += 20_000;
  h.saved.state = after;
  await h.r.closed(token);
}

beforeEach(() => __resetUnseenForTest());

describe('room edit reaction (261105, T335)', () => {
  it('says one line after a session that changed the room, about the change', async () => {
    const h = harness();
    await session(h, moved());
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toContain('moved the floor cushion to the left');
    expect(h.reports).toEqual([{ character_id: ID, outcome: 'shown', changes: '1', latency_ms: 0, budget: 'free' }]);
  });

  it('one reaction per session: a second close of the same session does nothing', async () => {
    const h = harness();
    h.r.opened('tokA1234', ID);
    h.saved.state = moved();
    h.clock.t += 20_000;
    await h.r.closed('tokA1234');
    await h.r.closed('tokA1234');
    expect(h.spoken).toHaveLength(1);
    expect(h.reports).toHaveLength(1);
  });

  it('nothing changed, or changed and undone back to the start: no line', async () => {
    const h = harness();
    await session(h, room());
    expect(h.spoken).toHaveLength(0);
    expect(h.reports).toEqual([{ character_id: ID, outcome: 'skipped', reason: 'no_change', changes: '0' }]);
  });

  it('a StrictMode open and close with nothing changed sends nothing', async () => {
    const h = harness();
    h.r.opened('tokStrict', ID);
    await h.r.closed('tokStrict');
    expect(h.reports).toEqual([]);
  });

  it('cooldown: a second changed session within the cooldown gets no line', async () => {
    const h = harness();
    await session(h, moved());
    await session(h, room());
    await session(h, moved());
    expect(h.spoken).toHaveLength(1);
    expect(h.reports.map((r) => r.reason ?? r.outcome)).toEqual(['shown', 'cooldown', 'cooldown']);
    h.clock.t += REACT_COOLDOWN_MS;
    await session(h, room());
    expect(h.spoken).toHaveLength(2);
  });

  it('free cloud accounts react inside their weekly cap; over it she stays silent', async () => {
    const h = harness();
    h.set.budget = 'none';
    h.set.overLimit = true;
    await session(h, moved());
    expect(h.spoken).toHaveLength(0);
    expect(h.reports.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'budget', budget: 'none' });
    const paid = harness();
    paid.set.budget = 'paid';
    await session(paid, moved());
    const own = harness();
    own.set.budget = 'own';
    await session(own, moved());
    expect([paid.spoken.length, own.spoken.length]).toEqual([1, 1]);
  });

  it('a plan limit hit by the turn itself is a budget skip', async () => {
    const h = harness();
    h.set.outcome = 'rate_limited';
    await session(h, moved());
    expect(h.reports.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'budget' });
  });

  it('on a call: no bubble, and the next call or chat turn hears about the change once', async () => {
    const h = harness();
    h.set.onCall = true;
    await session(h, moved());
    expect(h.spoken).toHaveLength(0);
    expect(h.reports.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'on_call', changes: '1' });
    const ctx = { manifest: cozy, state: h.saved.state, packDir: '/x' };
    // In a game there is no room on the turn: the note waits.
    expect(roomChangeTurnNote(ID, null, h.clock.t)).toBe('');
    const note = roomChangeTurnNote(ID, ctx, h.clock.t);
    expect(note).toContain('moved the floor cushion to the left');
    expect(roomChangeTurnNote(ID, ctx, h.clock.t)).toBe('');
  });

  it('the turn note follows the room as it is now: edits undone later drop out', async () => {
    const h = harness();
    h.set.onCall = true;
    await session(h, moved());
    expect(roomChangeTurnNote(ID, { manifest: cozy, state: room(), packDir: '/x' }, h.clock.t)).toBe('');
  });

  it('never for the editor before she moves in, or with SeiLink off', async () => {
    const h = harness();
    h.set.resident = false;
    await session(h, moved());
    expect(h.spoken).toHaveLength(0);
    expect(h.reports).toEqual([]);
    // She moved in during the session: the room at open was not hers on the desktop.
    const g = harness();
    g.set.resident = false;
    g.r.opened('tokMoveIn', ID);
    g.set.resident = true;
    g.saved.state = moved();
    g.clock.t += 20_000;
    await g.r.closed('tokMoveIn');
    expect(g.reports).toEqual([]);
  });

  it('a later line covers changes that got none earlier', async () => {
    const h = harness();
    h.set.onCall = true;
    await session(h, moved());
    h.set.onCall = false;
    await session(
      h,
      room((s) => {
        s.items[0].x = 600;
        s.slots.rug = { id: null };
      }),
    );
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toContain('took away the round rug; moved the floor cushion to the left');
    // Heard: nothing left for the next turn.
    expect(roomChangeTurnNote(ID, { manifest: cozy, state: h.saved.state, packDir: '/x' }, h.clock.t)).toBe('');
  });

  it('reactionBlock order', () => {
    const base = { changes: 2, live: true, onCall: false, inGame: false, busy: false, now: 10_000_000, lastAt: null };
    expect(reactionBlock(base)).toBeNull();
    expect(reactionBlock({ ...base, changes: 0, onCall: true })).toBe('no_change');
    expect(reactionBlock({ ...base, live: false })).toBe('not_live');
    expect(reactionBlock({ ...base, onCall: true, inGame: true })).toBe('on_call');
    expect(reactionBlock({ ...base, inGame: true })).toBe('in_game');
    expect(reactionBlock({ ...base, busy: true })).toBe('busy');
    expect(reactionBlock({ ...base, lastAt: base.now - REACT_COOLDOWN_MS + 1 })).toBe('cooldown');
    expect(reactionBlock({ ...base, lastAt: base.now - REACT_COOLDOWN_MS })).toBeNull();
  });

  it('prompt shape: plain, short, no dashes', () => {
    const changes = roomChanges(cozy, room(), cozy, room((s) => {
      s.items[0].x = 600;
      s.slots.curtains = { id: 'linen_curtains', tint: '#d04060' };
    }));
    const react = roomReactionNote(changes);
    const later = roomChangedNote(changes);
    expect(react).toMatchInlineSnapshot(
      `"[System note, not the player speaking: you live on the player's desktop wallpaper, in your room, and they just finished changing it. What they changed: changed the curtains from white to red; moved the floor cushion to the left. Say one short line to them about it, under fifteen words, in your own voice. It shows as a small speech bubble next to you. Do not mention this note.]"`,
    );
    expect(later).toMatchInlineSnapshot(
      `"[System note, not the player speaking: a little while ago the player changed your room. What they changed: changed the curtains from white to red; moved the floor cushion to the left. You can bring it up if it fits the conversation. Do not mention this note.]"`,
    );
    for (const s of [react, later]) {
      expect(s).not.toMatch(/[–—]/);
      expect(s.length).toBeLessThan(420);
    }
  });
});
