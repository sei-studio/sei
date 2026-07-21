/**
 * 260720 — onSummonFailure diagnostics callback: pre-gate failure sites fire
 * exactly one structured report per attempt, with the right phase, error
 * class, and backend. The pre-gate scenarios fail BEFORE fork (mirrors the
 * mock set of botSupervisor.summon.test.ts); the mid-session scenarios drive
 * a fake forked child through summon-ready and then kill it, pinning the
 * BOT_CRASH reclassification + synthesized message + crash-popup status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCharacterSpy, getAiBackendKindSpy, loadConfigSpy, depletedSpy, forkSpy, channelSpy } =
  vi.hoisted(() => ({
    getCharacterSpy: vi.fn(),
    getAiBackendKindSpy: vi.fn(),
    loadConfigSpy: vi.fn(),
    depletedSpy: vi.fn(),
    forkSpy: vi.fn(),
    channelSpy: vi.fn(),
  }));

vi.mock('electron', () => ({
  utilityProcess: { fork: forkSpy },
  MessageChannelMain: channelSpy,
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
  createLogRouter: vi.fn(async () => ({ append: vi.fn(), close: vi.fn(async () => {}) })),
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
  sendStatus?: (status: unknown) => void;
}): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: over.getLanPort ?? (() => 25565),
    sendStatus: over.sendStatus ?? vi.fn(),
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudCreditsDepleted: over.cloudCreditsDepleted ?? vi.fn(async () => false),
    emitHardStop: vi.fn(),
    onSummonFailure: over.onSummonFailure,
  });
}

/**
 * Fake UtilityProcess child + MessageChannelMain port pair, wired into the
 * hoisted fork/channel spies. Lets a test drive the full lifecycle: feed
 * stderr/stdout, deliver port messages (summon-ready), and end the child
 * with an arbitrary exit code.
 */
function armFakeChild(): {
  emitSpawn: () => void;
  emitExit: (code: number) => void;
  writeStderr: (t: string) => void;
  writeStdout: (t: string) => void;
  emitPortMessage: (data: unknown) => void;
} {
  const handlers: Record<string, Array<(...a: never[]) => void>> = {};
  const add = (ev: string, cb: (...a: never[]) => void): void => {
    (handlers[ev] ??= []).push(cb);
  };
  const dataSinks: Record<'stdout' | 'stderr', Array<(c: Buffer) => void>> = {
    stdout: [],
    stderr: [],
  };
  const child = {
    stdout: { on: (_e: string, cb: (c: Buffer) => void) => dataSinks.stdout.push(cb) },
    stderr: { on: (_e: string, cb: (c: Buffer) => void) => dataSinks.stderr.push(cb) },
    once: add,
    on: add,
    postMessage: vi.fn(),
    kill: vi.fn(),
  };
  const msgHandlers: Array<(e: { data: unknown }) => void> = [];
  const port1 = {
    on: (ev: string, cb: (e: { data: unknown }) => void) => {
      if (ev === 'message') msgHandlers.push(cb);
    },
    start: vi.fn(),
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  forkSpy.mockReturnValueOnce(child);
  channelSpy.mockImplementationOnce(function (this: Record<string, unknown>) {
    this.port1 = port1;
    this.port2 = {};
  });
  return {
    emitSpawn: () => handlers['spawn']?.forEach((f) => (f as () => void)()),
    emitExit: (code: number) => handlers['exit']?.forEach((f) => (f as (c: number) => void)(code)),
    writeStderr: (t: string) => dataSinks.stderr.forEach((f) => f(Buffer.from(t))),
    writeStdout: (t: string) => dataSinks.stdout.forEach((f) => f(Buffer.from(t))),
    emitPortMessage: (data: unknown) => msgHandlers.forEach((f) => f({ data })),
  };
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getCharacterSpy.mockResolvedValue(mkChar(A, 'Sui'));
  getAiBackendKindSpy.mockReset();
  getAiBackendKindSpy.mockResolvedValue('local');
  loadConfigSpy.mockReset();
  loadConfigSpy.mockResolvedValue({ preferred_name: 'Player' });
  depletedSpy.mockReset();
  forkSpy.mockReset();
  channelSpy.mockReset();
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

  it('bare sentinel-token refusals ship an explanatory error_message, not just the enum', async () => {
    loadConfigSpy.mockResolvedValue({}); // no preferred_name → bare PREFERRED_NAME_MISSING throw
    const onSummonFailure = vi.fn();
    const sup = makeSupervisor({ onSummonFailure });

    await expect(sup.summon(A)).rejects.toThrow('PREFERRED_NAME_MISSING');
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.errorClass).toBe('PREFERRED_NAME_MISSING');
    expect(info.errorMessage).not.toBe('PREFERRED_NAME_MISSING');
    expect(info.errorMessage).toContain('refused before fork');
  });
});

describe('onSummonFailure — mid-session death (fake forked child)', () => {
  /** Summon A through summon-ready against a fake child; returns the rig. */
  async function summonToReady(over: {
    onSummonFailure: (info: SummonFailureInfo) => void;
    sendStatus: (status: unknown) => void;
  }): Promise<{ sup: ReturnType<typeof createBotSupervisor>; fake: ReturnType<typeof armFakeChild> }> {
    const sup = makeSupervisor(over);
    const fake = armFakeChild();
    const p = sup.summon(A);
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
    return { sup, fake };
  }

  it('message-less nonzero exit (SIGKILL) → BOT_CRASH with the synthesized message and full tails', async () => {
    const onSummonFailure = vi.fn();
    const sendStatus = vi.fn<(status: unknown) => void>();
    const { fake } = await summonToReady({ onSummonFailure, sendStatus });

    // The live-test regression: the only output is a node deprecation warning
    // whose "userland" used to satisfy the bare /lan/ pattern and mislabel the
    // kill as LAN_NOT_OPEN.
    const noise =
      '(node:123) [DEP0040] DeprecationWarning: The punycode module is deprecated. ' +
      'Please use a userland alternative instead.\n';
    fake.writeStderr(noise);
    fake.emitExit(9);

    expect(onSummonFailure).toHaveBeenCalledTimes(1);
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.phase).toBe('mid_session');
    expect(info.errorClass).toBe('BOT_CRASH');
    expect(info.exitCode).toBe(9);
    expect(info.errorMessage).toContain('Bot process exited unexpectedly (code 9');
    expect(info.errorMessage).toContain('antivirus, out of memory, or a manual kill');
    expect(info.stderrTail).toContain('userland');
    expect(info.stdoutTail).toBe('');

    // Crash popup surface: a midSession-marked terminal error, then idle.
    const calls = sendStatus.mock.calls.map((c) => c[0] as { kind: string });
    const errorIdx = calls.findIndex((s) => s.kind === 'error');
    const idleIdx = calls.findIndex((s) => s.kind === 'idle');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(errorIdx);
    expect(sendStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        error: 'BOT_CRASH',
        characterId: A,
        midSession: true,
      }),
    );
  });

  it('nonzero exit WITH connection-loss evidence in the tail keeps LAN_NOT_OPEN', async () => {
    const onSummonFailure = vi.fn();
    const sendStatus = vi.fn<(status: unknown) => void>();
    const { fake } = await summonToReady({ onSummonFailure, sendStatus });

    fake.writeStderr('Error: read ECONNRESET\n    at TCP.onStreamRead\n');
    fake.emitExit(1);

    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.phase).toBe('mid_session');
    expect(info.errorClass).toBe('LAN_NOT_OPEN');
    expect(info.errorMessage).toContain('Bot exited mid-session (code 1)');
    expect(info.errorMessage).toContain('ECONNRESET');
  });

  it('a clean code-0 exit is a normal session end: no diagnostic, no error status', async () => {
    const onSummonFailure = vi.fn();
    const sendStatus = vi.fn<(status: unknown) => void>();
    const { fake } = await summonToReady({ onSummonFailure, sendStatus });

    fake.emitExit(0);

    expect(onSummonFailure).not.toHaveBeenCalled();
    expect(sendStatus).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(sendStatus).toHaveBeenCalledWith({ kind: 'idle', characterId: A });
  });

  it('a user-requested stop never fires the mid-session diagnostic, even on a kill-shaped code', async () => {
    const onSummonFailure = vi.fn();
    const sendStatus = vi.fn<(status: unknown) => void>();
    const { sup, fake } = await summonToReady({ onSummonFailure, sendStatus });

    const stopping = sup.stop(A);
    fake.emitExit(9); // kill escalation / SIGKILL during a requested drain
    await stopping;

    expect(onSummonFailure).not.toHaveBeenCalled();
    expect(sendStatus).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});
