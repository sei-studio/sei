/**
 * Chat persistence + cross-surface continuity watermark.
 *
 * Pins the two pieces of novel logic in the chat backend:
 *   - chatStore append/read/clear round-trips inside the per-character memory dir.
 *   - continuity.buildLaunchContinuity recursive-summary watermark: older-than-window
 *     messages are folded into the rolling summary exactly once, an unchanged window
 *     costs ZERO LLM calls, and only newly-evicted messages are re-summarized.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';

// Mock the LLM so the summary fold is deterministic and call-countable.
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({ content: [{ type: 'text', text: 'ROLLED SUMMARY' }] })),
}));
vi.mock('./sdk', () => ({
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));

import * as chatStore from './chatStore';
import { buildLaunchContinuity, readSummary, clearContinuity } from './continuity';

const CHAR = '33333333-3333-4333-8333-333333333333';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-'));
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

describe('chatStore', () => {
  it('appends, reads all, reads recent, and clears', async () => {
    await seed(3);
    expect((await chatStore.readAll(CHAR)).map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
    expect((await chatStore.readRecent(CHAR, 2)).map((m) => m.text)).toEqual(['msg 1', 'msg 2']);
    await chatStore.clear(CHAR);
    expect(await chatStore.readAll(CHAR)).toEqual([]);
  });

  it('readAll returns [] for a character with no transcript', async () => {
    expect(await chatStore.readAll('44444444-4444-4444-8444-444444444444')).toEqual([]);
  });
});

describe('continuity watermark', () => {
  it('does not summarize when the conversation fits in the window', async () => {
    await seed(10);
    const cont = await buildLaunchContinuity(CHAR);
    expect(cont).not.toBeNull();
    expect(cont!.summary).toBe('');
    expect(cont!.recent).toHaveLength(10);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns null when there is no conversation', async () => {
    expect(await buildLaunchContinuity(CHAR)).toBeNull();
  });

  it('clearContinuity wipes the rolling summary so a cleared chat cannot re-seed it', async () => {
    await seed(60); // 10 older than the window → first launch folds a summary
    await buildLaunchContinuity(CHAR);
    expect(await readSummary(CHAR)).toBe('ROLLED SUMMARY');
    await clearContinuity(CHAR);
    expect(await readSummary(CHAR)).toBe('');
  });

  it('folds aged-out messages once, reuses an unchanged window, then folds only new evictions', async () => {
    // 60 messages → 10 older than the 50-window. First launch folds those 10.
    await seed(60);
    const first = await buildLaunchContinuity(CHAR);
    expect(first!.recent).toHaveLength(50);
    expect(first!.summary).toBe('ROLLED SUMMARY');
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Second launch, nothing new → reuse the cached summary, NO LLM call.
    await buildLaunchContinuity(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await readSummary(CHAR)).toBe('ROLLED SUMMARY');

    // 5 more messages → 65 total, 15 older now; only the 5 newly-evicted
    // (indices 10..14, which just aged past the window) get folded.
    await seed(5, 60);
    await buildLaunchContinuity(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const lastArgs = (createSpy.mock.calls as unknown as Array<unknown[]>)[1][0] as {
      messages: Array<{ content: string }>;
    };
    const promptText = lastArgs.messages[0].content;
    expect(promptText).toContain('msg 10'); // newly evicted
    expect(promptText).toContain('msg 14'); // newly evicted (last before window)
    expect(promptText).not.toContain('msg 9'); // already folded in the first pass
    expect(promptText).not.toContain('msg 60'); // still inside the recent window
  });
});
