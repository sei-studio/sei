/**
 * SeiLink desktop-host addon loader (261104). The addon (native/seilink,
 * built by scripts/build-seilink-addon.mjs) ships OUTSIDE app.asar, at
 * `<resources>/seilink/seilink.node` (electron-builder extraResources, mac
 * universal + win x64). Dev runs load `<repo>/resources/seilink/seilink.node`.
 *
 * Linux, or an install whose build skipped the addon (a compile failure is
 * not fatal, see the build script), reports unsupported; nothing else in
 * the app depends on it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundleRequire } from '../../bundleRequire';
import type { SeilinkHostFailure } from '../../../shared/seilinkHost';

export interface WinAttachResult {
  ok: boolean;
  layout?: 'raised' | 'classic';
  method?: string;
  failure?: SeilinkHostFailure;
  error?: string;
  steps?: string[];
  osBuild?: number;
}

export interface WinValidateResult {
  ok: boolean;
  layout: 'raised' | 'classic';
  reasons: string[];
  hidden?: boolean;
}

export interface SeilinkWinAddon {
  platform: 'win32';
  attach(hwnd: Buffer, rect: { x: number; y: number; w: number; h: number }): WinAttachResult;
  validate(hwnd: Buffer, size: { w: number; h: number }): WinValidateResult;
  shellStatus(): { progman: boolean; defView: boolean };
  watchStart(cb: (json: string) => void): boolean;
  setHitRect(rect: { x: number; y: number; w: number; h: number } | null): void;
  coverageNow(): { covered: boolean; kind: string };
  redrawDesktop(hwnd: Buffer | null, hard: boolean): boolean;
  doubleClickMs(): number;
  /** True once after Explorer's exit freed the room window (win.cc "room window guard"); clears on read. */
  roomLost(): boolean;
}

export interface SeilinkMacAddon {
  platform: 'darwin';
  setDesktopLevel(handle: Buffer): { ok: boolean; wanted?: number; level?: number; failure?: SeilinkHostFailure; os?: string };
  windowLevel(handle: Buffer): number;
  onEvents(cb: (json: string) => void): boolean;
  /** 261110: `slot` 0 = her (default), 1 = the dock (when hitPanelSlots >= 2). */
  hitPanel(rect: { x: number; y: number; w: number; h: number }, slot?: number): boolean;
  /** No slot: every panel. */
  hitPanelClose(slot?: number): void;
  /** 261110: how many hit panels this build has (absent = 1). */
  hitPanelSlots?: number;
  observeOcclusion(handle: Buffer, tag: string): boolean;
  doubleClickMs(): number;
}

/**
 * Dev/CI only (unpackaged + SEI_SEILINK_FAKE_DESKTOP=1, any OS): no desktop layer, the room is a
 * plain window. Lets Linux exercise the host process, pipe, supervisor and page end to end.
 */
export interface SeilinkFakeAddon {
  platform: 'fake';
}

export type SeilinkAddon = SeilinkWinAddon | SeilinkMacAddon | SeilinkFakeAddon;

export const FAKE_ADDON_FILE = '<fake-desktop>';

export function fakeDesktopEnabled(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !packaged && env.SEI_SEILINK_FAKE_DESKTOP === '1';
}

export type AddonAvailability =
  | { ok: true; file: string }
  | { ok: false; failure: Extract<SeilinkHostFailure, 'unsupported_platform' | 'addon_missing' | 'addon_load_failed'> };

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** Where the addon is: packaged `<resources>/seilink`, dev `<appPath>/resources/seilink`. */
export function addonPath(opts: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.packaged
    ? path.join(opts.resourcesPath, 'seilink', 'seilink.node')
    : path.join(opts.appPath, 'resources', 'seilink', 'seilink.node');
}

/** Cheap check (no load): can this install run the host at all? */
export function addonAvailability(opts: {
  platform?: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): AddonAvailability {
  if (fakeDesktopEnabled(opts.packaged, opts.env)) return { ok: true, file: FAKE_ADDON_FILE };
  if (!isSupportedPlatform(opts.platform)) return { ok: false, failure: 'unsupported_platform' };
  const file = addonPath(opts);
  return existsSync(file) ? { ok: true, file } : { ok: false, failure: 'addon_missing' };
}

let loaded: { file: string; addon: SeilinkAddon } | null = null;

/** Load the addon (once). Throws an Error whose message starts with the failure class. */
export function loadSeilinkAddon(file: string): SeilinkAddon {
  if (loaded && loaded.file === file) return loaded.addon;
  if (file === FAKE_ADDON_FILE) return { platform: 'fake' };
  let addon: SeilinkAddon;
  try {
    addon = bundleRequire()(file) as SeilinkAddon;
  } catch (err) {
    throw new Error(`addon_load_failed: ${(err as Error).message}`);
  }
  if (addon.platform !== process.platform) throw new Error(`addon_load_failed: built for ${String(addon.platform)}`);
  loaded = { file, addon };
  return addon;
}
