/**
 * Is SeiLink on? (261104, M4.) One place every SeiLink path asks.
 *
 * On when either:
 *   - the dev flag is set (unpackaged + SEI_SEILINK_PACKS, packs.ts), or
 *   - the user turned it on in Settings > Labs (`seilink_enabled`, per
 *     profile) on an install that can run the desktop host.
 *
 * Kept synchronous (prompt assembly and IPC handlers ask on every call): the
 * setting is mirrored here from config at start, after every renderer save
 * and after an account switch (index.ts / ipc.ts call setSeilinkSetting).
 */
import { seilinkDevEnabled } from './packs';

let settingOn = false;
let testOverride: boolean | null = null;

/** The Labs setting as last read from this profile's config. */
export function setSeilinkSetting(on: boolean): void {
  settingOn = on === true;
}

export function seilinkSettingOn(): boolean {
  return settingOn;
}

export function seilinkEnabled(): boolean {
  if (testOverride !== null) return testOverride;
  return seilinkDevEnabled() || settingOn;
}

/** Tests only. null restores the real answer. */
export function __setSeilinkEnabledForTest(v: boolean | null): void {
  testOverride = v;
}
