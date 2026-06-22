/**
 * Electron main process entrypoint.
 *
 * Composes:
 *   - Single-instance lock
 *   - First-launch migration (legacy persona → characters/sui.json)
 *   - BrowserWindow (1180x760, platform-branched chrome)
 *   - LAN watcher (shared UDP socket, 3s stale)
 *   - Bot supervisor (one bot at a time)
 *   - IPC handler registrations
 *   - Graceful shutdown on before-quit
 *
 * Sources:
 *   - PATTERNS §src/main/index.ts (lines 370–424)
 *   - RESEARCH §Pattern 1 (utilityProcess + MessageChannel) — used inside botSupervisor
 *   - RESEARCH §Pitfall 5 (everything behind app.whenReady)
 *   - CONTEXT D-15, D-21, D-32, project constraints
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createMainWindow } from './windowChrome';
import { registerIpcHandlers, emitCreditsHardStop } from './ipc';
import { watchLan } from './lanWatcher';
import { createBotSupervisor } from './botSupervisor';
import { initUpdater } from './updater';
import { createSkinServer, SKIN_SERVER_DEV_PORT } from './skinServer';
import { runFirstLaunchMigration, runUuidRenameMigration } from './migration';
import { seedDefaultCharacters, refreshSeededDefaults } from './defaultCharacters';
import { safeStorageBackendKind } from './apiKeyStore';
import { loadWizardState, saveWizardState } from './wizardStateStore';
import { registerPortraitScheme, registerPortraitProtocol } from './portraitProtocol';
import { IpcChannel, type LanState, type BotStatus, type LogBatch, type WizardProgressEvent, type ExpansionProgressEvent, type VisionCapability } from '../shared/ipc';

// Lock the app name early so app.getPath('userData') resolves to
// "Sei" (packaged) or "Sei Dev" (electron-vite dev) — keeping dev state
// (your private personas) out of the shipped build.
app.setName(app.isPackaged ? 'Sei' : 'Sei Dev');
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Sei Dev'));
}

// Register the `sei-portrait://` privileged scheme that serves locally-stored
// character portraits to the renderer. MUST run before app 'ready'; the request
// handler is attached in bootstrap() once userData/paths are resolved.
registerPortraitScheme();

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
  error: (m: string) => console.error(`[sei] ${m}`),
};

let mainWindow: BrowserWindow | null = null;
let latestLanState: LanState = { kind: 'not_connected' };
let lanWatcherHandle: { stop: () => void } | null = null;
let supervisor: ReturnType<typeof createBotSupervisor> | null = null;
// Loopback HTTP server serving persona skin PNGs to
// CustomSkinLoader on the host's MC client. Bound on boot (port 0 → OS-chosen
// ephemeral) so the supervisor + IPC layer can hand the baseUrl out via the
// injected closures below.
let skinServer: { baseUrl: string; port: number; stop: () => Promise<void> } | null = null;
// Loopback HTTP server that handles Supabase auth-callback redirects
// (email verification in plan 10-04; Google OAuth in plan 10-05). Bound on
// a fixed port (54321) to localhost only. Lifecycle joined to the
// before-quit cleanup chain.
let loopbackAuthServer: { url: string; stop: () => Promise<void> } | null = null;

function preloadPath(): string {
  // electron-vite outputs preload to dist/preload/index.cjs relative to dist/main/index.js.
  // .cjs extension is required because package.json sets "type": "module", which would
  // otherwise force Node to load the preload as ESM and crash on its require() calls.
  return path.join(__dirname, '../preload/index.cjs');
}

function rendererTarget(): string {
  // electron-vite sets ELECTRON_RENDERER_URL in dev (http://localhost:<port>)
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  return path.join(__dirname, '../renderer/index.html');
}

function broadcastLan(state: LanState): void {
  latestLanState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.lan.state, state);
  }
}

function broadcastStatus(status: BotStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.status, status);
  }
}

/**
 * Phase 15 (D-10/VIS-03): forward the bot's vision-capability push to the
 * renderer over the dedicated `vision:capability` channel (parallel to
 * broadcastStatus). The renderer holds it in useUiStore.visionCapable so the
 * Settings auto-render toggle (15-05) can disable itself for a non-VLM provider.
 */
function broadcastVisionCapability(cap: VisionCapability): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.vision.capability, cap);
  }
}

function broadcastLog(batch: LogBatch): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.logBatch, batch);
  }
}

// Wizard install progress push channel. The IPC handler
// for `wizard:install` forwards each `WizardProgressEvent` through here so
// the renderer's `window.sei.onWizardProgress(...)` subscription fires.
function broadcastWizardProgress(ev: WizardProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.wizard.progress, ev);
  }
}

// Persona-expansion streaming progress push channel. The chars:save handler
// forwards each ExpansionProgressEvent through here so the renderer's
// `window.sei.onExpansionProgress(...)` subscription drives the creation
// progress bar.
function broadcastExpansionProgress(ev: ExpansionProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.chars.expansionProgress, ev);
  }
}

function getLanPort(): number | null {
  return latestLanState.kind === 'connected' ? latestLanState.port : null;
}

function getLanMotd(): string | null {
  return latestLanState.kind === 'connected' ? latestLanState.motd : null;
}

async function bootstrap(): Promise<void> {
  // 0. Auth foundation — wire safeStorage-backed session storage into the
  //    Supabase client BEFORE any auth IPC handler can call getClient().
  //    This is the only legal point in the lifecycle to call setStorageAdapter
  //    (plan 10-01 throws SUPABASE_CLIENT_ALREADY_CREATED if called later).
  {
    const { setStorageAdapter } = await import('./auth/supabaseClient');
    const { createSessionStorageAdapter } = await import('./auth/sessionStore');
    setStorageAdapter(createSessionStorageAdapter());
  }

  // 0a. Per-profile partitioning (260603) — determine the active scope from
  //     the persisted Supabase session BEFORE any per-account store is read or
  //     written. getSession() reads the storage adapter wired above and makes
  //     no network call in supabase-js v2. Signed in at boot → the account's
  //     UUID profile owns the existing data; signed out → the anonymous
  //     'local' profile. The auth-event subscription (step 5b) re-points the
  //     scope on any later sign-in/out/swap.
  {
    const { setActiveScope } = await import('./paths');
    let bootScope: string | null = null;
    try {
      const { getClient } = await import('./auth/supabaseClient');
      const { data: { session } } = await getClient().auth.getSession();
      bootScope = session?.user?.id ?? null;
    } catch (err) {
      logger.warn(`boot scope detection failed, defaulting to local: ${(err as Error).message}`);
    }
    setActiveScope(bootScope);
    logger.info(`active profile scope: ${bootScope ?? 'local'}`);
  }

  // 0b. One-shot global→profile partition. Relocates a pre-existing install's
  //     global per-account data (config, characters, skins, portraits, memory,
  //     api key, sync queue, trackers) into the scope set above. Idempotent via
  //     profiles-partitioned.json. MUST run BEFORE the legacy migrations and
  //     default-seeding below so they operate on the profile-scoped layout.
  try {
    const { migrateGlobalToProfile } = await import('./profile/partitionMigration');
    await migrateGlobalToProfile();
  } catch (err) {
    logger.warn(`partition migration failed: ${(err as Error).message}`);
  }

  // 1. Migration before any character is summoned (D-10)
  try { await runFirstLaunchMigration(); }
  catch (err) { logger.warn(`migration failed: ${(err as Error).message}`); }

  // 1a. Slug→UUID rename (Phase 11 D-23). Idempotent via
  //     <userData>/migration-uuid-rename.json. MUST run BEFORE botSupervisor
  //     is wired (Pitfall 7: rename mid-summon would corrupt skinServer
  //     state) and BEFORE any cloud-mirror call could fire (Plan 11-07/08
  //     gate on isCloudWriteAllowed()). Runs AFTER runFirstLaunchMigration
  //     so a migrated sui/lyra/clawd carries its new UUID downstream into
  //     the seed step.
  try { await runUuidRenameMigration(); }
  catch (err) { logger.warn(`uuid-rename migration failed: ${(err as Error).message}`); }

  // 1b. Seed shipped default characters (sui/lyra/clawd). Idempotent
  // via defaults-seeded.json so user deletions persist. Runs after the
  // migration so a CLI-cloned `sui` wins over the shipped default if
  // both paths fire.
  try { await seedDefaultCharacters(); }
  catch (err) { logger.warn(`seedDefaultCharacters failed: ${(err as Error).message}`); }

  // 1b-1. Re-assert bundled authored fields (persona, metadata, skin, …) onto
  // already-seeded defaults so an older build's stale copy is refreshed — e.g.
  // Sui regaining her current persona + Agentic proactiveness on installs that
  // first seeded her before those shipped. No-op when nothing drifted. Defaults
  // are read-only in the UI, so this never clobbers user edits.
  try { await refreshSeededDefaults(); }
  catch (err) { logger.warn(`refreshSeededDefaults failed: ${(err as Error).message}`); }

  // 1b-3. Cloud-default self-heal. The signed-in→cloud default is written on the
  // sign-in TRANSITION only; a session-restore launch re-points the scope at
  // boot, so that transition never re-fires and a profile stuck on the schema
  // default 'local' (e.g. last signed in on a build predating the default) would
  // keep showing BYOK. Flip a signed-in, key-less 'local' profile to cloud-proxy
  // here. No-op for signed-out, already-cloud, or genuine BYOK (key present).
  try { const { ensureCloudDefaultForSignedIn } = await import('./apiKeyStore'); await ensureCloudDefaultForSignedIn(); }
  catch (err) { logger.warn(`ensureCloudDefaultForSignedIn failed: ${(err as Error).message}`); }

  // 1b-2. One-time backfill of the profile-wide cumulative playtime total from
  // existing characters' playtime_ms (so historical time shows in the UsageBar
  // tooltip). Idempotent via the `total_playtime_backfilled` config flag. Runs
  // after seeding (characters exist) and before botSupervisor is wired so no
  // session can race the read-modify-write.
  try {
    const { backfillTotalPlaytimeOnce } = await import('./configStore');
    await backfillTotalPlaytimeOnce();
  } catch (err) { logger.warn(`playtime backfill failed: ${(err as Error).message}`); }

  // 1c. Start the loopback skin HTTP server BEFORE any bot is
  // summoned — the bot supervisor passes the baseUrl into the bot init payload
  // (where the bot logs it for verification; CustomSkinLoader on the host's MC
  // client is the real consumer). Bind failure is non-fatal: the bot still
  // launches without custom skins, and the renderer's getSkinServerUrl IPC
  // throws SKIN_SERVER_PORT_TAKEN so the UI shows the relevant ERROR_COPY string.
  try {
    // Dev runs from a separate userData dir but shares this machine with any
    // packaged build; binding a distinct fixed port keeps the dev skin URL
    // stable and stops the two builds from starving each other onto unstable
    // ephemeral ports (the recurring "skin shows as Steve" / port-drift bug).
    skinServer = await createSkinServer(app.isPackaged ? {} : { port: SKIN_SERVER_DEV_PORT });
    logger.info(`skin server listening on ${skinServer.baseUrl}`);
  } catch (err) {
    logger.warn(`skin server failed to start: ${(err as Error).message}`);
    skinServer = null;
  }

  // 1d. Port-drift detection (now a FALLBACK / migration path).
  // The skin server normally binds a FIXED port (SKIN_SERVER_PREFERRED_PORT),
  // so its URL is stable across launches and this block is a no-op. It still
  // matters in two cases: (a) the fixed port was taken and the server fell
  // back to an ephemeral one, and (b) one-time migration of configs written
  // by an older ephemeral-port build (their stored port won't match the new
  // fixed port). If the wizard has been run before AND the current port
  // differs from the one persisted in wizardState, the CSL configs on disk
  // for previously-enabled installs point at a stale loopback URL and skins
  // won't load — rewrite them in place. Bounded by enabledInstallIds (≤ ~10);
  // each rewrite is a small atomic JSON write (≤ 1s typical).
  if (skinServer) {
    try {
      const wizardState = await loadWizardState();
      if (
        wizardState.hasRunOnce &&
        wizardState.lastSkinServerPort !== null &&
        wizardState.lastSkinServerPort !== skinServer.port
      ) {
        logger.info(
          `skin server port drift detected, rewriting ${wizardState.enabledInstallIds.length} CSL configs`,
        );
        // Lazy import — only loaded when drift is detected. Keeps the
        // bootstrap fast path (no drift on most launches) module-init free
        // of customSkinLoader's network-tracing dependencies.
        const { writeCustomSkinLoaderConfig } = await import('./customSkinLoader');
        const { scanMcInstalls } = await import('./mcInstallScan');
        // scanMcInstalls failing here used to abort the whole block via the
        // outer catch — silently leaving every CSL config frozen at a stale
        // port (the exact symptom: bot joins as Steve after a Sei restart).
        // Isolate it so the failure is logged distinctly and we don't persist
        // a new port we never actually wrote into any config.
        let installs;
        try {
          installs = await scanMcInstalls();
        } catch (err) {
          logger.warn(
            `port drift rewrite: scanMcInstalls failed (${(err as Error).message}); ` +
              `CSL configs left unchanged — skins may load from a stale port until the wizard is re-run`,
          );
          installs = null;
        }
        if (installs) {
        const byId = new Map(installs.map((i) => [i.id, i]));
        for (const installId of wizardState.enabledInstallIds) {
          const inst = byId.get(installId);
          if (!inst) {
            // User moved / deleted the MC dir between wizard runs. Skip
            // gracefully — the row will just disappear from the wizard UI
            // next time the user opens it.
            logger.warn(`port drift rewrite: install ${installId} no longer detected; skipping`);
            continue;
          }
          // Lunar installs were never written to (T3 short-circuits in
          // processOneInstall); nothing to rewrite at boot either.
          if (inst.kind === 'lunar') continue;

          // Same loader-kind decision as wizard.ts: vanilla → fabric;
          // CurseForge → detected loader (fabric or forge), default forge.
          const loaderKind: 'fabric' | 'forge' =
            inst.kind === 'vanilla' ? 'fabric' : (inst.loader === 'fabric' ? 'fabric' : 'forge');
          // 260518-o1k T5: targetDir matches the wizard's placement rule —
          // vanilla writes config into the isolated <.minecraft>/sei/ dir;
          // CurseForge writes into the instance dir (unchanged). Without
          // this, port-drift rewrites would target the OLD vanilla-shared
          // config location and the launched Sei profile would still load
          // a stale port from the new gameDir-located config.
          const targetDir =
            inst.kind === 'vanilla' ? path.join(inst.path, 'sei') : inst.path;
          try {
            await writeCustomSkinLoaderConfig({
              targetDir,
              loaderKind,
              skinServerBaseUrl: skinServer.baseUrl,
            });
            logger.info(`port drift rewrite: ${installId} → ${skinServer.baseUrl}`);
          } catch (err) {
            // Best-effort — config dir might be read-only or the install
            // might be on an unmounted drive. The user can rerun the wizard
            // from settings to fix this manually.
            logger.warn(`port drift rewrite: ${installId} failed: ${(err as Error).message}`);
          }
        }
          // Persist the new port so the next launch (if no further drift) is
          // a no-op rather than re-rewriting the same configs. Only after a
          // successful scan — otherwise we'd record a port that no config
          // actually points at.
          await saveWizardState({ ...wizardState, lastSkinServerPort: skinServer.port });
        }
      }
    } catch (err) {
      // Non-fatal — bot still launches, just the configs may be stale. User
      // can re-run the wizard from Settings to fix it manually.
      logger.warn(`port drift detection failed: ${(err as Error).message}`);
    }
  }

  // 2. Create main window
  //    Attach the sei-portrait:// request handler first so the renderer can
  //    resolve <img src="sei-portrait://…"> the moment it loads.
  registerPortraitProtocol();
  mainWindow = createMainWindow({
    preloadPath: preloadPath(),
    indexHtmlUrlOrPath: rendererTarget(),
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Replay latest LAN state on did-finish-load so freshly-loaded renderer is in sync.
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.lan.state, latestLanState);
    }
  });

  // 3. LAN watcher (D-21 — single instance for the whole app session)
  lanWatcherHandle = watchLan({
    onUpdate: broadcastLan,
    staleMs: 3000,
  });

  // 4. Bot supervisor
  supervisor = createBotSupervisor({
    getLanPort,
    getLanMotd,
    sendStatus: broadcastStatus,
    // Phase 15 (D-10/VIS-03): forward the bot's vision-capability push to the
    // renderer over the dedicated vision:capability channel.
    sendVisionCapability: broadcastVisionCapability,
    sendLog: broadcastLog,
    // Hand the skin server's baseUrl into each bot init payload.
    // Closure-via-getter so a later restart of the skin server (port-drift
    // recovery) is observable by subsequent summons.
    getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null,
    // Pre-flight credit gate (quick/260605): block a cloud-proxy summon when
    // the account's ledger is exhausted so the bot never joins the world to
    // idle. cloudCreditsDepleted self-guards (no-session / BYOK / errors →
    // false), so the dynamic import is the only thing we defend against here.
    cloudCreditsDepleted: async () => {
      try {
        const { cloudCreditsDepleted } = await import('./cloud/proxyClient');
        return await cloudCreditsDepleted();
      } catch {
        return false;
      }
    },
    emitHardStop: emitCreditsHardStop,
  });

  // 4b. Per-profile scope switcher (260603). Re-points the local data scope
  //     and tears down the bot when the auth-event subscription (step 5b)
  //     reports a sign-in / sign-out / account swap. Wired here so it has the
  //     supervisor + window before initAuthState can fire an auth event.
  {
    const { initProfileScope } = await import('./profile/profileScope');
    initProfileScope({ supervisor, getMainWindow: () => mainWindow });
  }

  // 5. IPC handlers
  registerIpcHandlers({
    supervisor,
    getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null,
    // wizard:install handler forwards per-step progress events here; this
    // closure pipes them to the renderer via the wizard:progress push channel.
    sendWizardProgress: broadcastWizardProgress,
    // chars:save forwards streaming persona-expansion progress here; piped to
    // the renderer via the chars:expansion-progress push channel.
    sendExpansionProgress: broadcastExpansionProgress,
    getLanState: () => latestLanState,
  });

  // 5b. Auth state broadcast (initial replay + Supabase auth-event
  //     subscription). Runs AFTER registerIpcHandlers so the auth IPC surface
  //     is already bound when the first state push fires.
  {
    const { initAuthState } = await import('./auth/authState');
    try { await initAuthState(mainWindow); }
    catch (err) { logger.warn(`auth state init failed: ${(err as Error).message}`); }
  }

  // 5b-bis. JWT bridge (plan 10-06). Pushes session.access_token to the bot
  //          supervisor on every relevant Supabase auth event, and null on
  //          SIGNED_OUT. Runs AFTER createBotSupervisor (5b uses `supervisor`)
  //          so updateJwt() has a target. Bind failure is non-fatal —
  //          summons still work, just without an initial JWT seeded in
  //          (Phase 13 will surface its own error if cloud-AI is selected).
  try {
    const { initJwtBridge } = await import('./auth/jwtBridge');
    await initJwtBridge(supervisor);
  } catch (err) {
    logger.warn(`jwt bridge init failed: ${(err as Error).message}`);
  }

  // 5c. Loopback auth-callback HTTP server (plan 10-04 UAT fix #5).
  //     Handles Supabase's email-verification redirect (and, in plan 10-05,
  //     the Google OAuth redirect). MUST start AFTER initAuthState so the
  //     onAuthStateChange subscription is in place before any inbound
  //     exchangeCodeForSession can fire SIGNED_IN.
  //
  //     NOTE: the Supabase project's Site URL (or Additional Redirect URLs)
  //     must include http://localhost:54321/auth/callback for the email link
  //     to point here. See .planning/phases/10-auth-foundation/deferred-items.md.
  //
  //     Bind failure is non-fatal: the user can still sign in (the session
  //     IPC handlers work), but verification emails will keep redirecting
  //     to whatever Site URL is configured in Supabase.
  try {
    const { startLoopbackCallback } = await import('./auth/loopbackCallback');
    loopbackAuthServer = await startLoopbackCallback({
      logger,
      getMainWindow: () => mainWindow,
    });
  } catch (err) {
    logger.warn(`auth loopback callback failed to start: ${(err as Error).message}`);
    loopbackAuthServer = null;
  }

  // In-app updater (quick/260604-uoy, reverses D-63). initUpdater runs the
  // launch what's-new check (Flow D) immediately and kicks off the startup
  // auto-check (Flow A). In dev it's a no-op (autoUpdater is unpackaged-unsafe);
  // the manual "Check for updates" + download/install IPC handlers route into
  // the same updater module via ipc.ts. No artificial 8s delay needed —
  // electron-updater's check is already async + non-blocking.
  initUpdater({ getMainWindow: () => mainWindow });

  // 6. Linux fallback warning (RESEARCH Pitfall 3)
  if (process.platform === 'linux' && safeStorageBackendKind() === 'basic_text') {
    logger.warn(
      'safeStorage backend is basic_text — API key encryption is plaintext-with-hardcoded-key on this system. ' +
      'Renderer will surface KEYCHAIN_FALLBACK_PLAINTEXT warning to the user.',
    );
  }
}

// Single-instance lock — second launch focuses existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    bootstrap().catch((err) => {
      logger.error(`bootstrap failed: ${(err as Error).message}`);
      app.exit(1);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
        bootstrap().catch((err) => logger.error(`re-bootstrap failed: ${(err as Error).message}`));
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async (e) => {
    if (!supervisor && !lanWatcherHandle && !skinServer && !loopbackAuthServer) return; // already shut down
    e.preventDefault();
    try { if (supervisor) await supervisor.shutdown(); } catch (err) { logger.warn(`supervisor shutdown failed: ${(err as Error).message}`); }
    try { if (lanWatcherHandle) lanWatcherHandle.stop(); } catch { /* best-effort */ }
    // Close the skin server's TCP listener so the port is
    // freed promptly. server.close drains in-flight requests before resolving.
    try { if (skinServer) await skinServer.stop(); } catch { /* best-effort */ }
    // Same for the auth loopback callback server — release port 54321.
    try { if (loopbackAuthServer) await loopbackAuthServer.stop(); } catch { /* best-effort */ }
    supervisor = null;
    lanWatcherHandle = null;
    skinServer = null;
    loopbackAuthServer = null;
    app.exit(0);
  });
}
