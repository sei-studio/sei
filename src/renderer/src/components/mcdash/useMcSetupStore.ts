/**
 * useMcSetupStore — what the Minecraft launch panel's setup list needs to
 * know (260909): the detected Minecraft installs (the same scan the skin
 * wizard runs), whether any of them is Sei-ready (Fabric for a version Sei
 * can join + the companion-skin mod; shared/mcSetup.ts), and whether the
 * player has dismissed the setup step with "Do not show again"
 * (UserConfig.mc_setup_dismissed).
 *
 * The scan is a filesystem walk in main; the panel re-runs it on mount, on
 * a slow poll while the step is not done, and whenever the wizard closes,
 * so a finished setup flips the step without a click.
 */
import { create } from 'zustand';
import type { McInstall } from '@shared/ipc';
import { anyMcInstallReady } from '@shared/mcSetup';
import { sei } from '../../lib/ipcClient';

export interface McSetupStoreState {
  /** null until the first scan has answered. */
  installs: McInstall[] | null;
  scanning: boolean;
  /** Hydrated from UserConfig; null until read. */
  dismissed: boolean | null;
  scan: () => Promise<void>;
  hydrate: () => Promise<void>;
  /** "Do not show again": persists the flag, then hides the step. */
  dismiss: () => Promise<void>;
}

export const useMcSetupStore = create<McSetupStoreState>((set, get) => ({
  installs: null,
  scanning: false,
  dismissed: null,

  scan: async () => {
    if (get().scanning) return;
    set({ scanning: true });
    try {
      // The bridge answers `{ installs }` (the wizard's shape). The first cut
      // read the result as a bare array, so every scan came back as "no
      // Minecraft found" while a vanilla install with a Sei profile sat on
      // disk (260909, the user's own machine). The tests had stubbed the
      // bridge with an array, which is why they passed.
      const res = (await sei.detectMcInstalls()) as unknown;
      const installs = Array.isArray(res)
        ? (res as McInstall[])
        : res && typeof res === 'object' && Array.isArray((res as { installs?: unknown }).installs)
          ? (res as { installs: McInstall[] }).installs
          : [];
      set({ installs });
    } catch {
      set((s) => ({ installs: s.installs ?? [] }));
    } finally {
      set({ scanning: false });
    }
  },

  hydrate: async () => {
    try {
      const cfg = await sei.getConfig();
      set({ dismissed: cfg.mc_setup_dismissed === true });
    } catch {
      set((s) => ({ dismissed: s.dismissed ?? false }));
    }
  },

  dismiss: async () => {
    set({ dismissed: true });
    try {
      // Read fresh right before writing: config:save takes the WHOLE config,
      // and a stale copy would roll back whatever Settings wrote meanwhile.
      const cfg = await sei.getConfig();
      await sei.saveConfig({ ...cfg, mc_setup_dismissed: true });
    } catch {
      /* the step stays hidden for this session either way */
    }
  },
}));

/** The supported version a detected install is ready for, or null. */
export function selectReadyVersion(installs: McInstall[] | null, supported: readonly string[]): string | null {
  if (!installs) return null;
  return anyMcInstallReady(installs, supported);
}
