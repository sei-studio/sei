// Round-trip test for Branch B, no API needed:
// real skin -> renderPreview panel -> panelToAtlas -> front/back faces must
// match the original skin exactly.
import { renderPreview } from '../src/render.js';
import { panelToAtlas } from '../src/panelmap.js';
import { loadRgba } from '../src/validate.js';
import { writeSkinPng } from '../src/downsample.js';
import { enforceLayout } from '../src/enforce.js';
import { parts, SKIN_SIZE } from '../src/layout.js';

// clawd-skin.png is the wide (classic) example; sui/lyra are slim.
const SRC = new URL('../examples/clawd-skin.png', import.meta.url).pathname;
const PANEL = 'out/roundtrip-panel.png';
const OUT = 'out/roundtrip-skin.png';

const orig = await loadRgba(SRC);
// Flatten overlay onto base for comparison: what renderView shows per pixel is
// overlay-over-base, and the panel mapper writes what it sees onto the base.
await renderPreview(orig, PANEL, { scale: 16 });

const atlas = await panelToAtlas(PANEL);
await writeSkinPng(enforceLayout(atlas), OUT);

const idx = (x, y) => (y * SKIN_SIZE + x) * 4;
let checked = 0, diff = 0;
const P = parts('classic');
for (const part of Object.values(P)) {
  for (const face of ['front', 'back']) {
    const r = part.base[face];
    const o = part.overlay[face];
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        // expected = overlay pixel if opaque else base pixel (alpha-over)
        const oi = idx(o.x + x, o.y + y);
        const bi = idx(r.x + x, r.y + y);
        const src = orig[oi + 3] >= 128 ? oi : bi;
        if (orig[src + 3] < 128) continue; // fully transparent in original
        const ai = idx(r.x + x, r.y + y);
        checked++;
        const d = Math.hypot(orig[src] - atlas[ai], orig[src + 1] - atlas[ai + 1], orig[src + 2] - atlas[ai + 2]);
        if (d > 12) diff++;
      }
    }
  }
}
console.log(`front/back pixels checked=${checked} mismatched=${diff} (${((100 * diff) / checked).toFixed(1)}%)`);
const pass = diff / checked < 0.03;
console.log(pass ? 'PANEL ROUNDTRIP: PASS' : 'PANEL ROUNDTRIP: FAIL');
process.exit(pass ? 0 : 1);
