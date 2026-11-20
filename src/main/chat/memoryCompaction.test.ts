/**
 * Chat-side MEMORY.md compaction (260810) — memoryCompaction.ts.
 *
 * Pins: the 32 KB threshold gate, the never-while-summoned race guard, the
 * per-character single-flight, that a pass actually shrinks MEMORY.md while
 * preserving `## World N` headers, and that MEMORY.archive.md is never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setUserDataOverride, paths } from '../paths';
import { drainScopedWrites } from '../profile/scopeBarrier';

const { createSpy, summonedSpy, getCharacterSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({
    content: [{ type: 'text', text: '- [2026-08-08] one merged entry about the player' }],
  })),
  summonedSpy: vi.fn(() => false),
  getCharacterSpy: vi.fn(async () => ({ persona: { expanded: 'test persona voice' } })),
}));

vi.mock('./sdk', () => ({
  CHAT_MODEL: 'claude-haiku-4-5',
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: createSpy } }, model: 'test-model' })),
}));
vi.mock('../botSupervisor', () => ({ isCharacterSummoned: summonedSpy }));
vi.mock('../characterStore', () => ({ getCharacter: getCharacterSpy }));

import { maybeCompactChatMemory, CHAT_COMPACTION_TRIGGER_BYTES } from './memoryCompaction';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sei-chat-compact-'));
  _setUserDataOverride(dir);
  createSpy.mockClear();
  summonedSpy.mockClear();
  summonedSpy.mockReturnValue(false);
});
afterEach(async () => {
  // A finished LLM call records its tokens in the profile's usage ledger
  // (usage/llmUsageLedger.ts) a moment later, fire-and-forget. Let those
  // tracked writes land before the profile dir goes (under CI load they raced
  // the rm: ENOTEMPTY, or wrote after the override was cleared).
  await drainScopedWrites();
  _setUserDataOverride(null);
  await rm(dir, { recursive: true, force: true });
});

const HEADER =
  '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';

/** Write a MEMORY.md (+ archive) comfortably over the 32 KB trigger. */
async function seedBigMemory(characterId: string): Promise<{ file: string; archive: string; raw: string }> {
  const memDir = paths.memoryDir(characterId);
  await mkdir(memDir, { recursive: true });
  const entries: string[] = [];
  for (let i = 0; i < 220; i++) {
    entries.push(`- [2026-08-01T00:${String(i % 60).padStart(2, '0')}:00.000Z] entry ${i} ${'x'.repeat(150)}`);
  }
  const raw = HEADER + '## World 1 — testland\n' + entries.join('\n') + '\n';
  expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(CHAT_COMPACTION_TRIGGER_BYTES);
  const file = path.join(memDir, 'MEMORY.md');
  const archive = path.join(memDir, 'MEMORY.archive.md');
  await writeFile(file, raw, 'utf8');
  await writeFile(archive, '# Memory archive\n\nraw mirror, must never change\n' + raw, 'utf8');
  return { file, archive, raw };
}

describe('maybeCompactChatMemory (260810)', () => {
  it('no-ops without a MEMORY.md and under the threshold (no LLM call)', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(await maybeCompactChatMemory(id)).toBe(false);

    const memDir = paths.memoryDir(id);
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'MEMORY.md'), HEADER + '- [2026-08-01T00:00:00.000Z] small\n', 'utf8');
    expect(await maybeCompactChatMemory(id)).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    // Under threshold the summon probe is never even consulted (hot path is
    // one stat()).
    expect(summonedSpy).not.toHaveBeenCalled();
  });

  it('refuses to compact while the character is summoned (cross-process race guard)', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000002';
    const { file, raw } = await seedBigMemory(id);
    summonedSpy.mockReturnValue(true);
    expect(await maybeCompactChatMemory(id)).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(raw);
  });

  it('compacts an over-threshold file, preserves world headers, never touches the archive', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000003';
    const { file, archive } = await seedBigMemory(id);
    const archiveBefore = await readFile(archive, 'utf8');

    expect(await maybeCompactChatMemory(id)).toBe(true);
    expect(createSpy).toHaveBeenCalled();

    const after = await readFile(file, 'utf8');
    expect(after).toContain('## World 1 — testland');
    expect(after).toContain('- [2026-08-08] one merged entry about the player');
    expect(Buffer.byteLength(after, 'utf8')).toBeLessThan(CHAT_COMPACTION_TRIGGER_BYTES);

    // The raw archive is the permanent record — byte-identical after the pass.
    expect(await readFile(archive, 'utf8')).toBe(archiveBefore);

    // The compaction call used the chat SDK with the noise-guarded system
    // prompt and the persona voice.
    const call = createSpy.mock.calls[0] as unknown as [{ system: string }];
    expect(call[0].system).toContain('Noise guard');
    expect(call[0].system).toContain('test persona voice');
  });

  it('compacts a ~300-entry section in chunks, and a chunk cut off at max_tokens keeps its originals (261024)', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000005';
    const memDir = paths.memoryDir(id);
    await mkdir(memDir, { recursive: true });
    // About what a mostly-chat user has at the 32 KB trigger: one section,
    // ~300 entries of ~110 bytes.
    const entries: string[] = [];
    for (let i = 0; i < 300; i++) {
      entries.push(`- [2026-08-${String(1 + (i % 28)).padStart(2, '0')}] chat note ${String(i).padStart(3, '0')} ${'y'.repeat(80)}`);
    }
    const raw = HEADER + '## App chats\n' + entries.join('\n') + '\n';
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(CHAT_COMPACTION_TRIGGER_BYTES);
    const file = path.join(memDir, 'MEMORY.md');
    await writeFile(file, raw, 'utf8');

    // First chunk's reply is cut off; the rest compact normally.
    createSpy.mockImplementationOnce(async () => ({
      content: [{ type: 'text', text: '- [2026-08-08] the first part of a list that got cut' }],
      stop_reason: 'max_tokens',
    }));

    expect(await maybeCompactChatMemory(id)).toBe(true);
    const calls = createSpy.mock.calls as unknown as Array<[{ messages: Array<{ content: string }>; max_tokens: number }]>;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const sent: string[] = [];
    for (const [req] of calls) {
      const lines = req.messages[0].content.split('\n').filter((l) => l.startsWith('- ['));
      // Every call stays well under what the output cap can hold verbatim.
      expect(Buffer.byteLength(lines.join('\n'), 'utf8')).toBeLessThanOrEqual(10_240);
      expect(req.max_tokens).toBeGreaterThanOrEqual(4000);
      sent.push(...lines);
    }
    // All entries went out exactly once, in file order.
    expect(sent).toEqual(entries);

    const after = await readFile(file, 'utf8');
    const firstChunk = calls[0][0].messages[0].content.split('\n').filter((l) => l.startsWith('- ['));
    // The cut-off chunk is kept verbatim; its partial reply is not written.
    for (const l of firstChunk) expect(after).toContain(l);
    expect(after).not.toContain('a list that got cut');
    // Later chunks compacted.
    expect(after).toContain('- [2026-08-08] one merged entry about the player');
    expect(after).not.toContain(entries[entries.length - 1]);
    expect(after).toContain('## App chats');
  });

  it('leaves the file untouched when every compaction reply is cut off (261024)', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000006';
    const { file, raw } = await seedBigMemory(id);
    createSpy.mockImplementation(async () => ({
      content: [{ type: 'text', text: '- [2026-08-08] first half of a list that got cut' }],
      stop_reason: 'max_tokens',
    }));
    try {
      expect(await maybeCompactChatMemory(id)).toBe(false);
      expect(createSpy).toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(raw);
    } finally {
      createSpy.mockImplementation(async () => ({
        content: [{ type: 'text', text: '- [2026-08-08] one merged entry about the player' }],
      }));
    }
  });

  it('single-flights per character: a concurrent trigger is a no-op', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000004';
    await seedBigMemory(id);
    let release!: (v: { content: Array<{ type: string; text: string }> }) => void;
    createSpy.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const first = maybeCompactChatMemory(id);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    // Second trigger while the first pass's LLM call is in flight.
    expect(await maybeCompactChatMemory(id)).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);

    release({ content: [{ type: 'text', text: '- [2026-08-08] merged' }] });
    expect(await first).toBe(true);
  });
});
