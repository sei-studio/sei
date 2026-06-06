/**
 * Native OS file-picker pipeline for user-supplied Minecraft skin PNGs.
 *
 * Lifts the renderer out of needing a file-input element + drag-and-drop
 * handler — main owns the dialog so we can validate the PNG (magic + 64×64
 * IHDR) BEFORE handing bytes back to the renderer for the 3D preview. The
 * renderer then calls `skin:apply` with the base64 payload; main is the trust
 * boundary for the byte-validity check (applyPng re-validates as
 * defense-in-depth).
 *
 * Differs from mojangSkinLookup.normalize64x64 path: user uploads must
 * ALREADY be 64×64. Legacy 64×32 upscaling is reserved for Mojang downloads
 * only — if the user has a 64×32 file kicking around, they can drop it into
 * a converter offline. We surface "must be 64×64" copy via SKIN_FILE_INVALID
 * so they know what to do.
 *
 * Every throw starts with `SKIN_FILE_INVALID:` so the renderer's classifier
 * routes the message to `ERROR_COPY[SKIN_FILE_INVALID]` with no new rules.
 *
 * Sources:
 *   - src/main/skinStore.ts (same magic + IHDR parse, mirrored for defense-in-depth)
 *   - src/shared/errorClasses.ts (SKIN_FILE_INVALID)
 *   - Electron docs: dialog.showOpenDialog → { canceled, filePaths }
 */
import { BrowserWindow, dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { parsePngIhdr } from './skinImageUtil';

export interface SkinUploadResult {
  pngBase64: string;
  sha256: string;
}

const DIALOG_OPTIONS: Electron.OpenDialogOptions = {
  title: 'Choose a 64x64 Minecraft skin PNG',
  properties: ['openFile'],
  filters: [{ name: 'PNG Images', extensions: ['png'] }],
};

/**
 * Open the native file dialog, read + validate the chosen PNG, and return
 * `{ pngBase64, sha256 }`. Returns `null` when the user cancels (rather than
 * throwing — cancel is a normal flow, not an error).
 *
 * Validation:
 *   - File length ≥ 24 bytes (PNG signature 8 + IHDR length 4 + type 4 + at
 *     least width/height fields)
 *   - PNG signature 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
 *   - IHDR width === 64 && height === 64
 *
 * The OS file-picker filter restricts the visible files to *.png, but a user
 * could still rename a non-PNG to .png — magic + IHDR are the real gates.
 */
export async function openSkinPicker(): Promise<SkinUploadResult | null> {
  // Resolve a modal parent so the dialog attaches to the Sei window on macOS
  // (sheet) / Windows / Linux. Falls back to "no parent" if no window is open.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showOpenDialog(win, DIALOG_OPTIONS)
    : await dialog.showOpenDialog(DIALOG_OPTIONS);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const filePath = result.filePaths[0];

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SKIN_FILE_INVALID: could not read selected file: ${msg}`);
  }

  // Defense-in-depth magic check: parsePngIhdr throws on signature mismatch,
  // but its message starts with "parsePngIhdr:" — we want the SKIN_FILE_INVALID
  // prefix for the renderer's classifier, so wrap the throw.
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error('SKIN_FILE_INVALID: selected file is not a PNG (magic-byte mismatch)');
  }

  let header;
  try {
    header = parsePngIhdr(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SKIN_FILE_INVALID: ${msg}`);
  }

  if (header.width !== 64 || header.height !== 64) {
    throw new Error(
      `SKIN_FILE_INVALID: PNG must be 64×64 (got ${header.width}×${header.height})`,
    );
  }

  return {
    pngBase64: bytes.toString('base64'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
