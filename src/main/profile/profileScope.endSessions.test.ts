/**
 * Account switch ends every live per-account session in MAIN (260926).
 *
 * switchScopeForAuth used to stop only the game bots, so a chess game, a Draw!
 * round, a backseat share and a voice call kept running under the previous
 * account. Now it ends each surface through its own choke point, with reason
 * 'account_switch', BEFORE the scope moves, and waits for their closing rows.
 *
 * The surface services are stubbed here (their own tests cover what each end
 * does); what is pinned is the ORDER against the real profile scope and the
 * real transcript store:
 *   1. every surface is ended with 'account_switch' while the scope is still
 *      the outgoing account's;
 *   2. every closing row, including one that lands only after an await and a
 *      bot row registered after its process exits, is on disk in the OUTGOING
 *      account's profile and nowhere in the incoming one;
 *   3. app:scope-ending reaches the renderer after main ended the surfaces and
 *      before app:scope-changed;
 *   4. the account teardown flag (which defers the fold) is up during the ends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (_k: string) => tmpdir() },
}));

const h = vi.hoisted(() => ({
  calls: [] as Array<{ surface: string; reason: string; scope: string; teardown: boolean }>,
  rows: [] as Array<{ surface: string; scope: string }>,
}));

/** A closing row written the way the real services write theirs: tracked by
 *  the barrier, resolving `paths` only after an await. */
async function rowWriter(surface: string, delayMs: number): Promise<void> {
  const { trackScopedWrite } = await import('./scopeBarrier');
  const { getActiveScope } = await import('../paths');
  const { appendMessage } = await import('../chat/chatStore');
  await trackScopedWrite(
    (async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      h.rows.push({ surface, scope: getActiveScope() });
      await appendMessage('bbf5b66f-2f0f-4918-a953-a2cf66d5a586', {
        id: `${surface}-row`,
        role: 'system',
        text: `${surface} row`,
        ts: Date.now(),
        event: { kind: 'play', game: surface, durationMs: 1000 },
      } as never);
    })(),
  );
}

/** Synchronous, like the real ends' first halves (the bindings below are
 *  imported statically; this only runs at test time). */
function noteCall(surface: string, reason: string): void {
  h.calls.push({ surface, reason, scope: getActiveScope(), teardown: isAccountTeardownActive() });
}

// Each stub records its call synchronously-enough (before the scope could move)
// and writes its row later, like the real endSession / finishGame / endBackseat.
vi.mock('../chess/chessService', () => ({
  endAllChess: vi.fn((reason: string) => {
    noteCall('chess', reason);
    // endAllChess is sync; its row write is fire-and-forget + tracked.
    void rowWriter('chess', 60);
  }),
}));
vi.mock('../draw/drawService', () => ({
  endAllDraw: vi.fn(async (reason: string) => {
    noteCall('draw', reason);
    await rowWriter('draw', 10);
  }),
}));
vi.mock('../backseat/backseatService', () => ({
  endAllBackseat: vi.fn(async (reason: string) => {
    noteCall('backseat', reason);
    await rowWriter('backseat', 15);
  }),
}));
vi.mock('../chat/chatSession', () => ({
  endAllChatSessions: vi.fn(async (reason: string) => {
    noteCall('chat', reason);
  }),
}));

import { paths, _setUserDataOverride, setActiveScope, getActiveScope, profileRootFor } from '../paths';
import { IpcChannel } from '../../shared/ipc';
import { initProfileScope, switchScopeForAuth, _resetForTests } from './profileScope';
import { _resetScopeBarrierForTests, isAccountTeardownActive } from './scopeBarrier';

const UUID_A = 'a1111111-1111-4111-8111-111111111111';
const UUID_B = 'b2222222-2222-4222-8222-222222222222';
const SUI = 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586';

let tmp: string;
let sent: string[];
let stopScope: string | null;
let voiceReason: string | null;
/** What main had done when it pushed app:scope-ending. */
let atEnding: { ended: string[]; voice: string | null; scope: string } | null;

function transcriptFor(scope: string): string {
  return path.join(profileRootFor(scope), 'memory', SUI, 'chat.jsonl');
}

async function readRows(scope: string): Promise<string[]> {
  try {
    const raw = await readFile(transcriptFor(scope), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-scope-end-'));
  _setUserDataOverride(tmp);
  _resetScopeBarrierForTests();
  setActiveScope(UUID_A);
  h.calls.length = 0;
  h.rows.length = 0;
  sent = [];
  stopScope = null;
  voiceReason = null;
  atEnding = null;
  const supervisor = {
    stop: vi.fn(async () => {
      stopScope = getActiveScope();
      // A bot's play row is registered by broadcastStatus only once its
      // process has exited, i.e. just as stop() resolves.
      await new Promise((r) => setTimeout(r, 5));
      void rowWriter('bot', 50);
    }),
  };
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string) => {
        sent.push(channel);
        if (channel === IpcChannel.app.scopeEnding) {
          atEnding = {
            ended: h.calls.map((c) => c.surface).sort(),
            voice: voiceReason,
            scope: getActiveScope(),
          };
        }
      },
    },
  } as unknown as Electron.BrowserWindow;
  initProfileScope({
    supervisor: supervisor as never,
    getMainWindow: () => win,
    endVoiceCalls: async (reason) => {
      voiceReason = reason;
      await rowWriter('call', 30);
    },
  });
});

afterEach(async () => {
  _resetForTests();
  _setUserDataOverride(null);
  setActiveScope('local');
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* swallow */ } }
});

describe('switchScopeForAuth ends the outgoing account\'s sessions', () => {
  it.each([
    ['account switch A -> B', UUID_B],
    ['sign-out A -> local', null],
  ])('%s: each surface ends with account_switch and its row lands in A', async (_label, next) => {
    await switchScopeForAuth(next);

    // 1. Every surface ended, with the reason, in A, inside the teardown.
    expect(h.calls.map((c) => c.surface).sort()).toEqual(['backseat', 'chat', 'chess', 'draw']);
    for (const c of h.calls) {
      expect(c.reason).toBe('account_switch');
      expect(c.scope).toBe(UUID_A);
      expect(c.teardown).toBe(true);
    }
    expect(voiceReason).toBe('account_switch');
    expect(stopScope).toBe(UUID_A);

    // 2. Every closing row was written while the scope was still A, and is on
    //    disk under A only.
    expect(h.rows.map((r) => r.surface).sort()).toEqual(['backseat', 'bot', 'call', 'chess', 'draw']);
    for (const r of h.rows) expect(r.scope).toBe(UUID_A);
    expect(await readRows(UUID_A)).toEqual(
      ['backseat-row', 'bot-row', 'call-row', 'chess-row', 'draw-row'],
    );
    expect(await readRows(next ?? 'local')).toEqual([]);

    // 3. scope-ending went out after main ended every surface (their rows
    //    may still have been in flight) and before scope-changed; the scope
    //    did move afterwards.
    expect(atEnding).toEqual({
      ended: ['backseat', 'chat', 'chess', 'draw'],
      voice: 'account_switch',
      scope: UUID_A,
    });
    expect(sent.indexOf(IpcChannel.app.scopeEnding)).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf(IpcChannel.app.scopeEnding)).toBeLessThan(sent.indexOf(IpcChannel.app.scopeChanged));
    expect(getActiveScope()).toBe(next ?? 'local');
    expect(paths.profileRoot()).toBe(profileRootFor(next ?? 'local'));

    // 4. The teardown flag is down again.
    expect(isAccountTeardownActive()).toBe(false);
  });

  it('a token refresh (same scope) ends nothing', async () => {
    await switchScopeForAuth(UUID_A);
    expect(h.calls).toEqual([]);
    expect(voiceReason).toBeNull();
    expect(sent).toEqual([]);
  });
});
