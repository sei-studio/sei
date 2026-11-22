import { describe, expect, it } from 'vitest';
import { SEILINK_HOST_OFF, type SeilinkHostStatus } from '@shared/seilinkHost';
import { BOOT_QUIET_MS, openedHintFor, updatedHintFor } from './desktopHint';

const st = (state: SeilinkHostStatus['state'], characterId: string | null): SeilinkHostStatus => ({ ...SEILINK_HOST_OFF, state, characterId });
const calm = { sinceStartMs: BOOT_QUIET_MS + 1, intro: false, liveCard: false, desktopEditor: false };

describe('openedHintFor (product call (261116))', () => {
  it('a move-in that came up running says opened, once', () => {
    expect(openedHintFor(st('starting', 'a'), st('running', 'a'), calm)).toBe('a');
    expect(openedHintFor(st('running', 'a'), st('running', 'a'), calm)).toBeNull();
  });
  it('a swap to another companion says it again', () => {
    expect(openedHintFor(st('running', 'a'), st('running', 'b'), calm)).toBe('b');
  });
  it('not the move-in restored at launch, a host restart, or under the intro, the live card or the desktop editor', () => {
    expect(openedHintFor(SEILINK_HOST_OFF, st('running', 'a'), { ...calm, sinceStartMs: 1000 })).toBeNull();
    expect(openedHintFor(st('restarting', 'a'), st('running', 'a'), calm)).toBeNull();
    expect(openedHintFor(st('starting', 'a'), st('running', 'a'), { ...calm, intro: true })).toBeNull();
    expect(openedHintFor(st('starting', 'a'), st('running', 'a'), { ...calm, liveCard: true })).toBeNull();
    expect(openedHintFor(st('starting', 'a'), st('running', 'a'), { ...calm, desktopEditor: true })).toBeNull();
    expect(openedHintFor(st('running', 'a'), st('failed', 'a'), calm)).toBeNull();
  });
});

describe('updatedHintFor', () => {
  it('the in-app editor closed after a save while she lives on the desktop', () => {
    expect(updatedHintFor({ characterId: 'a', desktop: false }, new Set(['a']), 'a')).toBe(true);
    expect(updatedHintFor({ characterId: 'a', desktop: false }, new Set(), 'a')).toBe(false);
    expect(updatedHintFor({ characterId: 'a', desktop: true }, new Set(['a']), 'a')).toBe(false);
    expect(updatedHintFor({ characterId: 'a', desktop: false }, new Set(['a']), 'b')).toBe(false);
  });
});




