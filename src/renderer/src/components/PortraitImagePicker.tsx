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
import { PortraitCropModal } from './PortraitCropModal';
import { UserIcon } from './icons';
import avatarStyles from './PortraitImagePicker.module.css';

/** D-28 size budget (mirrors PORTRAIT_MAX_BYTES in src/main/portraitImageUtil.ts). */
const MAX_BYTES = 500 * 1024;

export interface PortraitImagePickerProps {
  /**
   * UUID of the persisted character to attach this portrait to. Optional when
   * `applyOverride` / `removeOverride` are provided (e.g. the user-profile
   * variant in Settings, which targets the current user instead of a character).
   */
  characterId?: string;
  /** Current portrait reference ('<uuid>.png') or null. */
  value: string | null;
  /** Called with the new path reference after a successful apply, or null on remove. */
  onChange: (portraitRef: string | null) => void;
  /**
   * Phase 18/19 — apply/remove override hooks. When provided, the picker calls
   * these instead of the character portrait IPC (sei.charsApplyPortrait /
   * sei.charsRemovePortrait), letting the same control target the user's profile
   * picture. The bytes/encoding pipeline is unchanged. (D-28 semantics: main
   * still re-validates magic + size + dims.)
   */
  applyOverride?: (args: { bytesBase64: string; format: 'png' | 'jpeg' | 'webp' }) => Promise<string>;
  removeOverride?: () => Promise<void>;
  /**
   * Presentation. 'default' = square preview + Upload/Change/Remove buttons.
   * 'avatar' = a circular preview that reveals a "Change" overlay on hover and
   * opens the picker on click (the user's profile picture in Settings).
   */
  variant?: 'default' | 'avatar';
}

export function PortraitImagePicker({
  characterId,
  value,
  onChange,
  applyOverride,
  removeOverride,
  variant = 'default',
}: PortraitImagePickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);
  // Decoded source image awaiting crop/preview in the popup (null = closed).
  const [cropImg, setCropImg] = React.useState<HTMLImageElement | null>(null);
  // Object URL backing the crop modal's <img>; revoked when the modal closes.
  const cropUrlRef = useRef<string | null>(null);

  const onPick = (): void => {
    if (busy) return;
    inputRef.current?.click();
  };

  const closeCrop = (): void => {
    if (cropUrlRef.current) {
      URL.revokeObjectURL(cropUrlRef.current);
      cropUrlRef.current = null;
    }
    setCropImg(null);
  };

  // Pick → decode → open the crop/preview popup. We no longer reject on size:
  // any image is accepted here, then downsized to fit on confirm.
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file (PNG/JPG/WebP).');
      return;
    }
    try {
      const objectUrl = URL.createObjectURL(file);
      const img = await loadImage(objectUrl);
      if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current);
      cropUrlRef.current = objectUrl;
      setCropImg(img);
    } catch (err) {
      setError((err as Error).message ?? 'Could not open that image.');
    }
  };

  // Confirm from the crop popup → compress the cropped canvas under the size
  // budget (auto-downscaling / re-encoding so ANY image fits), then apply.
  const onCropConfirm = async (canvas: HTMLCanvasElement): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { bytes, format } = await canvasToPortraitBytes(canvas, MAX_BYTES);
      if (bytes.byteLength > MAX_BYTES) {
        // Unreachable in practice (the compressor targets the budget), but keep
        // a guard so a pathological input surfaces a clear message.
        setError('Could not get this image under 500KB. Try a simpler picture.');
        return;
      }
      const bytesBase64 = bytesToBase64(bytes);
      const ref = applyOverride
        ? await applyOverride({ bytesBase64, format })
        : await sei.charsApplyPortrait({ characterId: characterId as string, bytesBase64, format });
      onChange(ref);
    } catch (err) {
      setError(prettifyError((err as Error).message ?? 'Failed to apply portrait.'));
    } finally {
      setBusy(false);
      closeCrop();
    }
  };

  const onRemove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (removeOverride) await removeOverride();
      else await sei.charsRemovePortrait(characterId as string);
      onChange(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to remove portrait.');
    } finally {
      setBusy(false);
    }
  };

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      onChange={(e) => void onFile(e)}
      style={{ display: 'none' }}
    />
  );

  // Avatar variant — circular, click-to-change, no buttons (Settings profile).
  if (variant === 'avatar') {
    const src = value ? portraitSrc(value) : null;
    return (
      <>
        <button
          type="button"
          className={avatarStyles.avatar}
          onClick={onPick}
          disabled={busy}
          aria-label={value ? 'Change profile picture' : 'Add profile picture'}
        >
          {src ? (
            <img src={src} alt="" className={avatarStyles.avatarImg} />
          ) : (
            <UserIcon size={22} />
          )}
          <span className={avatarStyles.avatarOverlay}>{busy ? '…' : 'Change'}</span>
        </button>
        {hiddenInput}
        {error ? <span className={avatarStyles.err}>{error}</span> : null}
        {cropImg ? (
          <PortraitCropModal
            image={cropImg}
            busy={busy}
            onCancel={closeCrop}
            onConfirm={(canvas) => void onCropConfirm(canvas)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
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
    {cropImg ? (
      <PortraitCropModal
        image={cropImg}
        busy={busy}
        onCancel={closeCrop}
        onConfirm={(canvas) => void onCropConfirm(canvas)}
      />
    ) : null}
    </>
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

type PortraitFormat = 'png' | 'jpeg' | 'webp';

/**
 * Compress a (cropped) canvas to bytes that fit `maxBytes`, downscaling and
 * lowering quality as needed so ANY image can be accepted. Strategy:
 *   - Opaque image → JPEG (great for photos), quality ladder per scale step.
 *   - Image with transparency → PNG first (lossless, preserves alpha), then
 *     lossy WebP (still preserves alpha) before shrinking further — we never
 *     fall back to JPEG for alpha images (it would fill transparent pixels).
 * The original bug: the old path always re-encoded to lossless PNG at up to
 * 1024², so a small JPEG photo ballooned past 500KB and was rejected instead
 * of compressed.
 */
async function canvasToPortraitBytes(
  source: HTMLCanvasElement,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; format: PortraitFormat }> {
  const hasAlpha = canvasHasAlpha(source);
  const scales = [1, 0.85, 0.7, 0.55, 0.42, 0.32, 0.24];
  let smallest: { bytes: Uint8Array; format: PortraitFormat } | null = null;

  const consider = async (
    blob: Blob | null,
    format: PortraitFormat,
  ): Promise<{ bytes: Uint8Array; format: PortraitFormat } | null> => {
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) smallest = { bytes, format };
    return bytes.byteLength <= maxBytes ? { bytes, format } : null;
  };

  for (const s of scales) {
    const cv = s >= 1 ? source : downscaleCanvas(source, s);
    if (hasAlpha) {
      const png = await encode(cv, 'image/png');
      const rp = await consider(png, 'png');
      if (rp) return rp;
      for (const q of [0.92, 0.85, 0.78, 0.7, 0.6, 0.5]) {
        const webp = await encode(cv, 'image/webp', q);
        const rw = await consider(webp, 'webp');
        if (rw) return rw;
      }
    } else {
      for (const q of [0.92, 0.86, 0.8, 0.72, 0.64, 0.55, 0.45, 0.35]) {
        const jpg = await encode(cv, 'image/jpeg', q);
        const rj = await consider(jpg, 'jpeg');
        if (rj) return rj;
      }
    }
  }

  // Nothing fit even at the smallest scale/quality — apply the smallest we got
  // (main re-validates; an honest error surfaces only for truly pathological input).
  if (smallest) return smallest;
  throw new Error('Could not encode the image.');
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function downscaleCanvas(src: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext('2d');
  if (!ctx) return src;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** True if any pixel has alpha < 255 (so we must preserve transparency). */
function canvasHasAlpha(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  } catch {
    return false;
  }
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
