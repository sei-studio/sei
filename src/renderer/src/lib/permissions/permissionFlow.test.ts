/**
 * 260929: the Call-press microphone preflight and the card's access check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { statusSpy, requestSpy, trackSpy } = vi.hoisted(() => ({
  statusSpy: vi.fn(async (): Promise<string> => 'granted'),
  requestSpy: vi.fn(async () => true),
  trackSpy: vi.fn(),
}));
vi.mock('../ipcClient', () => ({
  sei: {
    platform: 'darwin',
    permissionsStatus: statusSpy,
    permissionsRequestMic: requestSpy,
    permissionsOpenSettings: vi.fn(async () => true),
    track: trackSpy,
  },
}));

import { isPermissionRefusal, micAccessOk, micPreflight, trackPermission } from './permissionFlow';

beforeEach(() => {
  statusSpy.mockReset();
  requestSpy.mockReset();
  trackSpy.mockReset();
});

describe('micPreflight on macOS', () => {
  it('goes straight through when granted, without prompting', async () => {
    statusSpy.mockResolvedValue('granted');
    expect(await micPreflight('darwin')).toBe('ok');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('asks the system prompt the first time and follows the answer', async () => {
    statusSpy.mockResolvedValue('not-determined');
    requestSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await micPreflight('darwin')).toBe('ok');
    expect(await micPreflight('darwin')).toBe('blocked');
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('does not prompt after a denial (macOS would not show it again)', async () => {
    statusSpy.mockResolvedValue('denied');
    expect(await micPreflight('darwin')).toBe('blocked');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('reports restricted separately', async () => {
    statusSpy.mockResolvedValue('restricted');
    expect(await micPreflight('darwin')).toBe('restricted');
  });

  it('never blocks a call on a broken bridge', async () => {
    statusSpy.mockRejectedValue(new Error('no handler'));
    expect(await micPreflight('darwin')).toBe('ok');
  });
});

describe('micPreflight on Windows', () => {
  it('never stops a call: the status read is not the desktop-apps switch, getUserMedia decides', async () => {
    for (const status of ['denied', 'restricted', 'granted', 'unknown']) {
      statusSpy.mockResolvedValue(status);
      expect(await micPreflight('win32')).toBe('ok');
    }
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe('micAccessOk', () => {
  it('macOS trusts the live status', async () => {
    statusSpy.mockResolvedValue('denied');
    expect(await micAccessOk('darwin')).toBe(false);
    statusSpy.mockResolvedValue('granted');
    expect(await micAccessOk('darwin')).toBe(true);
  });

  it('Windows opens the mic for an instant to test the desktop-apps switch', async () => {
    const stop = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error(''), { name: 'NotAllowedError' }))
      .mockResolvedValueOnce({ getTracks: () => [{ stop }] })
      .mockRejectedValueOnce(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    statusSpy.mockResolvedValue('granted');
    expect(await micAccessOk('win32')).toBe(false);
    expect(await micAccessOk('win32')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    // No mic plugged in is not a permission problem: the call says so itself.
    expect(await micAccessOk('win32')).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('Windows ignores a "denied" status when the mic actually opens', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    statusSpy.mockResolvedValue('denied');
    expect(await micAccessOk('win32')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('macOS treats a broken bridge as "not yet"', async () => {
    statusSpy.mockRejectedValue(new Error('no handler'));
    expect(await micAccessOk('darwin')).toBe(false);
  });
});

describe('isPermissionRefusal', () => {
  it('knows a refusal from a missing device', () => {
    expect(isPermissionRefusal({ name: 'NotAllowedError', message: '' })).toBe(true);
    expect(isPermissionRefusal(new Error('Permission denied'))).toBe(true);
    expect(isPermissionRefusal({ name: 'NotFoundError', message: 'Requested device not found' })).toBe(false);
  });
});

describe('trackPermission', () => {
  it('sends kind and platform only', () => {
    trackPermission('permission_prompt_shown', 'screen');
    expect(trackSpy).toHaveBeenCalledWith('permission_prompt_shown', { kind: 'screen', platform: 'darwin' });
  });
});
