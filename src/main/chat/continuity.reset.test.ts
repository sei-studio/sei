/**
 * Reset memory vs the background summary fold (260705).
 *
 * chat.jsonl and bridge.json live INSIDE the per-character memory dir, so
 * resetMemoryForCharacter is also the chat wipe — and the fold is fired by the
 * chat surface regardless of whether a bot is summoned, so the IPC handler's
 * isActive gate does NOT cover it. Without the clearContinuity epoch bump in
 * the reset path, a fold in flight across the rm would write bridge.json into
 * the freshly wiped dir: a resurrected summary of the erased conversation with
 * a watermark above the now-empty transcript (the exact chat:clear race the
 * 260705 clear-epoch guard closed — chat:clear is gone; reset memory is the
 * one wipe surface left and must hold the same guarantee).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// electron isn't available in the node-test env. Stub safeStorage so the
// apiKeyStore module that characterStore drags in via personaExpansion can be
// imported without exploding (reset never exercises it).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
  app: {
    getPath: (_n: string) => '/tmp/sei-default',
  },
}));

// characterStore's cloud mirror is fire-and-forget; keep it inert so a stray
// async enqueue can't land after the tmpdir teardown (same as characterStore.test).
vi.mock('../cloud/syncQueue', () => ({
  enqueueUpsert: vi.fn(async () => {}),
  enqueueDelete: vi.fn(async () => {}),
  processNext: vi.fn(async () => {}),
}));

// Mock the LLM so the summary fold is deterministic and call-countable.
// CHAT_TIMEOUT_MS included because resetMemoryForCharacter dynamically imports
// chatService (cancelInflightTurn), which reads it from this module.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] })),
}));
vi.mock('./sdk', () => ({
  CHAT_TIMEOUT_MS: 30_000,
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));

import { _setUserDataOverride, paths } from '../paths';
import * as chatStore from './chatStore';
import { readChatContext, readSummary, foldIfDue } from './continuity';
import { resetMemoryForCharacter } from '../characterStore';

const CHAR = '77777777-7777-4777-8777-777777777777';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-reset-'));
  _setUserDataOverride(dir);
  createSpy.mockClear();
});
afterEach(async () => {
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

async function seed(n: number, from = 0): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await chatStore.appendMessage(CHAR, {
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'companion',
      text: `msg ${i}`,
      ts: 1000 + i,
    });
  }
}

describe('reset memory racing an in-flight fold (260705)', () => {
  it('a reset during the fold LLM call does not resurrect bridge.json into the wiped dir', async () => {
    await seed(100); // window(50) + batch(50) → a fold is due
    // Block the summarizer on a deferred so the reset can land mid-fold.
    let release!: (v: { content: Array<{ type: string; text: string }> }) => void;
    createSpy.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fold = foldIfDue(CHAR);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // The player hits "Reset memory" (no bot summoned — the isActive gate
    // upstream does not apply; the fold belongs to the chat surface).
    await resetMemoryForCharacter(CHAR);

    release({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] });
    await fold;

    // The epoch bump (clearContinuity inside reset) dropped the write: the
    // wiped memory dir holds no resurrected bridge.json.
    expect(await readSummary(CHAR)).toBe('');
    expect(await readdir(paths.memoryDir(CHAR))).not.toContain('bridge.json');

    // A fresh conversation reads full history, not a stale-watermark blackout.
    await seed(3);
    const ctx = await readChatContext(CHAR);
    expect(ctx.summary).toBe('');
    expect(ctx.history.map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
  });
});
