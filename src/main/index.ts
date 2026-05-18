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
import { registerIpcHandlers } from './ipc';
import { watchLan } from './lanWatcher';
import { createBotSupervisor } from './botSupervisor';
import { createSkinServer } from './skinServer';
import { runFirstLaunchMigration } from './migration';
import { seedDefaultCharacters } from './defaultCharacters';
import { backendKind } from './apiKeyStore';
import { IpcChannel, type LanState, type BotStatus, type LogBatch } from '../shared/ipc';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
  error: (m: string) => console.error(`[sei] ${m}`),
};

let mainWindow: BrowserWindow | null = null;
let latestLanState: LanState = { kind: 'not_connected' };
let lanWatcherHandle: { stop: () => void } | null = null;
let supervisor: ReturnType<typeof createBotSupervisor> | null = null;
// Phase 9 (09-02): loopback HTTP server serving persona skin PNGs to
// CustomSkinLoader on the host's MC client. Bound on boot (port 0 → OS-chosen
// ephemeral) so the supervisor + IPC layer can hand the baseUrl out via the
// injected closures below.
let skinServer: { baseUrl: string; port: number; stop: () => Promise<void> } | null = null;

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

function broadcastLog(batch: LogBatch): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.bot.logBatch, batch);
  }
}

function getLanPort(): number | null {
  return latestLanState.kind === 'connected' ? latestLanState.port : null;
}

async function bootstrap(): Promise<void> {
  // 1. Migration before any character is summoned (D-10)
  try { await runFirstLaunchMigration(); }
  catch (err) { logger.warn(`migration failed: ${(err as Error).message}`); }

  // 1b. Seed shipped default characters (sui/mochineko/clawd). Idempotent
  // via defaults-seeded.json so user deletions persist. Runs after the
  // migration so a CLI-cloned `sui` wins over the shipped default if
  // both paths fire.
  try { await seedDefaultCharacters(); }
  catch (err) { logger.warn(`seedDefaultCharacters failed: ${(err as Error).message}`); }

  // 1c. Phase 9 (09-02): start the loopback skin HTTP server BEFORE any bot is
  // summoned — the bot supervisor passes the baseUrl into the bot init payload
  // (where the bot logs it for verification; CustomSkinLoader on the host's MC
  // client is the real consumer). Bind failure is non-fatal: the bot still
  // launches without custom skins, and the renderer's getSkinServerUrl IPC
  // throws SKIN_SERVER_PORT_TAKEN so the UI shows the relevant ERROR_COPY string.
  try {
    skinServer = await createSkinServer({});
    logger.info(`skin server listening on ${skinServer.baseUrl}`);
  } catch (err) {
    logger.warn(`skin server failed to start: ${(err as Error).message}`);
    skinServer = null;
  }

  // 2. Create main window
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
    sendStatus: broadcastStatus,
    sendLog: broadcastLog,
    // Phase 9 (09-02): hand the skin server's baseUrl into each bot init
    // payload. Closure-via-getter so a later restart of the skin server (Plan 05
    // port-drift recovery) is observable by subsequent summons.
    getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null,
  });

  // 5. IPC handlers
  registerIpcHandlers({
    supervisor,
    getSkinServerBaseUrl: () => skinServer?.baseUrl ?? null,
  });

  // 6. Linux fallback warning (RESEARCH Pitfall 3)
  if (process.platform === 'linux' && backendKind() === 'basic_text') {
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
    if (!supervisor && !lanWatcherHandle && !skinServer) return; // already shut down
    e.preventDefault();
    try { if (supervisor) await supervisor.shutdown(); } catch (err) { logger.warn(`supervisor shutdown failed: ${(err as Error).message}`); }
    try { if (lanWatcherHandle) lanWatcherHandle.stop(); } catch { /* best-effort */ }
    // Phase 9 (09-02): close the skin server's TCP listener so the port is
    // freed promptly. server.close drains in-flight requests before resolving.
    try { if (skinServer) await skinServer.stop(); } catch { /* best-effort */ }
    supervisor = null;
    lanWatcherHandle = null;
    skinServer = null;
    app.exit(0);
  });
}
