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
  const params = new URLSearchParams(w.location.search);
  const ready = params.has('ready');
  // ?dashshot=chat|chatdst (260917): the dashboard mounted INSIDE ChatScreen,
  // so the game/chat split, the drag handle and the composer can be checked
  // in a plain tab. ChatScreen reaches many more bridge methods than the
  // panels do, so the stub becomes a Proxy: anything not listed answers an
  // async undefined (or, for on* subscriptions, an unsubscribe), and the chat
  // history is a fixture long enough to scroll.
  const chatMode = (params.get('dashshot') ?? '').startsWith('chat');
  // ?dashshot=creditwall (260926): the credit wall surfaces (usage-limit
  // popup, Credits screen callout, Draw! paused card, free-play-back banner)
  // over a fixture plan snapshot that is at the wall with the reset 3 days out.
  // Add &lang=zh for the Chinese copy.
  const creditWallMode = (params.get('dashshot') ?? '') === 'creditwall';
  const now = Date.now();
  const chatRows = Array.from({ length: 24 }, (_, i) => ({
    id: `row-${i}`,
    role: i % 3 === 0 ? 'user' : 'companion',
    text:
      i % 3 === 0
        ? `did you find any ${['iron', 'copper', 'a good fishing spot', 'the mine'][i % 4]} yet?`
        : `not yet, still ${['watering the parsnips', 'chopping wood by the pond', 'clearing the debris north of the house', 'checking the shipping bin'][i % 4]}. give me a minute and i'll head over.`,
    ts: now - (24 - i) * 90_000,
  }));
  // ?dashshot=chatfirst (260926): the guided first moment. An empty
  // transcript, so the armed greeting fires, answered after a short think with
  // a two-bubble greeting that ends on the chess offer. `&nomc=1` reports no
  // Minecraft install (chess + call only); `&lan=1` has a LAN world open
  // (Minecraft leads).
  const firstMode = params.get('dashshot') === 'chatfirst';
  const noMc = params.has('nomc');
  const firstGreeting = async (): Promise<unknown[]> => {
    await new Promise((r) => setTimeout(r, 900));
    const lan = params.has('lan');
    return [
      { id: 'fm-1', role: 'companion', text: 'oh hey Robin, you made it!', ts: Date.now() },
      {
        id: 'fm-2',
        role: 'companion',
        text: lan ? "i see your world is open. want me to hop in right now?" : 'wanna play a quick game of chess with me? i promise to go easy. maybe.',
        ts: Date.now(),
      },
    ];
  };
  const base: Record<string, unknown> = {
    chatHistory: async () => (firstMode ? [] : chatMode ? chatRows : []),
    chatOpened: firstMode ? firstGreeting : async () => [],
    // The Proxy's generic answer is not a LanState; the data store seeds from
    // this on start, so answer the real shape (open with `&lan=1`).
    getLanState: async () =>
      params.has('lan') ? { kind: 'open', port: 25565, motd: 'My World', lastSeenAt: Date.now() } : { kind: 'closed' },
    chatHistoryOlder: async () => [],
    chatPreviews: async () => ({}),
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
      installs: noMc ? [] : [
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
    creditsGet: async () => ({
      plan: 'free',
      usage_pct: 100,
      over_limit: true,
      resets_at: new Date(now + 3 * 86_400_000).toISOString(),
      extra_credits_used: 0,
      extra_credits_total: 0,
      renews_at: null,
      ends_at: null,
      subscription_status_raw: null,
      ai_backend_kind: 'cloud-proxy',
      feedback_reward_available: false,
    }),
    saveConfig: noop,
    openExternal: noop,
    gamePackState: async () => ({ kind: 'ready', root: '/r' }),
    gamePackEnsure: async () => ({ kind: 'ready', root: '/r' }),
    onGamePackProgress: () => () => undefined,
    wizardPromptShown: async () => ({ shown: true }),
    getWizardState: async () => ({ version: 1, hasRunOnce: false, enabledInstallIds: [], lastRunAt: null, lastSkinServerPort: null }),
  };
  (window as unknown as { sei: Record<string, unknown> }).sei = chatMode || creditWallMode
    ? new Proxy(base, {
        get(target, key) {
          if (key in target) return target[key as string];
          if (typeof key === 'string' && key.startsWith('on')) return () => () => undefined;
          return noop;
        },
      })
    : base;
}

export {};
