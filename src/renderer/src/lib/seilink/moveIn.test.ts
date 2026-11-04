import { describe, expect, it } from 'vitest';
import { SEILINK_HOST_OFF } from '@shared/seilinkHost';
import { moveInFailed, needsMoveInSheet } from './moveIn';

describe('seilink move-in (M4)', () => {
  it('shows the sheet for her first room or a swap, not for a plain return', () => {
    expect(needsMoveInSheet({ saved: false, movedInId: null, characterId: 'a' })).toBe(true);
    expect(needsMoveInSheet({ saved: true, movedInId: 'b', characterId: 'a' })).toBe(true);
    expect(needsMoveInSheet({ saved: true, movedInId: null, characterId: 'a' })).toBe(false);
    expect(needsMoveInSheet({ saved: true, movedInId: 'a', characterId: 'a' })).toBe(false);
  });

  it('treats failed, unsupported and off as a start that did not take', () => {
    expect(moveInFailed({ ...SEILINK_HOST_OFF })).toBe(true);
    expect(moveInFailed({ ...SEILINK_HOST_OFF, state: 'unsupported' })).toBe(true);
    expect(moveInFailed({ ...SEILINK_HOST_OFF, state: 'failed' })).toBe(true);
    expect(moveInFailed({ ...SEILINK_HOST_OFF, state: 'starting', characterId: 'a' })).toBe(false);
    expect(moveInFailed({ ...SEILINK_HOST_OFF, state: 'running', characterId: 'a' })).toBe(false);
  });
});
