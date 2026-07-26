/**
 * BackgroundImagePicker — Settings → Theme control for the custom app
 * background (260724). Pick → downscale to ≤2560px on a canvas → compress
 * under the size budget (WebP ladder, then JPEG) → send bytes to main via
 * sei.userApplyBackground, which validates and writes the fixed `_bg.png`
 * slot in the active profile's portraits dir. Same bytes-over-IPC pipeline
 * as PortraitImagePicker, minus the crop step (a wallpaper is used whole,
 * cover-fitted by the renderer).
 */
import React, { useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { portraitSrc } from '../lib/portraitSrc';
import { Button } from './Button';

/** Renderer-side budget, under main's BACKGROUND_MAX_BYTES (4 MB). */
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_DIM = 2560;

export interface BackgroundImagePickerProps {
  /** Current background ref ('_bg.png') or null. */
  value: string | null;
  /** Cache-buster so a re-upload of the fixed ref refreshes the preview. */
  bust: number;
  /** Called with the new ref after apply, or null after remove. */
  onChange: (ref: string | null) => void;
}

export function BackgroundImagePicker({
  value,
  bust,
  onChange,
}: BackgroundImagePickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

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
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(objectUrl);
      const { bytes, format } = await imageToBackgroundBytes(img, MAX_BYTES);
      const ref = await sei.userApplyBackground({ bytesBase64: bytesToBase64(bytes), format });
      onChange(ref);
    } catch (err) {
      setError(prettifyError((err as Error).message ?? 'Failed to set the background.'));
    } finally {
      URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  };

  const onRemove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sei.userRemoveBackground();
      onChange(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to remove the background.');
    } finally {
      setBusy(false);
    }
  };

  const base = value ? portraitSrc(value) : null;
  const src = base ? `${base}?v=${bust}` : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {src ? (
        <img
          src={src}
          alt="Background preview"
          style={{
            width: 72,
            height: 40,
            objectFit: 'cover',
            border: '1px solid var(--border)',
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            letterSpacing: '0.04em',
            color: 'var(--muted)',
          }}
        >
          None
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => void onFile(e)}
        style={{ display: 'none' }}
      />
      <Button kind="ghost" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Working…' : value ? 'Change' : 'Upload'}
      </Button>
      {value ? (
        <Button kind="ghost" size="sm" disabled={busy} onClick={() => void onRemove()}>
          Remove
        </Button>
      ) : null}
      {error ? (
        <span style={{ color: 'var(--red)', fontSize: 12, fontFamily: 'var(--mono)' }}>{error}</span>
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

type BgFormat = 'png' | 'jpeg' | 'webp';

/**
 * Downscale to ≤MAX_DIM and compress under `maxBytes`. WebP first (handles
 * both photos and flat art well, keeps alpha), then JPEG as a fallback,
 * shrinking further if nothing fits.
 */
async function imageToBackgroundBytes(
  img: HTMLImageElement,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; format: BgFormat }> {
  let smallest: { bytes: Uint8Array; format: BgFormat } | null = null;

  const consider = async (
    blob: Blob | null,
    format: BgFormat,
  ): Promise<{ bytes: Uint8Array; format: BgFormat } | null> => {
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) smallest = { bytes, format };
    return bytes.byteLength <= maxBytes ? { bytes, format } : null;
  };

  for (const scale of [1, 0.8, 0.6, 0.45]) {
    const canvas = drawScaled(img, scale);
    for (const q of [0.88, 0.78, 0.66]) {
      const webp = await encode(canvas, 'image/webp', q);
      const rw = await consider(webp, 'webp');
      if (rw) return rw;
    }
    for (const q of [0.85, 0.72, 0.6]) {
      const jpg = await encode(canvas, 'image/jpeg', q);
      const rj = await consider(jpg, 'jpeg');
      if (rj) return rj;
    }
  }
  if (smallest) return smallest;
  throw new Error('Could not encode the image.');
}

function drawScaled(img: HTMLImageElement, scale: number): HTMLCanvasElement {
  const fit = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight)) * scale;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * fit));
  c.height = Math.max(1, Math.round(img.naturalHeight * fit));
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return c;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Chunked Uint8Array → base64 (String.fromCharCode blows the stack on big arrays). */
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    s += String.fromCharCode(...slice);
  }
  return btoa(s);
}

function prettifyError(msg: string): string {
  if (msg.includes('BACKGROUND_TOO_LARGE_DIM')) return 'Picture is too big (max 4096x4096).';
  if (msg.includes('BACKGROUND_TOO_LARGE')) return 'File too large (max 4MB after resize).';
  if (msg.includes('BACKGROUND_TOO_SHORT')) return 'File looks empty.';
  if (msg.includes('BACKGROUND_BAD_MAGIC')) return 'Only PNG, JPEG, or WebP images are accepted.';
  return msg;
}
