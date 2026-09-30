/**
 * 260926: the summon watchdog is split in two. A 60s cold-boot budget runs
 * from fork to the bot's init-ack, then the 30s ready budget runs from
 * init-ack to summon-ready. Before this, one 30s clock started at fork and a
 * 21-24s Windows cold boot left the join about 5s (BOT_START_TIMEOUT, the top
 * Windows summon failure). Drives a fake forked child with fake timers.
 * Mock set and child rig mirror botSupervisor.diagnostics.test.ts.
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

import { createBotSupervisor } from './botSupervisor';
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
  return { p, fake, statuses, onSummonFailure };
}

describe('summon watchdog: cold-boot budget, then ready budget (260926)', () => {
  it('a slow cold boot past 30s is still "starting", not a failure', async () => {
    const { fake, statuses, onSummonFailure } = await startSummon();
    expect(statuses[0]).toMatchObject({ kind: 'connecting', stage: 'starting' });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(onSummonFailure).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.kind === 'error')).toBe(false);

    // Booted at 45s: the 30s ready budget starts now.
    fake.emitPortMessage({ type: 'init-ack' });
    expect(statuses.at(-1)).toMatchObject({ kind: 'connecting', stage: 'joining' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(onSummonFailure).not.toHaveBeenCalled();

    fake.emitPortMessage({ type: 'summon-ready' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSummonFailure).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.kind === 'online')).toBe(true);
  });

  it('a boot that never finishes fails at 60s as boot_timeout, with the phases it reached', async () => {
    const { p, fake, statuses, onSummonFailure } = await startSummon();
    const forkAt = fake.forkAt();
    fake.emitPortMessage({
      type: 'boot-timing',
      marks: { process_start: forkAt + 300, modules_loaded: forkAt + 9_000 },
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onSummonFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(p).rejects.toThrow('BOT_START_TIMEOUT');
    expect(onSummonFailure).toHaveBeenCalledTimes(1);
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.phase).toBe('boot_timeout');
    expect(info.errorClass).toBe('BOT_START_TIMEOUT');
    expect(info.errorMessage).toContain('60s');
    expect(info.boot?.forkAtMs).toBe(forkAt);
    expect(info.boot?.marks).toEqual({ process_start: forkAt + 300, modules_loaded: forkAt + 9_000 });
    expect(statuses.at(-1)).toMatchObject({ kind: 'error', error: 'BOT_START_TIMEOUT' });
  });

  it('after init-ack, no summon-ready within 30s fails as ready_timeout', async () => {
    const { p, fake, onSummonFailure } = await startSummon();
    await vi.advanceTimersByTimeAsync(20_000);
    fake.emitPortMessage({ type: 'init-ack' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(onSummonFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(p).rejects.toThrow('BOT_START_TIMEOUT');
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.phase).toBe('ready_timeout');
    expect(info.errorMessage).toContain('30s of booting');
  });

  it('ships the ready budget in the init payload so the bot starts it at init-ack too', async () => {
    const { fake } = await startSummon();
    fake.emitSpawn();
    await vi.waitFor(() => expect(fake.childPostMessage).toHaveBeenCalled());
    const init = fake.childPostMessage.mock.calls[0][0] as { type: string; readyBudgetMs: number; summonDeadlineAt: number };
    expect(init.type).toBe('init');
    expect(init.readyBudgetMs).toBe(30_000);
    // Fallback for a reader without the budget: the worst case from fork.
    expect(init.summonDeadlineAt - Date.now()).toBeGreaterThan(80_000);
  });

  it('summon-ready hands the boot breakdown to onSummonReady for character_summoned', async () => {
    const onSummonReady = vi.fn();
    const { p, fake } = await startSummon({ onSummonReady });
    const forkAt = fake.forkAt();
    fake.emitPortMessage({ type: 'boot-timing', marks: { process_start: forkAt + 200, booted: forkAt + 8_000 } });
    fake.emitPortMessage({ type: 'init-ack' });
    fake.emitPortMessage({ type: 'boot-timing', marks: { process_start: forkAt + 200, booted: forkAt + 8_000, spawn: forkAt + 12_000 } });
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
    expect(onSummonReady).toHaveBeenCalledTimes(1);
    const [cid, props] = onSummonReady.mock.calls[0];
    expect(cid).toBe(A);
    expect(props).toMatchObject({
      boot_process_start_ms: 200,
      boot_booted_ms: 8_000,
      boot_spawn_ms: 12_000,
      boot_last_phase: 'spawn',
    });
  });
});
