/**
 * characterSaveQueue (261120): the profile editors' writes for one companion
 * run one at a time and each applies only its own fields onto the row as
 * stored at that moment. Driven against an in-memory chars store whose IPC
 * calls take real (timer) time, so the old read-then-write race would show.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@shared/characterSchema';
import type { VoiceDraft } from './characterEdits';

const rows = new Map<string, Character>();
const saves: Character[] = [];
let expandGate: Promise<void> = Promise.resolve();
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const api = {
  getCharacter: vi.fn(async (id: string): Promise<Character | null> => {
    await tick(2);
    const row = rows.get(id);
    return row ? structuredClone(row) : null;
  }),
  saveCharacter: vi.fn(async (c: Character, opts?: { expandOnly?: boolean }): Promise<Character> => {
    if (opts?.expandOnly) {
      await expandGate;
      return { ...c, persona: { source: c.persona.source, expanded: `EXPANDED(${c.persona.source})` } };
    }
    await tick(2);
    // chars:save creates a missing row; that is the resurrection the queue must avoid.
    rows.set(c.id, structuredClone(c));
    saves.push(c);
    return c;
  }),
};
vi.mock('./ipcClient', () => ({ sei: api }));

const { enqueueCharacterSave, regenerateStoredPersona, updateStoredCharacter } = await import('./characterSaveQueue');
const { voiceMetadataToSave, chessMetadataToSave } = await import('./characterEdits');
const { editReleaseCount, forgetEditDrafts, getEditDraft, setEditDraft } = await import('./profileEditDrafts');

const base: Character = {
  id: 'c1',
  kind: 'custom',
  public_id: null,
  name: 'Nova',
  persona: { source: 'old source', expanded: 'old expanded' },
  is_default: false,
  description: 'old description',
  shared: false,
  slug: null,
  metadata: { voiceId: 'v-old' },
  created: '2026-11-01T00:00:00Z',
} as unknown as Character;

beforeEach(() => {
  rows.clear();
  saves.length = 0;
  rows.set(base.id, structuredClone(base));
  expandGate = Promise.resolve();
  api.getCharacter.mockClear();
  api.saveCharacter.mockClear();
});

describe('updateStoredCharacter', () => {
  it('keeps both of two concurrent saves of different fields (leaving the page with two drafts)', async () => {
    const voice: VoiceDraft = { voiceId: 'v-new', voiceOwn: null, params: {}, voiceShared: null };
    await Promise.all([
      updateStoredCharacter('c1', (latest) => ({ ...latest, name: 'Renamed', description: 'new description' })),
      updateStoredCharacter('c1', (latest) => ({
        ...latest,
        metadata: voiceMetadataToSave('c1', latest.metadata, voice),
      })),
      updateStoredCharacter('c1', (latest) => ({
        ...latest,
        metadata: chessMetadataToSave(latest.metadata, { custom: true, elo: 1400, style: 'sharp' }),
      })),
    ]);
    const row = rows.get('c1')!;
    expect(row.name).toBe('Renamed');
    expect(row.description).toBe('new description');
    expect(row.metadata?.voiceId).toBe('v-new');
    expect(row.metadata?.chess).toBeTruthy();
  });

  it('never writes a companion that is no longer stored (a save would recreate it)', async () => {
    rows.delete('c1');
    const out = await updateStoredCharacter('c1', (latest) => ({ ...latest, name: 'Back from the dead' }));
    expect(out).toBeNull();
    expect(api.saveCharacter).not.toHaveBeenCalled();
    expect(rows.has('c1')).toBe(false);
  });

  it('runs the next step after a failed one', async () => {
    const failed = enqueueCharacterSave('c1', async () => {
      throw new Error('boom');
    });
    const next = updateStoredCharacter('c1', (latest) => ({ ...latest, name: 'After' }));
    await expect(failed).rejects.toThrow('boom');
    await next;
    expect(rows.get('c1')!.name).toBe('After');
  });
});

describe('regenerateStoredPersona', () => {
  it('keeps a voice save made during the expansion and applies only the persona', async () => {
    let release!: () => void;
    expandGate = new Promise<void>((r) => (release = r));
    const regen = regenerateStoredPersona('c1', 'new source', 'req-1');
    await tick(10); // the expansion is running
    const voice: VoiceDraft = { voiceId: 'v-mid', voiceOwn: null, params: {}, voiceShared: null };
    await updateStoredCharacter('c1', (latest) => ({
      ...latest,
      name: 'Renamed mid-expansion',
      metadata: voiceMetadataToSave('c1', latest.metadata, voice),
    }));
    release();
    const out = await regen;
    const row = rows.get('c1')!;
    expect(out).not.toBeNull();
    expect(row.persona).toEqual({ source: 'new source', expanded: 'EXPANDED(new source)' });
    expect(row.metadata?.prompt_mode).toBe('standard');
    expect(row.metadata?.voiceId).toBe('v-mid');
    expect(row.name).toBe('Renamed mid-expansion');
    // The expansion call itself asked main not to write.
    expect(api.saveCharacter.mock.calls[0]![1]).toMatchObject({ expandOnly: true, expansionRequestId: 'req-1' });
  });

  it('writes nothing when the companion was released during the expansion', async () => {
    let release!: () => void;
    expandGate = new Promise<void>((r) => (release = r));
    const regen = regenerateStoredPersona('c1', 'new source');
    await tick(10);
    rows.delete('c1');
    release();
    expect(await regen).toBeNull();
    expect(rows.has('c1')).toBe(false);
    expect(saves).toHaveLength(0);
  });
});

describe('forgetEditDrafts', () => {
  it("drops only that companion's drafts and bumps its release count", () => {
    setEditDraft('c1', 'voice', { a: 1 });
    setEditDraft('c1', 'about', { b: 2 });
    setEditDraft('c2', 'voice', { c: 3 });
    const before = editReleaseCount('c1');
    forgetEditDrafts('c1');
    expect(getEditDraft('c1', 'voice')).toBeNull();
    expect(getEditDraft('c1', 'about')).toBeNull();
    expect(getEditDraft('c2', 'voice')).toEqual({ c: 3 });
    expect(editReleaseCount('c1')).toBe(before + 1);
    expect(editReleaseCount('c2')).toBe(0);
  });
});
