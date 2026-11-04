#!/usr/bin/env node
/**
 * Placeholder SeiLink room pack for development (261104).
 *
 *   node scripts/seilink-dev-pack.mjs [--out seilink-dev-packs]
 *
 * Writes <out>/cozy/manifest.json plus flat-shaded webp layers (shell with a
 * tintable wall, window view, curtains + mask, chair, shelf, lamp + glow, rug
 * + mask, and three items) for day, dusk and night, following the room format
 * in src/shared/seilinkRoom.ts. It is NOT the real art (that comes from the
 * designer); it exists so RoomCanvas, the pack loader and the editor have a
 * pack to draw. Then run the app with SEI_SEILINK_PACKS=<out>.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const OUT = path.resolve(arg('out', 'seilink-dev-packs'));
const W = 2560;
const H = 1440;
const PACK = path.join(OUT, 'cozy');
const TIMES = ['day', 'dusk', 'night'];

sharp.concurrency(1);

// Interior light per time: everything non-emissive is multiplied by it.
const TONE = { day: [255, 255, 255], dusk: [246, 196, 170], night: [92, 102, 150] };

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(h, time) {
  const t = TONE[time];
  const c = hex(h).map((v, i) => Math.round((v * t[i]) / 255));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

async function emit(rel, markup) {
  const file = path.join(PACK, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await sharp(Buffer.from(markup)).webp({ quality: 88, alphaQuality: 90 }).toBuffer());
}

// ── Geometry ────────────────────────────────────────────────────────────────
const FLOOR_Y = 1060;
const WIN = { x: 1720, y: 200, w: 660, h: 700 };

// ── View ────────────────────────────────────────────────────────────────────
function view(time) {
  const sky = { day: ['#6fbdf2', '#cdeeff'], dusk: ['#5a4b8f', '#ff9f72'], night: ['#0b1433', '#25305e'] }[time];
  const hill = { day: ['#7cc47a', '#5aa35f'], dusk: ['#6d5b7d', '#4f4469'], night: ['#1d2a48', '#16203a'] }[time];
  const city = { day: '#a9c3d9', dusk: '#7b6a92', night: '#1a2140' }[time];
  let extra = '';
  if (time === 'day') extra += `<circle cx="2200" cy="330" r="70" fill="#fff6c9"/>`;
  if (time === 'dusk') extra += `<circle cx="1900" cy="760" r="110" fill="#ffd27a" opacity="0.9"/>`;
  if (time === 'night') {
    extra += `<circle cx="2230" cy="320" r="52" fill="#f3f0d8"/>`;
    for (let i = 0; i < 60; i++) {
      const x = 1700 + ((i * 197) % 720);
      const y = 210 + ((i * 131) % 420);
      extra += `<circle cx="${x}" cy="${y}" r="${1.5 + (i % 3)}" fill="#ffffff" opacity="0.8"/>`;
    }
  }
  let towers = '';
  for (let i = 0; i < 9; i++) {
    const x = 1700 + i * 80;
    const h = 120 + ((i * 53) % 140);
    towers += `<rect x="${x}" y="${820 - h}" width="64" height="${h}" fill="${city}"/>`;
    if (time !== 'day') {
      for (let j = 0; j < 4; j++) towers += `<rect x="${x + 12 + (j % 2) * 26}" y="${830 - h + 20 + j * 26}" width="12" height="12" fill="#ffd98a" opacity="${time === 'night' ? 0.95 : 0.5}"/>`;
    }
  }
  return svg(W, H, `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/>${extra}${towers}
    <path d="M1600 900 Q1900 760 2200 860 T2600 820 V1440 H1600 Z" fill="${hill[0]}"/>
    <path d="M1600 960 Q2000 860 2400 940 T2600 930 V1440 H1600 Z" fill="${hill[1]}"/>`);
}

// ── Shell: wall (tintable, painted near white), floor, window frame ─────────
const wallHole = `M0 0 H${W} V${FLOOR_Y} H0 Z M${WIN.x} ${WIN.y} V${WIN.y + WIN.h} H${WIN.x + WIN.w} V${WIN.y} Z`;
function shell(time) {
  const frame = shade('#f6f1ea', time);
  const frameDark = shade('#cfc5b8', time);
  const floorA = shade('#b98a5e', time);
  const floorB = shade('#a77a50', time);
  let boards = '';
  for (let i = 0; i < 12; i++) boards += `<rect x="0" y="${FLOOR_Y + 12 + i * 32}" width="${W}" height="3" fill="${floorB}"/>`;
  const mx = WIN.x + WIN.w / 2;
  const my = WIN.y + WIN.h / 2;
  return svg(W, H, `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade('#f4f4f4', time)}"/><stop offset="1" stop-color="${shade('#e2e2e2', time)}"/></linearGradient></defs>
    <path d="${wallHole}" fill="url(#w)" fill-rule="evenodd"/>
    <rect x="0" y="${FLOOR_Y}" width="${W}" height="${H - FLOOR_Y}" fill="${floorA}"/>${boards}
    <rect x="0" y="${FLOOR_Y - 40}" width="${W}" height="40" fill="${frameDark}"/>
    <rect x="${WIN.x - 30}" y="${WIN.y - 30}" width="${WIN.w + 60}" height="30" fill="${frame}"/>
    <rect x="${WIN.x - 30}" y="${WIN.y + WIN.h}" width="${WIN.w + 60}" height="44" fill="${frame}"/>
    <rect x="${WIN.x - 30}" y="${WIN.y}" width="30" height="${WIN.h}" fill="${frame}"/>
    <rect x="${WIN.x + WIN.w}" y="${WIN.y}" width="30" height="${WIN.h}" fill="${frame}"/>
    <rect x="${mx - 9}" y="${WIN.y}" width="18" height="${WIN.h}" fill="${frame}"/>
    <rect x="${WIN.x}" y="${my - 9}" width="${WIN.w}" height="18" fill="${frame}"/>`);
}
const shellMask = svg(W, H, `<path d="${wallHole}" fill="#ffffff" fill-rule="evenodd"/><rect x="0" y="${FLOOR_Y - 40}" width="${W}" height="40" fill="#000000"/>`);

// ── Curtains (grayscale, tinted through the mask) ───────────────────────────
function curtainShape(x, w, folds, light, dark) {
  let s = `<path d="M${x} 150 H${x + w} V1000 Q${x + w / 2} 1030 ${x} 1000 Z" fill="${light}"/>`;
  for (let i = 1; i < folds; i++) s += `<rect x="${x + (i * w) / folds - 6}" y="150" width="12" height="860" fill="${dark}" opacity="0.6"/>`;
  return s;
}
function curtains(time) {
  const light = shade('#f2f2f2', time);
  const dark = shade('#bdbdbd', time);
  const rod = shade('#6b5644', time);
  return svg(W, H, `<rect x="1600" y="136" width="900" height="16" rx="8" fill="${rod}"/>
    ${curtainShape(1600, 170, 4, light, dark)}${curtainShape(2330, 170, 4, light, dark)}`);
}
const curtainsMask = svg(W, H, `${curtainShape(1600, 170, 4, '#ffffff', '#ffffff')}${curtainShape(2330, 170, 4, '#ffffff', '#ffffff')}`);

// ── Shelf, lamp, chair, rug ─────────────────────────────────────────────────
function shelf(time) {
  const wood = shade('#8a5e3c', time);
  const woodD = shade('#6d4a2f', time);
  const bookColors = ['#d96c6c', '#6c9bd9', '#e8c35a', '#7cc48a', '#b38ad9', '#e89a5a'];
  let books = '';
  for (let r = 0; r < 4; r++) {
    let x = 180;
    for (let i = 0; x < 600; i++) {
      const w = 34 + ((i * 7 + r * 5) % 22);
      const h = 120 + ((i * 13 + r * 3) % 40);
      books += `<rect x="${x}" y="${400 + r * 175 + (170 - h)}" width="${w}" height="${h}" fill="${shade(bookColors[(i + r) % 6], time)}"/>`;
      x += w + 6;
    }
  }
  let boards = '';
  for (let r = 0; r <= 4; r++) boards += `<rect x="150" y="${390 + r * 175}" width="480" height="18" fill="${woodD}"/>`;
  return svg(W, H, `<rect x="140" y="360" width="500" height="760" fill="${wood}"/><rect x="160" y="380" width="460" height="720" fill="${woodD}" opacity="0.5"/>${boards}${books}`);
}
function lamp(time) {
  const on = time !== 'day';
  const metal = shade('#4a4038', time);
  const shadeCol = on ? (time === 'night' ? '#ffe3a3' : '#fbe1b0') : shade('#f3e6cf', time);
  return svg(W, H, `<rect x="880" y="640" width="14" height="470" fill="${metal}"/>
    <ellipse cx="887" cy="1112" rx="70" ry="16" fill="${metal}"/>
    <path d="M800 640 L974 640 L930 520 L844 520 Z" fill="${shadeCol}"/>`);
}
function lampGlow(time) {
  const k = time === 'night' ? 1 : 0.55;
  return svg(W, H, `<defs>
      <radialGradient id="g" cx="887" cy="600" r="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffc46b" stop-opacity="${0.85 * k}"/><stop offset="0.35" stop-color="#ff9e45" stop-opacity="${0.35 * k}"/><stop offset="1" stop-color="#ff8a30" stop-opacity="0"/></radialGradient>
      <radialGradient id="f"><stop offset="0" stop-color="#ffb35c" stop-opacity="${0.45 * k}"/><stop offset="1" stop-color="#ffb35c" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/><ellipse cx="887" cy="1150" rx="420" ry="120" fill="url(#f)"/>`);
}
function chair(time) {
  const back = shade('#3e4a6b', time);
  const backL = shade('#56648a', time);
  const metal = shade('#2b2b33', time);
  return svg(W, H, `<rect x="1268" y="1250" width="24" height="120" fill="${metal}"/>
    <path d="M1080 1390 L1480 1390 L1460 1420 L1100 1420 Z" fill="${metal}"/>
    <rect x="960" y="740" width="640" height="560" rx="120" fill="${back}"/>
    <rect x="1010" y="790" width="540" height="440" rx="90" fill="${backL}"/>`);
}
function rugShape(fill, ring) {
  return `<ellipse cx="1280" cy="1340" rx="780" ry="105" fill="${fill}"/><ellipse cx="1280" cy="1340" rx="640" ry="78" fill="none" stroke="${ring}" stroke-width="14"/>`;
}
const rug = (time) => svg(W, H, rugShape(shade('#eeeeee', time), shade('#c4c4c4', time)));
const rugMask = svg(W, H, rugShape('#ffffff', '#ffffff'));

// ── Items (sprites; (x, y) of a placement is the bottom centre) ─────────────
function plant(time) {
  const pot = shade('#c8744a', time);
  const leaf = shade('#4f9a57', time);
  const leafL = shade('#6fbf6a', time);
  return svg(280, 440, `<path d="M90 330 H190 L176 440 H104 Z" fill="${pot}"/>
    <ellipse cx="140" cy="200" rx="60" ry="130" fill="${leaf}" transform="rotate(-25 140 300)"/>
    <ellipse cx="140" cy="200" rx="60" ry="130" fill="${leafL}" transform="rotate(25 140 300)"/>
    <ellipse cx="140" cy="180" rx="44" ry="140" fill="${leaf}"/>`);
}
function poster(time) {
  return svg(300, 420, `<rect width="300" height="420" fill="${shade('#2d2a3a', time)}"/>
    <rect x="16" y="16" width="268" height="388" fill="${shade('#f6b4c8', time)}"/>
    <circle cx="150" cy="170" r="80" fill="${shade('#fff3d6', time)}"/>
    <rect x="50" y="300" width="200" height="22" fill="${shade('#2d2a3a', time)}"/>`);
}
function lantern(time) {
  const body = shade('#3a3330', time);
  const flame = time === 'day' ? shade('#f2d7a6', time) : '#ffd27a';
  return svg(420, 420, `<rect x="170" y="290" width="80" height="120" rx="10" fill="${body}"/>
    <rect x="182" y="302" width="56" height="90" rx="6" fill="${flame}"/><path d="M160 290 H260 L240 266 H180 Z" fill="${body}"/>`);
}
const lanternGlow = (time) =>
  svg(
    420,
    420,
    `<defs><radialGradient id="g"><stop offset="0" stop-color="#ffc060" stop-opacity="${time === 'night' ? 0.9 : 0.5}"/><stop offset="1" stop-color="#ff8a30" stop-opacity="0"/></radialGradient></defs>
    <circle cx="210" cy="300" r="118" fill="url(#g)"/><ellipse cx="210" cy="400" rx="200" ry="20" fill="url(#g)" opacity="0.7"/>`,
  );

// ── Write ───────────────────────────────────────────────────────────────────
const frames = (base, opts = {}) =>
  Object.fromEntries(
    TIMES.map((t) => {
      const f = { src: `${base}/${t}.webp` };
      if (opts.mask) f.mask = opts.mask;
      if (opts.glow && opts.glow(t)) {
        f.glow = `${base}/${t}-glow.webp`;
        if (opts.effect) f.effect = opts.effect;
      }
      return [t, f];
    }),
  );

async function main() {
  const t0 = Date.now();
  for (const t of TIMES) {
    await emit(`view/${t}.webp`, view(t));
    await emit(`shell/${t}.webp`, shell(t));
    await emit(`curtains/${t}.webp`, curtains(t));
    await emit(`shelf/${t}.webp`, shelf(t));
    await emit(`lamp/${t}.webp`, lamp(t));
    if (t !== 'day') await emit(`lamp/${t}-glow.webp`, lampGlow(t));
    await emit(`chair/${t}.webp`, chair(t));
    await emit(`rug/${t}.webp`, rug(t));
    await emit(`items/plant/${t}.webp`, plant(t));
    await emit(`items/poster/${t}.webp`, poster(t));
    await emit(`items/lantern/${t}.webp`, lantern(t));
    if (t !== 'day') await emit(`items/lantern/${t}-glow.webp`, lanternGlow(t));
  }
  await emit('shell/mask.webp', shellMask);
  await emit('curtains/mask.webp', curtainsMask);
  await emit('rug/mask.webp', rugMask);

  const manifest = {
    format: 'sei-room',
    version: 1,
    id: 'cozy',
    place: 'your bedroom',
    canvas: [W, H],
    avatar: { x: 1280, y: 1440, height: 1120 },
    floor: [0, FLOOR_Y, W, H - FLOOR_Y],
    slots: {
      view: { z: 0, options: ['view-city'] },
      shell: { z: 10, options: ['shell-cozy'] },
      curtains: { z: 20, options: ['curtains-plain'], optional: true },
      shelf: { z: 30, options: ['shelf-books'], optional: true },
      rug: { z: 40, options: ['rug-round'], optional: true },
      lamp: { z: 50, options: ['lamp-floor'], optional: true },
      chair: { z: 90, options: ['chair-office'] },
    },
    components: [
      { id: 'view-city', slot: 'view', name: 'city view', frames: frames('view') },
      { id: 'shell-cozy', slot: 'shell', name: 'bedroom walls', tintable: true, defaultTint: '#e9dccb', frames: frames('shell', { mask: 'shell/mask.webp' }) },
      { id: 'curtains-plain', slot: 'curtains', name: 'curtains', tintable: true, defaultTint: '#8f6fd1', frames: frames('curtains', { mask: 'curtains/mask.webp' }) },
      { id: 'shelf-books', slot: 'shelf', name: 'bookshelf', frames: frames('shelf') },
      { id: 'rug-round', slot: 'rug', name: 'round rug', tintable: true, defaultTint: '#d98f8f', frames: frames('rug', { mask: 'rug/mask.webp' }) },
      { id: 'lamp-floor', slot: 'lamp', name: 'floor lamp', frames: frames('lamp', { glow: (t) => t !== 'day' }) },
      { id: 'chair-office', slot: 'chair', name: 'desk chair', frames: frames('chair') },
      { id: 'plant', slot: 'item', name: 'potted plant', placement: 'floor', frames: frames('items/plant') },
      { id: 'poster', slot: 'item', name: 'poster', placement: 'wall', frames: frames('items/poster') },
      { id: 'lantern', slot: 'item', name: 'lantern', placement: 'floor', frames: frames('items/lantern', { glow: (t) => t !== 'day', effect: 'flicker' }) },
    ],
    overlay: { day: '#f2ebe2', dusk: '#a3766c', night: '#242a47' },
  };
  await writeFile(path.join(PACK, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`seilink dev pack: ${PACK} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
