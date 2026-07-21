/**
 * Screen-share capture plumbing (260720) — the only Electron-touching half of
 * the watch feature. desktopCapturer thumbnails ONLY: no MediaStream pipeline,
 * no renderer involvement, no disk writes. Each poll grabs a ~1280x720 JPEG
 * for the (possible) LLM send, a 64x36 grayscale for the change gate, and a
 * small JPEG for the aside's live preview.
 *
 * watchService takes this module through its deps so tests can inject fake
 * frames without loading Electron.
 */
import { desktopCapturer, shell, systemPreferences } from 'electron';
import type { WatchPermissionStatus, WatchSource } from '../../shared/watchIpc';
import { GRAY_H, GRAY_W, grayFromBitmap, type CapturedFrame } from './changeGate';

export type { CapturedFrame } from './changeGate';
export { GRAY_H, GRAY_W } from './changeGate';

/** Max size of the frame that may reach the LLM. */
const FRAME_W = 1280;
const FRAME_H = 720;

/** Preview snapshot width pushed to the renderer aside (~every poll). */
const PREVIEW_W = 480;

/**
 * List capturable sources for the picker. Windows first (the encouraged,
 * least-oversharing pick), then screens. Sources with an empty thumbnail
 * (minimized windows, permission-blocked captures) are dropped. On macOS the
 * getSources call itself registers the app under Screen Recording in System
 * Settings when permission was never requested.
 */
export async function listSources(): Promise<WatchSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const out: WatchSource[] = [];
  for (const s of sources) {
    if (!s.thumbnail || s.thumbnail.isEmpty()) continue;
    // Skip our own window: sharing Sei to Sei is never what the player wants.
    if (s.id.startsWith('window:') && /^Sei$/i.test(s.name.trim())) continue;
    out.push({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnailDataUrl: `data:image/jpeg;base64,${s.thumbnail.toJPEG(60).toString('base64')}`,
      ...(s.appIcon && !s.appIcon.isEmpty()
        ? { appIconDataUrl: s.appIcon.toDataURL() }
        : {}),
    });
  }
  // Windows first, stable within each kind (getSources order is z-order-ish).
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'window' ? -1 : 1));
  return out;
}

/**
 * Capture one frame of `sourceId`. Returns null when the source no longer
 * exists (window closed) or produced an empty thumbnail.
 */
export async function captureFrame(sourceId: string): Promise<CapturedFrame | null> {
  const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: { width: FRAME_W, height: FRAME_H },
  });
  const src = sources.find((s) => s.id === sourceId);
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;

  const thumb = src.thumbnail;
  const tiny = thumb.resize({ width: GRAY_W, height: GRAY_H, quality: 'good' });
  const gray = grayFromBitmap(new Uint8Array(tiny.toBitmap()), GRAY_W * GRAY_H);

  const size = thumb.getSize();
  const preview =
    size.width > PREVIEW_W
      ? thumb.resize({ width: PREVIEW_W, quality: 'good' })
      : thumb;

  return {
    jpegBase64: thumb.toJPEG(70).toString('base64'),
    gray,
    previewDataUrl: `data:image/jpeg;base64,${preview.toJPEG(55).toString('base64')}`,
    capturedAt: Date.now(),
  };
}

/** macOS Screen Recording permission; other platforms have no OS gate. */
export function permissionStatus(): WatchPermissionStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') as WatchPermissionStatus;
  } catch {
    return 'unknown';
  }
}

/** Deep-link to System Settings > Privacy & Security > Screen Recording. */
export async function openPermissionSettings(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}
