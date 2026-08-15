/**
 * Avatar manifest cache (260804) — MAIN window only (the overlay window talks
 * to main directly; a zustand store never crosses windows).
 *
 * Tracks which characters have an imported Live2D model so the overlay pusher
 * can flag `live2d` on a participant without an IPC round-trip per push, and
 * so the profile Avatar tab shares one source of truth with the pusher.
 * `undefined` in the map means "never asked"; `null` means "asked, none".
 */
import { create } from 'zustand';
import type { AvatarManifest } from '@shared/ipc';
import { sei } from '../ipcClient';

interface AvatarStoreState {
  manifests: Record<string, AvatarManifest | null>;
  /** Fetch-once per character; safe to call from render effects. */
  ensure: (characterId: string) => void;
  /** Write-through after an import/remove from the profile tab. */
  setManifest: (characterId: string, manifest: AvatarManifest | null) => void;
}

const inFlight = new Set<string>();

export const useAvatarStore = create<AvatarStoreState>((set, get) => ({
  manifests: {},
  ensure: (characterId) => {
    if (characterId in get().manifests || inFlight.has(characterId)) return;
    inFlight.add(characterId);
    void sei
      .avatarGet?.(characterId)
      .then((m) => {
        set((s) => ({ manifests: { ...s.manifests, [characterId]: m ?? null } }));
      })
      .catch(() => {
        // Leave unknown so a later ensure() retries.
      })
      .finally(() => inFlight.delete(characterId));
  },
  setManifest: (characterId, manifest) =>
    set((s) => ({ manifests: { ...s.manifests, [characterId]: manifest } })),
}));
