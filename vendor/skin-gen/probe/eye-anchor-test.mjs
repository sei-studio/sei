// Offline test: run the eye-anchored panel->atlas mapping on already-generated
// raw panels (no API calls). For each panel it writes:
//   out/eyedbg-<name>.png  — the panel with detected eyes + head box drawn on
//   out/eyeprev-<name>.png — the resulting 64x64 skin, rendered front/back
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { _debugFrontHead, panelToAtlas } from '../src/panelmap.js';
import { enforceLayout } from '../src/enforce.js';
import { renderPreview } from '../src/render.js';
import { writeSkinPng } from '../src/downsample.js';

const OUT = new URL('../out/', import.meta.url).pathname;
const variant = 'slim';

function drawRect(data, w, r, [cr, cg, cb]) {
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y * w + x >= data.length / 4) return;
    const i = (y * w + x) * 4;
    data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; data[i + 3] = 255;
  };
  for (let x = r.x; x < r.x + r.w; x++) { put(x, r.y); put(x, r.y + r.h - 1); }
  for (let y = r.y; y < r.y + r.h; y++) { put(r.x, y); put(r.x + r.w - 1, y); }
}
function fillDot(data, w, cx, cy, rad, [cr, cg, cb]) {
  for (let y = Math.round(cy - rad); y <= cy + rad; y++)
    for (let x = Math.round(cx - rad); x <= cx + rad; x++) {
      if (x < 0 || y < 0 || x >= w || y * w + x >= data.length / 4) continue;
      const i = (y * w + x) * 4;
      data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; data[i + 3] = 255;
    }
}

const files = (await readdir(OUT)).filter((f) => f.endsWith('.raw-panel.png'));
for (const f of files) {
  const name = f.replace('.raw-panel.png', '');
  const panel = path.join(OUT, f);
  const { img, frontBox, head } = await _debugFrontHead(panel);
  const dbg = Buffer.from(img.data);
  drawRect(dbg, img.w, frontBox, [0, 255, 0]);          // green: front bbox
  if (head) {
    drawRect(dbg, img.w, head, [255, 0, 0]);            // red: head box
    if (head.face) drawRect(dbg, img.w, { x: head.face.minX, y: head.face.minY, w: head.face.w, h: head.face.h }, [255, 255, 0]); // yellow: face
    if (head.eyes) fillDot(dbg, img.w, head.eyes.fx, head.eyes.fy, 4, [0, 200, 255]); // cyan: eye midpoint
  }
  await sharp(dbg, { raw: { width: img.w, height: img.h, channels: 4 } })
    .png().toFile(path.join(OUT, `eyedbg-${name}.png`));

  const raw = await panelToAtlas(panel, { variant });
  const skin = enforceLayout(raw, { variant });
  const skinPath = path.join(OUT, `eyeprev-${name}.skin.png`);
  await writeSkinPng(skin, skinPath);
  await renderPreview(skin, path.join(OUT, `eyeprev-${name}.png`), { variant });
  console.log(`${name}: head=${head ? `${head.w}px @ (${head.x},${head.y})  conf` : 'FALLBACK (no confident eyes)'}`);
}
