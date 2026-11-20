import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/ipc';
import type { PlayerEndInput, PlayerEndOutcome } from './playerEndNextStep';
import {
  LATER_SESSION_MARGIN_MS,
  PENDING_FILE,
  PENDING_MAX_AGE_MS,
  PENDING_MAX_ATTEMPTS,
  _resetQuitNextStep,
  afterOutcome,
  bindQuitNextStepRuntime,
  callDigestFromRows,
  hasLaterSession,
  lateHours,
  noteNewSessionForQuit,
  parsePending,
  persistQuitSession,
  refreshQuitDigest,
  runPendingFor,
  runPendingQuitNextSteps,
  type QuitRunDeps,
} from './quitNextStep';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');

let root: string;
const dirOf = (id: string) => path.join(root, id);
const fileOf = (id: string) => path.join(dirOf(id), PENDING_FILE);
const readPending = (id: string) => parsePending(readFileSync(fileOf(id), 'utf8'));

const DIGEST = {
  lines: [
    { who: 'player' as const, text: 'can we put a roof on the cabin' },
    { who: 'you' as const, text: 'yes, I need more spruce planks first' },
  ],
  playerLines: 7,
  selfLines: 5,
};

function gameRecord(over: Record<string, unknown> = {}) {
  return {
    characterId: 'char-1',
    surface: 'game' as const,
    game: 'minecraft',
    durationMs: 20 * 60_000,
    endedAt: NOW - 3 * HOUR,
    digest: DIGEST,
    ...over,
  };
}

function writeRaw(id: string, body: unknown) {
  mkdirSync(dirOf(id), { recursive: true });
  writeFileSync(fileOf(id), typeof body === 'string' ? body : JSON.stringify(body));
}

function deps(over: Partial<QuitRunDeps> = {}, outcome: PlayerEndOutcome = 'saved') {
  const started: PlayerEndInput[] = [];
  const d: QuitRunDeps = {
    memoryRoot: () => root,
    backendReady: async () => true,
    recentRows: async () => [],
    activityFor: (game) => `playing ${game === 'minecraft' ? 'Minecraft' : game} together`,
    start: async (input) => {
      started.push(input);
      return outcome;
    },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { d, started };
}

function row(over: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36), role: 'user', text: 'hi', ts: NOW, ...over } as ChatMessage;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sei-quit-'));
  bindQuitNextStepRuntime({ memoryDir: dirOf, memoryRoot: () => root, activityFor: (g) => `playing ${g} together` });
});

afterEach(() => {
  _resetQuitNextStep();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('persist on quit', () => {
  it('writes the session digest, game, duration and time to the memory dir', () => {
    expect(persistQuitSession(gameRecord())).toBe(true);
    const p = readPending('char-1');
    expect(p).toEqual({ v: 1, ...gameRecord() });
  });

  it('writes nothing for a session too short to check', () => {
    expect(persistQuitSession(gameRecord({ durationMs: 90_000 }))).toBe(false);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('creates the memory dir when the character has none yet', () => {
    expect(existsSync(dirOf('fresh'))).toBe(false);
    expect(persistQuitSession(gameRecord({ characterId: 'fresh' }))).toBe(true);
    expect(readPending('fresh')?.characterId).toBe('fresh');
  });

  it('never throws when the disk refuses the write', () => {
    // A file where the memory dir should be: mkdir fails.
    writeFileSync(path.join(root, 'blocked'), 'x');
    expect(() => persistQuitSession(gameRecord({ characterId: 'blocked' }))).not.toThrow();
    expect(persistQuitSession(gameRecord({ characterId: 'blocked' }))).toBe(false);
  });

  it('a call keeps only its window (its lines are in the transcript)', () => {
    persistQuitSession({ characterId: 'char-2', surface: 'call', durationMs: 5 * 60_000, endedAt: NOW });
    expect(readPending('char-2')).toEqual({ v: 1, characterId: 'char-2', surface: 'call', durationMs: 5 * 60_000, endedAt: NOW });
  });

  it('the final digest the bot posts during the drain refreshes the file', () => {
    persistQuitSession(gameRecord());
    const fresh = { lines: [{ who: 'player', text: 'ok gotta go, finish the roof tomorrow' }], playerLines: 8, selfLines: 5 };
    refreshQuitDigest('char-1', fresh);
    expect(readPending('char-1')?.digest).toEqual(fresh);
    expect(readPending('char-1')?.endedAt).toBe(gameRecord().endedAt);
  });

  it('a digest for a character this quit did not write is ignored', () => {
    refreshQuitDigest('char-9', DIGEST);
    expect(existsSync(fileOf('char-9'))).toBe(false);
    persistQuitSession({ characterId: 'char-2', surface: 'call', durationMs: 5 * 60_000, endedAt: NOW });
    refreshQuitDigest('char-2', DIGEST);
    expect(readPending('char-2')?.digest).toBeUndefined();
  });
});

describe('parsing', () => {
  it('rejects unusable files', () => {
    expect(parsePending(null)).toBeNull();
    expect(parsePending('not json')).toBeNull();
    expect(parsePending(JSON.stringify({ characterId: 'a', surface: 'chess', durationMs: 1, endedAt: 1 }))).toBeNull();
    expect(parsePending(JSON.stringify({ characterId: 'a', surface: 'game', durationMs: -1, endedAt: 1 }))).toBeNull();
  });

  it('late_hours rounds to one decimal and never goes negative', () => {
    expect(lateHours(NOW - 3 * HOUR - 20 * 60_000, NOW)).toBe(3.3);
    expect(lateHours(NOW + HOUR, NOW)).toBe(0);
  });

  it('call lines are the voice rows inside the window', () => {
    const rows = [
      row({ role: 'user', voice: true, text: 'too early', ts: NOW - 20 * 60_000 }),
      row({ role: 'user', voice: true, text: 'lets build a farm', ts: NOW - 4 * 60_000 }),
      row({ role: 'companion', voice: true, text: 'yes, by the river', ts: NOW - 3 * 60_000 }),
      row({ role: 'user', text: 'typed, not spoken', ts: NOW - 2 * 60_000 }),
      row({ role: 'user', voice: true, text: 'after the call', ts: NOW + 60_000 }),
    ];
    expect(callDigestFromRows(rows, NOW - 10 * 60_000, NOW)).toEqual({
      lines: [
        { who: 'player', text: 'lets build a farm' },
        { who: 'you', text: 'yes, by the river' },
      ],
      playerLines: 1,
    });
  });

  it('a later bot-game play row or call row is a later session; chess is not', () => {
    const at = NOW - HOUR;
    const later = at + LATER_SESSION_MARGIN_MS + 1000;
    expect(hasLaterSession([row({ role: 'system', ts: at + 50, event: { kind: 'play', game: 'minecraft', durationMs: 1 } })], at)).toBe(false);
    expect(hasLaterSession([row({ role: 'system', ts: later, event: { kind: 'play', game: 'minecraft', durationMs: 1 } })], at)).toBe(true);
    expect(hasLaterSession([row({ role: 'system', ts: later, event: { kind: 'call', durationMs: 1 } })], at)).toBe(true);
    expect(hasLaterSession([row({ role: 'system', ts: later, event: { kind: 'play', game: 'chess', durationMs: 1 } })], at)).toBe(false);
    expect(hasLaterSession([row({ role: 'user', ts: later })], at)).toBe(false);
  });

  it('what happens to the file after each outcome', () => {
    for (const o of ['saved', 'none', 'trivial', 'over_limit', 'no_character', 'free_cloud'] as const) {
      expect(afterOutcome(o, 0)).toBe('delete');
    }
    for (const o of ['busy', 'cancelled'] as const) expect(afterOutcome(o, 0)).toBe('keep');
    for (const o of ['offline', 'error', 'timeout'] as const) {
      expect(afterOutcome(o, 0)).toBe('retry');
      expect(afterOutcome(o, PENDING_MAX_ATTEMPTS - 1)).toBe('delete');
    }
  });
});

describe('run on next launch', () => {
  it('runs the player-end check for a game with source app_quit and late_hours, then deletes the file', async () => {
    persistQuitSession(gameRecord());
    const { d, started } = deps();
    await runPendingQuitNextSteps(d);
    expect(started).toEqual([
      {
        characterId: 'char-1',
        surface: 'game',
        game: 'minecraft',
        activity: 'playing Minecraft together',
        durationMs: 20 * 60_000,
        lines: DIGEST.lines,
        playerLines: 7,
        goalsGame: 'minecraft',
        source: 'app_quit',
        eventProps: { late_hours: 3 },
      },
    ]);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('a call reads its lines from the transcript', async () => {
    persistQuitSession({ characterId: 'char-2', surface: 'call', durationMs: 5 * 60_000, endedAt: NOW - HOUR });
    const rows = [
      row({ role: 'user', voice: true, text: 'next time lets plan the trip', ts: NOW - HOUR - 2 * 60_000 }),
      row({ role: 'companion', voice: true, text: 'deal', ts: NOW - HOUR - 60_000 }),
    ];
    const { d, started } = deps({ recentRows: async () => rows });
    await runPendingQuitNextSteps(d);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      surface: 'call',
      activity: 'a voice call',
      playerLines: 1,
      source: 'app_quit',
      eventProps: { late_hours: 1 },
    });
    expect(started[0].lines).toHaveLength(2);
    expect(started[0].game).toBeUndefined();
    expect(existsSync(fileOf('char-2'))).toBe(false);
  });

  it('261107: a text chat reads its typed rows and keeps the free cloud gate', async () => {
    const endedAt = NOW - HOUR;
    persistQuitSession({ characterId: 'char-3', surface: 'chat', durationMs: 6 * 60_000, endedAt });
    expect(readPending('char-3')).toMatchObject({ surface: 'chat', durationMs: 6 * 60_000, endedAt });
    const rows = [
      row({ role: 'user', text: 'before the chat', ts: endedAt - 20 * 60_000 }),
      row({ role: 'user', text: 'lets build the lighthouse next', ts: endedAt - 6 * 60_000 }),
      row({ role: 'user', voice: true, text: 'a call line', ts: endedAt - 3 * 60_000 }),
      row({ role: 'companion', text: 'yes, copper first', ts: endedAt - 2 * 60_000 }),
      row({ role: 'user', text: 'ok gtg', ts: endedAt }),
      row({ role: 'companion', text: 'bye', ts: endedAt + 3_000 }),
    ];
    const { d, started } = deps({ recentRows: async () => rows });
    await runPendingQuitNextSteps(d);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      surface: 'chat',
      activity: 'a text chat',
      durationMs: 6 * 60_000,
      playerLines: 2,
      minPlayerLines: 4,
      skipOnFreeCloud: true,
      source: 'app_quit',
      eventProps: { late_hours: 1 },
    });
    expect(started[0].lines.map((l) => l.text)).toEqual(['lets build the lighthouse next', 'yes, copper first', 'ok gtg', 'bye']);
    expect(existsSync(fileOf('char-3'))).toBe(false);
  });

  it('runs every pending character once, one at a time, and ignores dirs without a file', async () => {
    persistQuitSession(gameRecord());
    persistQuitSession(gameRecord({ characterId: 'char-3', game: 'stardew' }));
    mkdirSync(dirOf('char-empty'), { recursive: true });
    let concurrent = 0;
    let maxConcurrent = 0;
    const { d, started } = deps({
      start: async (input) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        started.push(input);
        return 'none';
      },
    });
    await runPendingQuitNextSteps(d);
    expect(started.map((s) => s.characterId).sort()).toEqual(['char-1', 'char-3']);
    expect(started.find((s) => s.characterId === 'char-3')?.goalsGame).toBe('stardew');
    expect(maxConcurrent).toBe(1);
  });

  it('a "none" answer still deletes the file', async () => {
    persistQuitSession(gameRecord());
    await runPendingQuitNextSteps(deps({}, 'none').d);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('waits for a ready backend: nothing runs and the file stays', async () => {
    persistQuitSession(gameRecord());
    const { d, started } = deps({ backendReady: async () => false });
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('not_ready');
    expect(started).toHaveLength(0);
    expect(readPending('char-1')?.attempts).toBeUndefined();
  });

  it('a failed check is retried on later launches, then given up', async () => {
    persistQuitSession(gameRecord());
    for (let i = 1; i < PENDING_MAX_ATTEMPTS; i++) {
      expect(await runPendingFor(dirOf('char-1'), deps({}, 'offline').d)).toBe('offline');
      expect(readPending('char-1')?.attempts).toBe(i);
    }
    expect(await runPendingFor(dirOf('char-1'), deps({}, 'error').d)).toBe('error');
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('a check another one holds (busy) keeps the file as is', async () => {
    persistQuitSession(gameRecord());
    expect(await runPendingFor(dirOf('char-1'), deps({}, 'busy').d)).toBe('busy');
    expect(readPending('char-1')?.attempts).toBeUndefined();
  });

  it('a thrown start counts as an error, never escapes', async () => {
    persistQuitSession(gameRecord());
    const { d } = deps({
      start: async () => {
        throw new Error('boom');
      },
    });
    await expect(runPendingQuitNextSteps(d)).resolves.toBeUndefined();
    expect(readPending('char-1')?.attempts).toBe(1);
  });

  it('a second pass while one runs joins it (single flight)', async () => {
    persistQuitSession(gameRecord());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, started } = deps({
      start: async (input) => {
        started.push(input);
        await gate;
        return 'saved';
      },
    });
    const a = runPendingQuitNextSteps(d);
    const b = runPendingQuitNextSteps(d);
    expect(b).toBe(a);
    release();
    await a;
    expect(started).toHaveLength(1);
  });

  it('a missing memory root is nothing to do', async () => {
    rmSync(root, { recursive: true, force: true });
    await expect(runPendingQuitNextSteps(deps().d)).resolves.toBeUndefined();
  });
});

describe('skip when a new session started', () => {
  it('a game or call greeting this run drops the file and runs nothing', async () => {
    persistQuitSession(gameRecord());
    noteNewSessionForQuit('char-1');
    await vi.waitFor(() => expect(existsSync(fileOf('char-1'))).toBe(false));
    writeRaw('char-1', { v: 1, ...gameRecord() }); // even if the file came back
    const { d, started } = deps();
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('superseded');
    expect(started).toHaveLength(0);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('a later session in the transcript drops it', async () => {
    persistQuitSession(gameRecord());
    const rows = [row({ role: 'system', ts: NOW - HOUR, event: { kind: 'play', game: 'minecraft', durationMs: 600_000 } })];
    const { d, started } = deps({ recentRows: async () => rows });
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('superseded');
    expect(started).toHaveLength(0);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it("the quit's own play row does not count", async () => {
    persistQuitSession(gameRecord());
    const at = gameRecord().endedAt;
    const rows = [row({ role: 'system', ts: at + 40, event: { kind: 'play', game: 'minecraft', durationMs: 1_200_000 } })];
    const { d, started } = deps({ recentRows: async () => rows });
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('saved');
    expect(started).toHaveLength(1);
  });

  it('a session that starts while the check runs wins: the file is not rewritten', async () => {
    persistQuitSession(gameRecord());
    const { d } = deps({
      start: async () => {
        noteNewSessionForQuit('char-1');
        return 'cancelled';
      },
    });
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('superseded');
    await vi.waitFor(() => expect(existsSync(fileOf('char-1'))).toBe(false));
  });

  it('other characters are unaffected', async () => {
    persistQuitSession(gameRecord({ characterId: 'char-4' }));
    noteNewSessionForQuit('char-1');
    const { d, started } = deps();
    await runPendingQuitNextSteps(d);
    expect(started.map((s) => s.characterId)).toEqual(['char-4']);
  });
});

describe('expiry', () => {
  it('a pending check older than 7 days is deleted unrun', async () => {
    persistQuitSession(gameRecord({ endedAt: NOW - PENDING_MAX_AGE_MS - 1 }));
    const { d, started } = deps();
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('expired');
    expect(started).toHaveLength(0);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });

  it('one just inside 7 days still runs', async () => {
    persistQuitSession(gameRecord({ endedAt: NOW - PENDING_MAX_AGE_MS + 60_000 }));
    const { d, started } = deps();
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('saved');
    expect(started[0].eventProps).toEqual({ late_hours: 168 });
  });
});

describe('idempotent delete', () => {
  it('a second pass finds nothing and runs nothing', async () => {
    persistQuitSession(gameRecord());
    const { d, started } = deps();
    await runPendingQuitNextSteps(d);
    await runPendingQuitNextSteps(d);
    expect(started).toHaveLength(1);
    expect(await runPendingFor(dirOf('char-1'), d)).toBeNull();
  });

  it('dropping a file that is not there is fine', async () => {
    expect(() => noteNewSessionForQuit('nobody')).not.toThrow();
    await expect(runPendingFor(dirOf('nobody'), deps().d)).resolves.toBeNull();
  });

  it('an unreadable file is removed without a call', async () => {
    writeRaw('char-1', '{broken');
    const { d, started } = deps();
    expect(await runPendingFor(dirOf('char-1'), d)).toBe('unreadable');
    expect(started).toHaveLength(0);
    expect(existsSync(fileOf('char-1'))).toBe(false);
  });
});
