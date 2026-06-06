/**
 * PortraitImagePicker — image-upload control used by EditCharacterModal and
 * AddCharacterScreen. As of Plan 11-06 (D-28) the picker no longer inlines
 * the image as a base64 data URL — instead it:
 *
 *   1. Loads the picked file into an HTMLImageElement
 *   2. Renders it to a <canvas> at min(originalDim, 1024) preserving aspect
 *   3. Re-encodes to PNG via canvas.toBlob (≤500KB after resize)
 *   4. Sends the bytes to main via sei.charsApplyPortrait
 *   5. Stores the returned path reference '<uuid>.png' in onChange
 *
 * Main re-validates (magic + size + PNG dim) and writes to
 * <userData>/portraits/<uuid>.png. The picker is therefore characterId-bound:
 * the character must already exist before the picker can apply a portrait
 * (AddCharacterScreen does this — step 1 creates the character, step 2 picks
 * the portrait).
 *
 * Source: 11-06-PLAN.md Task 3 + 11-RESEARCH §Pattern 5.
 */
import React, { useRef } from 'react';
import { sei } from '../lib/ipcClient';
import { portraitSrc } from '../lib/portraitSrc';

/** D-28 limits (mirror PORTRAIT_MAX_BYTES / PORTRAIT_MAX_DIM in src/main/portraitImageUtil.ts). */
const MAX_BYTES = 500 * 1024;
const MAX_DIM = 1024;

export interface PortraitImagePickerProps {
  /** UUID of the persisted character to attach this portrait to. */
  characterId: string;
  /** Current portrait reference ('<uuid>.png') or null. */
  value: string | null;
  /** Called with the new path reference after a successful apply, or null on remove. */
  onChange: (portraitRef: string | null) => void;
}

export function PortraitImagePicker({
  characterId,
  value,
  onChange,
}: PortraitImagePickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);

  const onPick = (): void => {
    if (busy) return;
    inputRef.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file (PNG/JPG/WebP).');
      return;
    }
    setBusy(true);
    try {
      // Step 1+2: decode into <img>, then redraw to <canvas> at ≤1024² preserving aspect.
      const objectUrl = URL.createObjectURL(file);
      let pngBytes: Uint8Array;
      try {
        const img = await loadImage(objectUrl);
        pngBytes = await resizeToPngBytes(img, MAX_DIM);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      // Defensive client-side cap before sending across IPC. Main re-checks.
      if (pngBytes.byteLength > MAX_BYTES) {
        setError('Image too large after resize (max 500KB). Try a simpler picture.');
        return;
      }

      // Step 4: base64 + IPC. The byte → base64 conversion uses the
      // chunked btoa pattern to avoid blowing the stack on large arrays.
      const bytesBase64 = bytesToBase64(pngBytes);
      const ref = await sei.charsApplyPortrait({
        characterId,
        bytesBase64,
        format: 'png',
      });
      onChange(ref);
    } catch (err) {
      const msg = (err as Error).message ?? 'Failed to apply portrait.';
      setError(prettifyError(msg));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sei.charsRemovePortrait(characterId);
      onChange(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to remove portrait.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {value ? (
        <img
          src={portraitSrc(value)!}
          alt="Card image preview"
          style={{
            width: 56,
            height: 56,
            objectFit: 'cover',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
        />
      ) : (
        <div
          style={{
            width: 56,
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--border)',
            borderRadius: 4,
            color: 'var(--muted)',
            fontSize: 11,
            fontFamily: 'var(--mono)',
          }}
        >
          NONE
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => void onFile(e)}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        style={{
          fontFamily: 'inherit',
          fontSize: 13,
          padding: '6px 12px',
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--text)',
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Working…' : value ? 'Change' : 'Upload'}
      </button>
      {value ? (
        <button
          type="button"
          onClick={() => void onRemove()}
          disabled={busy}
          style={{
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '6px 12px',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--red)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Remove
        </button>
      ) : null}
      {error ? (
        <span style={{ color: 'var(--red)', fontSize: 12, fontFamily: 'var(--mono)' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the picked file as an image.'));
    img.src = src;
  });
}

async function resizeToPngBytes(img: HTMLImageElement, maxDim: number): Promise<Uint8Array> {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (srcW === 0 || srcH === 0) throw new Error('Image has zero dimensions.');
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not allocate a 2D canvas context.');
  ctx.drawImage(img, 0, 0, dstW, dstH);
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.92));
  if (!blob) throw new Error('Could not re-encode the image as PNG.');
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Chunked Uint8Array → base64 conversion. String.fromCharCode(...arr) blows
 * the stack on arrays bigger than ~65KB on some engines; chunk to keep it safe.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    s += String.fromCharCode(...slice);
  }
  return btoa(s);
}

/** Map the well-known main-side error codes to user-friendly copy. */
function prettifyError(msg: string): string {
  if (msg.includes('PORTRAIT_TOO_LARGE_DIM')) return 'Picture is too big (max 1024×1024).';
  if (msg.includes('PORTRAIT_TOO_LARGE')) return 'File too large (max 500KB after resize).';
  if (msg.includes('PORTRAIT_TOO_SHORT')) return 'File looks empty.';
  if (msg.includes('PORTRAIT_BAD_MAGIC')) return 'Only PNG, JPEG, or WebP images are accepted.';
  return msg;
}
