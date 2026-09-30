/**
 * 260828 — auto-retry guard for summon pre-gate refusals. Pins the contract
 * the retry-loop fix depends on: an automatic summon is blocked after a
 * pre-gate refusal until user action, success, or the age-out window.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTO_RETRY_BLOCK_MS,
  notePreGateFailure,
  clearSummonBlock,
  clearSummonBlocksOfClass,
  blockedAutoSummon,
  resetSummonGuardForTest,
} from './summonGuard';

const T0 = 1_000_000;

describe('summonGuard', () => {
  beforeEach(() => resetSummonGuardForTest());

  it('is unblocked by default', () => {
    expect(blockedAutoSummon('char-1', T0)).toBeNull();
  });

  it('blocks automatic re-attempts after a pre-gate refusal, reporting the class', () => {
    notePreGateFailure('char-1', 'PREFERRED_NAME_MISSING', T0);
    expect(blockedAutoSummon('char-1', T0 + 14_000)).toBe('PREFERRED_NAME_MISSING');
  });

  it('is per-character — another character is unaffected', () => {
    notePreGateFailure('char-1', 'LOCAL_NO_API_KEY', T0);
    expect(blockedAutoSummon('char-2', T0 + 1)).toBeNull();
  });

  it('clears on user action (clearSummonBlock)', () => {
    notePreGateFailure('char-1', 'PREFERRED_NAME_MISSING', T0);
    clearSummonBlock('char-1');
    expect(blockedAutoSummon('char-1', T0 + 1)).toBeNull();
  });

  it('ages out after AUTO_RETRY_BLOCK_MS', () => {
    notePreGateFailure('char-1', 'CLOUD_CREDITS_DEPLETED', T0);
    expect(blockedAutoSummon('char-1', T0 + AUTO_RETRY_BLOCK_MS - 1)).toBe('CLOUD_CREDITS_DEPLETED');
    expect(blockedAutoSummon('char-1', T0 + AUTO_RETRY_BLOCK_MS)).toBeNull();
    // The expiry is a deletion, not just a null read.
    expect(blockedAutoSummon('char-1', T0 + 1)).toBeNull();
  });

  it('a fresh refusal re-arms the window with the new class', () => {
    notePreGateFailure('char-1', 'LOCAL_NO_API_KEY', T0);
    notePreGateFailure('char-1', 'PREFERRED_NAME_MISSING', T0 + 60_000);
    expect(blockedAutoSummon('char-1', T0 + AUTO_RETRY_BLOCK_MS + 1)).toBe('PREFERRED_NAME_MISSING');
  });

  it('clears every block of one class and leaves the others (260929 Forge host changed)', () => {
    notePreGateFailure('char-1', 'FORGE_HOST_BLOCKED', T0);
    notePreGateFailure('char-2', 'FORGE_HOST_BLOCKED', T0);
    notePreGateFailure('char-3', 'LOCAL_NO_API_KEY', T0);
    clearSummonBlocksOfClass('FORGE_HOST_BLOCKED');
    expect(blockedAutoSummon('char-1', T0 + 1)).toBeNull();
    expect(blockedAutoSummon('char-2', T0 + 1)).toBeNull();
    expect(blockedAutoSummon('char-3', T0 + 1)).toBe('LOCAL_NO_API_KEY');
  });
});
