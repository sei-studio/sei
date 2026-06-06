/**
 * In-app updater (quick/260604-uoy) — reverses D-63.
 *
 * Replaces the notify-and-redirect updateChecker.ts. Drives `electron-updater`
 * over the GitHub Releases channel, with update POLICY (changelog + mandatory
 * timing) carried by the existing https://sei.gg/version.json side-channel.
 *
 * `electron-updater` MUST only be loaded behind `app.isPackaged` — its
 * `autoUpdater` throws when the app is not packaged (no app-update.yml). In dev
 * the pure policy fns still run (deriveLevel/etc), but `autoUpdater` is never
 * touched and the what's-new check is skipped entirely (app.getVersion()
 * returns a dev string, and there's no install to update). The
 * `electron-updater` import lives ONLY in this file — never in updatePolicy.ts,
 * the renderer, or any pure-fn module.
 *
 * Flows (see PLAN.md):
 *   A. Startup auto-check — checkForUpdates() → on update-available:
 *      optional → push app:update-available (no download); mandatory →
 *      downloadUpdate() silently + stash pending; on downloaded honor apply.
 *   B. Settings "Check for updates" — manual check, surfaces checking/
 *      not-available/available/error to the renderer.
 *   C. Optional accept — downloadUpdate(), progress ticks, then ready-to-install.
 *   D. Post-update what's-new — on launch, show stashed/ fallback changelog.
 *
 * Source:
 *   - src/main/updateChecker.ts (version.json net.request logic — ported here)
 *   - src/main/updatePolicy.ts (pure level/apply derivation)
 *   - src/main/updateStateStore.ts (device-global pending/lastSeen persistence)
 */
import { app, net, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc';
import { deriveLevel, normalizeApply, shouldShowWhatsNew, type ApplyTiming } from './updatePolicy';
import { loadUpdateState, saveUpdateState } from './updateStateStore';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const VERSION_URL = 'https://sei.gg/version.json';
const VERSION_FETCH_TIMEOUT_MS = 5000;
/** Brief window so the forced-restart overlay can paint before quitAndInstall. */
const FORCED_RESTART_DELAY_MS = 3500;

/** Parsed, validated version.json policy fields used by the updater. */
interface VersionPolicy {
  version: string;
  apply: ApplyTiming;
  changelog: string | null;
  downloadUrl: string;
}

/** Module singleton — set once by initUpdater. */
let getMainWindow: (() => BrowserWindow | null) | null = null;
/** True once autoUpdater event handlers have been attached (packaged only). */
let wired = false;
/** Lazily-resolved autoUpdater (packaged only) — typed loosely to avoid a
 *  top-level electron-updater import leaking into the unpackaged graph. */
type AutoUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};
let autoUpdater: AutoUpdater | null = null;

/**
 * The apply timing for the in-flight mandatory download, captured at
 * update-available time so the update-downloaded handler knows whether to
 * force-restart. Null when the in-flight download is the optional (consented)
 * flow.
 */
let mandatoryApply: ApplyTiming | null = null;

/* -------------------------------------------------------------------------- */
/*  version.json fetch (ported from updateChecker.ts)                          */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort fetch of https://sei.gg/version.json. Returns null on any
 * failure (no network, timeout, bad JSON, non-2xx). Backward-compatible: the
 * legacy `{version, downloadUrl, notes}` shape still parses — `changelog`
 * falls back to `notes` and `apply` defaults to `on-restart` when absent.
 */
function fetchVersionPolicy(): Promise<VersionPolicy | null> {
  return new Promise((resolve) => {
    const req = net.request({ url: VERSION_URL, method: 'GET', redirect: 'follow' });
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch {
        /* already settled */
      }
      resolve(null);
    }, VERSION_FETCH_TIMEOUT_MS);

    let body = '';
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      res.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(body) as Record<string, unknown>;
          if (typeof json?.version !== 'string') {
            resolve(null);
            return;
          }
          const changelog =
            typeof json.changelog === 'string'
              ? json.changelog
              : typeof json.notes === 'string'
                ? json.notes
                : null;
          resolve({
            version: json.version,
            apply: normalizeApply(json.apply),
            changelog,
            downloadUrl:
              typeof json.downloadUrl === 'string' ? json.downloadUrl : 'https://sei.gg/',
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Renderer push helper                                                       */
/* -------------------------------------------------------------------------- */

function send(channel: string, payload?: unknown): void {
  const win = getMainWindow?.() ?? null;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/* -------------------------------------------------------------------------- */
/*  autoUpdater wiring (packaged only)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Lazily load + configure electron-updater's autoUpdater and attach the event
 * handlers ONCE. Returns null in dev (unpackaged) — the caller must guard on
 * app.isPackaged before relying on the return value. Any load failure
 * (corrupt install, missing app-update.yml) degrades to null + a warn so the
 * app still boots.
 */
function ensureAutoUpdater(): AutoUpdater | null {
  if (!app.isPackaged) {
    logger.info('updater disabled in dev (autoUpdater not loaded — unpackaged)');
    return null;
  }
  if (autoUpdater && wired) return autoUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: AutoUpdater };
    autoUpdater = mod.autoUpdater;
  } catch (err) {
    logger.warn(`updater: failed to load electron-updater (${(err as Error).message})`);
    autoUpdater = null;
    return null;
  }

  // We branch download per level, so never auto-download; install pending
  // updates on the next quit by default (mandatory on-restart timing).
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    send(IpcChannel.app.updateChecking);
  });

  autoUpdater.on('update-not-available', () => {
    send(IpcChannel.app.updateNotAvailable);
  });

  autoUpdater.on('update-available', (info: unknown) => {
    void handleUpdateAvailable(info);
  });

  autoUpdater.on('download-progress', (progress: unknown) => {
    const percent =
      progress && typeof progress === 'object' && typeof (progress as { percent?: unknown }).percent === 'number'
        ? (progress as { percent: number }).percent
        : 0;
    send(IpcChannel.app.updateProgress, { percent });
  });

  autoUpdater.on('update-downloaded', () => {
    void handleUpdateDownloaded();
  });

  autoUpdater.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`updater error: ${message}`);
    send(IpcChannel.app.updateError, message);
  });

  wired = true;
  return autoUpdater;
}

/* -------------------------------------------------------------------------- */
/*  Flow A/B — update-available handling                                       */
/* -------------------------------------------------------------------------- */

/**
 * Handle electron-updater's `update-available`. Derives the level from semver,
 * fetches the version.json policy (changelog + apply), and branches:
 *   - optional → push app:update-available (no download yet).
 *   - mandatory → downloadUpdate() silently + stash the pending changelog;
 *     the actual install timing is decided in handleUpdateDownloaded.
 */
async function handleUpdateAvailable(info: unknown): Promise<void> {
  const au = autoUpdater;
  if (!au) return;
  const latestVersion =
    info && typeof info === 'object' && typeof (info as { version?: unknown }).version === 'string'
      ? (info as { version: string }).version
      : '';
  const currentVersion = app.getVersion();
  const level = deriveLevel(currentVersion, latestVersion);
  if (level === 'none') {
    // electron-updater thinks newer, our policy says no (downgrade/equal/
    // unparseable) — treat as up to date.
    send(IpcChannel.app.updateNotAvailable);
    return;
  }

  const policy = await fetchVersionPolicy();
  const changelog = policy?.changelog ?? undefined;
  const downloadUrl = policy?.downloadUrl ?? 'https://sei.gg/';
  const apply = policy?.apply ?? 'on-restart';

  if (level === 'optional') {
    mandatoryApply = null;
    send(IpcChannel.app.updateAvailable, {
      latestVersion,
      currentVersion,
      downloadUrl,
      level: 'optional',
      changelog,
    });
    return;
  }

  // mandatory (patch-only) → silent download. Stash the changelog so it can be
  // shown on the next launch (on-restart) or right after the forced restart.
  mandatoryApply = apply;
  try {
    const state = await loadUpdateState();
    await saveUpdateState({
      ...state,
      pending: { version: latestVersion, changelog: changelog ?? '' },
    });
  } catch (err) {
    logger.warn(`updater: failed to stash pending what's-new (${(err as Error).message})`);
  }
  try {
    await au.downloadUpdate();
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`updater: mandatory downloadUpdate failed (${message})`);
    send(IpcChannel.app.updateError, message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Flow C tail / mandatory tail — update-downloaded handling                  */
/* -------------------------------------------------------------------------- */

/**
 * Handle electron-updater's `update-downloaded`. Behavior depends on which
 * flow drove the download:
 *   - mandatory + apply==='now'  → push downloaded{forced:true}, then
 *     quitAndInstall() after a brief overlay delay.
 *   - mandatory + apply==='on-restart' → nothing visible; autoInstallOnAppQuit
 *     applies it on the next quit.
 *   - optional (consented) → push downloaded{forced:false}; the renderer shows
 *     "restarting…" then invokes app:update-install → installDownloadedUpdate().
 */
async function handleUpdateDownloaded(): Promise<void> {
  const apply = mandatoryApply;
  if (apply === null) {
    // Optional consented flow.
    send(IpcChannel.app.updateDownloaded, { forced: false });
    return;
  }
  // Mandatory flow.
  if (apply === 'now') {
    send(IpcChannel.app.updateDownloaded, { forced: true });
    setTimeout(() => {
      try {
        autoUpdater?.quitAndInstall();
      } catch (err) {
        logger.warn(`updater: forced quitAndInstall failed (${(err as Error).message})`);
      }
    }, FORCED_RESTART_DELAY_MS);
    return;
  }
  // apply === 'on-restart' → nothing visible; applied on next quit.
  logger.info('updater: mandatory update downloaded; will apply on next quit');
}

/* -------------------------------------------------------------------------- */
/*  Flow D — post-update what's-new (next launch)                              */
/* -------------------------------------------------------------------------- */

/**
 * Run on launch (packaged only). If a stashed `pending` matches the running
 * version, show it and clear the record. Otherwise fall back to a best-effort
 * version.json fetch IF lastSeenVersion → cur is a patch-only forward bump
 * (the user never saw a changelog up front). Always record lastSeenVersion=cur.
 *
 * Skipped entirely when !app.isPackaged: app.getVersion() is a benign dev
 * string there, and there's no real install to have updated — writing junk to
 * update-state.json would only confuse the next packaged run.
 */
async function runWhatsNewCheck(): Promise<void> {
  if (!app.isPackaged) {
    logger.info("updater: what's-new check skipped in dev (unpackaged)");
    return;
  }
  const cur = app.getVersion();
  let state;
  try {
    state = await loadUpdateState();
  } catch (err) {
    logger.warn(`updater: what's-new load failed (${(err as Error).message})`);
    return;
  }

  let shown = false;
  if (state.pending && state.pending.version === cur) {
    send(IpcChannel.app.whatsNew, { version: cur, changelog: state.pending.changelog });
    shown = true;
  } else if (shouldShowWhatsNew(state.lastSeenVersion, cur)) {
    // Fallback: a patch-only bump with no stash (e.g. installed via the OS
    // quit path before we could stash). Best-effort fetch the changelog.
    const policy = await fetchVersionPolicy();
    if (policy && policy.changelog) {
      send(IpcChannel.app.whatsNew, { version: cur, changelog: policy.changelog });
    }
    shown = true;
  }

  try {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: cur,
      // Clear pending once shown (or if it was for a different version — a
      // stale stash from an aborted update should not linger).
      pending: shown ? null : state.pending && state.pending.version === cur ? null : state.pending,
    });
  } catch (err) {
    logger.warn(`updater: what's-new save failed (${(err as Error).message})`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Initialize the updater. Wires autoUpdater (packaged only), runs the launch
 * what's-new check, then kicks off the startup auto-check (Flow A). Safe to
 * call in dev — it just logs "disabled in dev" and runs nothing that touches
 * autoUpdater.
 */
export function initUpdater(deps: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = deps.getMainWindow;

  // Flow D — what's-new on launch (skipped in dev internally).
  void runWhatsNewCheck();

  const au = ensureAutoUpdater();
  if (!au) return; // dev or load failure — nothing else to do.

  // Flow A — startup auto-check.
  au.checkForUpdates().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`updater: startup checkForUpdates failed (${message})`);
  });
}

/**
 * Flow B — manual "Check for updates" (Settings). In dev, immediately reports
 * not-available so the UI resolves. In packaged, triggers a real check whose
 * events flow through the same handlers as the startup check.
 */
export async function checkForUpdatesManual(): Promise<void> {
  const au = ensureAutoUpdater();
  if (!au) {
    send(IpcChannel.app.updateNotAvailable);
    return;
  }
  send(IpcChannel.app.updateChecking);
  try {
    await au.checkForUpdates();
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`updater: manual checkForUpdates failed (${message})`);
    send(IpcChannel.app.updateError, message);
  }
}

/**
 * Flow C — consent to download an available OPTIONAL update. download-progress
 * ticks push app:update-progress; on completion handleUpdateDownloaded pushes
 * app:update-downloaded {forced:false}.
 */
export async function downloadAcceptedUpdate(): Promise<void> {
  const au = ensureAutoUpdater();
  if (!au) return;
  mandatoryApply = null; // optional/consented flow.
  try {
    await au.downloadUpdate();
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`updater: downloadUpdate failed (${message})`);
    send(IpcChannel.app.updateError, message);
  }
}

/**
 * Quit and install a downloaded update (optional flow, after the renderer's
 * brief "restarting…" state). No-op in dev.
 */
export function installDownloadedUpdate(): void {
  const au = ensureAutoUpdater();
  if (!au) return;
  try {
    au.quitAndInstall();
  } catch (err) {
    logger.warn(`updater: quitAndInstall failed (${(err as Error).message})`);
  }
}
