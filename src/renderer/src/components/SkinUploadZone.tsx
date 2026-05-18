/**
 * SkinUploadZone — drag-and-drop + click-to-browse source-of-skin entry point.
 *
 * Behaviors:
 *   - Click / Enter / Space → invoke the Electron native file picker via
 *     `sei.uploadSkinPng()` (Plan 03 handler). On success, hand the bytes
 *     to `onUpload`. On cancel, no-op. On error, surface the classifier's
 *     copy via `onError`.
 *   - Drag a File from the OS shell → validate PNG type, magic, and 64×64
 *     dimensions client-side (defense-in-depth against the main-side gate
 *     already in skinUpload.ts), compute sha256 via Web Crypto, hand bytes
 *     to `onUpload`. On any failure: `onError(ERROR_COPY.SKIN_FILE_INVALID)`.
 *
 * Source: 09-UI-SPEC.md §"Skin editor — copy" (verbatim copy below) +
 * §"Interaction States" (resting / hover / focus / drag-over).
 *
 * a11y:
 *   - root is `role="button" tabIndex=0`; Enter/Space activates the picker
 *   - `aria-describedby` points at the secondary "Files stay on your computer" hint
 *   - drag-over visual change is mirrored in copy ("Drop to upload") — not color-only
 */

import React, { useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { ERROR_COPY } from '../lib/errors';
import { classifyRendererError } from '../lib/errors';
import styles from './SkinUploadZone.module.css';

export interface SkinUploadZoneProps {
  onUpload: (result: { pngBase64: string; sha256: string }) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

// PNG magic bytes — first 8 bytes of every PNG file (RFC 2083 §3.1).
//   0x89  P  N  G  CR LF SUB LF
const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Validate that a Uint8Array buffer is a 64×64 PNG. Mirrors src/main/skinImageUtil.ts
 * `parsePngIhdr` minimal contract — only checks what's needed to reject obviously
 * wrong files BEFORE handing bytes to the main-side strict gate. The main-side
 * validator stays the source of truth; this is a UX nicety so users get feedback
 * without a round-trip when they drop a JPG/16×16 PNG/etc.
 */
function validatePng64x64(bytes: Uint8Array): { ok: true } | { ok: false; reason: string } {
  if (bytes.length < 24) {
    return { ok: false, reason: 'File too small to be a PNG.' };
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) {
      return { ok: false, reason: 'Not a PNG (magic bytes mismatch).' };
    }
  }
  // IHDR chunk starts at offset 8. Layout: 4-byte length + 4-byte type "IHDR"
  // + 4-byte width (big-endian) + 4-byte height + 1-byte bit-depth + 1-byte
  // color-type. We only need width/height here.
  // Width  = bytes[16..19], Height = bytes[20..23], big-endian.
  const width =
    ((bytes[16] ?? 0) << 24) | ((bytes[17] ?? 0) << 16) | ((bytes[18] ?? 0) << 8) | (bytes[19] ?? 0);
  const height =
    ((bytes[20] ?? 0) << 24) | ((bytes[21] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[23] ?? 0);
  if (width !== 64 || height !== 64) {
    return { ok: false, reason: `Wrong dimensions: ${width}×${height} (expected 64×64).` };
  }
  return { ok: true };
}

/** Base64-encode a small (≤2KB) byte buffer via btoa(String.fromCharCode(...)). */
function bytesToBase64(bytes: Uint8Array): string {
  // 64×64 PNG is <2KB; String.fromCharCode(...bytes) is safe at this size.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Hex-encode an ArrayBuffer (sha256 digest output). */
function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function SkinUploadZone({
  onUpload,
  onError,
  disabled,
}: SkinUploadZoneProps): React.ReactElement {
  const [dragOver, setDragOver] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Hidden <input type=file> kept for fallback keyboard activation if the
  // native picker IPC ever fails (extremely defensive — primary path is `sei.uploadSkinPng`).
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleClick = async (): Promise<void> => {
    if (disabled) return;
    try {
      const res = await sei.uploadSkinPng();
      if (res === null) return; // user cancelled the native dialog
      onUpload({ pngBase64: res.pngBase64, sha256: res.sha256 });
    } catch (err) {
      const classified = classifyRendererError(err);
      onError(classified.copy);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void handleClick();
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (disabled) return;
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (disabled) return;
    // Only flip off when the cursor actually leaves the root (not its children).
    if (e.target === rootRef.current) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    if (disabled) return;
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) {
      onError(ERROR_COPY.SKIN_FILE_INVALID);
      return;
    }
    if (file.type && file.type !== 'image/png') {
      onError(ERROR_COPY.SKIN_FILE_INVALID);
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const check = validatePng64x64(bytes);
      if (!check.ok) {
        onError(ERROR_COPY.SKIN_FILE_INVALID);
        return;
      }
      const pngBase64 = bytesToBase64(bytes);
      // Web Crypto subtle digest — runs in the renderer process; same algorithm
      // as main's sha256 so the persisted png_sha256 matches between paths.
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const sha256 = bufferToHex(digest);
      onUpload({ pngBase64, sha256 });
    } catch {
      onError(ERROR_COPY.SKIN_FILE_INVALID);
    }
  };

  const zoneClass = [
    styles.zone,
    dragOver ? styles.dragOver : '',
    disabled ? styles.disabled : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className={zoneClass}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? true : undefined}
      aria-describedby="skin-upload-zone-secondary"
      onClick={() => void handleClick()}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* Hidden fallback input — never actually triggered in the happy path, but
          kept around for environments where the IPC native picker fails (e.g.
          test harnesses that don't expose window.sei). */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png"
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
      />
      <p className={styles.heading}>
        {dragOver ? 'Drop to upload' : 'Drop a 64x64 PNG here, or click to browse'}
      </p>
      <p id="skin-upload-zone-secondary" className={styles.secondary}>
        Files stay on your computer.
      </p>
    </div>
  );
}
