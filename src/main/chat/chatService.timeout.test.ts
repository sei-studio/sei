/**
 * 260926: a model timeout is a real chat failure, a user cancel is not.
 *
 * Before this, a local/Ollama provider enforced its 120 s floor by aborting
 * its own fetch, and chatService's abort check turned that AbortError into the
 * CHAT_ABORTED sentinel: the reply vanished, the renderer stayed silent and no
 * surface_error was captured. The providers now throw LlmTimeoutError for
 * their own deadline (see llm/timeout.test.ts); these tests pin what the chat
 * turn does with each shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride } from '../paths';
import { LlmTimeoutError } from '../llm/timeout';

const { createSpy, captureSurfaceErrorSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  captureSurfaceErrorSpy: vi.fn(),
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({
    client: { messages: { create: createSpy, stream: vi.fn() } },
    model: 'test-model',
  })),
}));
vi.mock('../characterStore', () => ({
  getCharacter: vi.fn(async () => ({
    id: CHAR,
    name: 'Marv',
    persona: { source: 'grumpy robot', expanded: 'PERSONA' },
    metadata: {},
  })),
  patchCharacter: vi.fn(async () => undefined),
}));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Player' })),
}));
vi.mock('../llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({ lastProvider: 'fake', beginTurn() {}, async runTool() { return { content: '', is_error: false }; } }),
}));
// The real classifier, a spy for the event.
vi.mock('../analytics', async () => ({
  captureSurfaceError: captureSurfaceErrorSpy,
  surfaceErrorClass: (await import('../surfaceErrorClass')).surfaceErrorClass,
}));

import type { ChatDeps } from './chatService';
import { sendChatMessage, cancelInflightTurn, CHAT_ABORTED } from './chatService';

const CHAR = '66666666-6666-4666-8666-666666666666';
let dir: string;

const deps = (): ChatDeps => ({
  getLanState: () => ({ kind: 'closed' }),
  summon: vi.fn(async () => undefined),
  leaveGame: vi.fn(),
});

/** An LLM call that only settles when its request signal aborts. */
function parkUntilAborted(): void {
  createSpy.mockImplementationOnce(
    (_req: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-timeout-'));
  _setUserDataOverride(dir);
  createSpy.mockReset();
  captureSurfaceErrorSpy.mockReset();
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

describe('sendChatMessage: model timeout vs user cancel', () => {
  it('a model timeout rejects with the real error and captures surface_error "timeout"', async () => {
    createSpy.mockRejectedValueOnce(new LlmTimeoutError('ollama', 120_000));

    const err = (await sendChatMessage({ characterId: CHAR, text: 'hi' }, deps()).catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.message).not.toContain(CHAT_ABORTED);
    await vi.waitFor(() => expect(captureSurfaceErrorSpy).toHaveBeenCalledWith('chat', 'timeout', CHAR));
  });

  it('a user cancel rejects with CHAT_ABORTED and captures nothing', async () => {
    parkUntilAborted();

    const turn = sendChatMessage({ characterId: CHAR, text: 'hi' }, deps()).catch((e: unknown) => e);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    cancelInflightTurn(CHAR);
    const err = (await turn) as Error;

    expect(err.message).toBe(CHAT_ABORTED);
    // Give the fire-and-forget capture a chance to run if it (wrongly) would.
    await new Promise((r) => setTimeout(r, 20));
    expect(captureSurfaceErrorSpy).not.toHaveBeenCalled();
  });
});
