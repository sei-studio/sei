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
vi.mock('./roomStore', () => ({ getRoomPayload: vi.fn(), roomSource: { getRoom: vi.fn() } }));
vi.mock('./packs', () => ({ loadPack: vi.fn() }));
vi.mock('../lazyAnalytics', () => ({ loadAnalytics: () => Promise.resolve({ capture: () => {} }) }));

import { defaultRoomState, type RoomPresetManifest, type RoomState } from '../../shared/seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from '../../shared/seilinkValidate';
import { setSlotTint, slotChoice, swatchesFor } from '../../shared/seilinkEdit';
import type { SeilinkEditorEvent } from '../../shared/seilinkTogether';
import { __resetUnseenForTest, keepUnseenBaseline } from './roomChangeNote';
import {
  __resetTogetherForTest,
  callPictureDecision,
  closeTogether,
  decorateToolFor,
  editorTurnNote,
  LIVE_GAP_MS,
  LIVE_MAX_PER_SESSION,
  LIVE_PAUSE_MS,
  liveLineBlock,
  liveLineNote,
  liveRoomFor,
  notePictureSent,
  openTogether,
  PICTURE_GAP_MS,
  runDecorate,
  setTogetherSink,
  syncTogether,
  togetherByToken,
} from './editorTogether';
import { TogetherLive, type LiveLineReport, type TogetherLiveDeps } from './decorateTogether';
import { RoomReactions, type RoomReactionReport } from './roomReaction';
import type { LineBudget, PokeOutcome } from './desktopLines';
import type { RoomContext } from './types';

const cozy = parseRoomManifest(
  JSON.parse(readFileSync(path.join(__dirname, '../../../resources/seilink-packs/cozy/manifest.json'), 'utf8')),
) as RoomPresetManifest;

const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'tok_together_1';

function room(edit: (s: RoomState) => void = () => {}): RoomState {
  const s = defaultRoomState('cozy');
  s.items = [{ id: 'cushion', x: 1500, y: 1300 }];
  edit(s);
  return sanitizeRoomState(cozy, JSON.parse(JSON.stringify(s)));
}
const ctx = (state: RoomState): RoomContext => ({ manifest: cozy, state, packDir: '/packs/cozy' });
const tint = (s: RoomState, slot: 'bed' | 'curtains' | 'rug', i: number): RoomState =>
  setSlotTint(cozy, s, slot, swatchesFor(cozy.components.find((c) => c.id === slotChoice(cozy, s, slot))!)[i]);

interface Harness {
  live: TogetherLive;
  timers: Array<{ fn: () => void; at: number; id: number }>;
  clock: { t: number };
  spoken: string[];
  reports: LiveLineReport[];
  events: SeilinkEditorEvent[];
  set: Partial<{ resident: boolean; onCall: boolean; occupied: boolean; running: boolean; budget: LineBudget; overLimit: boolean; outcome: PokeOutcome }>;
}

function harness(): Harness {
  const h: Harness = { timers: [], clock: { t: 5_000_000 }, spoken: [], reports: [], events: [], set: {} } as unknown as Harness;
  let seq = 0;
  const deps: TogetherLiveDeps = {
    resident: () => h.set.resident ?? true,
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
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock.t + ms, id: ++seq };
      h.timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      h.timers = h.timers.filter((t) => t.id !== id);
    },
  };
  h.live = new TogetherLive(deps);
  setTogetherSink((ev) => h.events.push(ev));
  return h;
}

/** Move the clock and run the timers that are due (and the turns they start). */
async function advance(h: Harness, ms: number): Promise<void> {
  const end = h.clock.t + ms;
  for (;;) {
    const due = h.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    h.timers = h.timers.filter((t) => t !== due);
    h.clock.t = Math.max(h.clock.t, due.at);
    due.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  h.clock.t = end;
}

function edit(h: Harness, state: RoomState): void {
  const s = syncTogether(TOKEN, ctx(state), h.clock.t);
  if (s) h.live.edited(s);
}

beforeEach(() => {
  __resetTogetherForTest();
  __resetUnseenForTest();
});

describe('live lines', () => {
  it('batches edits and speaks once after the pause', async () => {
    const h = harness();
    openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: false });
    edit(h, tint(room(), 'bed', 3));
    await advance(h, 1_000);
    edit(h, tint(tint(room(), 'bed', 3), 'curtains', 5));
    await advance(h, LIVE_PAUSE_MS - 100);
    expect(h.spoken).toHaveLength(0);
    await advance(h, 200);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toMatch(/bed/);
    expect(h.spoken[0]).toMatch(/curtains/);
    expect(h.reports.at(-1)).toMatchObject({ outcome: 'shown', changes: '2' });
    expect(h.events).toContainEqual({ token: TOKEN, kind: 'count', key: 'live_lines' });
    // Nothing new: no second line.
    await advance(h, LIVE_GAP_MS * 2);
    expect(h.spoken).toHaveLength(1);
  });

  it('waits out the cooldown and then covers only what is new', async () => {
    const h = harness();
    openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: false });
    const a = tint(room(), 'bed', 3);
    edit(h, a);
    await advance(h, LIVE_PAUSE_MS + 10);
    expect(h.spoken).toHaveLength(1);
    edit(h, tint(a, 'rug', 2));
    await advance(h, LIVE_PAUSE_MS + 10);
    expect(h.spoken).toHaveLength(1);
    expect(h.reports.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'cooldown' });
    await advance(h, LIVE_GAP_MS);
    expect(h.spoken).toHaveLength(2);
    expect(h.spoken[1]).toMatch(/rug/);
    expect(h.spoken[1]).not.toMatch(/bed/);
  });

  it(`stops at ${LIVE_MAX_PER_SESSION} lines a session`, async () => {
    const h = harness();
    openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: false });
    for (let i = 1; i <= LIVE_MAX_PER_SESSION + 2; i++) {
      edit(h, tint(room(), 'bed', i % 7 + 1));
      await advance(h, LIVE_GAP_MS + LIVE_PAUSE_MS);
    }
    expect(h.spoken).toHaveLength(LIVE_MAX_PER_SESSION);
    expect(h.reports.some((r) => r.reason === 'cap')).toBe(true);
  });

  it('is quiet on a call and in a game', async () => {
    for (const set of [{ onCall: true }, { occupied: true }]) {
      __resetTogetherForTest();
      const h = harness();
      h.set = set;
      openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: false });
      edit(h, tint(room(), 'bed', 3));
      await advance(h, LIVE_PAUSE_MS + 10);
      expect(h.spoken).toHaveLength(0);
      expect(h.reports[0].reason).toBe(set.onCall ? 'on_call' : 'in_game');
    }
  });

  it('a free account over its weekly cap gets no line; inside it does', async () => {
    const h = harness();
    h.set = { budget: 'none', overLimit: true };
    openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: false });
    edit(h, tint(room(), 'bed', 3));
    await advance(h, LIVE_PAUSE_MS + 10);
    expect(h.spoken).toHaveLength(0);
    expect(h.reports[0]).toMatchObject({ outcome: 'skipped', reason: 'budget' });

    __resetTogetherForTest();
    const h2 = harness();
    h2.set = { budget: 'free' };
    openTogether(TOKEN, ID, ctx(room()), { now: h2.clock.t, onCall: false });
    edit(h2, tint(room(), 'bed', 3));
    await advance(h2, LIVE_PAUSE_MS + 10);
    expect(h2.spoken).toHaveLength(1);
  });

  it('reports each skip reason once a session', async () => {
    const h = harness();
    h.set = { onCall: true };
    openTogether(TOKEN, ID, ctx(room()), { now: h.clock.t, onCall: true });
    for (let i = 1; i < 4; i++) {
      edit(h, tint(room(), 'bed', i));
      await advance(h, LIVE_PAUSE_MS + 10);
    }
    expect(h.reports.filter((r) => r.reason === 'on_call')).toHaveLength(1);
  });

  it('liveLineBlock: gates in order', () => {
    const base = { changes: 2, resident: true, onCall: false, inGame: false, busy: false, shown: 0, lastAt: null, lastEditAt: 0, now: 100_000 };
    expect(liveLineBlock(base)).toBeNull();
    expect(liveLineBlock({ ...base, changes: 0 })?.skip).toBe('no_change');
    expect(liveLineBlock({ ...base, resident: false })?.skip).toBe('not_resident');
    expect(liveLineBlock({ ...base, lastEditAt: base.now - 1_000 })).toEqual({ skip: 'busy', retryInMs: LIVE_PAUSE_MS - 1_000 });
    expect(liveLineBlock({ ...base, lastAt: base.now - 10_000 })).toEqual({ skip: 'cooldown', retryInMs: LIVE_GAP_MS - 10_000 });
  });
});

describe('closing line after a live session', () => {
  function reactions(after: () => RoomState) {
    const reports: RoomReactionReport[] = [];
    const spoken: string[] = [];
    let saved = room();
    let t = 9_000_000;
    const r = new RoomReactions({
      resident: () => true,
      live: () => true,
      room: async () => ({ manifest: cozy, state: saved }),
      lines: () => ({ running: false, onCall: false, occupied: false }),
      budget: async () => ({ value: 'paid', credits: { plan: 'quest', over_limit: false } }),
      speak: async (_id, note) => {
        spoken.push(note);
        return 'ok';
      },
      report: (x) => reports.push(x),
      now: () => t,
    });
    return {
      r,
      reports,
      spoken,
      save: () => {
        saved = after();
      },
      tick: (ms: number) => {
        t += ms;
      },
      now: () => t,
    };
  }

  it('skips the closing line when she already talked about everything', async () => {
    const after = tint(room(), 'bed', 3);
    const x = reactions(() => after);
    x.r.opened('tok_close_1', ID);
    await Promise.resolve();
    x.tick(120_000);
    x.save();
    await x.r.closed('tok_close_1', { seen: { manifest: cozy, state: after }, lastLiveAt: x.now() - 90_000 });
    expect(x.spoken).toHaveLength(0);
    expect(x.reports[0]).toMatchObject({ outcome: 'skipped', reason: 'seen_live' });
  });

  it('covers only what changed after her live line', async () => {
    const seen = tint(room(), 'bed', 3);
    const after = tint(seen, 'curtains', 5);
    const x = reactions(() => after);
    x.r.opened('tok_close_2', ID);
    await Promise.resolve();
    x.tick(120_000);
    x.save();
    await x.r.closed('tok_close_2', { seen: { manifest: cozy, state: seen }, lastLiveAt: x.now() - 90_000 });
    expect(x.spoken).toHaveLength(1);
    expect(x.spoken[0]).toMatch(/curtains/);
    expect(x.spoken[0]).not.toMatch(/bed/);
  });

  it('no closing line right after a live one', async () => {
    const seen = tint(room(), 'bed', 3);
    const x = reactions(() => tint(seen, 'curtains', 5));
    x.r.opened('tok_close_3', ID);
    await Promise.resolve();
    x.tick(120_000);
    x.save();
    await x.r.closed('tok_close_3', { seen: { manifest: cozy, state: seen }, lastLiveAt: x.now() - 5_000 });
    expect(x.spoken).toHaveLength(0);
    expect(x.reports[0]).toMatchObject({ reason: 'cooldown' });
  });
});

describe('her turns while the editor is open', () => {
  it('the room she sees is the editor room, unsaved', () => {
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    const next = tint(room(), 'bed', 3);
    syncTogether(TOKEN, ctx(next), 1);
    expect(liveRoomFor(ID, ctx(room())).state).toEqual(next);
    closeTogether(TOKEN);
    expect(liveRoomFor(ID, ctx(room())).state).toEqual(room());
  });

  it('the turn note lists what changed since her last turn, once', () => {
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    syncTogether(TOKEN, ctx(tint(room(), 'bed', 3)), 1);
    const first = editorTurnNote(ID, { now: 2, onCall: false });
    expect(first).toMatch(/What they changed since your last turn: .*bed/);
    expect(first).toMatch(/In your room now:/);
    const second = editorTurnNote(ID, { now: 3, onCall: false });
    expect(second).not.toMatch(/What they changed/);
    expect(second).not.toMatch(/—|friend/);
  });

  it('changes from an earlier session she never heard about are carried in', () => {
    keepUnseenBaseline(ID, { manifest: cozy, state: room() }, 0);
    openTogether(TOKEN, ID, ctx(tint(room(), 'rug', 2)), { now: 1, onCall: false });
    expect(editorTurnNote(ID, { now: 2, onCall: false })).toMatch(/rug/);
  });

  it('offers decorate only while her editor is open, the same object every turn', () => {
    expect(decorateToolFor(ID, ctx(room()))).toBeNull();
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    const a = decorateToolFor(ID, ctx(room()));
    expect(a?.name).toBe('decorate');
    expect(decorateToolFor(ID, ctx(room()))).toBe(a);
    expect(decorateToolFor(ID, null)).toBeNull();
  });

  it('decorate applies to the editor room and sends the ops to the editor', () => {
    const events: SeilinkEditorEvent[] = [];
    setTogetherSink((e) => events.push(e));
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    const r = runDecorate(ID, { changes: [{ do: 'add', target: 'monstera' }, { do: 'color', target: 'curtains', value: 'navy' }] }, { now: 5 });
    expect(r.result?.ops).toHaveLength(2);
    expect(r.text).toMatch(/Done, the room changed/);
    const edits = events.find((e) => e.kind === 'edits');
    expect(edits).toMatchObject({ token: TOKEN, kind: 'edits', mode: 'apply' });
    expect(togetherByToken(TOKEN)?.live.state.items.map((i) => i.id)).toContain('monstera');
    // She knows what she did: no change list about her own edits next turn.
    expect(editorTurnNote(ID, { now: 6, onCall: false })).not.toMatch(/What they changed/);
    expect(events).toContainEqual({ token: TOKEN, kind: 'count', key: 'her_edits_applied' });
  });

  it('suggest leaves the room as it is', () => {
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    const r = runDecorate(ID, { mode: 'suggest', changes: [{ do: 'time', value: 'night' }] }, { now: 5 });
    expect(r.result?.mode).toBe('suggest');
    expect(togetherByToken(TOKEN)?.live.state).toEqual(room());
  });

  it('tells her once when the player undid her changes, and not after another edit', () => {
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: false });
    runDecorate(ID, { changes: [{ do: 'color', target: 'curtains', value: 'navy' }] }, { now: 1 });
    // The editor's "Undo her changes": the room is back to before hers.
    syncTogether(TOKEN, ctx(room()), 2);
    const note = editorTurnNote(ID, { now: 3, onCall: false });
    expect(note).toMatch(/They undid your last changes/);
    expect(note).not.toMatch(/What they changed/);
    expect(editorTurnNote(ID, { now: 4, onCall: false })).not.toMatch(/undid/);
    // Hers again, then the player changes something else and only later goes back: a plain change list.
    runDecorate(ID, { changes: [{ do: 'color', target: 'curtains', value: 'navy' }] }, { now: 5 });
    const after = togetherByToken(TOKEN)!.live.state;
    syncTogether(TOKEN, ctx(tint(after, 'bed', 3)), 6);
    syncTogether(TOKEN, ctx(room()), 7);
    expect(editorTurnNote(ID, { now: 8, onCall: false })).toMatch(/What they changed since your last turn/);
  });

  it('a live line after the undo says so instead of listing it', () => {
    expect(liveLineNote([], true)).toMatch(/They undid your last changes/);
    expect(liveLineNote([], true)).not.toMatch(/What they just changed/);
  });

  it('decorate with the editor closed changes nothing', () => {
    expect(runDecorate(ID, { changes: [{ do: 'time', value: 'night' }] }, { now: 0 }).result).toBeNull();
  });
});

describe('call pictures', () => {
  it('only when the room changed, at most one per PICTURE_GAP_MS', () => {
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: true });
    let t = 100_000;
    expect(callPictureDecision(ID, { now: t, vision: 'yes' })).toBe('skipped_unchanged');
    const a = tint(room(), 'bed', 3);
    syncTogether(TOKEN, ctx(a), t);
    expect(callPictureDecision(ID, { now: t, vision: 'yes' })).toBe('send');
    notePictureSent(ID, ctx(a), t);
    // Same room again: no picture.
    t += 60_000;
    expect(callPictureDecision(ID, { now: t, vision: 'yes' })).toBe('skipped_unchanged');
    const b = tint(a, 'curtains', 5);
    syncTogether(TOKEN, ctx(b), t);
    expect(callPictureDecision(ID, { now: t, vision: 'yes' })).toBe('send');
    notePictureSent(ID, ctx(b), t);
    const c = tint(b, 'rug', 2);
    syncTogether(TOKEN, ctx(c), t + 1_000);
    expect(callPictureDecision(ID, { now: t + 5_000, vision: 'yes' })).toBe('rate_limited');
    expect(callPictureDecision(ID, { now: t + PICTURE_GAP_MS, vision: 'yes' })).toBe('send');
  });

  it('none for a model that cannot see, or with no editor', () => {
    expect(callPictureDecision(ID, { now: 0, vision: 'yes' })).toBe('none');
    openTogether(TOKEN, ID, ctx(room()), { now: 0, onCall: true });
    syncTogether(TOKEN, ctx(tint(room(), 'bed', 3)), 1);
    expect(callPictureDecision(ID, { now: 2, vision: 'no' })).toBe('none');
  });
});
