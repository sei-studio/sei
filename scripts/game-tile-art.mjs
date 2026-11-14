// Tile art for the games picker (261115): original scenes in the sei.gg
// Backseat illustration style (gradient sky, soft glowing disc, layered hills,
// flat silhouettes). No game logos, key art or characters.
// Usage: node scripts/game-tile-art.mjs <outDir>  (960x540 PNGs via headless
// Chrome; CHROME_PATH overrides /usr/bin/google-chrome). The shipped JPGs in
// src/renderer/public/img/game-<id>.jpg are these, converted at quality 86.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const pw = await import(req.resolve('playwright'));
const chromium = pw.chromium ?? pw.default.chromium;
const OUT = process.argv[2];
const W = 960, H = 540;

// Deterministic pseudo-random for stars, windows, blocks.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const defs = (id, stops) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
    .join('')}</linearGradient>`;
const blur = (id, s) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${s}"/></filter>`;
// A smooth hill band: points across the width, filled to the bottom.
function hill(y, amp, waves, phase, color) {
  let d = `M0 ${H} L0 ${y}`;
  for (let x = 0; x <= W; x += 16) {
    const yy = y + Math.sin((x / W) * Math.PI * waves + phase) * amp + Math.sin((x / W) * Math.PI * waves * 2.3 + phase * 1.7) * amp * 0.35;
    d += ` L${x} ${yy.toFixed(1)}`;
  }
  return `<path d="${d} L${W} ${H} Z" fill="${color}"/>`;
}
function stars(n, maxY, op = 0.7) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * maxY).toFixed(0)}" r="${(0.6 + rnd() * 1.3).toFixed(1)}" fill="#fff" opacity="${(op * (0.3 + rnd() * 0.7)).toFixed(2)}"/>`;
  return s;
}
function pine(x, base, h, color) {
  const w = h * 0.36;
  return `<path d="M${x} ${base - h} L${x + w * 0.5} ${base - h * 0.55} L${x + w * 0.28} ${base - h * 0.55} L${x + w * 0.62} ${base - h * 0.18} L${x + w * 0.1} ${base - h * 0.18} L${x + w * 0.1} ${base} L${x - w * 0.1} ${base} L${x - w * 0.1} ${base - h * 0.18} L${x - w * 0.62} ${base - h * 0.18} L${x - w * 0.28} ${base - h * 0.55} L${x - w * 0.5} ${base - h * 0.55} Z" fill="${color}"/>`;
}

const scenes = {};

// Elden Ring: amber dusk, a great glowing tree on the horizon, ruins on a cliff.
scenes.eldenring = () => {
  let tree = '';
  // Trunk plus branching canopy, drawn as glowing gold strokes.
  const branch = (x, y, len, ang, depth) => {
    if (depth === 0) return;
    const x2 = x + Math.cos(ang) * len, y2 = y - Math.sin(ang) * len;
    tree += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ffd98a" stroke-width="${(depth * 1.5).toFixed(1)}" stroke-linecap="round"/>`;
    branch(x2, y2, len * 0.72, ang + 0.42 + (rnd() - 0.5) * 0.2, depth - 1);
    branch(x2, y2, len * 0.72, ang - 0.42 + (rnd() - 0.5) * 0.2, depth - 1);
  };
  branch(610, 330, 70, Math.PI / 2, 7);
  return `
  <defs>${defs('sky', [[0, '#1f1831'], [0.45, '#4e3738'], [0.75, '#8a5a3c'], [1, '#b8834f']])}${blur('b1', 26)}${blur('b2', 3)}${blur('b3', 60)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars(40, 160, 0.35)}
  <circle cx="610" cy="200" r="170" fill="#ffcf7a" opacity="0.28" filter="url(#b3)"/>
  <g filter="url(#b2)" opacity="0.9">${tree}</g>
  <g opacity="0.55" filter="url(#b1)">${tree}</g>
  ${hill(345, 14, 2.2, 0.6, '#5a3c3a')}
  ${hill(385, 18, 1.6, 2.2, '#3a2a33')}
  <path d="M60 540 L60 300 L90 300 L90 280 L110 280 L110 300 L130 300 L130 250 L150 235 L170 250 L170 330 L200 330 L200 300 L225 300 L225 380 L330 420 L330 540 Z" fill="#1d1522"/>
  <path d="M138 270 L162 270 L162 300 L138 300 Z" fill="#ffb867" opacity="0.5"/>
  ${hill(440, 16, 1.2, 4.0, '#211826')}
  ${hill(490, 10, 1.8, 1.0, '#120c18')}`;
};

// Silksong: blue-violet night, pale moon, silk threads, spires of a citadel.
scenes.silksong = () => {
  let threads = '';
  for (let i = 0; i < 9; i++) {
    const x = 60 + i * 105 + rnd() * 40, len = 120 + rnd() * 230;
    threads += `<line x1="${x}" y1="0" x2="${x + (rnd() - 0.5) * 10}" y2="${len}" stroke="#e8e6ff" stroke-width="1.2" opacity="${(0.25 + rnd() * 0.3).toFixed(2)}"/><circle cx="${x}" cy="${len}" r="3" fill="#f2efff" opacity="0.55"/>`;
  }
  let spires = '';
  const sp = [[520, 250, 26], [580, 190, 30], [640, 230, 24], [700, 270, 22], [470, 300, 20], [760, 310, 18]];
  for (const [x, top, w] of sp) {
    spires += `<path d="M${x - w / 2} 420 L${x - w / 2} ${top + 40} Q${x} ${top - 10} ${x + w / 2} ${top + 40} L${x + w / 2} 420 Z" fill="#0b0f22"/><line x1="${x}" y1="${top + 2}" x2="${x}" y2="${top - 40}" stroke="#0b0f22" stroke-width="3"/>`;
    for (let k = 0; k < 3; k++) if (rnd() > 0.35) spires += `<rect x="${x - 3}" y="${top + 60 + k * 34}" width="6" height="10" fill="#f6d7a0" opacity="0.75"/>`;
  }
  return `
  <defs>${defs('sky', [[0, '#0f1525'], [0.55, '#1d213b'], [1, '#2e3458']])}${blur('b1', 14)}${blur('b2', 40)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars(90, 300, 0.8)}
  <circle cx="300" cy="150" r="120" fill="#a8a8d8" opacity="0.18" filter="url(#b2)"/>
  <circle cx="300" cy="150" r="54" fill="#c9c8e6" opacity="0.9" filter="url(#b1)"/>
  ${threads}
  ${hill(390, 20, 2.0, 1.3, '#262b4b')}
  ${spires}
  ${hill(430, 18, 1.4, 3.0, '#171b33')}
  ${hill(490, 12, 2.4, 0.4, '#0a0e1a')}`;
};

// Valheim: teal aurora, moon, pines, a longship on dark water.
scenes.valheim = () => {
  let pines = '';
  for (let i = 0; i < 26; i++) {
    const x = rnd() * W, h = 50 + rnd() * 70;
    if (x > 360 && x < 640) continue;
    pines += pine(x, 395 + rnd() * 10, h, '#0b2229');
  }
  return `
  <defs>${defs('sky', [[0, '#0b1b27'], [0.5, '#153f47'], [1, '#17313a']])}${blur('b1', 30)}${blur('b2', 10)}${blur('b3', 45)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars(70, 260, 0.6)}
  <path d="M-40 140 C 160 60, 320 220, 520 110 S 860 90, 1000 160 L1000 220 C 820 160, 680 260, 500 190 S 120 150, -40 230 Z" fill="#3fd0a0" opacity="0.32" filter="url(#b3)"/>
  <path d="M-40 90 C 200 40, 380 150, 560 80 S 880 40, 1000 110" stroke="#7af0c0" stroke-width="18" fill="none" opacity="0.22" filter="url(#b1)"/>
  <circle cx="700" cy="150" r="40" fill="#cfe2e4" opacity="0.85" filter="url(#b2)"/>
  ${hill(360, 22, 1.6, 0.3, '#12343c')}
  ${pines}
  <rect x="0" y="405" width="${W}" height="135" fill="#0a1d24"/>
  <path d="M0 440 L960 440" stroke="#2a5560" stroke-width="2" opacity="0.5"/>
  <path d="M0 470 L960 470" stroke="#2a5560" stroke-width="2" opacity="0.35"/>
  <path d="M400 420 Q 480 445 560 420 L 548 432 Q 480 452 412 432 Z" fill="#06141a"/>
  <path d="M400 420 Q 392 400 404 392" stroke="#06141a" stroke-width="5" fill="none"/>
  <path d="M560 420 Q 568 400 556 392" stroke="#06141a" stroke-width="5" fill="none"/>
  <line x1="480" y1="425" x2="480" y2="340" stroke="#06141a" stroke-width="4"/>
  <path d="M444 348 L516 348 L512 404 L448 404 Z" fill="#7a2f2a" opacity="0.9"/>
  <path d="M444 348 L516 348 L512 404 L448 404 Z" fill="none" stroke="#06141a" stroke-width="2"/>
  <circle cx="700" cy="460" r="30" fill="#cfe2e4" opacity="0.12" filter="url(#b2)"/>`;
};

// Genshin Impact: bright day, distant mountains, a floating island with a waterfall, wind.
scenes.genshin = () => {
  let clouds = '';
  for (const [x, y, s] of [[140, 120, 1.2], [760, 90, 1], [560, 200, 0.8], [880, 240, 0.7]]) {
    clouds += `<g opacity="0.85" transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="0" rx="70" ry="22" fill="#fff"/><ellipse cx="-30" cy="-14" rx="34" ry="22" fill="#fff"/><ellipse cx="22" cy="-18" rx="40" ry="26" fill="#fff"/></g>`;
  }
  return `
  <defs>${defs('sky', [[0, '#3d7fd0'], [0.6, '#8cc4ee'], [1, '#d8eefa']])}${blur('b1', 8)}${blur('b2', 2)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="180" cy="110" r="70" fill="#fff8e0" opacity="0.6" filter="url(#b1)"/>
  ${clouds}
  <path d="M0 380 L120 260 L200 330 L320 210 L430 320 L520 270 L640 360 L760 240 L880 330 L960 290 L960 540 L0 540 Z" fill="#9db9d8" opacity="0.8"/>
  <path d="M300 222 L320 210 L342 230 Z" fill="#fff" opacity="0.8"/>
  <path d="M742 252 L760 240 L780 262 Z" fill="#fff" opacity="0.8"/>
  ${hill(410, 16, 1.8, 0.8, '#6f9bc0')}
  <g transform="translate(600 160)">
    <path d="M-120 40 Q 0 20 120 40 L 70 70 L 30 140 L 0 110 L -40 150 L -70 80 Z" fill="#5c6f8a"/>
    <path d="M-120 40 Q 0 20 120 40 Q 0 52 -120 40 Z" fill="#6fbf73"/>
    <path d="M-124 40 Q 0 14 124 40 Q 0 30 -124 40 Z" fill="#8fd48e"/>
    <rect x="-8" y="-30" width="16" height="64" fill="#e8e2d0"/>
    <path d="M-20 -30 L0 -52 L20 -30 Z" fill="#c9604a"/>
    <path d="M60 40 L 74 40 L 70 260 L 62 260 Z" fill="#e8f6ff" opacity="0.8" filter="url(#b2)"/>
  </g>
  ${hill(450, 14, 1.4, 2.4, '#4f8a5e')}
  ${hill(495, 10, 2.0, 0.2, '#3a6e4a')}
  <path d="M40 300 C 200 280, 300 320, 460 300" stroke="#fff" stroke-width="3" fill="none" opacity="0.6" stroke-linecap="round"/>
  <path d="M520 420 C 640 400, 720 430, 860 410" stroke="#fff" stroke-width="3" fill="none" opacity="0.55" stroke-linecap="round"/>
  <path d="M100 460 C 180 450, 230 470, 300 455" stroke="#fff" stroke-width="2" fill="none" opacity="0.5" stroke-linecap="round"/>`;
};

// Escape the Backrooms: a one-point-perspective yellow hallway, buzzing lights.
scenes.backrooms = () => {
  const cx = 480, cy = 250; // vanishing point
  const far = { l: 410, r: 550, t: 200, b: 310 };
  let lights = '';
  for (let i = 0; i < 5; i++) {
    const t = Math.pow(i / 5, 1.6);
    const y = 0 + (far.t - 0) * t + 18 * (1 - t);
    const hw = 150 * (1 - t) + 18 * t, hh = 16 * (1 - t) + 3 * t;
    lights += `<rect x="${cx - hw}" y="${y}" width="${hw * 2}" height="${hh}" fill="#fffbe0" opacity="${0.95 - i * 0.1}"/>`;
  }
  let stripes = '';
  for (let i = 1; i < 9; i++) {
    const t = i / 9;
    const xl = 0 + (far.l - 0) * t, xr = W - (W - far.r) * t;
    const top = 0 + (far.t - 0) * t, bot = H - (H - far.b) * t;
    stripes += `<line x1="${xl}" y1="${top}" x2="${xl}" y2="${bot}" stroke="#a8913c" stroke-width="${2 * (1 - t) + 0.5}" opacity="0.35"/>`;
    stripes += `<line x1="${xr}" y1="${top}" x2="${xr}" y2="${bot}" stroke="#a8913c" stroke-width="${2 * (1 - t) + 0.5}" opacity="0.35"/>`;
  }
  return `
  <defs>${defs('wallL', [[0, '#c8b45a'], [1, '#a8933e']])}${defs('floor', [[0, '#7a6a3a'], [1, '#5a4c26']])}${blur('b1', 18)}${blur('b2', 6)}
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="#cbb85e"/>
  <path d="M0 0 L${far.l} ${far.t} L${far.l} ${far.b} L0 ${H} Z" fill="url(#wallL)"/>
  <path d="M${W} 0 L${far.r} ${far.t} L${far.r} ${far.b} L${W} ${H} Z" fill="url(#wallL)"/>
  <path d="M0 0 L${W} 0 L${far.r} ${far.t} L${far.l} ${far.t} Z" fill="#d9cf9a"/>
  <path d="M0 ${H} L${W} ${H} L${far.r} ${far.b} L${far.l} ${far.b} Z" fill="url(#floor)"/>
  ${stripes}
  <rect x="${far.l}" y="${far.t}" width="${far.r - far.l}" height="${far.b - far.t}" fill="#3a3220"/>
  <rect x="${far.l + 30}" y="${far.t}" width="80" height="${far.b - far.t}" fill="#16120a"/>
  <path d="M120 120 L220 150 L220 420 L120 470 Z" fill="#2a2416" opacity="0.85"/>
  ${lights}
  <g filter="url(#b1)" opacity="0.5">${lights}</g>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>`;
};

// Factorio: dusk factory skyline (the sei.gg Factorio illustration's scene).
scenes.factorio = () => {
  let windows = '';
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W, y = 330 + rnd() * 70;
    windows += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="7" height="5" fill="#f2a64a" opacity="${(0.5 + rnd() * 0.5).toFixed(2)}"/>`;
  }
  let belts = '';
  for (const y of [440, 475, 510]) {
    belts += `<rect x="0" y="${y - 7}" width="${W}" height="14" fill="#2a2430"/>`;
    for (let x = 0; x < W; x += 28) belts += `<rect x="${x + 6}" y="${y - 2}" width="14" height="4" fill="#6b6170" opacity="0.6"/>`;
    for (let x = 30; x < W; x += 96 + ((x * 7) % 40)) belts += `<rect x="${x}" y="${y - 6}" width="12" height="12" fill="#e19a4c"/>`;
  }
  let stacks = '';
  for (const [x, top, w] of [[170, 200, 22], [230, 250, 18], [560, 175, 24], [620, 230, 18], [380, 280, 18]]) {
    stacks += `<rect x="${x}" y="${top}" width="${w}" height="${420 - top}" fill="#1a1520"/>`;
  }
  return `
  <defs>${defs('sky', [[0, '#1e1b2e'], [0.5, '#3d2c34'], [0.8, '#7a4636'], [1, '#a35a3a']])}${blur('b1', 6)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars(30, 140, 0.4)}
  <g filter="url(#b1)" opacity="0.32" fill="#c7b0b0">
    <circle cx="180" cy="150" r="58"/><circle cx="235" cy="120" r="46"/><circle cx="570" cy="130" r="72"/><circle cx="640" cy="90" r="52"/><circle cx="388" cy="230" r="40"/>
  </g>
  ${stacks}
  <path d="M0 330 L120 330 L120 300 L300 300 L300 320 L460 320 L460 290 L700 290 L700 315 L820 315 L820 285 L960 285 L960 420 L0 420 Z" fill="#1a1520"/>
  ${windows}
  <rect x="0" y="415" width="${W}" height="125" fill="#120e16"/>
  ${belts}`;
};

// Terraria: a blocky side view at night: grass, dirt, stone, glowing ore, a tree.
scenes.terraria = () => {
  const B = 24;
  let blocks = '';
  const cols = W / B;
  let h = 12;
  const tops = [];
  for (let c = 0; c < cols; c++) {
    if (rnd() < 0.35) h += rnd() < 0.5 ? -1 : 1;
    h = Math.max(10, Math.min(15, h));
    tops.push(h);
  }
  for (let c = 0; c < cols; c++) {
    const top = tops[c];
    for (let r = top; r < H / B; r++) {
      const depth = r - top;
      let col = depth === 0 ? '#5fa83c' : depth < 4 ? '#7a5234' : '#5d5d66';
      if (depth >= 4 && depth < 6 && rnd() < 0.4) col = '#6a4a32';
      if (depth > 4 && rnd() < 0.06) col = rnd() < 0.5 ? '#e8b04a' : '#6fd0e8';
      const shade = 0.88 + rnd() * 0.12;
      blocks += `<rect x="${c * B}" y="${r * B}" width="${B}" height="${B}" fill="${col}" opacity="${shade.toFixed(2)}"/>`;
      if (depth === 0) blocks += `<rect x="${c * B}" y="${r * B}" width="${B}" height="6" fill="#7cc84e"/>`;
    }
  }
  // A cave pocket.
  blocks += `<path d="M${B * 22} ${B * 19} h${B * 6} v${B} h${B * 2} v${B * 2} h-${B * 9} v-${B} h${B} Z" fill="#1c1a24"/>`;
  // Tree.
  const tc = 9, tt = tops[tc] * B;
  let tree = `<rect x="${tc * B + 6}" y="${tt - B * 5}" width="12" height="${B * 5}" fill="#6b4a2c"/>`;
  const x0 = tc * B + 12;
  tree += `<path d="M${x0 - 12} ${tt - B * 8} h24 v12 h24 v12 h12 v36 h-12 v12 h-24 v12 h-48 v-12 h-24 v-12 h-12 v-36 h12 v-12 h24 v-12 Z" fill="#3f8a3a"/>`;
  tree += `<path d="M${x0 - 12} ${tt - B * 8} h24 v12 h24 v12 h-48 v-12 h0 Z" fill="#56a64a"/>`;
  return `
  <defs>${defs('sky', [[0, '#0e1430'], [0.6, '#24305e'], [1, '#3a4a7a']])}${blur('b1', 10)}${blur('b2', 30)}</defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars(90, 230, 0.8)}
  <circle cx="760" cy="110" r="90" fill="#fff6d8" opacity="0.14" filter="url(#b2)"/>
  <path d="M736 70 h48 v8 h8 v8 h8 v48 h-8 v8 h-8 v8 h-48 v-8 h-8 v-8 h-8 v-48 h8 v-8 h8 Z" fill="#fff4cf" opacity="0.92"/>
  <rect x="744" y="90" width="16" height="16" fill="#e8dcb0" opacity="0.8"/><rect x="772" y="116" width="12" height="12" fill="#e8dcb0" opacity="0.8"/>
  ${hill(250, 16, 2.4, 1.2, '#1c2648')}
  ${blocks}
  ${tree}`;
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // One scene per document: the scenes reuse gradient/filter ids.
  for (const [id, f] of Object.entries(scenes)) {
    seed = 7; // each scene draws the same stars/blocks whatever runs before it
    await page.setContent(`<!doctype html><html><body style="margin:0"><svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">${f()}</svg></body></html>`);
    await page.locator(`#${id}`).screenshot({ path: path.join(OUT, `game-${id}.png`) });
    console.log(id);
  }
} finally {
  await browser.close();
}
