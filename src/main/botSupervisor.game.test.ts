/**
 * Game adapters (M0, 260908) — the supervisor's game-aware summon.
 *
 *   - summon(id) defaults to Minecraft: the init payload carries the new
 *     {game, joinTarget} shape AND the legacy top-level Minecraft keys (one
 *     release), and every status is stamped with the game;
 *   - a registered GameModule for another game drives its own username rule,
 *     collision test, join target and missing-target error;
 *   - two bots in DIFFERENT games never collide on a username.
 *
 * Same fake-child rig as botSupervisor.diagnostics.test.ts: nothing here
 * launches Electron.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { getCharacterSpy, getAiBackendKindSpy, loadConfigSpy, forkSpy, channelSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  getAiBackendKindSpy: vi.fn(),
  loadConfigSpy: vi.fn(),
  forkSpy: vi.fn(),
  channelSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: forkSpy },
  MessageChannelMain: channelSpy,
  app: { getPath: (_n: string) => '/tmp/sei-default', isPackaged: false },
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
vi.mock('./knowledge/knowledgeStore', () => ({
  readKnowledgeForPrompt: vi.fn(async () => ''),
}));
vi.mock('./configStore', () => ({
  loadConfig: loadConfigSpy,
  saveConfig: vi.fn(async () => {}),
  addPlaytimeMs: vi.fn(async () => {}),
}));
vi.mock('./games/packs', () => ({
  ensurePack: vi.fn(async (game: string) => `/packs/${game}`),
}));
vi.mock('./logRouter', () => ({
  createLogRouter: vi.fn(async () => ({ append: vi.fn(), close: vi.fn(async () => {}) })),
}));

import { createBotSupervisor } from './botSupervisor';
import { registerGameModule, clearGameModulesForTests, type GameModule } from './games';
import type { WorldState } from '../shared/gameIpc';

const A = 'char-aaaa';
const B = 'char-bbbb';

function mkChar(id: string, username: string): unknown {
  return { id, name: username, username, persona: { source: 's', expanded: 'e' }, metadata: {} };
}

function armFakeChild(): { postMessage: ReturnType<typeof vi.fn>; emitSpawn: () => void; emitPortMessage: (d: unknown) => void } {
  const handlers: Record<string, Array<(...a: never[]) => void>> = {};
  const add = (ev: string, cb: (...a: never[]) => void): void => { (handlers[ev] ??= []).push(cb); };
  const postMessage = vi.fn();
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    once: add,
    on: add,
    postMessage,
    kill: vi.fn(),
  };
  const msgHandlers: Array<(e: { data: unknown }) => void> = [];
  const port1 = {
    on: (ev: string, cb: (e: { data: unknown }) => void) => { if (ev === 'message') msgHandlers.push(cb); },
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
    postMessage,
    emitSpawn: () => handlers['spawn']?.forEach((f) => (f as () => void)()),
    emitPortMessage: (data: unknown) => msgHandlers.forEach((f) => f({ data })),
  };
}

function stardewModule(open: boolean): GameModule {
  const state: WorldState = open
    ? { game: 'stardew', kind: 'open', farmName: 'Sunny', uniqueId: '42', day: 3, season: 'spring', year: 1, port: 27431, lastSeenAt: 1, label: 'Sunny Farm, spring 3' }
    : { game: 'stardew', kind: 'closed' };
  return {
    id: 'stardew',
    displayName: 'Stardew Valley',
    effectiveUsername: (c) => `${c.name} the farmhand`,
    collides: (a, b) => a === b,
    watcher: { start() {}, async checkNow() { return state; }, stop() {} },
    getWorldState: () => state,
    getJoinTarget: () => (open ? { port: 8123, token: 'tok', label: 'Sunny Farm' } : null),
    joinTargetMissingError: { error: 'GAME_WORLD_NOT_OPEN', message: 'Open your farm first.' },
  };
}

function makeSupervisor(sendStatus = vi.fn()) {
  return {
    sendStatus,
    sup: createBotSupervisor({
      getLanPort: () => 25565,
      getLanMotd: () => 'A Minecraft Server',
      sendStatus,
      sendLog: vi.fn(),
      getSkinServerBaseUrl: () => 'http://127.0.0.1:5000',
      cloudOverLimit: vi.fn(async () => false),
      emitHardStop: vi.fn(),
    }),
  };
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getCharacterSpy.mockImplementation(async (id: string) => (id === A ? mkChar(A, 'Sui') : mkChar(B, 'Marv')));
  getAiBackendKindSpy.mockReset();
  getAiBackendKindSpy.mockResolvedValue('local');
  loadConfigSpy.mockReset();
  loadConfigSpy.mockResolvedValue({ preferred_name: 'Player', mc_username: 'steve' });
  forkSpy.mockReset();
  channelSpy.mockReset();
  clearGameModulesForTests();
});
afterEach(() => clearGameModulesForTests());

describe('summon(id) defaults to Minecraft (legacy option wiring, no registry)', () => {
  it('ships game + joinTarget + packRoot AND the legacy keys, and stamps statuses with the game', async () => {
    const { sup, sendStatus } = makeSupervisor();
    const fake = armFakeChild();
    const p = sup.summon(A);
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fake.emitSpawn();
    await vi.waitFor(() => expect(fake.postMessage).toHaveBeenCalledTimes(1));
    const init = fake.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(init.type).toBe('init');
    expect(init.game).toBe('minecraft');
    expect(init.joinTarget).toEqual({
      port: 25565,
      motd: 'A Minecraft Server',
      mc_username: 'steve',
      skinServerBaseUrl: 'http://127.0.0.1:5000',
    });
    expect(init.worldLabel).toBe('A Minecraft Server');
    expect(init.packRoot).toBe('/packs/minecraft');
    // Legacy keys (one release) for an older bot build.
    expect(init.lanPort).toBe(25565);
    expect(init.lanMotd).toBe('A Minecraft Server');
    expect(init.mc_username).toBe('steve');
    expect(init.skinServerBaseUrl).toBe('http://127.0.0.1:5000');
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
    expect(sendStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connecting', characterId: A, game: 'minecraft' }));
    expect(sendStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'online', characterId: A, game: 'minecraft' }));
  });
});

describe('summon(id, "stardew") through a registered GameModule', () => {
  it('uses the module username rule, join target, and missing-target error', async () => {
    registerGameModule(stardewModule(false));
    const { sup, sendStatus } = makeSupervisor();
    await expect(sup.summon(A, 'stardew')).rejects.toThrow('GAME_WORLD_NOT_OPEN');
    expect(sendStatus).toHaveBeenCalledWith({
      kind: 'error',
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'Open your farm first.',
      characterId: A,
      game: 'stardew',
    });
    expect(forkSpy).not.toHaveBeenCalled();
  });

  it('forks with the module join target and no Minecraft legacy keys', async () => {
    registerGameModule(stardewModule(true));
    const { sup } = makeSupervisor();
    const fake = armFakeChild();
    const p = sup.summon(A, 'stardew');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fake.emitSpawn();
    await vi.waitFor(() => expect(fake.postMessage).toHaveBeenCalledTimes(1));
    const init = fake.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(init.game).toBe('stardew');
    expect(init.joinTarget).toEqual({ port: 8123, token: 'tok', label: 'Sunny Farm' });
    expect(init.worldLabel).toBe('Sunny Farm');
    expect(init.packRoot).toBe('/packs/stardew');
    expect(init.lanPort).toBeNull();
    expect(init.lanMotd).toBeNull();
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
  });

  it('merges the module prepareJoin fields into the join target, and a rejecting one changes nothing (260921)', async () => {
    const look = { gender: 'female', skin: 3, hair: 26 };
    const prepareJoin = vi.fn(async (_args: { characterId: string; character: { name: string } }) => ({ appearance: look }));
    registerGameModule({ ...stardewModule(true), prepareJoin });
    const { sup } = makeSupervisor();
    const fake = armFakeChild();
    const p = sup.summon(A, 'stardew');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fake.emitSpawn();
    await vi.waitFor(() => expect(fake.postMessage).toHaveBeenCalledTimes(1));
    const init = fake.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(prepareJoin).toHaveBeenCalledTimes(1);
    expect(prepareJoin.mock.calls[0][0].characterId).toBe(A);
    expect(init.joinTarget).toEqual({ port: 8123, token: 'tok', label: 'Sunny Farm', appearance: look });
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
  });

  it('a prepareJoin that rejects never fails the summon', async () => {
    registerGameModule({ ...stardewModule(true), prepareJoin: async () => { throw new Error('boom'); } });
    const { sup } = makeSupervisor();
    const fake = armFakeChild();
    const p = sup.summon(A, 'stardew');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fake.emitSpawn();
    await vi.waitFor(() => expect(fake.postMessage).toHaveBeenCalledTimes(1));
    const init = fake.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(init.joinTarget).toEqual({ port: 8123, token: 'tok', label: 'Sunny Farm' });
    fake.emitPortMessage({ type: 'summon-ready' });
    await p;
  });

  it('refuses an unknown game with no module', async () => {
    const { sup } = makeSupervisor();
    await expect(sup.summon(A, 'dontstarve')).rejects.toThrow(/GAME_NOT_INSTALLED/);
  });

  it('refuses a SECOND character in a one-body game while the first is live (260909)', async () => {
    const mod = { ...stardewModule(true), maxBodies: 1, oneBodyError: { error: 'DST_ONE_COMPANION' as const, message: 'DST_ONE_COMPANION: one at a time' } };
    registerGameModule(mod);
    const { sup } = makeSupervisor();
    const fakeA = armFakeChild();
    const pA = sup.summon(A, 'stardew');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fakeA.emitPortMessage({ type: 'summon-ready' });
    await pA;
    // Different name, same one-body game → refused before fork with the module's error.
    await expect(sup.summon(B, 'stardew')).rejects.toThrow(/DST_ONE_COMPANION/);
    expect(forkSpy).toHaveBeenCalledTimes(1);
    // The same character re-summoning is not a second body.
    expect(sup.getActiveIds()).toEqual([A]);
  });

  it('collides only within the same game', async () => {
    // Both characters share the effective name under the stardew rule when
    // their names match; under Minecraft their usernames differ.
    getCharacterSpy.mockImplementation(async (id: string) => (id === A ? mkChar(A, 'Sui') : mkChar(B, 'Sui')));
    registerGameModule(stardewModule(true));
    const { sup } = makeSupervisor();
    const fakeA = armFakeChild();
    const pA = sup.summon(A, 'stardew');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(1));
    fakeA.emitPortMessage({ type: 'summon-ready' });
    await pA;
    // Same game, same name → refused before fork.
    await expect(sup.summon(B, 'stardew')).rejects.toThrow(/SUMMON_USERNAME_CONFLICT/);
    // Different game, same name → allowed (its own world).
    const fakeB = armFakeChild();
    const pB = sup.summon(B, 'minecraft');
    await vi.waitFor(() => expect(forkSpy).toHaveBeenCalledTimes(2));
    fakeB.emitPortMessage({ type: 'summon-ready' });
    await pB;
    expect(sup.getActiveIds().sort()).toEqual([A, B].sort());
  });
});
