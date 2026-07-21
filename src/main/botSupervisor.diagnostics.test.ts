/**
 * 260720 — onSummonFailure diagnostics callback: pre-gate failure sites fire
 * exactly one structured report per attempt, with the right phase, error
 * class, and backend. All scenarios fail BEFORE fork (mirrors the mock set of
 * botSupervisor.summon.test.ts), so no utilityProcess is ever created.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCharacterSpy, getAiBackendKindSpy, loadConfigSpy, depletedSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  getAiBackendKindSpy: vi.fn(),
  loadConfigSpy: vi.fn(),
  depletedSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
  MessageChannelMain: vi.fn(),
  app: { getPath: (_n: string) => '/tmp/sei-default' },
}));
vi.mock('./characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: vi.fn(async () => null),
}));
vi.mock('./apiKeyStore', () => ({
  loadApiKey: vi.fn(async () => 'k'),
  hasApiKey: vi.fn(async () => true),
  getAiBackendKind: getAiBackendKindSpy,
}));
vi.mock('./chat/continuity', () => ({
  buildLaunchContinuity: vi.fn(async () => null),
}));
vi.mock('./configStore', () => ({
  loadConfig: loadConfigSpy,
  saveConfig: vi.fn(async () => {}),
  addPlaytimeMs: vi.fn(async () => {}),
}));
vi.mock('./logRouter', () => ({
  createLogRouter: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
}));

import { createBotSupervisor } from './botSupervisor';
import type { SummonFailureInfo } from './diagnostics';

const A = 'char-aaaa';

function mkChar(id: string, username: string): unknown {
  return { id, name: username, username, persona: { source: 's', expanded: 'e' }, metadata: {} };
}

function makeSupervisor(over: {
  onSummonFailure: (info: SummonFailureInfo) => void;
  getLanPort?: () => number | null;
  cloudCreditsDepleted?: () => Promise<boolean>;
}): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: over.getLanPort ?? (() => 25565),
    sendStatus: vi.fn(),
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudCreditsDepleted: over.cloudCreditsDepleted ?? vi.fn(async () => false),
    emitHardStop: vi.fn(),
    onSummonFailure: over.onSummonFailure,
  });
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getCharacterSpy.mockResolvedValue(mkChar(A, 'Sui'));
  getAiBackendKindSpy.mockReset();
  getAiBackendKindSpy.mockResolvedValue('local');
  loadConfigSpy.mockReset();
  loadConfigSpy.mockResolvedValue({ preferred_name: 'Player' });
  depletedSpy.mockReset();
});

describe('onSummonFailure — pre-gate sites', () => {
  it('LAN closed: fires once with phase pre_gate, class LAN_NOT_OPEN, backend local', async () => {
    const onSummonFailure = vi.fn();
    const sup = makeSupervisor({ onSummonFailure, getLanPort: () => null });

    await expect(sup.summon(A)).rejects.toThrow('LAN_NOT_OPEN');
    expect(onSummonFailure).toHaveBeenCalledTimes(1);
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info).toMatchObject({
      characterId: A,
      phase: 'pre_gate',
      errorClass: 'LAN_NOT_OPEN',
      backend: 'local',
      exitCode: null,
    });
    expect(info.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('cloud credit gate: class CLOUD_CREDITS_DEPLETED with backend cloud-proxy', async () => {
    getAiBackendKindSpy.mockResolvedValue('cloud-proxy');
    depletedSpy.mockResolvedValue(true);
    const onSummonFailure = vi.fn();
    const sup = makeSupervisor({ onSummonFailure, cloudCreditsDepleted: depletedSpy });

    await expect(sup.summon(A)).rejects.toThrow('CLOUD_CREDITS_DEPLETED');
    expect(onSummonFailure).toHaveBeenCalledTimes(1);
    expect(onSummonFailure.mock.calls[0][0]).toMatchObject({
      phase: 'pre_gate',
      errorClass: 'CLOUD_CREDITS_DEPLETED',
      backend: 'cloud-proxy',
    });
  });

  it('missing preferred name: class PREFERRED_NAME_MISSING', async () => {
    loadConfigSpy.mockResolvedValue({});
    const onSummonFailure = vi.fn();
    const sup = makeSupervisor({ onSummonFailure });

    await expect(sup.summon(A)).rejects.toThrow('PREFERRED_NAME_MISSING');
    expect(onSummonFailure.mock.calls[0][0]).toMatchObject({
      phase: 'pre_gate',
      errorClass: 'PREFERRED_NAME_MISSING',
    });
  });

  it('a throwing callback never breaks the summon error surface', async () => {
    const onSummonFailure = vi.fn(() => {
      throw new Error('diagnostics exploded');
    });
    const sup = makeSupervisor({ onSummonFailure, getLanPort: () => null });
    await expect(sup.summon(A)).rejects.toThrow('LAN_NOT_OPEN');
    expect(onSummonFailure).toHaveBeenCalledTimes(1);
  });
});
