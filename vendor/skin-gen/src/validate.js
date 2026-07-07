// Validate a 64x64 skin against the layout: base layer fully opaque,
// never-rendered whitespace fully transparent. Also usable as a layout
// self-check against known-good skins (Steve/Alex).
import sharp from 'sharp';
import { SKIN_SIZE, usedGrid } from './layout.js';

export async function loadRgba(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== SKIN_SIZE || info.height !== SKIN_SIZE) {
    throw new Error(`expected 64x64, got ${info.width}x${info.height}`);
  }
  return data; // RGBA row-major
}

export function alphaAt(data, x, y) {
  return data[(y * SKIN_SIZE + x) * 4 + 3];
}

export async function validateSkin(path, variant = 'classic') {
  const data = await loadRgba(path);
  const base = usedGrid(variant, 'base');
  const any = usedGrid(variant, 'both');
  const problems = { transparentBase: [], opaqueWhitespace: [] };
  for (let y = 0; y < SKIN_SIZE; y++) {
    for (let x = 0; x < SKIN_SIZE; x++) {
      const a = alphaAt(data, x, y);
      if (base[y][x] && a < 255) problems.transparentBase.push([x, y, a]);
      if (!any[y][x] && a !== 0) problems.opaqueWhitespace.push([x, y, a]);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) {
  const variant = process.argv[3] ?? 'classic';
  const p = await validateSkin(process.argv[2], variant);
  const tb = p.transparentBase.length;
  const ow = p.opaqueWhitespace.length;
  console.log(
    `${process.argv[2]} [${variant}]: transparent-base=${tb} opaque-whitespace=${ow}`
  );
  if (tb) console.log('  sample transparent-base:', p.transparentBase.slice(0, 5));
  if (ow) console.log('  sample opaque-whitespace:', p.opaqueWhitespace.slice(0, 5));
}
