/**
 * 260929 — the Forge/NeoForge host gate blocks: it always opens the modal
 * (never summons), even after the modded warning was acknowledged or hidden.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { summonSpy, getConfigSpy } = vi.hoisted(() => ({
  summonSpy: vi.fn(async () => {}),
  getConfigSpy: vi.fn(async () => ({ hide_modded_host_warning: true })),
}));
vi.mock('./ipcClient', () => ({ sei: { summon: summonSpy, getConfig: getConfigSpy } }));

import { summonWithHostGate, acknowledgeHostWarning } from './summonFlow';
import { useUiStore } from './stores/useUiStore';
import type { LanHost } from '@shared/ipc';

const forge: LanHost = { client: 'neoforge', forgeModCount: 2 };
const quilt: LanHost = { client: 'quilt', forgeModCount: null };

beforeEach(() => {
  summonSpy.mockClear();
  useUiStore.getState().closeModal();
});

describe('summonWithHostGate: Forge block', () => {
  it('opens the blocking modal and never summons, even when modded warnings are hidden or acknowledged', async () => {
    acknowledgeHostWarning('modded');
    await summonWithHostGate('c1', false, forge);
    expect(summonSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().modal).toMatchObject({ kind: 'lan-host-warning', warning: 'forge', characterId: 'c1' });
  });

  it('a Quilt host keeps the soft path: a hidden modded warning summons straight away', async () => {
    await summonWithHostGate('c2', false, quilt);
    expect(summonSpy).toHaveBeenCalledWith('c2', 'minecraft');
  });
});
