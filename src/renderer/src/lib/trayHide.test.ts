/**
 * Hiding the window to the tray ends a live call and the Backseat share
 * through their normal teardown, capture first.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const order: string[] = [];
const backseat = {
  sharingFor: null as string | null,
  clearPendingShare: vi.fn(() => order.push('clearPending')),
  stopWatch: vi.fn(() => order.push('stopWatch')),
  stopSharing: vi.fn(async () => {
    order.push('stopSharing');
  }),
};
const voice = {
  participants: [] as unknown[],
  status: 'idle',
  callCharacterId: null as string | null,
  endCall: vi.fn(() => order.push('endCall')),
};
const ui = { view: { kind: 'home' } as { kind: string }, navigate: vi.fn() };

vi.mock('./stores/useBackseatStore', () => ({ useBackseatStore: { getState: () => backseat } }));
vi.mock('./stores/useVoiceStore', () => ({ useVoiceStore: { getState: () => voice } }));
vi.mock('./stores/useUiStore', () => ({ useUiStore: { getState: () => ui } }));

import { endCallSurfacesForTrayHide } from './trayHide';

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  backseat.sharingFor = null;
  voice.participants = [];
  voice.status = 'idle';
  voice.callCharacterId = null;
  ui.view = { kind: 'home' };
});

describe('endCallSurfacesForTrayHide', () => {
  it('stops the share, then ends the call, and leaves the call screen', () => {
    backseat.sharingFor = 'sui';
    voice.participants = [{ id: 'sui' }];
    voice.status = 'connected';
    voice.callCharacterId = 'sui';
    ui.view = { kind: 'voice-call' };
    endCallSurfacesForTrayHide();
    expect(order).toEqual(['clearPending', 'stopWatch', 'stopSharing', 'endCall']);
    expect(ui.navigate).toHaveBeenCalledWith({ kind: 'chat', characterId: 'sui' });
  });

  it('ends a call that is still connecting', () => {
    voice.status = 'connecting';
    endCallSurfacesForTrayHide();
    expect(voice.endCall).toHaveBeenCalled();
    expect(ui.navigate).not.toHaveBeenCalled();
  });

  it('does nothing to an idle app beyond dropping armed shares', () => {
    endCallSurfacesForTrayHide();
    expect(backseat.stopSharing).not.toHaveBeenCalled();
    expect(voice.endCall).not.toHaveBeenCalled();
    expect(backseat.clearPendingShare).toHaveBeenCalled();
  });

  it('still ends the call when stopping the share throws', () => {
    backseat.stopWatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    voice.status = 'connected';
    endCallSurfacesForTrayHide();
    expect(voice.endCall).toHaveBeenCalled();
  });
});
