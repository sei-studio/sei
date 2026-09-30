/**
 * Chat turns across an account switch (260926).
 *
 * A turn is tagged with the scope it began in (withScopedTurn). If the
 * account changes while the model is out, the late reply must write nothing:
 * no transcript row and no MEMORY.md line, since the bundled defaults share
 * ids across profiles and the write would land in the incoming account. A
 * turn requested while the switch runs is refused, and the switch aborts
 * every turn still waiting on the model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';

const { createSpy, streamSpy, getCharacterSpy, patchCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  streamSpy: vi.fn(),
  getCharacterSpy: vi.fn(),
  patchCharacterSpy: vi.fn(),
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({
    client: { messages: { create: createSpy, stream: streamSpy } },
    model: 'test-model',
  })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: getCharacterSpy,
  patchCharacter: patchCharacterSpy,
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('../llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({ lastProvider: 'fake', beginTurn() {}, async runTool() { return { content: '', is_error: false }; } }),
}));

import type { ChatDeps } from './chatService';
import { sendChatMessage, cancelAllInflightTurns, CHAT_ABORTED } from './chatService';
import { setCallActive } from '../voice/callState';
import { readAll as chatStoreRead } from './chatStore';
import {
  beginScopeSwitch,
  noteScopeChanged,
  ACCOUNT_SWITCHING,
  _resetScopeBarrierForTests,
} from '../profile/scopeBarrier';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;

const deps = (): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
});

/** The switch runs to completion while the model is answering. */
function switchAccounts(): void {
  const release = beginScopeSwitch();
  noteScopeChanged();
  release();
}

async function memoryFile(): Promise<string> {
  try {
    return await readFile(path.join(paths.memoryDir(CHAR), 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-scope-'));
  _setUserDataOverride(dir);
  _resetScopeBarrierForTests();
  const character = {
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  };
  getCharacterSpy.mockImplementation(async () => structuredClone(character));
  patchCharacterSpy.mockReset();
  patchCharacterSpy.mockImplementation(async () => structuredClone(character));
  createSpy.mockReset();
  streamSpy.mockReset();
});
afterEach(async () => {
  _setUserDataOverride(null);
  setCallActive(CHAR, false);
  _resetScopeBarrierForTests();
  await rm(dir, { recursive: true, force: true });
});

describe('chat turns across an account switch', () => {
  it('control: without a switch the reply row and the remember() line are written', async () => {
    createSpy
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'big exam, noted.' },
          { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player has an exam friday' } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'good luck.' }] });
    await sendChatMessage({ characterId: CHAR, text: 'exam friday', voiceCall: true }, deps());
    const rows = await chatStoreRead(CHAR);
    expect(rows.some((r) => r.role === 'companion')).toBe(true);
    expect(await memoryFile()).toContain('player has an exam friday');
  });

  it('a reply that lands after the account changed writes no row and no memory', async () => {
    createSpy
      .mockImplementationOnce(async () => {
        switchAccounts();
        return {
          content: [
            { type: 'text', text: 'big exam, noted.' },
            { type: 'tool_use', id: 'tu_rem', name: 'remember', input: { text: 'player has an exam friday' } },
          ],
        };
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'good luck.' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendChatMessage({ characterId: CHAR, text: 'exam friday', voiceCall: true }, deps()).catch(
        () => undefined,
      );
    } finally {
      warn.mockRestore();
    }
    const rows = await chatStoreRead(CHAR);
    // Only the player's own line, written before the model was called.
    expect(rows.map((r) => r.role)).toEqual(['user']);
    expect(await memoryFile()).toBe('');
  });

  it('a text-chat reply that lands after the account changed writes no row', async () => {
    createSpy.mockImplementationOnce(async () => {
      switchAccounts();
      return { content: [{ type: 'text', text: 'hey there' }] };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps()).catch(() => undefined);
    } finally {
      warn.mockRestore();
    }
    const rows = await chatStoreRead(CHAR);
    expect(rows.filter((r) => r.role === 'companion')).toHaveLength(0);
  });

  it('a turn requested while the switch runs is refused before it writes anything', async () => {
    const release = beginScopeSwitch();
    await expect(sendChatMessage({ characterId: CHAR, text: 'hi' }, deps())).rejects.toMatchObject({
      code: ACCOUNT_SWITCHING,
    });
    release();
    expect(createSpy).not.toHaveBeenCalled();
    expect(await chatStoreRead(CHAR)).toEqual([]);
  });

  it('cancelAllInflightTurns aborts a turn waiting on the model', async () => {
    createSpy.mockImplementation(
      (_params: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const turn = sendChatMessage({ characterId: CHAR, text: 'hi' }, deps());
    for (let i = 0; i < 100 && createSpy.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(createSpy).toHaveBeenCalled();
    cancelAllInflightTurns();
    await expect(turn).rejects.toThrow(CHAT_ABORTED);
    expect((await chatStoreRead(CHAR)).filter((r) => r.role === 'companion')).toHaveLength(0);
  });
});

