/**
 * Renderer side of the OS permission flows (260929). The cards
 * (components/permissions/*) and the voice store call these; main owns the
 * actual OS calls (src/main/permissions/*).
 */
import { sei } from '../ipcClient';
import type { OsPermissionKind } from '@shared/permissionsIpc';

export type PermissionEvent = 'permission_prompt_shown' | 'permission_settings_opened' | 'permission_granted';

/** Analytics: shape only, {kind, platform}. */
export function trackPermission(event: PermissionEvent, kind: OsPermissionKind): void {
  try {
    sei.track(event, { kind, platform: sei.platform });
  } catch {
    /* analytics must never break the flow */
  }
}

/** Open the OS Settings page for this permission and record it. */
export async function openPermissionSettings(kind: OsPermissionKind): Promise<void> {
  trackPermission('permission_settings_opened', kind);
  try {
    await sei.permissionsOpenSettings(kind);
  } catch {
    /* nothing to open on this platform; the card copy still names the page */
  }
}

export type MicPreflight = 'ok' | 'blocked' | 'restricted';

/**
 * Run on a Call press, before the call connects. On macOS this is where the
 * system "allow microphone" prompt appears the first time (it used to fire at
 * app boot).
 *
 * Everywhere else it never stops a call. Windows has no per-app prompt for
 * desktop apps, and its status read is not the switch that decides: Electron
 * reads the device-wide consent (DeviceAccessInformation), which can say
 * 'denied' while "Let desktop apps access your microphone" lets Sei's
 * getUserMedia through. Before 260929 that status was only logged and the call
 * went ahead; gating on it would lock such a player out of calls, with a card
 * whose poll could never clear. The call's own getUserMedia is the test, and a
 * refusal there raises the same card.
 */
export async function micPreflight(platform: string = sei.platform): Promise<MicPreflight> {
  if (platform !== 'darwin') return 'ok';
  let status: string;
  try {
    status = await sei.permissionsStatus('mic');
  } catch {
    return 'ok';
  }
  if (status === 'granted' || status === 'unknown') return 'ok';
  if (status === 'restricted') return 'restricted';
  if (status === 'not-determined') {
    try {
      return (await sei.permissionsRequestMic()) ? 'ok' : 'blocked';
    } catch {
      return 'ok';
    }
  }
  return 'blocked';
}

/**
 * The poll check behind the microphone card. macOS reports a new grant live,
 * so its status is enough. On Windows the status does not follow the "Let
 * desktop apps access your microphone" switch (see micPreflight), so this
 * opens the mic for an instant and closes it again, and that is the whole
 * answer. Any failure other than a permission refusal (no mic plugged in, say)
 * is not this card's problem and counts as access: the call then reports the
 * real reason.
 */
export async function micAccessOk(platform: string = sei.platform): Promise<boolean> {
  if (platform === 'darwin') {
    try {
      return (await sei.permissionsStatus('mic')) === 'granted';
    } catch {
      return false;
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (err) {
    return !isPermissionRefusal(err);
  }
}

/** A getUserMedia failure that means "not allowed", not "no device". */
export function isPermissionRefusal(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const msg = String((err as Error)?.message ?? err ?? '');
  return name === 'NotAllowedError' || name === 'SecurityError' || /permission/i.test(msg);
}
