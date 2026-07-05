/**
 * 260705 (issue #6) — the summon reservation.
 *
 * `_summon`'s sessions.has() guard spans ~10 awaits (including the network
 * credit gate) between check and sessions.set, so two interleaved summons
 * could both pass it and both fork; the loser's teardown then deleted the
 * winner's map entry, leaving a live child with NO map entry — an unstoppable
 * orphan burning LLM spend until app quit. These tests pin the fix's three
 * faces, all in the pre-fork window (no utilityProcess is ever forked — every
 * attempt is parked or failed at a mocked store/config read):
 *   - single-flight: a re-entrant summon joins the in-flight attempt;
 *   - stop consults the reservation instead of no-op'ing to "success";
 *   - the duplicate-username guard sees pending (pre-registration) attempts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCharacterSpy, getAiBackendKindSpy, sendStatusSpy } = vi.hoisted(() => ({
  getCharacterSpy: vi.fn(),
  getAiBackendKindSpy: vi.fn(),
  sendStatusSpy: vi.fn(),
}));

// electron isn't available in the node-test env; nothing here reaches fork.
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
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  addPlaytimeMs: vi.fn(async () => {}),
}));
vi.mock('./logRouter', () => ({
  createLogRouter: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
}));

import { createBotSupervisor } from './botSupervisor';

const A = 'char-aaaa';
const B = 'char-bbbb';

function makeSupervisor(): ReturnType<typeof createBotSupervisor> {
  return createBotSupervisor({
    getLanPort: () => 25565,
    sendStatus: sendStatusSpy,
    sendLog: vi.fn(),
    getSkinServerBaseUrl: () => null,
    cloudCreditsDepleted: vi.fn(async () => false),
    emitHardStop: vi.fn(),
  });
}

/** Minimal character shape the pre-fork path touches (id + effective username). */
function mkChar(id: string, username: string): unknown {
  return { id, name: username, username, persona: { source: 's', expanded: 'e' }, metadata: {} };
}

beforeEach(() => {
  getCharacterSpy.mockReset();
  getAiBackendKindSpy.mockReset();
  getAiBackendKindSpy.mockResolvedValue('local');
  sendStatusSpy.mockClear();
});

describe('summon reservation (issue #6)', () => {
  it('a re-entrant summon joins the in-flight attempt — one store read, same promise', async () => {
    const sup = makeSupervisor();
    let release!: (c: unknown) => void;
    getCharacterSpy.mockImplementationOnce(() => new Promise((r) => { release = r; }));

    const first = sup.summon(A);
    const second = sup.summon(A); // lands inside the check-to-register gap
    expect(second).toBe(first); // joined, not a duplicate attempt

    // Pending counts as active: the "refuse while running" gates (delete /
    // reset memory / skin swap) must hold through the fork window too.
    expect(sup.isActive(A)).toBe(true);

    release(null); // character vanished → the attempt fails pre-fork
    await expect(first).rejects.toThrow('Character not found');
    expect(getCharacterSpy).toHaveBeenCalledTimes(1);
    expect(sup.isActive(A)).toBe(false); // reservation cleared on settle
  });

  it('stop during the pre-registration window waits for the attempt instead of no-op success', async () => {
    const sup = makeSupervisor();
    let release!: (c: unknown) => void;
    getCharacterSpy.mockImplementationOnce(() => new Promise((r) => { release = r; }));

    const summoning = sup.summon(B);
    summoning.catch(() => { /* asserted below */ });

    let stopReturned = false;
    const stopping = sup.stop(B).then(() => { stopReturned = true; });
    await new Promise((r) => setTimeout(r, 20));
    // The old bug: stop found no session, reported success, and the bot joined
    // anyway seconds later. Now it parks on the reservation.
    expect(stopReturned).toBe(false);

    release(null);
    await expect(summoning).rejects.toThrow('Character not found');
    await stopping;
    // Failed attempt → nothing to stop; the idle push still clears the widget.
    expect(sendStatusSpy).toHaveBeenCalledWith({ kind: 'idle', characterId: B });
  });

  it('a pending summon already holds its username — a same-name character is refused pre-fork', async () => {
    const sup = makeSupervisor();
    let releaseA!: (c: unknown) => void;
    getCharacterSpy.mockImplementation((id: string) =>
      id === A
        ? new Promise((r) => { releaseA = r; })
        : Promise.resolve(mkChar(B, 'Sui')),
    );
    // B races ahead of A: computes its username, then parks at the backend-kind
    // read — registered in pendingUsernames but NOT yet in sessions, so the old
    // sessions-only guard would have been blind to it.
    getAiBackendKindSpy.mockImplementation(() => new Promise(() => { /* park */ }));

    const summonA = sup.summon(A);
    summonA.catch(() => { /* asserted below */ });
    sup.summon(B).catch(() => { /* parked forever; supervisor discarded */ });
    await vi.waitFor(() => expect(getAiBackendKindSpy).toHaveBeenCalledTimes(1));

    releaseA(mkChar(A, 'Sui')); // same effective in-game name as pending B
    await expect(summonA).rejects.toThrow('SUMMON_USERNAME_CONFLICT');
  });
});
