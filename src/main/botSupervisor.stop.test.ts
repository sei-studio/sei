/**
 * 260926: stop and quit during a slow boot. A stop used to wait out the
 * pending summon (up to 60s boot + 30s ready) before it could stop anything,
 * and app quit waited the same plus a 10s drain. Now a stop during a pending
 * summon kills the child at once and rejects the summon as SUMMON_CANCELLED
 * (silent: no error status, no failure diagnostic), and shutdown is
 * hard-capped. Harness copied from botSupervisor.bootWatchdog.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { createBotSupervisor, isSummonCancelled, SUMMON_CANCELLED } from './botSupervisor';
import type { SummonFailureInfo } from './diagnostics';

const A = 'char-aaaa';

function mkChar(id: string, username: string): unknown {
  return { id, name: username, username, persona: { source: 's', expanded: 'e' }, metadata: {} };
}

function makeSupervisor(over: {
  onSummonFailure: (info: SummonFailureInfo) => void;
  getLanPort?: () => number | null;
  cloudOverLimit?: () => Promise<boolean>;
  sendStatus?: (status: unknown) => void;
  onSummonReady?: (characterId: string, props: Record<string, number | string | null>) => void;
}): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: over.getLanPort ?? (() => 25565),
    sendStatus: over.sendStatus ?? vi.fn(),
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudOverLimit: over.cloudOverLimit ?? vi.fn(async () => false),
    emitHardStop: vi.fn(),
    onSummonFailure: over.onSummonFailure,
    onSummonReady: over.onSummonReady,
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
  childPostMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  forkAt: () => number;
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
  let forkAt = NaN;
  forkSpy.mockImplementationOnce(() => {
    forkAt = Date.now();
    return child;
  });
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
    childPostMessage: child.postMessage,
    kill: child.kill,
    forkAt: () => forkAt,
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


afterEach(() => {
  vi.useRealTimers();
});

type Status = { kind: string; stage?: string; error?: string; message?: string };

async function startSummon(over: {
  onSummonFailure?: (info: SummonFailureInfo) => void;
  onSummonReady?: (characterId: string, props: Record<string, number | string | null>) => void;
} = {}): Promise<{
  p: Promise<void>;
  fake: ReturnType<typeof armFakeChild>;
  statuses: Status[];
  onSummonFailure: ReturnType<typeof vi.fn>;
  sup: ReturnType<typeof createBotSupervisor>;
}> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const onSummonFailure = vi.fn(over.onSummonFailure ?? (() => {}));
  const statuses: Status[] = [];
  const sup = makeSupervisor({
    onSummonFailure,
    onSummonReady: over.onSummonReady,
    sendStatus: (s) => statuses.push(s as Status),
  });
  const fake = armFakeChild();
  const p = sup.summon(A);
  p.catch(() => {}); // asserted per test
  await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
  return { p, fake, statuses, onSummonFailure, sup };
}


describe('stop during a pending summon (260926)', () => {
  it('kills the child at once and rejects the summon as a silent cancel', async () => {
    const { p, fake, statuses, onSummonFailure, sup } = await startSummon();
    await vi.advanceTimersByTimeAsync(20_000); // still booting

    const stopAt = Date.now();
    await sup.stop(A);
    expect(Date.now() - stopAt).toBeLessThan(1_000);
    expect(fake.kill).toHaveBeenCalled();
    const err = await p.catch((e: unknown) => e);
    expect(isSummonCancelled(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(new RegExp(`^${SUMMON_CANCELLED}`));

    // Silent: no error status, no failure diagnostic; the widget goes idle.
    expect(statuses.some((s) => s.kind === 'error')).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ kind: 'idle' });
    fake.emitExit(1); // the killed child's exit
    await vi.advanceTimersByTimeAsync(100_000); // no watchdog left to fire
    expect(onSummonFailure).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.kind === 'error')).toBe(false);
    expect(sup.isActive(A)).toBe(false);
  });

  it('ignores a late summon-ready from the cancelled child', async () => {
    const { p, fake, statuses, sup } = await startSummon();
    await sup.stop(A);
    await p.catch(() => {});
    fake.emitPortMessage({ type: 'summon-ready' });
    expect(statuses.some((s) => s.kind === 'online')).toBe(false);
  });

  it('a stop after summon-ready still drains the live bot normally', async () => {
    const { p, fake, sup } = await startSummon();
    fake.emitPortMessage({ type: 'init-ack' });
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
    const stopping = sup.stop(A);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.childPostMessage).not.toHaveBeenCalled(); // stop goes over port1, not the child
    fake.emitExit(0);
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(fake.kill).not.toHaveBeenCalled();
  });
});

describe('shutdown is hard-capped (260926)', () => {
  it('a live bot that ignores the stop is killed within a few seconds', async () => {
    const { p, fake, sup } = await startSummon();
    fake.emitPortMessage({ type: 'init-ack' });
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
    const t0 = Date.now();
    let done = false;
    void sup.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(true);
    expect(Date.now() - t0).toBeLessThanOrEqual(5_000);
    expect(fake.kill).toHaveBeenCalled();
  });

  it('a summon still booting is cancelled, not waited out', async () => {
    const { p, fake, sup } = await startSummon();
    let done = false;
    void sup.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    expect(fake.kill).toHaveBeenCalled();
    expect(isSummonCancelled(await p.catch((e: unknown) => e))).toBe(true);
  });
});
