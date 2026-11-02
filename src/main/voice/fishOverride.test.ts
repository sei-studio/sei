/**
 * A character's own Fish Audio voice (261103): parse, check with the user's
 * key, store sparsely in the main-owned `fish_voice_overrides`, in the scope
 * the call started in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  scope: 'user-1',
  writes: [] as { scope: string | undefined }[],
  key: 'fish-key' as string | null,
  fetchVoice: vi.fn(),
}));
vi.mock('../paths', () => ({ getActiveScope: () => m.scope }));
vi.mock('../configStore', () => ({
  updateConfig: async (fn: (c: Record<string, unknown>) => Record<string, unknown>, opts?: { scope?: string }) => {
    m.writes.push({ scope: opts?.scope });
    m.config = fn(m.config);
    return m.config;
  },
}));
vi.mock('./fishKeyStore', () => ({ resolveFishKey: async () => m.key }));
vi.mock('./fishTts', async (orig) => ({ ...await orig<typeof import('./fishTts')>(), fetchFishVoice: m.fetchVoice }));
import { setFishVoiceOverride } from './fishOverride';

const ID = '0123456789abcdef0123456789abcdef';

describe('setFishVoiceOverride', () => {
  beforeEach(() => {
    m.config = {};
    m.scope = 'user-1';
    m.writes = [];
    m.key = 'fish-key';
    m.fetchVoice.mockReset().mockResolvedValue({ id: ID, name: 'Calm Voice' });
  });

  it('checks a pasted link with the key and stores {id, name} for that character', async () => {
    const res = await setFishVoiceOverride('c1', `https://fish.audio/m/${ID}/`);
    expect(res).toEqual({ ok: true, voice: { id: ID, name: 'Calm Voice' } });
    expect(m.fetchVoice).toHaveBeenCalledWith('fish-key', ID);
    expect(m.config.fish_voice_overrides).toEqual({ c1: { id: ID, name: 'Calm Voice' } });
    expect(m.writes).toEqual([{ scope: 'user-1' }]);
  });

  it('writes into the scope the call started in, even if it moved during the lookup', async () => {
    m.fetchVoice.mockImplementation(async () => { m.scope = 'user-2'; return { id: ID, name: 'V' }; });
    await setFishVoiceOverride('c1', ID);
    expect(m.writes).toEqual([{ scope: 'user-1' }]);
  });

  it('refuses a link that is not a Fish voice without calling Fish or writing', async () => {
    expect(await setFishVoiceOverride('c1', 'https://example.com/m/x')).toEqual({ ok: false, reason: 'invalid-link' });
    expect(m.fetchVoice).not.toHaveBeenCalled();
    expect(m.writes).toEqual([]);
  });

  it('needs a key', async () => {
    m.key = null;
    expect(await setFishVoiceOverride('c1', ID)).toEqual({ ok: false, reason: 'no-key' });
    expect(m.fetchVoice).not.toHaveBeenCalled();
  });

  it('maps a failed check to its reason and writes nothing', async () => {
    m.fetchVoice.mockRejectedValue(new Error('FISH_VOICE_MISSING: status 404'));
    expect(await setFishVoiceOverride('c1', ID)).toEqual({ ok: false, reason: 'voice-missing' });
    m.fetchVoice.mockRejectedValue(new Error('something odd'));
    expect(await setFishVoiceOverride('c1', ID)).toEqual({ ok: false, reason: 'failed' });
    expect(m.writes).toEqual([]);
  });

  it('null or blank clears only that character, and drops the field when empty', async () => {
    m.config.fish_voice_overrides = { c1: { id: ID, name: 'A' }, c2: { id: ID, name: 'B' } };
    expect(await setFishVoiceOverride('c1', null)).toEqual({ ok: true, voice: null });
    expect(m.config.fish_voice_overrides).toEqual({ c2: { id: ID, name: 'B' } });
    await setFishVoiceOverride('c2', '   ');
    expect(m.config.fish_voice_overrides).toBeUndefined();
    // Clearing a character with nothing stored is a no-op write.
    await setFishVoiceOverride('c3', null);
    expect(m.config.fish_voice_overrides).toBeUndefined();
  });
});
