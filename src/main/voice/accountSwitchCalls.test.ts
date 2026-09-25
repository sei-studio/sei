/**
 * endCallsForAccountSwitch (260926): what index.ts's endVoiceCallsForAccountSwitch
 * does with every open call when the account changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { endCallsForAccountSwitch, type AccountSwitchCallDeps } from './accountSwitchCalls';
import { applyCallReport, clearAllCalls, isCallActive, endCallFromCompanion } from './callState';
import { pendingScopedWrites, drainScopedWrites, _resetScopeBarrierForTests } from '../profile/scopeBarrier';

let order: string[];
let release: (() => void) | null;

function deps(): AccountSwitchCallDeps & {
  setVoiceCall: ReturnType<typeof vi.fn>;
  closeOverlay: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  emitCallSession: ReturnType<typeof vi.fn>;
} {
  return {
    setVoiceCall: vi.fn((id: string, on: boolean) => order.push(`voice:${id}:${on}`)),
    closeOverlay: vi.fn(() => order.push('overlay')),
    capture: vi.fn((event: string) => order.push(`capture:${event}`)),
    emitCallSession: vi.fn(
      (id: string) =>
        new Promise<void>((r) => {
          release = () => {
            order.push(`row:${id}`);
            r();
          };
        }),
    ),
  };
}

function openLive(id: string, liveMs: number): void {
  applyCallReport({ characterId: id, active: true });
  applyCallReport({ characterId: id, active: true, live: true });
  vi.advanceTimersByTime(liveMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  _resetScopeBarrierForTests();
  order = [];
  release = null;
});
afterEach(() => {
  clearAllCalls();
  vi.useRealTimers();
});

describe('endCallsForAccountSwitch', () => {
  it('closes the call, emits voice_call_ended with the reason, and tracks the row', async () => {
    openLive('sui', 30_000);
    const d = deps();
    const done = endCallsForAccountSwitch('account_switch', d);

    // Synchronous half: overlay closed, bot out of call mode, event captured,
    // row write registered with the barrier before anything yields.
    expect(isCallActive('sui')).toBe(false);
    expect(d.closeOverlay).toHaveBeenCalledTimes(1);
    expect(d.setVoiceCall).toHaveBeenCalledWith('sui', false);
    expect(d.capture).toHaveBeenCalledWith('voice_call_ended', {
      character_id: 'sui',
      duration_ms: 30_000,
      reason: 'account_switch',
    });
    expect(d.emitCallSession).toHaveBeenCalledWith('sui', 30_000);
    expect(pendingScopedWrites()).toBe(1);

    // The switch's drain waits for the row.
    let drained = false;
    const drain = drainScopedWrites(5_000).then((ok) => (drained = ok));
    await Promise.resolve();
    expect(drained).toBe(false);
    release!();
    await done;
    await drain;
    expect(drained).toBe(true);
    expect(order).toEqual(['overlay', 'voice:sui:false', 'capture:voice_call_ended', 'row:sui']);
  });

  it('a call that never connected leaves no row and no event', async () => {
    applyCallReport({ characterId: 'lyra', active: true }); // still ringing
    const d = deps();
    await endCallsForAccountSwitch('account_switch', d);
    expect(isCallActive('lyra')).toBe(false);
    expect(d.setVoiceCall).toHaveBeenCalledWith('lyra', false);
    expect(d.capture).not.toHaveBeenCalled();
    expect(d.emitCallSession).not.toHaveBeenCalled();
    expect(pendingScopedWrites()).toBe(0);
  });

  it('includes a companion hang-up whose renderer report is still pending', async () => {
    openLive('sui', 12_000);
    endCallFromCompanion('sui');
    const d = deps();
    const done = endCallsForAccountSwitch('account_switch', d);
    expect(d.emitCallSession).toHaveBeenCalledWith('sui', 12_000);
    release!();
    await done;
    // The renderer's late report is swallowed.
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 12_500 }).endedMs).toBeNull();
  });

  it('no calls: nothing happens, not even the overlay', async () => {
    const d = deps();
    await endCallsForAccountSwitch('account_switch', d);
    expect(d.closeOverlay).not.toHaveBeenCalled();
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('a failing row write is logged, not thrown', async () => {
    openLive('sui', 1_000);
    const d = deps();
    d.emitCallSession.mockImplementationOnce(async () => {
      throw new Error('disk');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(endCallsForAccountSwitch('account_switch', d)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
