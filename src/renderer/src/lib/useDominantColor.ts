/**
 * useDominantColor — extract a character portrait's signature color for
 * surface tinting (chat presence panel, 260705).
 *
 * Loading: the image is fetched to a blob first (sei-portrait:// has
 * supportFetchAPI, and a blob: URL is same-origin) so canvas readback never
 * taints; a plain <img> load is the fallback for anything fetch can't reach.
 *
 * Extraction: downscale to 24×24 and vote hue buckets over VIVID pixels only
 * (opaque, saturated, mid-to-bright) — flat white/transparent backgrounds and
 * black linework carry zero weight, so the character's own color wins even on
 * a mostly-background portrait. The winning bucket's average is then boosted
 * to a bright tint (saturation ≥ 0.65, value ≥ 0.9) so the wash reads as the
 * character's color, not a muddy mean. Returns `rgb(r g b)` or null (no
 * portrait / load failure / nothing vivid) — callers fall back to the plain
 * surface. Results are memoized per src for the session.
 */

import { useEffect, useState } from 'react';

const cache = new Map<string, string | null>();

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

function extract(img: HTMLImageElement): string | null {
  try {
    const N = 24;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    // 12 hue buckets (30° each). Two passes: strict (vivid only), then a
    // relaxed pass for pale/muted portraits where nothing clears the bar.
    const vote = (minSat: number, minVal: number): { h: number; s: number; v: number } | null => {
      const buckets = Array.from({ length: 12 }, () => ({ h: 0, s: 0, v: 0, w: 0 }));
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue; // transparent background
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const val = mx / 255;
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        // Reject background/linework: white (bright + unsaturated), black.
        if (sat < minSat || val < minVal) continue;
        let h = 0;
        if (mx !== mn) {
          if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
          else if (mx === g) h = (b - r) / (mx - mn) + 2;
          else h = (r - g) / (mx - mn) + 4;
          h *= 60;
        }
        const w = sat * val;
        const k = Math.floor(h / 30) % 12;
        buckets[k].h += h * w;
        buckets[k].s += sat * w;
        buckets[k].v += val * w;
        buckets[k].w += w;
      }
      const best = buckets.reduce((a, c) => (c.w > a.w ? c : a));
      if (best.w <= 0) return null;
      return { h: best.h / best.w, s: best.s / best.w, v: best.v / best.w };
    };

    const picked = vote(0.3, 0.35) ?? vote(0.12, 0.2);
    if (!picked) return null;
    // Brighten: the tint is mixed at low opacity into a dark surface, so pin
    // it vivid — keep the hue, floor saturation and value.
    const [r, g, b] = hsvToRgb(picked.h, Math.max(picked.s, 0.65), Math.max(picked.v, 0.9));
    return `rgb(${r} ${g} ${b})`;
  } catch {
    // Tainted canvas (readback blocked) — no tint.
    return null;
  }
}

async function load(src: string): Promise<string | null> {
  const fromImage = (url: string, revoke?: () => void): Promise<string | null> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = extract(img);
        revoke?.();
        resolve(c);
      };
      img.onerror = () => {
        revoke?.();
        resolve(null);
      };
      img.src = url;
    });
  // Blob path first: same-origin readback, no taint.
  try {
    const res = await fetch(src);
    if (res.ok) {
      const url = URL.createObjectURL(await res.blob());
      return await fromImage(url, () => URL.revokeObjectURL(url));
    }
  } catch {
    // fetch unsupported for this src (or network refusal) — try direct.
  }
  return fromImage(src);
}

/**
 * Extract the dominant color of a portrait, memoized for the session.
 *
 * `version` busts the cache when the portrait changes behind a stable URL:
 * sei-portrait:// deliberately reuses the same uuid on a re-upload (no-store,
 * so the <img> re-fetches fresh bytes), which means the URL alone can never
 * signal a change. Pass a value that moves when the portrait does (e.g. the
 * character's cloud_updated_at) so the tint re-extracts instead of serving the
 * previous image's color until restart.
 */
export function useDominantColor(
  src: string | null,
  version?: string | number | null,
): string | null {
  const key = src == null ? null : `${src}::${version ?? ''}`;
  const [color, setColor] = useState<string | null>(key ? (cache.get(key) ?? null) : null);
  useEffect(() => {
    if (!src || !key) {
      setColor(null);
      return;
    }
    if (cache.has(key)) {
      setColor(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    void load(src).then((c) => {
      // Only memoize a successful extraction. A null (portrait 404 during the
      // write-race, or a decode failure) must stay retryable — pinning it would
      // leave the tint permanently absent for the session even after the PNG
      // lands.
      if (c !== null) cache.set(key, c);
      if (!cancelled) setColor(c);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return color;
}
