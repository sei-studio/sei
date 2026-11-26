/**
 * 261124: party full. The cap check, main's slot-limit backstop recognised
 * through the IPC wrapper, the picker's pick (opens the Danger zone, never
 * unbinds), and the funnel events (shown, tapped, picked, unbind after).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const track = vi.fn();
(globalThis as unknown as { window: unknown }).window = { sei: { track } };

const {
  isPartyFullError,
  partyIsFull,
  openForUnbind,
  trackPartyFullShown,
  trackFreeSlotTapped,
  noteCompanionUnbound,
  __resetPartyFullTracking,
} = await import('./partyFull');
const { takeRequestedProfileFocus } = await import('./profileRows');
const { MAX_COMPANION_SLOTS } = await import('@shared/characterSchema');

const MAIN_MESSAGE = `You can only have ${MAX_COMPANION_SLOTS} companions. Remove one to make room.`;

function events(): Array<[string, Record<string, unknown>]> {
  return track.mock.calls.map((c) => [c[0] as string, c[1] as Record<string, unknown>]);
}

beforeEach(() => {
  track.mockClear();
  __resetPartyFullTracking();
  takeRequestedProfileFocus();
});

describe('party cap', () => {
  it('is full at the cap and over it, not below', () => {
    expect(partyIsFull(MAX_COMPANION_SLOTS - 1, MAX_COMPANION_SLOTS)).toBe(false);
    expect(partyIsFull(MAX_COMPANION_SLOTS, MAX_COMPANION_SLOTS)).toBe(true);
    expect(partyIsFull(MAX_COMPANION_SLOTS + 1, MAX_COMPANION_SLOTS)).toBe(true);
  });

  it("recognises main's slot-limit message, bare or IPC-wrapped", () => {
    expect(isPartyFullError(new Error(MAIN_MESSAGE))).toBe(true);
    expect(
      isPartyFullError(new Error(`Error invoking remote method 'chars:add-to-library': Error: ${MAIN_MESSAGE}`)),
    ).toBe(true);
    expect(isPartyFullError(MAIN_MESSAGE)).toBe(true);
  });

  it('other failures are not party-full', () => {
    expect(isPartyFullError(new Error('daily_limit_reached'))).toBe(false);
    expect(isPartyFullError(new Error('fetch failed'))).toBe(false);
    expect(isPartyFullError(null)).toBe(false);
  });
});

describe('openForUnbind', () => {
  it("opens the companion's page on the Danger zone and unbinds nothing", () => {
    const navigate = vi.fn();
    openForUnbind('invite', 'c-1', navigate);
    expect(navigate).toHaveBeenCalledWith({ kind: 'character', id: 'c-1' });
    expect(takeRequestedProfileFocus()).toBe('danger');
    expect(events().map(([e]) => e)).toEqual(['party_full_slot_picked']);
  });
});

describe('party-full analytics', () => {
  it('shown fires once per surface per run', () => {
    trackPartyFullShown('world');
    trackPartyFullShown('world');
    trackPartyFullShown('invite');
    expect(events()).toEqual([
      ['party_full_shown', { surface: 'world' }],
      ['party_full_shown', { surface: 'invite' }],
    ]);
  });

  it('an unbind after the picker reports the surface, the tap and the pick', () => {
    trackPartyFullShown('world', 1_000);
    trackFreeSlotTapped('world', 2_000);
    openForUnbind('world', 'c-2', () => undefined);
    noteCompanionUnbound('c-2', 31_000);
    expect(events().at(-1)).toEqual([
      'party_full_unbind',
      { surface: 'world', tapped: true, picked: true, secs_since_shown: 30 },
    ]);
  });

  it('an unbind without a tap still counts, with tapped false', () => {
    trackPartyFullShown('import_settings', 0);
    noteCompanionUnbound('c-3', 5_000);
    expect(events().at(-1)).toEqual([
      'party_full_unbind',
      { surface: 'import_settings', tapped: false, picked: false, secs_since_shown: 5 },
    ]);
  });

  it('only the first unbind after a party-full line is reported', () => {
    trackPartyFullShown('create', 0);
    noteCompanionUnbound('a', 1_000);
    noteCompanionUnbound('b', 2_000);
    expect(events().filter(([e]) => e === 'party_full_unbind')).toHaveLength(1);
  });

  it('no party-full line this run: an unbind reports nothing', () => {
    noteCompanionUnbound('c-4');
    expect(events()).toEqual([]);
  });
});
