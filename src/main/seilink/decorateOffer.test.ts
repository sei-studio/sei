import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blankRoomState, defaultRoomState, plainRoomState, withoutPlain, type RoomState } from '../../shared/seilinkRoom';

const m = vi.hoisted(() => ({
  events: [] as Array<{ event: string; props: Record<string, unknown> }>,
  enabled: true,
  live: 'sui' as string | null,
  offer: new Map<string, string>(),
  rooms: new Map<string, unknown>(),
  roomListeners: [] as Array<(id: string) => void>,
}));

vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: (event: string, props: Record<string, unknown>) => m.events.push({ event, props }) }),
}));
vi.mock('./gate', () => ({ seilinkEnabled: () => m.enabled }));
vi.mock('./host/seilinkHost', () => ({
  seilinkLiveCharacter: () => m.live,
  seilinkDockOffer: (id: string) => m.offer.get(id) ?? 'none',
  setSeilinkDockOffer: (id: string, o: string) => {
    if (m.live !== id) return false;
    m.offer.set(id, o);
    return true;
  },
}));
vi.mock('./roomStore', () => ({
  getRoomState: async (id: string) => {
    const s = m.rooms.get(id);
    if (!s) throw new Error('none');
    return s;
  },
  onRoomChange: (fn: (id: string) => void) => {
    m.roomListeners.push(fn);
    return () => {
      m.roomListeners = m.roomListeners.filter((f) => f !== fn);
    };
  },
}));

import {
  DECORATE_OFFER_NOTE,
  DECORATE_OFFER_NOTE_PLAIN,
  OFFER_LINE_WAIT_MS,
  OFFER_TTL_MS,
  __resetDecorateOfferForTest,
  closeDecorateOffer,
  initDecorateOffer,
  offerDecorateTogether,
  onDecorateOfferAnswer,
} from './decorateOffer';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const offerEvents = (): Array<Record<string, unknown>> => m.events.filter((e) => e.event === 'seilink_decorate_offer').map((e) => e.props);

describe('decorate-together offer', () => {
  const open = vi.fn();
  let speak: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetDecorateOfferForTest();
    m.events = [];
    m.enabled = true;
    m.live = 'sui';
    m.offer.clear();
    m.rooms.clear();
    m.roomListeners = [];
    m.rooms.set('sui', blankRoomState());
    open.mockReset();
    speak = vi.fn(async () => ({ outcome: 'ok' }));
    initDecorateOffer({ openDesktopEditor: open, speak: speak as never });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('she asks: the dock shows her offer, one turn with the note', async () => {
    const r = await offerDecorateTogether('sui', 'intro');
    expect(r).toEqual({ shown: true, line: 'her' });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('sui', DECORATE_OFFER_NOTE);
    expect(m.offer.get('sui')).toBe('her');
    await flush();
    expect(offerEvents()).toEqual([expect.objectContaining({ action: 'shown', line: 'her', via: 'intro' })]);
  });

  it('no line (budget, busy): the dock asks in UI copy and says why', async () => {
    speak.mockResolvedValueOnce({ outcome: 'budget' });
    const r = await offerDecorateTogether('sui', 'move_in');
    expect(r).toEqual({ shown: true, line: 'ui' });
    expect(m.offer.get('sui')).toBe('prompt');
    await flush();
    expect(offerEvents()[0]).toMatchObject({ action: 'shown', line: 'ui', line_outcome: 'budget' });
  });

  it('a slow line does not hold the offer: UI copy after the wait', async () => {
    vi.useFakeTimers();
    speak.mockReturnValueOnce(new Promise(() => {}));
    const p = offerDecorateTogether('sui', 'intro');
    await vi.advanceTimersByTimeAsync(OFFER_LINE_WAIT_MS + 10);
    expect(await p).toEqual({ shown: true, line: 'ui' });
    expect(m.offer.get('sui')).toBe('prompt');
  });

  it('asked once per companion', async () => {
    await offerDecorateTogether('sui', 'intro');
    onDecorateOfferAnswer('sui', 'later');
    expect(await offerDecorateTogether('sui', 'move_in')).toEqual({ shown: false, reason: 'already' });
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('skips a room that is not blank, a companion who is not there, and SeiLink off', async () => {
    m.rooms.set('sui', defaultRoomState('cozy'));
    expect(await offerDecorateTogether('sui', 'intro')).toEqual({ shown: false, reason: 'not_blank' });
    expect(await offerDecorateTogether('lyra', 'intro')).toEqual({ shown: false, reason: 'not_live' });
    m.enabled = false;
    expect(await offerDecorateTogether('sui', 'intro')).toEqual({ shown: false, reason: 'disabled' });
    expect(speak).not.toHaveBeenCalled();
  });

  it('"Decorate together" opens her editor on the desktop', async () => {
    await offerDecorateTogether('sui', 'intro');
    onDecorateOfferAnswer('sui', 'decorate');
    expect(open).toHaveBeenCalledWith('sui');
    await flush();
    expect(offerEvents().map((e) => e.action)).toEqual(['shown', 'accepted']);
  });

  it('"Not now" only records the answer (the host already cleared the dock)', async () => {
    await offerDecorateTogether('sui', 'intro');
    onDecorateOfferAnswer('sui', 'later');
    expect(open).not.toHaveBeenCalled();
    await flush();
    expect(offerEvents()[1]).toMatchObject({ action: 'declined', line: 'her' });
    // A second answer (a stale press) does nothing.
    onDecorateOfferAnswer('sui', 'decorate');
    expect(open).not.toHaveBeenCalled();
  });

  it('expires after the TTL and clears the dock', async () => {
    vi.useFakeTimers();
    await offerDecorateTogether('sui', 'intro');
    await vi.advanceTimersByTimeAsync(OFFER_TTL_MS + 10);
    expect(m.offer.get('sui')).toBe('none');
    expect(offerEvents().map((e) => e.action)).toContain('expired');
  });

  it('closes once the room is decorated some other way', async () => {
    await offerDecorateTogether('sui', 'intro');
    const decorated: RoomState = { ...blankRoomState(), items: [{ id: 'plant', x: 0.5, y: 0.8, scale: 1, flip: false } as never] };
    m.rooms.set('sui', decorated);
    for (const fn of m.roomListeners) fn('sui');
    await flush();
    expect(m.offer.get('sui')).toBe('none');
    expect(offerEvents().map((e) => e.action)).toContain('closed');
  });

  it('closes when she moves out', async () => {
    await offerDecorateTogether('sui', 'intro');
    closeDecorateOffer();
    await flush();
    expect(offerEvents().map((e) => e.action)).toEqual(['shown', 'closed']);
  });
  it('on the plain first state she asks to set the room up (261106)', async () => {
    m.rooms.set('sui', plainRoomState({ id: 'cozy', slots: {} }));
    expect(await offerDecorateTogether('sui', 'move_in')).toEqual({ shown: true, line: 'her' });
    expect(speak).toHaveBeenCalledWith('sui', DECORATE_OFFER_NOTE_PLAIN);
    expect(DECORATE_OFFER_NOTE_PLAIN).not.toContain('—');
  });

  it('closes once the plain room is set up some other way', async () => {
    const plain = plainRoomState({ id: 'cozy', slots: {} });
    m.rooms.set('sui', plain);
    await offerDecorateTogether('sui', 'intro');
    m.rooms.set('sui', { ...withoutPlain(plain), items: [{ id: 'plant', x: 0.5, y: 0.8 } as never] });
    for (const fn of m.roomListeners) fn('sui');
    await flush();
    expect(m.offer.get('sui')).toBe('none');
  });
});
