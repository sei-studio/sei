/**
 * Is SeiLink on? (261104, M4.) One place every SeiLink path asks.
 *
 * On when either:
 *   - the dev flag is set (unpackaged + SEI_SEILINK_PACKS, packs.ts), or
 *   - the user turned it on in Settings > Labs (`seilink_enabled`, per
 *     profile) on an install that can run the desktop host: macOS or
 *     Windows with the host addon in the build (native.ts). Elsewhere the
 *     Settings row is shown disabled with the reason.
 *
 * Kept synchronous (prompt assembly asks on every turn): the setting is
 * mirrored here from config at start and after an account switch
 * (restoreSeilinkHost) and after a renderer save (the config:save handler).
 */
import { app } from 'electron';
import type { SeilinkAvailability } from '../../shared/seilinkHost';
import { seilinkDevEnabled } from './packs';
import { addonAvailability } from './host/native';

let settingOn = false;
let testOverride: boolean | null = null;
/** Who lives in the desktop room right now: set while her host session is open (seilinkHost.ts). */
let resident: string | null = null;
let supportCache: Pick<SeilinkAvailability, 'supported' | 'reason'> | null = null;

/** The Labs setting as last read from this profile's config. */
export function setSeilinkSetting(on: boolean | undefined | null): void {
  settingOn = on === true;
}

export function seilinkSettingOn(): boolean {
  return settingOn;
}

/** Can this install run the desktop host at all? Cached: the addon does not come and go. */
export function seilinkSupport(): Pick<SeilinkAvailability, 'supported' | 'reason'> {
  if (supportCache) return supportCache;
  let out: Pick<SeilinkAvailability, 'supported' | 'reason'>;
  try {
    if (!app) throw new Error('no app');
    const a = addonAvailability({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    out = a.ok ? { supported: true } : { supported: false, reason: a.failure === 'unsupported_platform' ? 'platform' : 'addon' };
  } catch {
    // vitest (no electron app): unsupported, and not cached so a test can stub it.
    return { supported: false, reason: 'platform' };
  }
  supportCache = out;
  return out;
}

export function seilinkEnabled(): boolean {
  if (testOverride !== null) return testOverride;
  return seilinkDevEnabled() || (settingOn && seilinkSupport().supported);
}

export function seilinkAvailability(): SeilinkAvailability {
  const support = seilinkSupport();
  return { ...support, setting: settingOn, enabled: seilinkEnabled(), dev: seilinkDevEnabled() };
}

/**
 * The companion whose room is on the desktop now (a host session is open for
 * her: starting, running or restarting), or null. Only she gets the room
 * prompt line and look() (roomStore.roomSource); the others do not live there.
 */
export function seilinkResident(): string | null {
  return resident;
}

/** seilinkHost.ts: a session opened (her id) or ended (null). */
export function setSeilinkResident(characterId: string | null): void {
  resident = characterId;
}

/** Tests only. null restores the real answer. */
export function __setSeilinkEnabledForTest(v: boolean | null): void {
  testOverride = v;
}
