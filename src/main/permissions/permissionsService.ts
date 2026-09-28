/**
 * OS permission flows, electron side (260929). See osPermissions.ts for the
 * pure parts and shared/permissionsIpc.ts for the contract.
 *
 * Microphone: asked on the first Call press (askForMediaAccess, macOS only;
 * Windows has no per-app prompt for desktop apps), no longer at boot.
 * Screen Recording (macOS): read, probed by re-listing sources, and fixed from
 * System Settings; a relaunch with a resume flag covers the case where macOS
 * will not hand the grant to the running process.
 */
import { app, ipcMain, shell, systemPreferences } from 'electron';
import { z } from 'zod';
import { IpcChannel } from '../../shared/ipc';
import type { OsPermissionKind, OsPermissionStatus, PermissionResume } from '../../shared/permissionsIpc';
import { paths } from '../paths';
import {
  assertAllowedSettingsUrl,
  clearResume,
  normalizeStatus,
  parseResume,
  screenProbeSeesOtherApps,
  settingsUrlFor,
  takeResume,
  writeResume,
} from './osPermissions';

const KindSchema = z.enum(['mic', 'screen']);

function mediaType(kind: OsPermissionKind): 'microphone' | 'screen' {
  return kind === 'mic' ? 'microphone' : 'screen';
}

export function permissionStatus(kind: OsPermissionKind): OsPermissionStatus {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown';
  try {
    return normalizeStatus(systemPreferences.getMediaAccessStatus(mediaType(kind)));
  } catch {
    return 'unknown';
  }
}

/**
 * macOS: show the system microphone prompt if the user has never answered it,
 * and report whether access is granted. Resolves false at once (no prompt) when
 * it was denied or is restricted. Elsewhere: true unless the OS says denied;
 * the call's own getUserMedia is the real test on Windows.
 */
export async function requestMic(): Promise<boolean> {
  const status = permissionStatus('mic');
  if (process.platform !== 'darwin') return status !== 'denied' && status !== 'restricted';
  if (status === 'granted') return true;
  if (status !== 'not-determined') return false;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch {
    return false;
  }
}

/** Open the Settings page for this permission. False when there is none. */
export async function openPermissionSettings(kind: OsPermissionKind): Promise<boolean> {
  const url = settingsUrlFor(kind, process.platform, safeSystemVersion());
  if (!url) return false;
  assertAllowedSettingsUrl(url);
  await shell.openExternal(url);
  return true;
}

function safeSystemVersion(): string {
  try {
    return process.getSystemVersion();
  } catch {
    return '';
  }
}

/**
 * Re-list sources and decide whether Screen Recording is on. A 'granted'
 * status short-circuits; otherwise it is the fresh listing that decides (the
 * status call caches a denial for the life of the process). The first call
 * also puts Sei into the Screen Recording list in System Settings, so the
 * user has a switch to turn on.
 */
export async function probeScreen(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (permissionStatus('screen') === 'granted') return true;
  try {
    const { desktopCapturer } = await import('electron');
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return screenProbeSeesOtherApps(sources);
  } catch {
    return false;
  }
}

export function armResume(resume: PermissionResume): void {
  writeResume(paths.userData(), resume);
}

export function relaunchForResume(resume: PermissionResume): void {
  armResume(resume);
  // Same pattern as factory reset: the relaunch is honored however this
  // instance exits, and app.quit() runs the normal before-quit shutdown.
  app.relaunch();
  app.quit();
}

export function registerPermissionHandlers(): void {
  ipcMain.handle(IpcChannel.permissions.status, async (_e, kindArg: unknown) =>
    permissionStatus(KindSchema.parse(kindArg)),
  );
  ipcMain.handle(IpcChannel.permissions.requestMic, async () => requestMic());
  ipcMain.handle(IpcChannel.permissions.openSettings, async (_e, kindArg: unknown) =>
    openPermissionSettings(KindSchema.parse(kindArg)),
  );
  ipcMain.handle(IpcChannel.permissions.probeScreen, async () => probeScreen());
  ipcMain.handle(IpcChannel.permissions.armResume, async (_e, raw: unknown) => {
    const resume = parseResume(raw);
    if (!resume) throw new Error('Invalid resume flag');
    armResume(resume);
  });
  ipcMain.handle(IpcChannel.permissions.clearResume, async () => {
    clearResume(paths.userData());
  });
  ipcMain.handle(IpcChannel.permissions.takeResume, async () => takeResume(paths.userData()));
  ipcMain.handle(IpcChannel.permissions.relaunch, async (_e, raw: unknown) => {
    const resume = parseResume(raw);
    if (!resume) throw new Error('Invalid resume flag');
    relaunchForResume(resume);
  });
}
