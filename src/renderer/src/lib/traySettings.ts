/**
 * Renderer access to the "keep Sei in the menu bar / tray" setting (261005).
 *
 * Main owns the setting (a device-global file, see src/main/tray/); the
 * renderer only reads it and asks for changes. Every call is defensive: an
 * older preload or the dev harness may not have the methods, and a missing
 * answer means "unsupported", which hides every tray surface.
 */
import { sei } from './ipcClient';
import type { TraySetArgs, TraySettingsView } from '@shared/ipc';

function isView(v: unknown): v is TraySettingsView {
  return !!v && typeof v === 'object' && typeof (v as TraySettingsView).supported === 'boolean';
}

export async function loadTraySettings(): Promise<TraySettingsView | null> {
  try {
    const v: unknown = await sei.trayGetSettings?.();
    return isView(v) ? v : null;
  } catch {
    return null;
  }
}

export async function saveTraySettings(args: TraySetArgs): Promise<TraySettingsView | null> {
  try {
    const v: unknown = await sei.traySetSettings?.(args);
    return isView(v) ? v : null;
  } catch {
    return null;
  }
}

export async function markWallPromptSeen(): Promise<void> {
  try {
    await sei.trayMarkWallPromptSeen?.();
  } catch {
    /* best effort: at worst the prompt shows once more */
  }
}

/**
 * Whether the credit wall should offer the setting: only where the platform
 * has a tray, only while the setting is off, and only once per install.
 */
export function shouldOfferWallPrompt(view: TraySettingsView | null): boolean {
  return !!view && view.supported && !view.enabled && !view.wallPromptSeen;
}
