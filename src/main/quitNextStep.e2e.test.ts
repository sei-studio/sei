/**
 * T120 end to end on the production wiring: a pending app-quit file runs
 * through quitNextStep's default deps -> startPlayerEndNextStep's default
 * deps (real MEMORY.md append, real NEXT_STEP.json tag, real Home notifier),
 * with only the provider, the account lookups and analytics faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const capture = vi.fn();
const llmCalls: unknown[] = [];
let reply = 'finish the cabin roof';
let backend: 'local' | 'cloud-proxy' = 'local';
let rows: unknown[] = [];

vi.mock('./llm', () => ({
  buildLlmProvider: async () => ({
    backend: 'local',
    kind: 'anthropic',
    model: 'claude-haiku-5-5',
    vision: 'yes',
    streaming: false,
    async call(p: unknown) {
      llmCalls.push(p);
      return { text: reply, usage: { input_tokens: 800, output_tokens: 6 } };
    },
  }),
  providerTimeoutMs: (_p: unknown, ms: number) => ms,
}));
vi.mock('./cloud/proxyClient', () => ({ cloudOverLimit: async () => false }));
vi.mock('./characterStore', () => ({ getCharacter: async () => ({ name: 'Sui' }) }));
vi.mock('./lazyAnalytics', () => ({ loadAnalytics: async () => ({ capture }) }));
vi.mock('./chat/memoryCompaction', () => ({ maybeCompactChatMemory: async () => {} }));
vi.mock('./apiKeyStore', () => ({ getAiBackendKind: async () => backend }));
vi.mock('./auth/supabaseClient', () => ({
  getClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));
vi.mock('./chat/chatStore', () => ({ readRecent: async () => rows }));

import { _resetPlayerEndNextStep, bindPlayerEndRuntime } from './playerEndNextStep';
import { bindHomeNextStepNotifier, readHomeNextStep, LEDGER_FILE } from './homeNextStep';
import {
  PENDING_FILE,
  _resetQuitNextStep,
  bindQuitNextStepRuntime,
  persistQuitSession,
  runPendingQuitNextSteps,
} from './quitNextStep';

const HOUR = 3_600_000;
let root: string;
const dirOf = (id: string) => path.join(root, id);
const notified: string[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sei-quit-e2e-'));
  bindPlayerEndRuntime({ memoryDir: dirOf, providerTimeoutMs: (_p, ms) => ms, isOnline: () => true });
  bindQuitNextStepRuntime({ memoryDir: dirOf, memoryRoot: () => root, activityFor: () => 'playing Minecraft together' });
  bindHomeNextStepNotifier((id) => notified.push(id));
  capture.mockClear();
  llmCalls.length = 0;
  notified.length = 0;
  reply = 'finish the cabin roof';
  backend = 'local';
  rows = [];
});

afterEach(() => {
  _resetQuitNextStep();
  _resetPlayerEndNextStep();
  bindHomeNextStepNotifier(null);
  rmSync(root, { recursive: true, force: true });
});

function persistGame() {
  persistQuitSession({
    characterId: 'char-1',
    surface: 'game',
    game: 'minecraft',
    durationMs: 25 * 60_000,
    endedAt: Date.now() - 2 * HOUR,
    digest: {
      lines: [
        { who: 'player', text: 'can we put a roof on the cabin' },
        { who: 'you', text: 'yes, I need more spruce planks first' },
        { who: 'player', text: 'ok I have to go' },
      ],
      playerLines: 9,
      selfLines: 6,
    },
  });
}

describe('app-quit check on the next launch (production wiring)', () => {
  it('saves the plan, tags it with the game, notifies Home, sends the events and deletes the file', async () => {
    persistGame();
    await runPendingQuitNextSteps();

    expect(llmCalls).toHaveLength(1);
    const memory = readFileSync(path.join(dirOf('char-1'), 'MEMORY.md'), 'utf8');
    expect(memory).toMatch(/Plan for next time in Minecraft: finish the cabin roof/);

    const ledger = JSON.parse(readFileSync(path.join(dirOf('char-1'), LEDGER_FILE), 'utf8'));
    expect(ledger.tags).toEqual([expect.objectContaining({ surface: 'game', game: 'minecraft' })]);
    const card = await readHomeNextStep(dirOf('char-1'), 'char-1');
    expect(card).toMatchObject({ source: 'plan', surface: 'game', game: 'minecraft', text: 'Finish the cabin roof' });
    expect(notified).toEqual(['char-1']);

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledWith('next_step_checked', {
      character_id: 'char-1',
      source: 'app_quit',
      surface: 'game',
      game: 'minecraft',
      late_hours: 2,
      saved: true,
      outcome: 'saved',
      reached_model: true,
      duration_s: expect.any(Number),
    });
    expect(capture).toHaveBeenCalledWith('next_step_saved', {
      character_id: 'char-1',
      source: 'app_quit',
      surface: 'game',
      game: 'minecraft',
      late_hours: 2,
    });
    expect(existsSync(path.join(dirOf('char-1'), PENDING_FILE))).toBe(false);
  });

  it('a call is tagged as a call', async () => {
    const endedAt = Date.now() - HOUR;
    rows = [
      { id: 'a', role: 'user', voice: true, text: 'lets plan the camping trip next time', ts: endedAt - 3 * 60_000 },
      { id: 'b', role: 'companion', voice: true, text: 'yes, pick a spot first', ts: endedAt - 2 * 60_000 },
      { id: 'c', role: 'user', voice: true, text: 'ok bye', ts: endedAt - 60_000 },
    ];
    reply = 'pick a spot for the camping trip';
    persistQuitSession({ characterId: 'char-1', surface: 'call', durationMs: 6 * 60_000, endedAt });
    await runPendingQuitNextSteps();
    const card = await readHomeNextStep(dirOf('char-1'), 'char-1');
    expect(card).toMatchObject({ source: 'plan', surface: 'call', game: null });
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith('next_step_saved', {
        character_id: 'char-1',
        source: 'app_quit',
        surface: 'call',
        late_hours: 1,
      }),
    );
  });

  it('a "none" answer saves nothing, sends saved:false and still deletes the file', async () => {
    reply = 'none';
    persistGame();
    await runPendingQuitNextSteps();
    expect(existsSync(path.join(dirOf('char-1'), 'MEMORY.md'))).toBe(false);
    expect(notified).toEqual([]);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith('next_step_checked', expect.objectContaining({ source: 'app_quit', saved: false, outcome: 'none' }));
    expect(existsSync(path.join(dirOf('char-1'), PENDING_FILE))).toBe(false);
  });

  it('cloud with no signed-in session waits: no call, the file stays for later', async () => {
    backend = 'cloud-proxy';
    persistGame();
    await runPendingQuitNextSteps();
    expect(llmCalls).toHaveLength(0);
    expect(existsSync(path.join(dirOf('char-1'), PENDING_FILE))).toBe(true);
  });
});
