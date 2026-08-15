/**
 * Fold safety fixes (260810), motivated by the 260808 incident where ~20
 * consecutive folds over phantom voice rows (a mic hearing reels audio)
 * progressively destroyed a good summary with no recovery path:
 *
 *   1. An empty/unusable fold output must NOT advance the watermark. The old
 *      `summary: text || bridge.summary` kept the old text while the watermark
 *      still advanced — the evicted messages were silently skipped forever.
 *   2. writeBridge is atomic (tmp + rename) and keeps a one-generation
 *      bridge.prev.json backup before every overwrite.
 *   3. One foldIfDue call drains at most FOLD_MAX_MESSAGES (300), so a huge
 *      backlog folds incrementally instead of in one unbounded LLM call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
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
import { foldIfDue, readSummary, readChatContext } from './continuity';

const CHAR = '88888888-8888-4888-8888-888888888888';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-fold-safety-'));
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

async function readBridgeRaw(): Promise<{ summary: string; summarizedCount: number }> {
  return JSON.parse(await readFile(path.join(paths.memoryDir(CHAR), 'bridge.json'), 'utf8'));
}

describe('fold safety (260810)', () => {
  it('an empty fold output keeps the watermark so the batch is retried, not skipped', async () => {
    await seed(100); // window(50) + batch(50) → a fold is due
    createSpy.mockImplementationOnce(async () => ({ content: [{ type: 'text', text: '   ' }] }));
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);

    // No bridge written: summary empty AND (critically) watermark not advanced.
    expect(await readSummary(CHAR)).toBe('');
    const files = await readdir(paths.memoryDir(CHAR)).catch(() => [] as string[]);
    expect(files).not.toContain('bridge.json');

    // The next fold retries the SAME batch and succeeds.
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const bridge = await readBridgeRaw();
    expect(bridge.summary).toBe('ROLLED SUMMARY');
    expect(bridge.summarizedCount).toBe(50);
  });

  it('writeBridge keeps a one-generation bridge.prev.json backup', async () => {
    await seed(100);
    createSpy.mockImplementationOnce(async () => ({ content: [{ type: 'text', text: 'GEN ONE' }] }));
    await foldIfDue(CHAR);
    expect((await readBridgeRaw()).summary).toBe('GEN ONE');
    // No previous generation existed before the first write.
    const filesAfterFirst = await readdir(paths.memoryDir(CHAR));
    expect(filesAfterFirst).not.toContain('bridge.prev.json');
    // No stray tmp files left behind by the atomic write.
    expect(filesAfterFirst.filter((f) => f.includes('.tmp.'))).toEqual([]);

    await seed(50, 100); // another batch due
    createSpy.mockImplementationOnce(async () => ({ content: [{ type: 'text', text: 'GEN TWO' }] }));
    await foldIfDue(CHAR);
    expect((await readBridgeRaw()).summary).toBe('GEN TWO');
    const prev = JSON.parse(
      await readFile(path.join(paths.memoryDir(CHAR), 'bridge.prev.json'), 'utf8'),
    );
    expect(prev.summary).toBe('GEN ONE');
    expect(prev.summarizedCount).toBe(50);
  });

  it('one fold call drains at most 300 messages; the backlog folds incrementally', async () => {
    await seed(400); // evictable = 350 > cap
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(1);
    let bridge = await readBridgeRaw();
    expect(bridge.summarizedCount).toBe(300);

    // The transcript sent to the model covered exactly the first 300 messages.
    const call = createSpy.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }];
    const userText = call[0].messages[0].content;
    expect(userText).toContain('msg 0');
    expect(userText).toContain('msg 299');
    expect(userText).not.toContain('msg 300');

    // Remaining tail is 100 = window + batch → the next call drains 50 more.
    await foldIfDue(CHAR);
    expect(createSpy).toHaveBeenCalledTimes(2);
    bridge = await readBridgeRaw();
    expect(bridge.summarizedCount).toBe(350);

    // Reads stay coherent throughout: summary + the unsummarized tail.
    const ctx = await readChatContext(CHAR);
    expect(ctx.summary).toBe('ROLLED SUMMARY');
    expect(ctx.history[0].text).toBe('msg 350');
    expect(ctx.history).toHaveLength(50);
  });
});
