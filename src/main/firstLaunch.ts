/**
 * `installer_first_launch` (260926): one analytics event per install, on the
 * very first launch.
 *
 * Why: Mac download to install converted at 22% against 70% on Windows, and
 * nothing in the app said whether the Macs that did launch were running the
 * right build, from /Applications, or translocated out of ~/Downloads. This
 * event is the install-side half of that funnel (the site's `download` event
 * is the other half).
 *
 * "Once per install" is a DEVICE-GLOBAL marker file, `<userData>/
 * install-marker.json`, created with an exclusive open. It cannot ride on the
 * analytics install id: that lives in the profile-scoped config.json, so a
 * first sign-in (new profile dir) would mint a new one and look like a new
 * install. The marker is written at the very start of bootstrap(), before
 * anything else creates Sei state under userData, so the probe below can tell
 * a fresh install from an existing one updating to the first build that has
 * this code:
 *   - marker present                  → 'seen'     (no event)
 *   - no marker, older Sei state      → 'upgrade'  (marker written, no event)
 *   - no marker, no Sei state         → 'fresh'    (marker written, EVENT)
 *   - marker could not be written     → 'unrecorded' (no event, so a disk
 *     that refuses the write cannot turn every launch into a "first" launch)
 * The event is emitted only after the marker was created, so it fires at most
 * once per userData dir. Deleting the app but keeping userData is not a new
 * install; deleting userData (or a factory reset that removes it) is.
 *
 * Shape only: platform facts and a coarse location enum, never a path. The
 * capture itself goes through analytics.capture(), so opt-out and the
 * no-ingestion-key build are respected there.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const INSTALL_MARKER_FILE = 'install-marker.json';

/**
 * Sei-owned entries under userData that only exist once some earlier Sei
 * version has run. Chromium's own files (Local Storage, Preferences, the
 * singleton lock, ...) are deliberately absent: Electron creates those before
 * bootstrap on a fresh install too.
 */
export const PRIOR_STATE_ENTRIES: readonly string[] = [
  'profiles',                    // per-account data root (260603+)
  'profiles-partitioned.json',   // partition marker, written on every boot since 260603
  'config.json',                 // pre-partition global config
  'characters',                  // pre-partition global characters
  'update-state.json',           // updater's last-launched version
  'skin-setup-state.json',       // Minecraft wizard state
  'session.bin',                 // Supabase session
  'device-id.json',              // trial-claim device id
  'migration-uuid-rename.json',  // slug→UUID migration marker
  'notices.json',                // notices inbox state
];

export type LaunchKind = 'fresh' | 'upgrade' | 'seen' | 'unrecorded';

/**
 * Classify this launch and, unless the marker already exists, create it.
 * Synchronous on purpose: it runs once, before any other startup I/O, and
 * must finish before bootstrap writes the state it probes for. Never throws.
 */
export function recordLaunch(userDataDir: string, appVersion: string, now: Date = new Date()): LaunchKind {
  const marker = path.join(userDataDir, INSTALL_MARKER_FILE);
  try {
    if (existsSync(marker)) return 'seen';
    const prior = PRIOR_STATE_ENTRIES.some((name) => existsSync(path.join(userDataDir, name)));
    const kind: LaunchKind = prior ? 'upgrade' : 'fresh';
    mkdirSync(userDataDir, { recursive: true });
    // 'wx' = create exclusively: if another process got here first, EEXIST
    // lands in the catch and this launch is not the first.
    writeFileSync(
      marker,
      JSON.stringify({ kind, first_version: appVersion, first_launch_at: now.toISOString() }, null, 2) + '\n',
      { flag: 'wx' },
    );
    return kind;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'seen';
    console.warn(`[sei] install marker: ${(err as Error).message}`);
    return 'unrecorded';
  }
}

/** Where a macOS app bundle is running from, as a coarse enum (never a path). */
export type MacAppLocation = 'applications' | 'translocated' | 'volume' | 'downloads' | 'other';

/**
 * Pure: classify the running bundle's location. Translocation is checked
 * first: Gatekeeper runs a quarantined app that was not moved by Finder from
 * a read-only randomized mount under .../AppTranslocation/..., and the updater
 * cannot replace a bundle there. 'volume' is almost always the mounted .dmg
 * itself (the user opened Sei from the disk image instead of dragging it).
 */
export function macAppLocation(exePath: string, homeDir: string, inApplications: boolean): MacAppLocation {
  if (exePath.includes('/AppTranslocation/')) return 'translocated';
  if (inApplications) return 'applications';
  if (exePath.startsWith('/Volumes/')) return 'volume';
  const downloads = path.join(homeDir, 'Downloads') + path.sep;
  if (homeDir && exePath.startsWith(downloads)) return 'downloads';
  return 'other';
}

/** Inputs for installerFirstLaunchProps; injectable for tests. */
export interface FirstLaunchEnv {
  platform: NodeJS.Platform;
  arch: string;
  osVersion: string;
  packaged: boolean;
  /** x64 build running under Rosetta 2 (mac) or x64 emulation (Windows on ARM). */
  arm64Translation: boolean;
  exePath: string;
  homeDir: string;
  /** app.isInApplicationsFolder(); only meaningful on darwin. */
  inApplications: boolean;
}

/** Pure: the event's properties. Scalars and enums only. */
export function installerFirstLaunchProps(env: FirstLaunchEnv): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {
    platform: env.platform,
    arch: env.arch,
    os_version: env.osVersion,
    packaged: env.packaged,
    arm64_translation: env.arm64Translation,
  };
  if (env.platform === 'darwin') {
    const location = macAppLocation(env.exePath, env.homeDir, env.inApplications);
    props.in_applications = env.inApplications;
    props.translocated = location === 'translocated';
    props.app_location = location;
  }
  return props;
}

/** Read the live environment from Electron / Node. Never throws. */
export function currentFirstLaunchEnv(): FirstLaunchEnv {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try { return fn(); } catch { return fallback; }
  };
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: safe(() => process.getSystemVersion(), os.release()),
    packaged: safe(() => app.isPackaged, false),
    arm64Translation: safe(() => app.runningUnderARM64Translation === true, false),
    exePath: safe(() => app.getPath('exe'), ''),
    homeDir: safe(() => os.homedir(), ''),
    inApplications: process.platform === 'darwin' ? safe(() => app.isInApplicationsFolder(), false) : false,
  };
}

// ── Process-level wiring ────────────────────────────────────────────────────

let pendingFirstLaunch = false;

/** Call once, first thing in bootstrap(). */
export function noteLaunch(userDataDir: string, appVersion: string): LaunchKind {
  const kind = recordLaunch(userDataDir, appVersion);
  pendingFirstLaunch = kind === 'fresh';
  return kind;
}

/**
 * True exactly once per process, and only when noteLaunch() created the
 * marker on a fresh install. Consuming it means a second caller can never
 * emit the event twice.
 */
export function takeInstallerFirstLaunch(): boolean {
  const pending = pendingFirstLaunch;
  pendingFirstLaunch = false;
  return pending;
}
