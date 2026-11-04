import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: Array<[string, Record<string, unknown>]> = [];
vi.mock('../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: (e: string, p: Record<string, unknown>) => captured.push([e, p]) }),
}));

import { ROOM_ERROR_QUIET_MS, _resetSeilinkErrorsForTests, reportPackError, reportRoomError, seilinkErrorClass } from './seilinkErrors';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('seilink error analytics (261105)', () => {
  beforeEach(() => {
    captured.length = 0;
    _resetSeilinkErrorsForTests();
  });

  it('classifies without the message', () => {
    expect(seilinkErrorClass(new Error('SEILINK_PACK_MISSING: no pack for preset gamer'))).toBe('pack_missing');
    expect(seilinkErrorClass(new Error('SEILINK_BAD_ID'))).toBe('bad_id');
    expect(seilinkErrorClass(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission');
    expect(seilinkErrorClass(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('disk_full');
    expect(seilinkErrorClass(Object.assign(new Error('x'), { code: 'ACCOUNT_SWITCHING' }))).toBe('account_switching');
    expect(seilinkErrorClass(new SyntaxError('bad json'))).toBe('invalid');
    expect(seilinkErrorClass('C:\\Users\\bob\\room.json')).toBe('other');
  });

  it('sends a pack error once per pack, source and class', async () => {
    reportPackError('cozy', 'bundled', 'file_missing');
    reportPackError('cozy', 'bundled', 'file_missing');
    reportPackError('cozy', 'installed', 'file_missing');
    await flush();
    expect(captured).toEqual([
      ['seilink_pack_error', { pack_id: 'cozy', source: 'bundled', error_class: 'file_missing' }],
      ['seilink_pack_error', { pack_id: 'cozy', source: 'installed', error_class: 'file_missing' }],
    ]);
  });

  it('quiets repeated room errors', async () => {
    const err = Object.assign(new Error('/secret/path'), { code: 'EPERM' });
    expect(reportRoomError('write', err, 0)).toBe('permission');
    reportRoomError('write', err, 1000);
    reportRoomError('write', err, ROOM_ERROR_QUIET_MS + 1);
    await flush();
    expect(captured).toEqual([
      ['seilink_room_error', { op: 'write', error_class: 'permission' }],
      ['seilink_room_error', { op: 'write', error_class: 'permission' }],
    ]);
    expect(JSON.stringify(captured)).not.toContain('secret');
  });
});
