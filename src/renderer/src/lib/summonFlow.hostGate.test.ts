/**
 * 260929 — the Forge/NeoForge host gate blocks: it always opens the modal
 * (never summons), even after the modded warning was acknowledged or hidden.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { summonSpy, getConfigSpy, trackSpy } = vi.hoisted(() => ({
  summonSpy: vi.fn(async () => {}),
  trackSpy: vi.fn(),
  getConfigSpy: vi.fn(async () => ({ hide_modded_host_warning: true })),
}));
vi.mock('./ipcClient', () => ({ sei: { summon: summonSpy, getConfig: getConfigSpy, track: trackSpy } }));

import { summonWithHostGate, acknowledgeHostWarning } from './summonFlow';
import { useUiStore } from './stores/useUiStore';
import type { LanHost } from '@shared/ipc';

const forge: LanHost = { client: 'neoforge', forgeModCount: 2 };
const quilt: LanHost = { client: 'quilt', forgeModCount: null };

beforeEach(() => {
  summonSpy.mockClear();
  trackSpy.mockClear();
  useUiStore.getState().closeModal();
});

describe('summonWithHostGate: Forge block', () => {
  it('opens the blocking modal and never summons, even when modded warnings are hidden or acknowledged', async () => {
    acknowledgeHostWarning('modded');
    await summonWithHostGate('c1', false, forge);
    expect(summonSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().modal).toMatchObject({ kind: 'lan-host-warning', warning: 'forge', characterId: 'c1' });
  });

  it('fires one summon_blocked per refused click, from the button path', async () => {
    await summonWithHostGate('c1', false, forge);
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('summon_blocked', {
      character_id: 'c1',
      game: 'minecraft',
      reason: 'FORGE_HOST_BLOCKED',
      loader: 'NeoForge',
      host_client: 'neoforge',
      path: 'button',
    });
  });

  it('does not fire summon_blocked on the soft paths', async () => {
    await summonWithHostGate('c2', false, quilt);
    await summonWithHostGate('c3', false, { client: 'forge', forgeModCount: null });
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('Forge on weak evidence only (no ping data, no launch target) takes the soft path, not the block', async () => {
    const weak: LanHost = { client: 'forge', forgeModCount: null, forgeLaunchTarget: false };
    await summonWithHostGate('c3', false, weak);
    expect(summonSpy).toHaveBeenCalledWith('c3', 'minecraft');
  });

  it("Sei's own Fabric profile summons with no modal", async () => {
    const ours: LanHost = { client: 'fabric', forgeModCount: null, seiSkinMod: true, otherModCount: 0 };
    await summonWithHostGate('c4', false, ours);
    expect(summonSpy).toHaveBeenCalledWith('c4', 'minecraft');
    expect(useUiStore.getState().modal).toBeNull();
  });

  it('a Quilt host keeps the soft path: a hidden modded warning summons straight away', async () => {
    await summonWithHostGate('c2', false, quilt);
    expect(summonSpy).toHaveBeenCalledWith('c2', 'minecraft');
  });
});
