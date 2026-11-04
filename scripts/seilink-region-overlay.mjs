#!/usr/bin/env node
/**
 * SeiLink placement regions: draw them on the room, and help trace them
 * (261105, physics-aware placement). No Electron, no browser: sharp only.
 *
 *   node scripts/seilink-region-overlay.mjs --pack <dir> [--out regions.png]
 *        [--time day] [--items] [--grid 100] [--crop x,y,w,h] [--scale 0.5]
 *        [--regions draft.json] [--without chair,curtains]
 *        [--show floor,wall,blocks,surfaces,horizon,labels]
 *   node scripts/seilink-region-overlay.mjs --pack <dir> --lines <componentId> [--time day]
 *   node scripts/seilink-region-overlay.mjs --pack <dir> --regions draft.json --merge
 *
 * Overlay (default): composes the room the way the app does (each slot's
 * default part, by slot z, no tints, no avatar; `--items` adds every item at
 * its box spot) and draws what the manifest labels (seilinkRoom.ts has the
 * format):
 *   floorAreas         green fill      (where a floor item's bottom stands)
 *   wallAreas          blue fill       (where a wall item hangs)
 *   blocks.floor       orange hatch    (floor a part covers while it is in the room)
 *   blocks.wall        red hatch       (wall a part covers)
 *   surfaceTops.area   yellow fill     (a top: a surface item's contact rests anywhere inside)
 *   surfaceTops.lip    cyan hatch      (the part's front lip, drawn again over items on that top)
 *   surfaceTops.sink   label "sink N"  (a soft top: items settle N px in)
 *   surfaceLines       yellow line     (legacy: a surface item's contact sits ON it)
 *   surfaceAreas       yellow fill     (legacy: a top without lip or sink)
 *   horizon            dashed line     (eye level, for the depth scale)
 * `--regions draft.json` merges a draft (same field names, plus
 * `components: { <id>: { surfaceTops, blocks } }`) over the manifest, so a
 * region can be checked before it goes into the pack. `--grid N` draws a
 * labelled grid every N canvas px for measuring by eye; `--without` leaves
 * slots out (to see the floor under a chair, say).
 *
 * `--lines <componentId>` measures plank tops from that part's day frame:
 * every column's opaque runs are grouped into planks; in each run the back
 * edge is the first opaque row and the front edge of the top face is the
 * first dark outline row below the lighter top face. A line is fitted through
 * the middle of the top face (where an object standing on the plank touches
 * it) and printed as `surfaceLines` JSON. Check it on the overlay.
 *
 * `--merge` writes the draft into the pack's manifest.json (a null value
 * deletes a key, e.g. `"z": null` on an item that should take its z from
 * where it stands) and prints the result's region counts.
 *
 * `--bands <componentId>` (261105 shelf pass) measures the same planks as
 * whole tops: per plank an `area` quad from the back edge to the front of
 * the top face (pushed --overlap px into the lip) and the `lip` quad of the
 * front face under it, printed as `surfaceTops` JSON (see suggestBands).
 *
 * How to label a new pack: run --bands on the shelf (and any desk or
 * nightstand part), paste the tops into that component (or into the draft
 * and --merge). Tops the measure cannot read (a log, a stump, a bed) are
 * traced by hand with --grid 25 --crop: an `area` polygon over the whole
 * visible top, a `lip` polygon only where the art draws a front edge the
 * items should tuck behind, `sink` (about 6) for a soft one. Trace floorAreas
 * and wallAreas with --grid 50 (and --crop to zoom), add `blocks` to parts
 * that stand on the floor or hang on the wall, set `horizon` where the
 * room's receding lines meet; then render the overlay and check that every
 * line sits on its plank and every fill stays on real floor or wall.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const PACK = path.resolve(arg('pack', 'resources/seilink-packs/cozy'));
const TIME = arg('time', 'day');
const manifest = JSON.parse(await fs.readFile(path.join(PACK, 'manifest.json'), 'utf8'));
const [CW, CH] = manifest.canvas;
const byId = new Map(manifest.components.map((c) => [c.id, c]));
const frameOf = (c) => c.frames[TIME] ?? c.frames.day;

async function raw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

// ── --lines: plank tops from a part's alpha and shading ─────────────────────

async function suggestLines(id) {
  const comp = byId.get(id);
  if (!comp) throw new Error(`no component ${id}`);
  const img = await raw(path.join(PACK, comp.frames.day.src));
  const ox = comp.box ? comp.box[0] : 0;
  const oy = comp.box ? comp.box[1] : 0;
  const lum = (x, y) => {
    const i = (y * img.w + x) * img.c;
    return (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
  };
  const alpha = (x, y) => img.data[(y * img.w + x) * img.c + 3];
  /** Per column: [back, front] of each plank's top face. */
  const planks = []; // { pts: [[x, mid, back, front]] }
  for (let x = 0; x < img.w; x += 4) {
    const runs = [];
    let s = -1;
    for (let y = 0; y < img.h; y++) {
      const a = alpha(x, y) > 128;
      if (a && s < 0) s = y;
      if (!a && s >= 0) {
        runs.push([s, y - 1]);
        s = -1;
      }
    }
    for (const [a, b] of runs) {
      if (b - a < 6) continue;
      // Skip the outline at the back edge, then walk the light top face down to the next dark line.
      let y = a;
      while (y <= b && lum(x, y) < 90) y++;
      const faceTop = y;
      while (y <= b && lum(x, y) >= 90) y++;
      const front = y <= b ? y : b;
      if (front - faceTop < 2) continue;
      const mid = (a + front) / 2;
      let p = planks.find((q) => Math.abs(q.pts[q.pts.length - 1][2] - a) < 14 && x - q.pts[q.pts.length - 1][0] <= 12);
      if (!p) planks.push((p = { pts: [] }));
      p.pts.push([x, mid, a, front]);
    }
  }
  const lines = [];
  for (const p of planks) {
    if (p.pts.length < 8) continue;
    // Least squares y = k x + m through the top-face middles, ends trimmed a little.
    const pts = p.pts.slice(1, -1);
    const n = pts.length;
    const sx = pts.reduce((s, q) => s + q[0], 0);
    const sy = pts.reduce((s, q) => s + q[1], 0);
    const sxx = pts.reduce((s, q) => s + q[0] * q[0], 0);
    const sxy = pts.reduce((s, q) => s + q[0] * q[1], 0);
    const k = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const m = (sy - k * sx) / n;
    const x1 = p.pts[0][0];
    const x2 = p.pts[p.pts.length - 1][0];
    const depth = pts.reduce((s, q) => s + (q[3] - q[2]), 0) / n;
    const err = Math.sqrt(pts.reduce((s, q) => s + (q[1] - (k * q[0] + m)) ** 2, 0) / n);
    lines.push({ seg: [x1 + ox, Math.round(k * x1 + m) + oy, x2 + ox, Math.round(k * x2 + m) + oy], depth: Math.round(depth), err: +err.toFixed(2) });
  }
  lines.sort((a, b) => a.seg[1] - b.seg[1]);
  for (const l of lines) console.error(`plank ${JSON.stringify(l.seg)} top face ~${l.depth}px deep, fit rms ${l.err}px`);
  console.log(JSON.stringify({ surfaceLines: lines.map((l) => l.seg) }));
}

// ── --bands: whole plank tops and their front lips ──────────────────────────

/** Least squares y = k x + m through [x, y] points. */
function fitLine(pts) {
  const n = pts.length;
  const sx = pts.reduce((s, q) => s + q[0], 0);
  const sy = pts.reduce((s, q) => s + q[1], 0);
  const sxx = pts.reduce((s, q) => s + q[0] * q[0], 0);
  const sxy = pts.reduce((s, q) => s + q[0] * q[1], 0);
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const m = (sy - k * sx) / n;
  const err = Math.sqrt(pts.reduce((s, q) => s + (q[1] - (k * q[0] + m)) ** 2, 0) / n);
  return { at: (x) => k * x + m, err };
}

/**
 * Measure each plank of a part's day frame, column by column: the back edge
 * (first opaque row), the front of the light top face (the first dark row
 * under it: the line where the top meets the front face), and the bottom of
 * the front face (last opaque row). Three lines are fitted per plank and
 * printed as `surfaceTops`: `area` is the quad from the back edge to the
 * front of the top face pushed `--overlap` px (default 3) into the lip, so a
 * base at the very front tucks just behind it; `lip` is the quad from that
 * front line down to the bottom edge (plus `--pad` px, default 3, at the
 * ends and below), the band drawn again over items on the plank. Works for
 * any part drawn as a light top over a darker outlined front face (shelf
 * planks, a desk, a nightstand). A top without such a face (a log, a stump,
 * a duvet) is traced by hand with --grid: an `area` polygon, a `lip` only
 * where the art has a front edge to tuck behind, `sink` for a soft top.
 */
async function suggestBands(id) {
  const comp = byId.get(id);
  if (!comp) throw new Error(`no component ${id}`);
  const img = await raw(path.join(PACK, comp.frames.day.src));
  const ox = comp.box ? comp.box[0] : 0;
  const oy = comp.box ? comp.box[1] : 0;
  const overlap = Number(arg('overlap', 3));
  const pad = Number(arg('pad', 3));
  const dark = Number(arg('dark', 90));
  const lum = (x, y) => {
    const i = (y * img.w + x) * img.c;
    return (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
  };
  const alpha = (x, y) => img.data[(y * img.w + x) * img.c + 3];
  const planks = []; // { cols: [[x, back, front, bottom]] }
  for (let x = 0; x < img.w; x += 2) {
    let s = -1;
    const runs = [];
    for (let y = 0; y <= img.h; y++) {
      const a = y < img.h && alpha(x, y) > 128;
      if (a && s < 0) s = y;
      if (!a && s >= 0) {
        runs.push([s, y - 1]);
        s = -1;
      }
    }
    for (const [a, b] of runs) {
      if (b - a < 6) continue;
      let y = a;
      while (y <= b && lum(x, y) < dark) y++;
      const faceTop = y;
      while (y <= b && lum(x, y) >= dark) y++;
      if (y > b || y - faceTop < 2) continue;
      const front = y;
      let p = planks.find((q) => {
        const last = q.cols[q.cols.length - 1];
        return Math.abs(last[1] - a) < 14 && x - last[0] <= 8;
      });
      if (!p) planks.push((p = { cols: [] }));
      p.cols.push([x, a, front, b]);
    }
  }
  const tops = [];
  for (const p of planks) {
    if (p.cols.length < 16) continue;
    // Fit on the inner columns (the ends round off), apply over the whole plank.
    const inner = p.cols.slice(2, -2);
    const back = fitLine(inner.map((c) => [c[0], c[1]]));
    const front = fitLine(inner.map((c) => [c[0], c[2]]));
    const bottom = fitLine(inner.map((c) => [c[0], c[3]]));
    const x1 = p.cols[0][0] + ox;
    const x2 = p.cols[p.cols.length - 1][0] + ox;
    const at = (f, x) => Math.round((f.at(x - ox) + oy) * 10) / 10;
    const r = (v) => Math.round(v);
    const area = [
      [x1, r(at(back, x1))],
      [x2, r(at(back, x2))],
      [x2, r(at(front, x2) + overlap)],
      [x1, r(at(front, x1) + overlap)],
    ];
    const lx1 = x1 - pad;
    const lx2 = x2 + pad;
    const lip = [
      [lx1, r(at(front, lx1))],
      [lx2, r(at(front, lx2))],
      [lx2, r(at(bottom, lx2) + pad)],
      [lx1, r(at(bottom, lx1) + pad)],
    ];
    const depth = inner.reduce((s, c) => s + (c[2] - c[1]), 0) / inner.length;
    const face = inner.reduce((s, c) => s + (c[3] - c[2]), 0) / inner.length;
    console.error(
      `plank x ${x1}..${x2}: top face ~${depth.toFixed(1)}px deep, front face ~${face.toFixed(1)}px; ` +
        `fit rms back ${back.err.toFixed(2)} front ${front.err.toFixed(2)} bottom ${bottom.err.toFixed(2)}px`,
    );
    tops.push({ y: at(back, (x1 + x2) / 2), top: { area, lip } });
  }
  tops.sort((a, b) => a.y - b.y);
  console.log(format({ surfaceTops: tops.map((t) => t.top) }));
}

// ── --merge: a draft into manifest.json ─────────────────────────────────────

/** JSON with arrays of numbers (points, boxes, lines) and polygons on one line, the rest indented. */
function format(v, ind = '') {
  const flat = (a) => Array.isArray(a) && a.every((n) => typeof n === 'number');
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (flat(v) || v.every(flat)) return JSON.stringify(v).replace(/,/g, ', ');
    const inner = ind + '  ';
    return `[\n${v.map((x) => inner + format(x, inner)).join(',\n')}\n${ind}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return '{}';
    const inner = ind + '  ';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${format(v[k], inner)}`).join(',\n')}\n${ind}}`;
  }
  return JSON.stringify(v);
}

function apply(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

async function merge() {
  const draft = JSON.parse(await fs.readFile(arg('regions'), 'utf8'));
  const out = JSON.parse(JSON.stringify(manifest));
  const { components = {}, ...top } = draft;
  apply(out, top);
  for (const [id, patch] of Object.entries(components)) {
    const c = out.components.find((x) => x.id === id);
    if (!c) throw new Error(`draft names a component the pack does not have: ${id}`);
    apply(c, patch);
  }
  await fs.writeFile(path.join(PACK, 'manifest.json'), format(out) + '\n');
  const n = (k) => out.components.reduce((s, c) => s + (c[k]?.length ?? 0), 0);
  console.log(
    `merged into ${path.join(PACK, 'manifest.json')}: ${out.floorAreas?.length ?? 0} floor, ${out.wallAreas?.length ?? 0} wall, ` +
      `${n('surfaceLines')} surface lines, ${n('surfaceAreas')} surface areas, horizon ${out.horizon ?? 'none'}`,
  );
}

// ── overlay ─────────────────────────────────────────────────────────────────

async function layerInput(frameSrc, box) {
  const file = path.join(PACK, frameSrc);
  if (!box) return { input: file, left: 0, top: 0 };
  const input = await sharp(file).resize(Math.round(box[2]), Math.round(box[3]), { fit: 'fill' }).png().toBuffer();
  return { input, left: Math.round(box[0]), top: Math.round(box[1]) };
}

async function overlay() {
  const draft = arg('regions') ? JSON.parse(await fs.readFile(arg('regions'), 'utf8')) : {};
  const m = { ...manifest, ...draft };
  const parts = [];
  const without = new Set((arg('without', '') || '').split(',').filter(Boolean));
  for (const [slot, def] of Object.entries(manifest.slots)) {
    if (without.has(slot)) continue;
    const c = byId.get(def.options[0]);
    if (c) parts.push({ z: def.z, c, slot });
  }
  const items = has('items') ? manifest.components.filter((c) => c.slot === 'item' && c.box) : [];
  const comps = (id) => ({ ...(byId.get(id) ?? {}), ...((draft.components ?? {})[id] ?? {}) });
  // Items over every slot below her (the chair is drawn over floor items, as in the app).
  for (const c of items) parts.push({ z: c.placement === 'floor' ? 70 : c.placement === 'wall' ? 15 : 55, c, item: true });
  parts.sort((a, b) => a.z - b.z);
  const layers = [];
  for (const p of parts) layers.push(await layerInput(frameOf(p.c).src, p.item ? (comps(p.c.id).box ?? p.c.box) : p.c.box ?? null));

  const present = parts.filter((p) => !p.item).map((p) => comps(p.c.id));
  const poly = (pts, cls) => `<polygon class="${cls}" points="${pts.map((q) => q.join(',')).join(' ')}"/>`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
<defs><pattern id="hatch" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="18" height="18" fill="rgba(230,40,40,0.14)"/><line x1="0" y1="0" x2="0" y2="18" stroke="rgba(230,40,40,0.7)" stroke-width="4"/></pattern>
<pattern id="hatchl" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="rgba(0,220,255,0.18)"/><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(0,220,255,0.85)" stroke-width="2"/></pattern>
<pattern id="hatchf" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="18" height="18" fill="rgba(255,120,0,0.14)"/><line x1="0" y1="0" x2="0" y2="18" stroke="rgba(255,110,0,0.75)" stroke-width="4"/></pattern></defs>
<style>
.floor{fill:rgba(40,210,90,0.30);stroke:rgb(20,170,60);stroke-width:4}
.wall{fill:rgba(60,120,255,0.22);stroke:rgb(40,90,230);stroke-width:4}
.block{fill:url(#hatch);stroke:rgb(220,30,30);stroke-width:4}
.fblock{fill:url(#hatchf);stroke:rgb(240,110,0);stroke-width:4}
.sarea{fill:rgba(255,214,0,0.35);stroke:rgb(255,214,0);stroke-width:3}
.lip{fill:url(#hatchl);stroke:rgb(0,220,255);stroke-width:2}
.line{stroke:rgb(255,214,0);stroke-width:${Number(arg('line', 4))};stroke-linecap:round}
.end{fill:rgb(255,214,0);stroke:#000;stroke-width:1.5}
.lbl{font:bold 26px sans-serif;fill:#fff;stroke:#000;stroke-width:5;paint-order:stroke}
.grid{stroke:rgba(255,0,255,0.55);stroke-width:1.5}
.gl{font:18px monospace;fill:#fff;stroke:#000;stroke-width:3;paint-order:stroke}
.hz{stroke:rgba(255,255,255,0.9);stroke-width:3;stroke-dasharray:18 12}
</style>`;
  const show = new Set((arg('show', 'floor,wall,blocks,surfaces,horizon,labels') || '').split(','));
  const legacyFloor = m.floor ? [[[m.floor[0], m.floor[1]], [m.floor[0] + m.floor[2], m.floor[1]], [m.floor[0] + m.floor[2], m.floor[1] + m.floor[3]], [m.floor[0], m.floor[1] + m.floor[3]]]] : [];
  if (show.has('floor')) for (const p of m.floorAreas ?? legacyFloor) svg += poly(p, 'floor');
  if (show.has('wall')) for (const p of m.wallAreas ?? []) svg += poly(p, 'wall');
  for (const c of show.has('blocks') ? present : []) {
    if (show.has('floor')) for (const p of c.blocks?.floor ?? []) svg += poly(p, 'fblock');
    if (show.has('wall')) for (const p of c.blocks?.wall ?? []) svg += poly(p, 'block');
  }
  for (const c of show.has('surfaces') ? present : []) {
    (c.surfaceLines ?? []).forEach((s, i) => {
      svg += `<line class="line" x1="${s[0]}" y1="${s[1]}" x2="${s[2]}" y2="${s[3]}"/><circle class="end" cx="${s[0]}" cy="${s[1]}" r="6"/><circle class="end" cx="${s[2]}" cy="${s[3]}" r="6"/>`;
      if (show.has('labels')) svg += `<text class="lbl" x="${(s[0] + s[2]) / 2}" y="${(s[1] + s[3]) / 2 - 12}" text-anchor="middle">${c.id}#${i}</text>`;
    });
    for (const p of c.surfaceAreas ?? []) svg += poly(p, 'sarea');
    (c.surfaceTops ?? []).forEach((t, i) => {
      svg += poly(t.area, 'sarea');
      if (t.lip) svg += poly(t.lip, 'lip');
      if (show.has('labels')) {
        const [x0, y0] = t.area[0];
        const sink = t.sink ? ` sink ${t.sink}` : '';
        svg += `<text class="lbl" x="${x0 + 12}" y="${y0 - 10}">${c.id}#${i}${t.lip ? ' +lip' : ''}${sink}</text>`;
      }
    });
    for (const b of c.surfaces ?? []) svg += `<rect class="line" fill="none" x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${Math.max(1, b[3])}"/>`;
  }
  if (typeof m.horizon === 'number' && show.has('horizon')) svg += `<line class="hz" x1="0" y1="${m.horizon}" x2="${CW}" y2="${m.horizon}"/><text class="lbl" x="12" y="${m.horizon - 10}">horizon ${m.horizon}</text>`;
  for (const it of items) {
    // White: the sprite's bottom centre (its anchor). Black: where the object touches (anchor raised by its foot).
    const c = comps(it.id);
    const [x, y, w, h] = c.box ?? it.box;
    svg += `<circle cx="${x + w / 2}" cy="${y + h}" r="6" fill="#fff" stroke="#000" stroke-width="2"/>`;
    if (c.foot) svg += `<circle cx="${x + w / 2}" cy="${y + h - c.foot}" r="6" fill="#000" stroke="#fff" stroke-width="2"/>`;
  }
  const grid = Number(arg('grid', 0));
  if (grid > 0) {
    for (let x = 0; x <= CW; x += grid) svg += `<line class="grid" x1="${x}" y1="0" x2="${x}" y2="${CH}"/><text class="gl" x="${x + 3}" y="18">${x}</text>`;
    for (let y = 0; y <= CH; y += grid) svg += `<line class="grid" x1="0" y1="${y}" x2="${CW}" y2="${y}"/><text class="gl" x="3" y="${y - 3}">${y}</text>`;
  }
  svg += `<text class="lbl" x="${CW - 20}" y="${CH - 20}" text-anchor="end">${manifest.id} ${TIME}: green floor, blue wall, orange/red blocked, yellow surface top, cyan lip</text></svg>`;
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });

  let img = sharp({ create: { width: CW, height: CH, channels: 4, background: '#000' } }).composite(layers);
  img = sharp(await img.png().toBuffer());
  const crop = arg('crop');
  if (crop) {
    // Clamped to the canvas, so a crop past the edge still works.
    const [cx, cy, cw, ch] = crop.split(',').map(Number);
    const left = Math.max(0, Math.min(CW - 1, cx));
    const top = Math.max(0, Math.min(CH - 1, cy));
    const width = Math.max(1, Math.min(CW - left, cw));
    const height = Math.max(1, Math.min(CH - top, ch));
    img = sharp(await img.extract({ left, top, width, height }).png().toBuffer());
  }
  const scale = Number(arg('scale', 1));
  if (scale !== 1) {
    const meta = await img.metadata();
    img = img.resize(Math.round(meta.width * scale));
  }
  const out = path.resolve(arg('out', 'seilink-regions.png'));
  await img.png().toFile(out);
  console.log(out);
}

if (arg('lines')) await suggestLines(arg('lines'));
else if (arg('bands')) await suggestBands(arg('bands'));
else if (has('merge')) await merge();
else await overlay();
