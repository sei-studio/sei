// Render front/back full-body previews from a 64x64 skin buffer.
// Front view canvas is 16x32 skin-pixels; upscaled with nearest for output.
import sharp from 'sharp';
import { SKIN_SIZE, parts } from './layout.js';

const sidx = (x, y) => (y * SKIN_SIZE + x) * 4;

// alpha-over blit of one face rect onto the canvas
function blit(canvas, cw, skin, rect, dx, dy, { mirror = false } = {}) {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + (mirror ? rect.w - 1 - x : x);
      const si = sidx(sx, rect.y + y);
      const a = skin[si + 3];
      if (a === 0) continue;
      const di = ((dy + y) * cw + dx + x) * 4;
      canvas[di] = skin[si];
      canvas[di + 1] = skin[si + 1];
      canvas[di + 2] = skin[si + 2];
      canvas[di + 3] = 255;
    }
  }
}

export function renderView(skin, side = 'front', variant = 'classic') {
  const P = parts(variant);
  const aw = P.rightArm.dims.w;
  const cw = 8 + 2 * aw; // arms + body
  const ch = 32;
  const canvas = Buffer.alloc(cw * ch * 4);
  const bodyX = aw;

  // viewer-left/right arm & leg depend on which side we look at
  const [armL, armR, legL, legR] =
    side === 'front'
      ? [P.rightArm, P.leftArm, P.rightLeg, P.leftLeg]
      : [P.leftArm, P.rightArm, P.leftLeg, P.rightLeg];

  for (const layer of ['base', 'overlay']) {
    blit(canvas, cw, skin, P.head[layer][side], bodyX, 0); // head 8 wide, aligned with body
    blit(canvas, cw, skin, P.body[layer][side], bodyX, 8);
    blit(canvas, cw, skin, armL[layer][side], 0, 8);
    blit(canvas, cw, skin, armR[layer][side], bodyX + 8, 8);
    blit(canvas, cw, skin, legL[layer][side], bodyX, 20);
    blit(canvas, cw, skin, legR[layer][side], bodyX + 4, 20);
  }
  return { canvas, w: cw, h: ch };
}

export async function renderPreview(skin, outFile, { variant = 'classic', scale = 12 } = {}) {
  const gap = 4;
  const views = [renderView(skin, 'front', variant), renderView(skin, 'back', variant)];
  const w = views[0].w + gap + views[1].w;
  const h = 32;
  const combined = Buffer.alloc(w * h * 4);
  for (let v = 0; v < 2; v++) {
    const off = v === 0 ? 0 : views[0].w + gap;
    const { canvas, w: vw } = views[v];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < vw; x++) {
        const si = (y * vw + x) * 4;
        const di = (y * w + off + x) * 4;
        canvas.copy(combined, di, si, si + 4);
      }
  }
  await sharp(combined, { raw: { width: w, height: h, channels: 4 } })
    .resize(w * scale, h * scale, { kernel: 'nearest' })
    .png()
    .toFile(outFile);
  return outFile;
}
