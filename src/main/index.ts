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
import { app, BrowserWindow, session, systemPreferences } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMainWindow } from './windowChrome';
import { registerIpcHandlers, emitCreditsHardStop } from './ipc';
import { isAnalyticsActive, shutdownAnalytics, capture } from './analytics';
import { watchLan } from './lanWatcher';
import { createBotSupervisor } from './botSupervisor';
import { isCallActive, wasCallRecentlyActive, activeCallIds, clearAllCalls } from './voice/callState';
import { initCallOverlay, closeCallOverlay } from './callOverlay';
import { initUpdater } from './updater';
import { createSkinServer, SKIN_SERVER_DEV_PORT } from './skinServer';
import { runFirstLaunchMigration, runUuidRenameMigration, runDefaultsToWorldMigration } from './migration';
import { safeStorageBackendKind } from './apiKeyStore';
import { loadWizardState, saveWizardState } from './wizardStateStore';
import { registerPortraitScheme, registerPortraitProtocol } from './portraitProtocol';
import { maybeOfferMoveToApplications, cleanupRelocationLeftover } from './relocate';
import { IpcChannel, type LanState, type BotStatus, type LogBatch, type WizardProgressEvent, type ExpansionProgressEvent, type GenProgressEvent, type VisionCapability, type ChatMessage } from '../shared/ipc';

// Lock the app name early so app.getPath('userData') resolves to
// "Sei" (packaged) or "Sei Dev" (electron-vite dev) — keeping dev state
// (your private personas) out of the shipped build.
//
// DEV-ONLY: SEI_DEV_USERDATA overrides the dev userData/app name so two dev
// builds (e.g. this UI-revisions worktree + a separate MC-connecting one) can
// run side by side. Each distinct name gets its own userData dir, which means a
// distinct single-instance lock — otherwise the second launch quits. Defaults
// to "Sei Dev" so normal `npm run dev` is unchanged.
const devUserData = process.env.SEI_DEV_USERDATA?.trim() || 'Sei Dev';
app.setName(app.isPackaged ? 'Sei' : devUserData);
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), devUserData));
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
let latestLanState: LanState = { kind: 'closed' };
let lanWatcherHandle: ReturnType<typeof watchLan> | null = null;
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
  // Transition log (260703): broadcastLan only fires on CHANGE (the watcher's
  // emit gate), so this is one line per flip — enough to reconstruct exactly
  // what the companion/pill believed at any moment when triaging "Marv says my
  // open world is closed" reports.
  console.log(
    `[sei/lan] world ${state.kind}` +
    (state.kind === 'open' ? ` (port=${state.port}, motd=${JSON.stringify(state.motd)})` : ''),
  );
  latestLanState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.lan.state, state);
  }
}

/**
 * Current per-character bot status, maintained by broadcastStatus (idle drops
 * the key, everything else upserts — same shape the renderer keeps). Backs the
 * bot:get-statuses snapshot pull: status pushes only fire on TRANSITIONS, so a
 * renderer that (re)subscribes after 'online' — reload, dev HMR, late mount —
 * would otherwise never learn a session is live (260703).
 */
const currentStatuses = new Map<string, BotStatus>();

/**
 * Characters whose bot is fully ONLINE (spawned in-world), so a chat message can
 * be safely routed into that live session (task 4). A merely-'connecting' session
 * must NOT be routed to — it may never spawn, which would strand the chat's
 * typing indicator waiting for a reply that never comes.
 */
const onlineIds = new Set<string>();

/** Push a chat message (bot reply while in-game, or a system line) to the UI. */
function pushChatMessage(characterId: string, message: ChatMessage): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.chat.message, { characterId, message });
  }
}

/** Persist a pushed chat message to the transcript, then surface it live. */
async function appendChatMessage(characterId: string, message: ChatMessage): Promise<void> {
  try {
    const { appendMessage } = await import('./chat/chatStore');
    await appendMessage(characterId, message);
  } catch (err) {
    console.warn(`[sei] failed to persist pushed chat message: ${(err as Error).message}`);
  }
  pushChatMessage(characterId, message);
}

// Play-session tracking: when a bot goes online we stamp the moment; when it
// leaves (idle/error) we post a Discord-style "You and X played Minecraft for Y"
// system row into that character's chat transcript. First-online wins so a
// mid-session backend-switch re-emit doesn't reset the clock.
const playStartedAt = new Map<string, number>();

/** Human phrase for a play-session length ("a few seconds" / "N minutes" / "N hours"). */
function formatPlayDuration(ms: number): string {
  if (ms < 60_000) return 'a few seconds';
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** Post the "You and <name> played Minecraft for <duration>" system row. */
async function emitPlaySession(characterId: string, durationMs: number): Promise<void> {
  let name = 'your companion';
  try {
    const { getCharacter } = await import('./characterStore');
    const c = await getCharacter(characterId);
    if (c?.name) name = c.name;
  } catch {
    /* fall back to the generic name */
  }
  await appendChatMessage(characterId, {
    id: randomUUID(),
    role: 'system',
    text: `You and ${name} played Minecraft for ${formatPlayDuration(durationMs)}.`,
    ts: Date.now(),
    event: { kind: 'play', game: 'minecraft', durationMs },
  });
}

/** Voice calls (260705): post the "You and <name> called for <duration>" row.
 *  Fired from the voice:call-state hang-up when the renderer reports how long
 *  the call was actually live (never for calls that failed to connect). */
async function emitCallSession(characterId: string, durationMs: number): Promise<void> {
  let name = 'your companion';
  try {
    const { getCharacter } = await import('./characterStore');
    const c = await getCharacter(characterId);
    if (c?.name) name = c.name;
  } catch {
    /* fall back to the generic name */
  }
  await appendChatMessage(characterId, {
    id: randomUUID(),
    role: 'system',
    text: `You and ${name} called for ${formatPlayDuration(durationMs)}.`,
    ts: Date.now(),
    event: { kind: 'call', durationMs },
  });
}

/** Voice calls (260705): the companion hung up (end_call) — clear main-side
 *  call state and tell the renderer, which finishes speaking the goodbye then
 *  tears the call down (and reports connectedMs back for the call-log row). */
function endVoiceCallFromCompanion(characterId: string): void {
  void (async () => {
    try {
      const { setCallActive } = await import('./voice/callState');
      setCallActive(characterId, false);
    } catch { /* state module unavailable — renderer teardown still proceeds */ }
  })();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.voice.callEnded, { characterId });
  }
}

// 260703: the "joined your world" system line was removed — the floating
// SummonedWidget is the live-session surface, so the chat row was redundant.

/**
 * Party redesign §2/§5: push the companion's current world action to the
 * renderer over `bot:action`. `name` null clears the verb (loop idle / session
 * ended). The renderer maps name+args to a presence phrase.
 */
function broadcastAction(
  characterId: string,
  name: string | null,
  args: Record<string, unknown> | undefined,
  ts: number,
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.action, { characterId, name, args, ts });
  }
}

function broadcastStatus(status: BotStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.status, status);
  }
  const id = (status as { characterId?: string }).characterId;
  if (!id) return;
  // A TRANSIENT error (BotStatus.error.transient) is advisory: the session is
  // still live (e.g. a mid-session backend switch to local with no key — the
  // bot stays connected and just 401s). It must NOT be treated as a session
  // end. We still upsert it into currentStatuses and forward it to the renderer
  // above (the model row should surface the "no key" error), but we leave
  // onlineIds and playStartedAt untouched so chat keeps routing to the live bot
  // and the eventual REAL end still reports the right total duration (260703).
  const transientError = status.kind === 'error' && status.transient === true;
  // Snapshot map for bot:get-statuses — mirror the renderer's summons-map
  // semantics ('idle' means the session is gone). A transient error still
  // upserts (renderer keeps showing the error over the still-live session).
  if (status.kind === 'idle') currentStatuses.delete(id);
  else currentStatuses.set(id, status);
  if (transientError) return;
  // Track online-ness for chat routing (only route to a spawned bot).
  if (status.kind === 'online') onlineIds.add(id);
  else onlineIds.delete(id);
  // Play-session bookkeeping: stamp first-online, and on the terminal
  // idle/error post a "played for X" row (only if the bot was actually live).
  if (status.kind === 'online') {
    if (!playStartedAt.has(id)) {
      playStartedAt.set(id, Date.now());
      // Analytics (260707): first-online is the "bot reached the world" signal.
      capture('character_summoned', { character_id: id });
    }
  } else if (status.kind === 'error' || status.kind === 'idle') {
    const startedAt = playStartedAt.get(id);
    if (startedAt !== undefined) {
      playStartedAt.delete(id);
      const durationMs = Date.now() - startedAt;
      void emitPlaySession(id, durationMs);
      capture('bot_session_ended', { character_id: id, duration_ms: durationMs });
    } else if (status.kind === 'error') {
      // Terminal error with no live session ⇒ the summon never reached the
      // world. Record the failure reason (an ErrorClass enum, never content).
      capture('summon_failed', { character_id: id, reason: String((status as { error?: unknown }).error ?? 'unknown') });
    }
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

// 260703 procgen — unique-companion generation stage-progress push channel. The
// gen:start handler forwards each GenProgressEvent through here so the renderer's
// `window.sei.onGenProgress(...)` subscription drives the generation ritual UI.
function broadcastGenProgress(ev: GenProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.gen.progress, ev);
  }
}

function getLanPort(): number | null {
  return latestLanState.kind === 'open' ? latestLanState.port : null;
}

function getLanMotd(): string | null {
  return latestLanState.kind === 'open' ? latestLanState.motd : null;
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

  // 1b. 260707: sui/lyra/marv ship NO bundle baseline. They are ordinary
  // user-owned public World characters, delivered like any other public
  // character (World tab + cache-on-demand from their cloud rows). Fresh
  // installs hold no local copy at all; the only local-copy population left is
  // pre-0.4 installs that once seeded `is_default:true` copies.
  //
  // 1b-1. Convert any leftover local `is_default` copy of the three into the
  // normal owned/public World shape (is_default:false, owner =
  // DEFAULT_CHARACTERS_OWNER, kind:'custom', cloud_updated_at:null). After the
  // flip, cache-on-demand's refreshFromCloud pulls the authoritative persona /
  // portrait / skin from the cloud row on next open — no bundle re-assert
  // needed. Idempotent (state-gated heal + config.defaults_to_world_migrated);
  // a no-op on a fresh install that has no is_default files.
  try { await runDefaultsToWorldMigration(); }
  catch (err) { logger.warn(`defaults→world migration failed: ${(err as Error).message}`); }

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

  // 1c. Microphone permission (voice calls, 260707). Electron's default
  //     permission handler DENIES `media` requests in a packaged app, so
  //     getUserMedia in the renderer would reject before macOS TCC is ever
  //     consulted. Grant mic (and the check) for our own renderer content, and
  //     on macOS proactively trigger the OS prompt so the "allow microphone"
  //     dialog appears at a sane time rather than mid-call. Pairs with the
  //     NSMicrophoneUsageDescription + audio-input entitlement in the packaged
  //     build (see electron-builder.yml / build/entitlements.mac.plist).
  //     `clipboard-sanitized-write` must stay in the allowlist: installing these
  //     handlers replaces Electron's grant-all default, so without it every
  //     navigator.clipboard.writeText (all copy buttons) rejects with
  //     NotAllowedError. Clipboard *read* stays denied.
  {
    const allowMedia = (permission: string): boolean =>
      permission === 'media' ||
      permission === 'audioCapture' ||
      permission === 'microphone' ||
      permission === 'clipboard-sanitized-write';
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(allowMedia(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
    if (process.platform === 'darwin') {
      try {
        if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
          void systemPreferences.askForMediaAccess('microphone').catch(() => {});
        }
      } catch {
        /* older Electron / non-mac path — getUserMedia still prompts on first use */
      }
    } else if (process.platform === 'win32') {
      // 260709 — Windows never shows a per-app mic prompt for desktop apps:
      // getUserMedia either works silently or fails because the OS privacy
      // toggle ("Let desktop apps access your microphone") is off. There is
      // no askForMediaAccess on Windows, so we can only read the status and
      // leave a loud diagnostic; the renderer's call-error copy tells the
      // user which Settings page fixes it.
      try {
        const micStatus = systemPreferences.getMediaAccessStatus('microphone');
        if (micStatus !== 'granted') {
          logger.warn(
            `microphone access status: ${micStatus}. Voice calls will fail until ` +
              `"Let desktop apps access your microphone" is enabled in Windows ` +
              `Settings (Privacy & security > Microphone).`,
          );
        }
      } catch {
        /* older Electron — getMediaAccessStatus unavailable; nothing to log */
      }
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

  // Always-on-top call overlay (260706): a second frameless window driven by the
  // renderer's voice:overlay-set pushes. Init with the same preload + renderer
  // target so it can load the overlay-mode bundle.
  initCallOverlay({ preloadPath: preloadPath(), rendererUrlOrPath: rendererTarget() });

  // Replay latest LAN state on did-finish-load so freshly-loaded renderer is in sync.
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.lan.state, latestLanState);
    }
  });

  // Voice calls (260705): a call cannot survive its renderer — the mic and
  // audio playback live there. Sweep the call flags on any main-frame
  // navigation (incl. reload/HMR) and on renderer death, telling any live bot
  // to resume normal in-game chat; without this a mid-call reload leaves the
  // bot muted in minecraft chat forever.
  const sweepVoiceCalls = (): void => {
    for (const id of activeCallIds()) supervisor?.setVoiceCall(id, false);
    clearAllCalls();
    // The overlay belongs to the call the (now-gone) renderer was driving.
    closeCallOverlay();
  };
  mainWindow.webContents.on('did-navigate', sweepVoiceCalls);
  mainWindow.webContents.on('render-process-gone', sweepVoiceCalls);

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
    // Task 4 — a live in-game bot replied to a message routed in from the chat.
    // Persist it to the transcript and surface it live (same as a normal reply).
    onBotChat: (characterId, text) => {
      const trimmed = (text ?? '').trim();
      if (!trimmed) return;
      void appendChatMessage(characterId, {
        id: randomUUID(),
        role: 'companion',
        text: trimmed,
        ts: Date.now(),
        // An in-game say() routed up while a call is open (or in the brief grace
        // after hang-up) is a call line: SPOKEN and hidden from the chat thread
        // like every other call line (ChatMessage.voice). The grace stops a reply
        // the bot began mid-call but finished a beat after hang-up from leaking
        // into the DM (the "she answered in DM after the call ended" report).
        ...(wasCallRecentlyActive(characterId) ? { voice: true } : {}),
      });
    },
    // Party redesign §2/§5 — the live bot's current world action (verb line).
    onBotAction: broadcastAction,
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
    // Voice calls (260705): lets summon-ready re-apply an open call to a bot
    // that spawned mid-call (launch()-from-a-call handoff).
    isVoiceCallActive: isCallActive,
    // Voice calls (260705): the in-game bot called end_call() — hang up the
    // player's call (the renderer finishes speaking the goodbye first).
    onCallEndRequested: endVoiceCallFromCompanion,
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
    // Voice streaming (260706): the streaming chat turn emits each sentence here
    // (already persisted) so it reaches the renderer — and TTS — immediately.
    pushChatMessage,
    getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null,
    // wizard:install handler forwards per-step progress events here; this
    // closure pipes them to the renderer via the wizard:progress push channel.
    sendWizardProgress: broadcastWizardProgress,
    // chars:save forwards streaming persona-expansion progress here; piped to
    // the renderer via the chars:expansion-progress push channel.
    sendExpansionProgress: broadcastExpansionProgress,
    // gen:start forwards unique-companion generation stage ticks here; piped to
    // the renderer via the gen:progress push channel.
    sendGenProgress: broadcastGenProgress,
    getLanState: () => latestLanState,
    // 260703: run one detection pass right now (refreshes latestLanState via
    // the watcher's emit path). The chat turn awaits this before building the
    // prompt so the companion answers "is my world open?" from live truth —
    // the player often messages seconds after clicking "Open to LAN", inside
    // the 2s poll window, and the stale 'closed' had Marv insisting an open
    // world was "not broadcasting".
    refreshLanState: async () => {
      try { await lanWatcherHandle?.checkNow(); } catch { /* best-effort */ }
    },
    // 260703: like refreshLanState but RETURNS the fresh state — backs the
    // `lan:check-now` channel the summon click awaits. checkNow's emit path
    // also refreshes latestLanState as a side effect, so the getLanPort() the
    // actual summon reads is fresh by the time it lands. Falls back to the
    // cached snapshot on error.
    checkLanNow: async () => {
      try {
        return (await lanWatcherHandle?.checkNow()) ?? latestLanState;
      } catch {
        return latestLanState;
      }
    },
    // Snapshot pull for the renderer's summons map (see broadcastStatus).
    getBotStatuses: () => [...currentStatuses.values()],
    // Task 4 — only route chat into a bot that's fully spawned in-world.
    isSessionOnline: (id) => onlineIds.has(id),
    // A non-blocking chat-launched join failed — tell the COMPANION (task 2,
    // 260702): its last message said "hopping in", so without a correcting turn
    // its own history claims it joined and it later insists "i'm already in".
    // sendLaunchFailedTurn runs a short persona-voiced turn (persisted), and we
    // push the replies live. No canned system row (task 7) — the companion
    // reports the failure in its own words.
    notifyLaunchFailed: (id, reason) => {
      void (async () => {
        try {
          const { sendLaunchFailedTurn } = await import('./chat/chatService');
          const replies = await sendLaunchFailedTurn(id, reason);
          for (const r of replies) pushChatMessage(id, r);
        } catch (err) {
          console.warn(`[sei] launch-failed companion turn failed: ${(err as Error).message}`);
        }
      })();
    },
    // Voice calls (260705): a live call ended — post the "You and X called for
    // Y" system row (renderer supplies how long audio actually flowed).
    notifyCallEnded: (id, connectedMs) => {
      void emitCallSession(id, connectedMs);
    },
    // Voice calls (260705): the call went live — companion greets first. An
    // in-game session takes it over the port (say() routes into the call); an
    // idle character runs a standalone greeting turn whose replies are pushed
    // (and spoken by the renderer's TTS hook).
    greetVoiceCall: (id, peers = []) => {
      // A solo in-game session greets over the port (say() routes to the call).
      // On a group call we always run the standalone greeting turn so the joiner
      // can name the room — the in-game greet path has no group framing.
      if (peers.length === 0 && onlineIds.has(id) && supervisor?.greetVoiceCall(id)) return;
      void (async () => {
        try {
          const { sendVoiceGreetingTurn } = await import('./chat/chatService');
          const replies = await sendVoiceGreetingTurn(id, peers);
          for (const r of replies) pushChatMessage(id, r);
        } catch (err) {
          console.warn(`[sei] voice greeting turn failed: ${(err as Error).message}`);
        }
      })();
    },
  });

  // 5b. Auth state broadcast (initial replay + Supabase auth-event
  //     subscription). Runs AFTER registerIpcHandlers so the auth IPC surface
  //     is already bound when the first state push fires.
  {
    const { initAuthState } = await import('./auth/authState');
    try { await initAuthState(mainWindow); }
    catch (err) { logger.warn(`auth state init failed: ${(err as Error).message}`); }
  }

  // 5b-ii. Product analytics (260707). Init AFTER initAuthState so the backend
  //         kind is settled; the app_opened event is the session-start signal.
  //         Never throws — analytics must not block startup.
  try {
    const { initAnalytics, capture } = await import('./analytics');
    await initAnalytics();
    capture('app_opened');
  } catch (err) {
    logger.warn(`analytics init failed: ${(err as Error).message}`);
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

// Voice calls (260705): expose SharedArrayBuffer in the renderer so the local
// Whisper dictation (onnxruntime WASM in a worker) can run MULTI-threaded —
// single-threaded transcription is the longest fixed cost in the voice-reply
// loop. Chromium normally gates SAB behind cross-origin isolation (COOP/COEP
// headers), which our file://-served renderer can't opt into; the feature
// flag re-exposes it. Safe here: the renderer only loads our own bundled
// content, never arbitrary web pages. Must be set before app ready.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

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
    // First thing on launch (macOS only): offer to relocate to /Applications so
    // auto-update works. If accepted, the app quits + relaunches from there, so
    // skip the rest of startup. No-op on Windows/Linux and in dev. See relocate.ts.
    if (maybeOfferMoveToApplications()) return;

    // If a prior launch moved us here from ~/Downloads, trash the leftover copy
    // now that we're running from /Applications. Best-effort, never blocks.
    cleanupRelocationLeftover();

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
    if (!supervisor && !lanWatcherHandle && !skinServer && !loopbackAuthServer && !isAnalyticsActive()) return; // already shut down
    e.preventDefault();
    // Flush buffered analytics first so queued events survive the quit.
    try { await shutdownAnalytics(); } catch (err) { logger.warn(`analytics shutdown failed: ${(err as Error).message}`); }
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
