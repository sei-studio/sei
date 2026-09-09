/**
 * Dev-only window.sei stubs for the `?dashshot=` screenshot harness (260909).
 *
 * lib/ipcClient.ts captures `window.sei` the moment it is evaluated, and
 * main.tsx's static import of App reaches it before any harness code can
 * run, so a stub installed from inside the harness component arrives too
 * late. This module is main.tsx's FIRST import for exactly that reason: it
 * runs ahead of the rest of the graph. Outside a dev build, or in a window
 * that already has the real bridge (Electron's preload), it does nothing.
 * See components/games/DevDashShot.tsx for what the harness renders.
 */
const w = typeof window !== 'undefined' ? (window as unknown as { sei?: unknown; location: Location }) : null;
if (import.meta.env.DEV && w && w.sei == null && new URLSearchParams(w.location.search).has('dashshot')) {
  const noop = async (): Promise<undefined> => undefined;
  (window as unknown as { sei: Record<string, unknown> }).sei = {
    gameDashboardSetWatching: noop,
    gameDashboardGet: async () => null,
    mcDashboardSetWatching: noop,
    mcDashboardSetPaused: noop,
    mcDashboardSetMode: noop,
    gameDashboardSetPaused: noop,
    gameDashboardSetMode: noop,
    stop: noop,
    // The Minecraft launch panel (?dashshot=mclaunch): a vanilla install
    // with no Sei profile yet, the pack ready, nothing dismissed.
    detectMcInstalls: async () => [
      { id: 'v1', kind: 'vanilla', label: 'Vanilla Launcher', path: '/Users/you/Library/Application Support/minecraft', mc_version: '26.1', loader: null, loader_version: null, fabric_mc_versions: [], csl_installed: false, csl_version: null, sei_enabled: false, compatibility: 'full' },
    ],
    getConfig: async () => ({}),
    saveConfig: noop,
    openExternal: noop,
    gamePackState: async () => ({ kind: 'ready', root: '/r' }),
    gamePackEnsure: async () => ({ kind: 'ready', root: '/r' }),
    onGamePackProgress: () => () => undefined,
    wizardPromptShown: async () => ({ shown: true }),
    getWizardState: async () => ({ version: 1, hasRunOnce: false, enabledInstallIds: [], lastRunAt: null, lastSkinServerPort: null }),
  };
}

export {};
