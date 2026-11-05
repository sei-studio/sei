/**
 * Pattern swatches for the room editor (261105, room catalog): a small square
 * of the pattern in the part's two colours, drawn from the same grey tile the
 * room uses (a code pattern is generated, a painted one is loaded from the
 * pack). Cached by pattern and colours, so a colour drag redraws only the
 * swatches whose colours changed.
 */
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { codeTile, mixPatternColour, hexToRgb, type PatternDef, type PatternTile } from '@shared/seilinkPatterns';
import { ctx2d, loadPatternTileGrey, makeCanvas } from './roomImages';

const urls = new Map<string, Promise<string>>();
const MAX = 120;

async function tileOf(def: PatternDef, resolve?: RoomUrlResolver): Promise<PatternTile | null> {
  if (def.made === 'code') return codeTile(def.id);
  if (!def.tile || !resolve) return null;
  return loadPatternTileGrey(resolve(def.tile));
}

/**
 * A data URL of `def` in base and accent, `w` x `h` px (a strip of fabric,
 * drawn at twice the size it shows), a few periods across.
 */
export function patternThumb(def: PatternDef, base: string, accent: string, resolve?: RoomUrlResolver, w = 168, h = 68): Promise<string> {
  const key = `${def.id}|${def.tile ?? ''}|${base}|${accent}|${w}x${h}`;
  let hit = urls.get(key);
  if (hit) return hit;
  hit = (async () => {
    const tile = await tileOf(def, resolve);
    if (!tile) throw new Error(`pattern ${def.id}: no tile`);
    const c = makeCanvas(w, h);
    const ctx = ctx2d(c, { willReadFrequently: true });
    const img = ctx.createImageData(w, h);
    const b = hexToRgb(base) ?? [255, 255, 255];
    const a = hexToRgb(accent) ?? [0, 0, 0];
    // A few periods across, so a wide stripe and a pinstripe both read.
    const per = Math.max(def.period[0], def.period[1]);
    const repeats = per >= 140 ? 2 : per >= 80 ? 3 : 4.5;
    const k = (tile.w * repeats) / w;
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = Math.floor((x + 0.5) * k) % tile.w;
        const ty = Math.floor((y + 0.5) * k * (tile.h / tile.w)) % tile.h;
        const g = tile.data[ty * tile.w + tx] / 255;
        const [r, gg, bb] = mixPatternColour(b, a, g);
        const i = (y * w + x) * 4;
        d[i] = r;
        d[i + 1] = gg;
        d[i + 2] = bb;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if ('toDataURL' in c) return (c as HTMLCanvasElement).toDataURL('image/png');
    const blob = await (c as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    return URL.createObjectURL(blob);
  })();
  hit.catch(() => urls.delete(key));
  urls.set(key, hit);
  while (urls.size > MAX) urls.delete(urls.keys().next().value as string);
  return hit;
}
