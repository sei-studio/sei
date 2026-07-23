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
import { app, net, powerMonitor, type BrowserWindow } from 'electron';
import { IpcChannel, type WhatsNewEvent } from '../shared/ipc';
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
/**
 * Background re-check cadence (260710). The startup check alone meant a
 * long-running app never noticed a release — v0.4.4 sat invisible to every
 * open 0.4.3 instance until users happened to relaunch.
 *
 * Responsiveness now comes from EVENTS, not the clock (260722): a check fires
 * when the user returns to the app (window focus) or the machine wakes / the
 * screen unlocks — the moments a stale app is most likely and the user is right
 * there to act on it. The periodic timer below is just a backstop for a session
 * left continuously in the foreground. Every automatic check funnels through
 * maybeBackgroundCheck(), which enforces MIN_BACKGROUND_GAP_MS between checks so
 * focus-thrashing or a wake+unlock burst can't spam the feed. Each check is one
 * ~1KB GitHub feed GET (latest.yml), so the cost is negligible either way.
 */
const PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Floor between two automatic (event- or timer-driven) checks. Bounds the feed
 * traffic from event triggers to at most one hit per this window, regardless of
 * how many focus/resume/unlock events fire.
 */
const MIN_BACKGROUND_GAP_MS = 20 * 60 * 1000;

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
  /** When true, GitHub pre-releases are eligible (the beta channel). */
  allowPrerelease: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};
let autoUpdater: AutoUpdater | null = null;

/**
 * The current update channel, mirrored onto `autoUpdater.allowPrerelease`.
 * false (default) = stable only — a normal user is NEVER offered a pre-release.
 * true = beta — any newer release, including GitHub pre-releases, is eligible.
 * Seeded from `config.advanced_updates` in initUpdater and flipped live by
 * setUpdateChannel when the Settings toggle changes; ensureAutoUpdater applies
 * it to the SDK instance on first wiring so the startup check honors it.
 */
let allowPrerelease = false;

/**
 * The apply timing for the in-flight mandatory download, captured at
 * update-available time so the update-downloaded handler knows whether to
 * force-restart. Null when the in-flight download is the optional (consented)
 * flow.
 */
let mandatoryApply: ApplyTiming | null = null;

/**
 * True while the in-flight checkForUpdates() came from the background timer.
 * Read synchronously at the top of handleUpdateAvailable (the event fires
 * inside the check, before the finally that clears this). Background
 * discoveries are handled more gently than launch-time ones — see the two
 * uses below.
 */
let backgroundCheck = false;
/**
 * True while a manual "Check for updates" (Settings) is in flight. A manual
 * check always WINS over a concurrent background one: its checking/available/
 * not-available feedback is surfaced and version dedup is bypassed, even if it
 * overlaps a background check that set `backgroundCheck`. See isBackgroundDiscovery.
 */
let manualCheckInFlight = false;
/**
 * Whether a discovery from the in-flight check should be treated as background
 * (silent checking/not-available + per-run version dedup). Only when a
 * background check is running AND no manual check is in flight — a manual check
 * overrides, so the Settings flow always resolves to a terminal status.
 */
function isBackgroundDiscovery(): boolean {
  return backgroundCheck && !manualCheckInFlight;
}
/**
 * Versions already handled by handleUpdateAvailable this run. A background
 * re-check must not re-open the optional popup or re-download a mandatory
 * update every interval; manual checks bypass this so the Settings flow
 * always resolves to a terminal status event.
 */
const handledVersions = new Set<string>();
/** Wall-clock (ms) of the last automatic check's start — drives the throttle. */
let lastBackgroundCheckAt = 0;
/** True while an automatic check is in flight, so overlapping triggers dedup. */
let backgroundCheckInFlight = false;
/** True once the event-trigger listeners are attached (attach exactly once). */
let eventsWired = false;

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
  // Channel: stable-only unless the user opted into advanced updates. Seeded
  // from config by initUpdater before this runs; setUpdateChannel flips it live.
  autoUpdater.allowPrerelease = allowPrerelease;

  // checking/not-available are FEEDBACK for the manual Settings button (and
  // the startup check) — a background re-check stays invisible unless it
  // actually finds something, so the Settings status label never flips on its
  // own when a focus/wake/timer check runs.
  autoUpdater.on('checking-for-update', () => {
    if (!isBackgroundDiscovery()) send(IpcChannel.app.updateChecking);
  });

  autoUpdater.on('update-not-available', () => {
    if (!isBackgroundDiscovery()) send(IpcChannel.app.updateNotAvailable);
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
  // Captured before the first await — the event fires inside checkForUpdates(),
  // so a manual check that overlaps a background one is still in flight here and
  // correctly forces foreground treatment (feedback + no dedup).
  const fromBackground = isBackgroundDiscovery();
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
    // unparseable) — treat as up to date (silently for a background check).
    if (!fromBackground) send(IpcChannel.app.updateNotAvailable);
    return;
  }
  if (fromBackground && handledVersions.has(latestVersion)) return;
  handledVersions.add(latestVersion);

  const policy = await fetchVersionPolicy();
  const changelog = policy?.changelog ?? undefined;
  const downloadUrl = policy?.downloadUrl ?? 'https://sei.gg/';
  // apply is the operator's severity lever (version.json):
  //   - "on-restart" (the DEFAULT for normal releases): silent download,
  //     dismissable "restart now / later" popup, installs on next quit.
  //   - "now" (CRITICAL releases only): forced restart after the download —
  //     including apps that discover it via a background check, i.e.
  //     mid-session. Reserve it for updates worth interrupting a live game or
  //     call for; everything else ships as on-restart.
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
  // apply === 'on-restart' → surface a DISMISSABLE "ready, restart to apply"
  // popup so the foreground download bar doesn't hang at 100% (it previously
  // sent nothing here, leaving the renderer stuck in the 'downloading' state).
  // The update still installs on the next quit via autoInstallOnAppQuit; the
  // popup just adds a "Restart now" affordance.
  send(IpcChannel.app.updateDownloaded, { forced: false, onRestart: true });
  logger.info('updater: mandatory update downloaded; applies on next quit (popup offers restart now)');
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
// Holds the post-update changelog from this launch's check until the renderer
// pulls it (via getPendingWhatsNew). The `send()` push is fire-and-forget and
// races the renderer mounting its onWhatsNew listener — especially on a forced
// `apply:"now"` restart, where the push fires during early main bootstrap and
// is dropped because nothing is listening yet. Retaining it here lets the
// renderer pull it on mount, so the changelog is never silently lost. (260625)
let pendingWhatsNew: WhatsNewEvent | null = null;
// The launch check runs at most once; the pull awaits it so a renderer that
// mounts before the (async) check finishes still gets the right answer.
let whatsNewComputed: Promise<void> | null = null;

function ensureWhatsNewComputed(): Promise<void> {
  if (!whatsNewComputed) whatsNewComputed = runWhatsNewCheck();
  return whatsNewComputed;
}

/**
 * Renderer pull (app:whats-new-get): wait for this launch's what's-new check to
 * finish, then return the pending changelog event and consume it (so it shows
 * exactly once). Returns null when there's nothing to show.
 */
export async function getPendingWhatsNew(): Promise<WhatsNewEvent | null> {
  await ensureWhatsNewComputed();
  const ev = pendingWhatsNew;
  pendingWhatsNew = null;
  return ev;
}

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
    pendingWhatsNew = { version: cur, changelog: state.pending.changelog };
    send(IpcChannel.app.whatsNew, pendingWhatsNew);
    shown = true;
  } else if (shouldShowWhatsNew(state.lastSeenVersion, cur)) {
    // Fallback: a patch-only bump with no stash (e.g. installed via the OS
    // quit path before we could stash). Best-effort fetch the changelog.
    const policy = await fetchVersionPolicy();
    if (policy && policy.changelog) {
      pendingWhatsNew = { version: cur, changelog: policy.changelog };
      send(IpcChannel.app.whatsNew, pendingWhatsNew);
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
 * Fire a background update check unless one ran within MIN_BACKGROUND_GAP_MS or
 * is still in flight. Shared by the periodic timer and every event trigger, so
 * the throttle and the background-only softenings (silent checking/
 * not-available, per-run version dedup in handleUpdateAvailable) apply
 * uniformly. No-op in dev / on load failure (no autoUpdater).
 */
function maybeBackgroundCheck(reason: string): void {
  const au = autoUpdater;
  if (!au) return;
  if (backgroundCheckInFlight || manualCheckInFlight) return;
  const now = Date.now();
  if (now - lastBackgroundCheckAt < MIN_BACKGROUND_GAP_MS) return;
  lastBackgroundCheckAt = now;
  backgroundCheckInFlight = true;
  backgroundCheck = true;
  logger.info(`updater: background re-check (${reason})`);
  au
    .checkForUpdates()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`updater: background checkForUpdates failed (${message})`);
    })
    .finally(() => {
      backgroundCheck = false;
      backgroundCheckInFlight = false;
    });
}

/**
 * Initialize the updater. Wires autoUpdater (packaged only), runs the launch
 * what's-new check, then kicks off the startup auto-check (Flow A). Safe to
 * call in dev — it just logs "disabled in dev" and runs nothing that touches
 * autoUpdater.
 */
export function initUpdater(deps: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = deps.getMainWindow;

  // Flow D — what's-new on launch (skipped in dev internally). Memoized so the
  // renderer's pull (getPendingWhatsNew) shares this one computation.
  void ensureWhatsNewComputed();

  const au = ensureAutoUpdater();
  if (!au) return; // dev or load failure — nothing else to do.

  // Flow A — startup auto-check. Seed the throttle so the window's own
  // launch-time focus event doesn't immediately fire a redundant second check.
  lastBackgroundCheckAt = Date.now();
  // Seed the channel from persisted config BEFORE the startup check, so an
  // advanced-updates user checks the beta feed from the first check on. Config
  // load is async and best-effort: on any failure we keep the safe stable
  // default (a normal user must never be silently moved onto a beta). The
  // lazy import keeps configStore out of updater's cold-start graph.
  void (async () => {
    try {
      const { loadConfig } = await import('./configStore');
      const cfg = await loadConfig();
      allowPrerelease = cfg.advanced_updates === true;
      au.allowPrerelease = allowPrerelease;
    } catch (err) {
      logger.warn(`updater: advanced-updates config read failed (${(err as Error).message})`);
    }
    au.checkForUpdates().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`updater: startup checkForUpdates failed (${message})`);
    });
  })();

  // Flow A' — self-notice a release without a relaunch. Responsiveness is
  // event-driven (see maybeBackgroundCheck); the periodic timer is only a
  // backstop for a session left continuously in the foreground. All triggers
  // share the same throttle + background-only softenings: an already-seen
  // version is not re-handled, and checking/not-available stay silent. apply is
  // NOT softened — "now" means critical, so running apps restart too (see
  // handleUpdateAvailable).
  setInterval(() => maybeBackgroundCheck('periodic'), PERIODIC_CHECK_INTERVAL_MS);

  if (!eventsWired) {
    eventsWired = true;
    // The user just returned to the app — the most likely moment to act on an
    // update, after any length of time away.
    app.on('browser-window-focus', () => maybeBackgroundCheck('window-focus'));
    // The machine woke or the screen unlocked — likely a long gap since the
    // last check. powerMonitor is main-process only and safe post-ready.
    powerMonitor.on('resume', () => maybeBackgroundCheck('resume'));
    powerMonitor.on('unlock-screen', () => maybeBackgroundCheck('unlock-screen'));
  }
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
  // Take priority over any in-flight background check for the duration (see
  // isBackgroundDiscovery), so the Settings flow always gets its feedback. Also
  // count as a check for the throttle, so a focus/wake event right after a
  // manual check doesn't fire a redundant background one.
  manualCheckInFlight = true;
  lastBackgroundCheckAt = Date.now();
  send(IpcChannel.app.updateChecking);
  try {
    await au.checkForUpdates();
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`updater: manual checkForUpdates failed (${message})`);
    send(IpcChannel.app.updateError, message);
  } finally {
    manualCheckInFlight = false;
  }
}

/**
 * Switch the update channel (Settings "Advanced updates" toggle). The renderer
 * persists `advanced_updates` in config; this applies the choice to the live
 * updater so it takes effect without a re-launch.
 *
 *   - `advanced` true  → beta channel: `allowPrerelease = true`, so any newer
 *     release (including GitHub pre-releases) is offered. A check fires now so a
 *     waiting beta surfaces immediately instead of at the next focus/timer tick.
 *   - `advanced` false → stable only: `allowPrerelease = false`. No check is
 *     fired — the user simply stops being offered pre-releases; a build already
 *     installed is not downgraded (electron-updater's default), so they hold
 *     until stable catches up.
 *
 * No-op beyond recording the flag in dev / on load failure (no autoUpdater).
 */
export function setUpdateChannel(advanced: boolean): void {
  allowPrerelease = advanced;
  const au = ensureAutoUpdater();
  if (!au) {
    logger.info(`updater: channel = ${advanced ? 'beta' : 'stable'} (no autoUpdater — dev/load failure)`);
    return;
  }
  au.allowPrerelease = advanced;
  logger.info(`updater: channel = ${advanced ? 'beta (pre-releases included)' : 'stable only'}`);
  // Enabling may reveal a waiting beta. Route through the manual path so the
  // Settings status line gets its checking/available/not-available feedback,
  // and so a background check running concurrently doesn't suppress it.
  if (advanced) void checkForUpdatesManual();
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
