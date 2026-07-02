/**
 * PortraitCropModal — in-app crop/preview popup for character images.
 *
 * Shown by PortraitImagePicker after a file is decoded, BEFORE it is
 * compressed + applied. The user pans (drag) and zooms (slider / wheel) the
 * source image inside a fixed portrait frame (the 210:312 card aspect — the
 * hero display; the square avatar/preview center-crop this acceptably). On
 * confirm we render the visible frame region to an output canvas at full
 * working resolution and hand it back; the picker's compressor then guarantees
 * the encoded bytes fit the portrait size budget.
 *
 * Zero dependencies — pointer events + canvas only (no crop library). Matches
 * the design system: scrim + --surface card, --border-strong outline, sharp
 * corners (D-28), Oswald title / Rajdhani hint / accent CTA.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import styles from './PortraitCropModal.module.css';

// On-screen crop frame, portrait card aspect (210:312).
const FRAME_W = 268;
const FRAME_H = Math.round(FRAME_W * (312 / 210)); // 398
// Output resolution of the cropped image (both ≤ 1024 → within PORTRAIT_MAX_DIM).
const OUT_W = 600;
const OUT_H = Math.round(OUT_W * (FRAME_H / FRAME_W));
const MAX_ZOOM = 4;

export interface PortraitCropModalProps {
  /** Already-decoded source image (object URL still alive). */
  image: HTMLImageElement;
  onCancel: () => void;
  /** Receives the cropped, full-resolution output canvas. */
  onConfirm: (canvas: HTMLCanvasElement) => void;
  /** Disables the actions while the parent compresses + uploads. */
  busy?: boolean;
}

interface Offset {
  x: number;
  y: number;
}

export function PortraitCropModal({
  image,
  onCancel,
  onConfirm,
  busy = false,
}: PortraitCropModalProps): React.ReactElement {
  const imgW = image.naturalWidth || image.width || 1;
  const imgH = image.naturalHeight || image.height || 1;
  // Base scale so the image always COVERS the frame at zoom = 1 (no gaps).
  const baseScale = Math.max(FRAME_W / imgW, FRAME_H / imgH);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Keep the frame fully covered: clamp the pan so the image never reveals a gap.
  const clampOffset = useCallback(
    (o: Offset, z: number): Offset => {
      const dispW = imgW * baseScale * z;
      const dispH = imgH * baseScale * z;
      const maxX = Math.max(0, (dispW - FRAME_W) / 2);
      const maxY = Math.max(0, (dispH - FRAME_H) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, o.x)),
        y: Math.min(maxY, Math.max(-maxY, o.y)),
      };
    },
    [imgW, imgH, baseScale],
  );

  // Re-clamp the pan whenever zoom changes (zooming out can push the frame past the edge).
  useEffect(() => {
    setOffset((o) => clampOffset(o, zoom));
  }, [zoom, clampOffset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (busy) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clampOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, zoom));
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  const onWheel = (e: React.WheelEvent): void => {
    if (busy) return;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z - e.deltaY * 0.0022)));
  };

  const confirm = (): void => {
    if (busy) return;
    const dispScale = baseScale * zoom;
    const dispW = imgW * dispScale;
    const dispH = imgH * dispScale;
    // Displayed image top-left in frame coords (frame origin = its top-left).
    const imgLeft = FRAME_W / 2 + offset.x - dispW / 2;
    const imgTop = FRAME_H / 2 + offset.y - dispH / 2;
    // Map the frame rect back into source pixels.
    let sx = (0 - imgLeft) / dispScale;
    let sy = (0 - imgTop) / dispScale;
    let sw = FRAME_W / dispScale;
    let sh = FRAME_H / dispScale;
    // Numeric safety clamp to the source bounds (pan clamp already guarantees this).
    sx = Math.max(0, Math.min(sx, imgW));
    sy = Math.max(0, Math.min(sy, imgH));
    sw = Math.max(1, Math.min(sw, imgW - sx));
    sh = Math.max(1, Math.min(sh, imgH - sy));

    const canvas = document.createElement('canvas');
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onCancel();
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H);
    onConfirm(canvas);
  };

  const dispW = imgW * baseScale * zoom;
  const dispH = imgH * baseScale * zoom;

  return (
    <div className={styles.wrap} role="dialog" aria-modal="true" aria-label="Crop image">
      <div className={styles.scrim} onClick={() => !busy && onCancel()} />
      <div className={styles.card}>
        <div className={styles.title}>Crop your image</div>
        <div className={styles.hint}>Drag to reposition. Scroll or use the slider to zoom.</div>

        <div
          className={styles.stage}
          style={{ width: FRAME_W, height: FRAME_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <img
            className={styles.img}
            src={image.src}
            alt=""
            draggable={false}
            style={{
              width: dispW,
              height: dispH,
              left: FRAME_W / 2 + offset.x - dispW / 2,
              top: FRAME_H / 2 + offset.y - dispH / 2,
            }}
          />
          <div className={styles.frameOverlay} aria-hidden="true" />
        </div>

        <input
          className={styles.zoom}
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          disabled={busy}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label="Zoom"
        />

        <div className={styles.actions}>
          <Button kind="quiet" size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button kind="accent" size="md" onClick={confirm} disabled={busy}>
            {busy ? 'Working…' : 'Use photo'}
          </Button>
        </div>
      </div>
    </div>
  );
}
