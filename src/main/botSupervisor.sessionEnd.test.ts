/**
 * 260929 — why a live session ended (BotStatus.endReason → bot_session_ended
 * .reason) and the modded-host timeout reclassification. Drives a fake forked
 * child; mock set and child rig mirror botSupervisor.bootWatchdog.test.ts.
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
import type { LanHost } from '../shared/ipc';

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
  getLanHost?: () => LanHost | undefined;
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
    getLanHost: over.getLanHost,
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

type Status = { kind: string; error?: string; message?: string; endReason?: string; kickCode?: string };

// Strong evidence (ping forgeData): refused at the pre-gate, never forked.
const FORGE: LanHost = { client: 'forge', forgeModCount: 0 };
// Strong evidence from the command line only (no ping metadata).
const NEOFORGE_TARGET: LanHost = { client: 'neoforge', forgeModCount: null, forgeLaunchTarget: true };
// Weak evidence (a cmdline marker only): soft warning, the summon still runs.
const WEAK_FORGE: LanHost = { client: 'forge', forgeModCount: null };
const MODDED_FABRIC: LanHost = { client: 'fabric', forgeModCount: null, seiSkinMod: true, otherModCount: 3 };
const OUR_FABRIC: LanHost = { client: 'fabric', forgeModCount: null, seiSkinMod: true, otherModCount: 0 };
const VANILLA: LanHost = { client: 'vanilla', forgeModCount: null };

async function summonToReady(getLanHost?: () => LanHost | undefined): Promise<{
  sup: ReturnType<typeof createBotSupervisor>;
  fake: ReturnType<typeof armFakeChild>;
  statuses: Status[];
}> {
  const statuses: Status[] = [];
  const sup = makeSupervisor({ onSummonFailure: vi.fn(), sendStatus: (s) => statuses.push(s as Status), getLanHost });
  const fake = armFakeChild();
  const p = sup.summon(A);
  await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
  fake.emitPortMessage({ type: 'summon-ready' });
  await p;
  return { sup, fake, statuses };
}

const terminal = (statuses: Status[]): Status | undefined =>
  statuses.find((s) => s.kind === 'idle' || s.kind === 'error');

describe('session end reasons (260929)', () => {
  it('a Stop from the app ends with user_stop', async () => {
    const { sup, fake, statuses } = await summonToReady();
    const stopping = sup.stop(A);
    fake.emitExit(0);
    await stopping;
    expect(terminal(statuses)).toMatchObject({ kind: 'idle', endReason: 'user_stop' });
    expect(statuses.filter((s) => s.kind === 'idle').every((s) => s.endReason === 'user_stop')).toBe(true);
  });

  it('a stop with a reason carries it (companion quit from chat, app quit)', async () => {
    const { sup, fake, statuses } = await summonToReady();
    const stopping = sup.stop(A, 'companion_quit');
    fake.emitExit(0);
    await stopping;
    expect(terminal(statuses)).toMatchObject({ kind: 'idle', endReason: 'companion_quit' });
  });

  it('shutdown drains with app_quit', async () => {
    const { sup, fake, statuses } = await summonToReady();
    const down = sup.shutdown();
    fake.emitExit(0);
    await down;
    expect(terminal(statuses)).toMatchObject({ kind: 'idle', endReason: 'app_quit' });
  });

  it('the companion calling quit() in game ends with companion_quit', async () => {
    const { fake, statuses } = await summonToReady();
    fake.emitPortMessage({ type: 'summon-stopped', reason: 'quit' });
    fake.emitExit(0);
    expect(terminal(statuses)).toMatchObject({ kind: 'idle', endReason: 'companion_quit' });
  });

  it('a clean exit with no stop and no quit is bot_exit', async () => {
    const { fake, statuses } = await summonToReady();
    fake.emitExit(0);
    expect(terminal(statuses)).toMatchObject({ kind: 'idle', endReason: 'bot_exit' });
  });

  it('a mid-session crash is crash on the error status', async () => {
    const { fake, statuses } = await summonToReady();
    fake.emitExit(9);
    expect(terminal(statuses)).toMatchObject({ kind: 'error', error: 'BOT_CRASH', endReason: 'crash' });
  });

  it("a kick loop's lifecycle error carries the bot's reason and kick code", async () => {
    const { fake, statuses } = await summonToReady();
    fake.emitPortMessage({
      type: 'error',
      error: 'LAN_NOT_OPEN',
      message: 'LAN_NOT_OPEN: The world kept kicking Sei (Kicked: x).',
      endReason: 'kicked',
      kickCode: 'name_taken',
    });
    fake.emitPortMessage({ type: 'summon-stopped', reason: 'error' });
    fake.emitExit(0);
    expect(terminal(statuses)).toMatchObject({
      kind: 'error',
      error: 'LAN_NOT_OPEN',
      endReason: 'kicked',
      kickCode: 'name_taken',
    });
  });
});

describe('join timeout on a modded host (260929)', () => {
  async function startSummon(getLanHost: () => LanHost | undefined) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const onSummonFailure = vi.fn();
    const statuses: Status[] = [];
    const sup = makeSupervisor({ onSummonFailure, sendStatus: (s) => statuses.push(s as Status), getLanHost });
    const fake = armFakeChild();
    const p = sup.summon(A);
    p.catch(() => {});
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    return { p, fake, statuses, onSummonFailure };
  }

  // A strongly detected Forge host never gets this far (pre-gate below), so
  // these run on hosts that still summon: weak-evidence Forge, modded Fabric.
  it('a ready timeout on a modded host is reported as MODDED_HOST_REJECTED', async () => {
    const { p, fake, statuses, onSummonFailure } = await startSummon(() => WEAK_FORGE);
    fake.emitPortMessage({ type: 'init-ack' });
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(p).rejects.toThrow('MODDED_HOST_REJECTED');
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info).toMatchObject({
      phase: 'ready_timeout',
      errorClass: 'MODDED_HOST_REJECTED',
      reclassifiedFrom: 'BOT_START_TIMEOUT',
    });
    expect(statuses.find((s) => s.kind === 'error')).toMatchObject({ error: 'MODDED_HOST_REJECTED' });
  });

  it("the bot's own connect-guard timeout on a modded host is reclassified too", async () => {
    const { p, fake, statuses, onSummonFailure } = await startSummon(() => MODDED_FABRIC);
    fake.emitPortMessage({ type: 'init-ack' });
    fake.emitPortMessage({ type: 'error', error: 'BOT_START_TIMEOUT', message: 'connect guard: 20000ms' });
    await expect(p).rejects.toThrow('MODDED_HOST_REJECTED');
    expect(onSummonFailure.mock.calls[0][0]).toMatchObject({
      phase: 'connect',
      errorClass: 'MODDED_HOST_REJECTED',
      reclassifiedFrom: 'BOT_START_TIMEOUT',
    });
    expect(statuses.find((s) => s.kind === 'error')).toMatchObject({ error: 'MODDED_HOST_REJECTED' });
  });

  it("stays a plain timeout on Sei's own Fabric setup", async () => {
    const { p, fake, onSummonFailure } = await startSummon(() => OUR_FABRIC);
    fake.emitPortMessage({ type: 'init-ack' });
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(p).rejects.toThrow('BOT_START_TIMEOUT');
    const info = onSummonFailure.mock.calls[0][0] as SummonFailureInfo;
    expect(info.errorClass).toBe('BOT_START_TIMEOUT');
    expect(info.reclassifiedFrom).toBeUndefined();
  });

  it('a BOOT timeout says nothing about the world and is never reclassified', async () => {
    const { p, onSummonFailure } = await startSummon(() => WEAK_FORGE);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(p).rejects.toThrow('BOT_START_TIMEOUT');
    expect(onSummonFailure.mock.calls[0][0]).toMatchObject({ phase: 'boot_timeout', errorClass: 'BOT_START_TIMEOUT' });
  });
});

describe('Forge host pre-gate (260929)', () => {
  async function trySummon(host: LanHost | undefined) {
    const onSummonFailure = vi.fn();
    const statuses: Status[] = [];
    const sup = makeSupervisor({ onSummonFailure, sendStatus: (s) => statuses.push(s as Status), getLanHost: () => host });
    armFakeChild();
    const p = sup.summon(A);
    p.catch(() => {});
    return { p, statuses, onSummonFailure };
  }

  it.each([
    ['Forge seen in the status ping', FORGE, 'Forge'],
    ['NeoForge with an explicit launch target', NEOFORGE_TARGET, 'NeoForge'],
  ])('refuses %s before forking, with a plain message', async (_label, host, loader) => {
    const { p, statuses, onSummonFailure } = await trySummon(host);
    await expect(p).rejects.toThrow(/^FORGE_HOST_BLOCKED: Sei can't join/);
    expect(forkSpy).not.toHaveBeenCalled();
    const err = statuses.find((s) => s.kind === 'error');
    expect(err).toMatchObject({ error: 'FORGE_HOST_BLOCKED' });
    expect(err?.message).toContain(`Sei can't join ${loader} worlds`);
    expect(err?.message).toContain('Sei profile');
    expect(onSummonFailure.mock.calls[0][0]).toMatchObject({ phase: 'pre_gate', errorClass: 'FORGE_HOST_BLOCKED' });
  });

  it.each([
    ['vanilla', VANILLA],
    ["Sei's own Fabric profile", OUR_FABRIC],
    ['Fabric with other mods', MODDED_FABRIC],
    ['Forge on weak evidence only', WEAK_FORGE],
    ['an undetected host', undefined],
  ])('lets %s through to the fork', async (_label, host) => {
    await trySummon(host);
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
  });

  it('SEI_FORGE_HANDSHAKE=1 keeps the handshake spike reachable', async () => {
    vi.stubEnv('SEI_FORGE_HANDSHAKE', '1');
    try {
      await trySummon(FORGE);
      await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
