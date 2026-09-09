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
  const ready = new URLSearchParams(w.location.search).has('ready');
  (window as unknown as { sei: Record<string, unknown> }).sei = {
    gameDashboardSetWatching: noop,
    gameDashboardGet: async () => null,
    mcDashboardSetWatching: noop,
    mcDashboardSetPaused: noop,
    mcDashboardSetMode: noop,
    gameDashboardSetPaused: noop,
    gameDashboardSetMode: noop,
    stop: noop,
    // The launch panels (?dashshot=mclaunch|dstlaunch|stardewlaunch): the
    // game found but not set up; add `&ready=1` for the set-up state, so
    // both the "Set up" and the "Launch" faces of a panel can be checked.
    // detectMcInstalls answers `{ installs }`, the wizard's shape: a stub
    // returning a bare array hid the 260909 "not detected" bug.
    detectMcInstalls: async () => ({
      installs: [
        {
          id: 'v1', kind: 'vanilla', label: 'Vanilla Launcher', path: '/Users/you/Library/Application Support/minecraft', mc_version: '26.1',
          loader: ready ? 'fabric' : null, loader_version: ready ? '0.19.3' : null, fabric_mc_versions: ready ? ['1.21.1'] : [],
          csl_installed: ready, csl_version: ready ? '14.28' : null, sei_enabled: ready, compatibility: 'full',
        },
      ],
    }),
    dstInstallState: async () => ({
      kind: 'found', installPath: '/Applications/dontstarve_steam.app', modsDir: '/Applications/dontstarve_steam.app/Contents/mods',
      modInstalled: ready, modVersion: ready ? '0.2.0' : null, enabled: ready, gameRunning: false, needsRestart: false,
    }),
    dstInstall: noop,
    dstLaunch: noop,
    dstOpenAppManagement: noop,
    dstSurvivorGet: async () => ({ prefab: 'wickerbottom', source: 'auto', reason: 'She reads, and so do I.' }),
    dstSurvivorSet: async () => ({ prefab: 'wickerbottom', source: 'user', reason: '' }),
    onDstInstallProgress: () => () => undefined,
    stardewInstallState: async () => ({
      gamePath: '/Users/you/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS',
      candidates: ['/Users/you/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS', '/Applications/Stardew Valley.app/Contents/MacOS'],
      smapiInstalled: ready, smapiVersion: ready ? '4.5.2' : null, modInstalled: ready, modVersion: ready ? '0.1.0' : null,
      modConfig: ready ? { port: 27431, hasToken: true } : null, store: 'steam', platform: 'darwin', ready,
    }),
    stardewInstall: noop,
    stardewLaunch: async () => ({ launched: true, via: 'launcher' }),
    onStardewInstallProgress: () => () => undefined,
    worldCheckNow: async () => null,
    lanCheckNow: async () => ({ kind: 'closed' }),
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
