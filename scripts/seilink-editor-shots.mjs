#!/usr/bin/env node
/**
 * Screenshots of the SeiLink room editor (261104), headless, no Electron.
 *
 *   node scripts/seilink-editor-shots.mjs --packs <dir> [--out seilink-editor-shots]
 *                                         [--shots day,curtains,...] [--size 1280x720]
 *                                         [--presets gamer,cozy] [--perf [--profile]] [--dpr 2]
 *
 * <dir> holds one folder per preset (<dir>/cozy/manifest.json, ...); every
 * preset found is passed to the editor, so the room type picker can switch.
 * Starts the renderer's Vite dev server, a CORS static server for <dir> and
 * headless Chrome (playwright), opens `?seilink=1&editor=1&pack=...` per
 * shot and drives it. A shot may name a crop (room canvas px) to zoom in on;
 * `--dpr 2` renders the room at full resolution for those. `--perf` also times a colour drag against structural
 * edits (long tasks on the main thread). Everything it starts is closed
 * before it exits. CHROME_PATH overrides the browser.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PACKS = path.resolve(arg('packs', 'seilink-dev-packs'));
const OUT = path.resolve(arg('out', 'seilink-editor-shots'));
const [VW, VH] = arg('size', '1280x720').split('x').map(Number);
const PERF = process.argv.includes('--perf');
const DPR = Number(arg('dpr', 1));
const PROFILE = process.argv.includes('--profile');

/**
 * name -> [query, optional action]. The rail has five panels (avatar, room,
 * fabrics, furniture, items); `panel=<slot id>` (curtains, shell, view, lamp,
 * ...) opens the slot's group with that section scrolled into view, so the
 * slot shots below show their part of the group's panel.
 */
const SHOTS = {
  day: ['time=day&items=1'],
  room: ['time=day&items=1&panel=room'],
  fabrics: ['time=day&items=1&panel=fabrics'],
  furniture: ['time=day&items=1&panel=furniture'],
  items: ['time=day&items=1&panel=items'],
  'night-room': ['time=night&items=1&panel=room'],
  'night-fabrics': ['time=night&items=1&panel=fabrics'],
  // Opens Furniture scrolled down to its last section.
  'night-furniture': ['time=night&items=1&panel=lamp'],
  'night-items': ['time=night&items=1&panel=items'],
  // Click the left curtain in the room: Walls & fabrics opens at Curtains, which flashes.
  'click-part': [
    'time=day&items=1',
    async (page) => {
      const box = await page.locator('[data-room-editor] canvas').first().boundingBox();
      await page.mouse.click(box.x + box.width * 0.49, box.y + box.height * 0.3);
    },
  ],
  curtains: ['time=day&items=1&panel=curtains'],
  walls: ['time=day&panel=shell'],
  'item-day': ['time=day&items=1&panel=items&selected=3'],
  'item-color': ['time=dusk&items=1&panel=items&selected=4', async (page) => page.getByRole('button', { name: 'Color', exact: true }).click()],
  'room-dusk': ['time=dusk&items=1&panel=room'],
  'night-walls': ['time=night&items=1&panel=shell'],
  'night-avatar': ['time=night&items=1&panel=avatar'],
  'night-item': ['time=night&items=1&panel=items&selected=3'],
  'night-view': ['time=night&panel=view'],
  drag: [
    'time=day&items=1&panel=items',
    async (page) => {
      // Grab the floor cushion and pull it left along the floor.
      const box = await page.locator('[data-room-editor] canvas').first().boundingBox();
      const vw = box.width;
      const sx = vw * 0.86;
      const sy = box.height * 0.96;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(sx - i * 30, sy - i * 4);
      await page.waitForTimeout(250);
    },
  ],
  close: ['time=day&items=1', async (page) => {
    await page.getByRole('button', { name: 'Flip' }).count();
    await page.keyboard.press('Escape');
  }],
  // Recolour through the fast path; compare with 'retint-ref' (same colour, drawn fresh).
  retint: [
    'time=day&items=1&panel=curtains',
    async (page) => {
      await page.evaluate(async () => {
        const input = document.querySelector('[data-room-editor] [data-slot="curtains"] input[type=color]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const c of ['#3b6fd1', '#d13b6f', '#6fd13b', '#7a4fc2']) {
          setter.call(input, c);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(800);
    },
  ],
  'retint-ref': ['time=day&items=1&panel=curtains&tint.curtains=7a4fc2'],
  'lang-ja': ['time=dusk&items=1&panel=room&lang=ja'],
  // Physics-aware placement (261105), in cozy canvas px. Items with items=1 are
  // the pack's own, in manifest order: desk_lamp 0, books 1, succulent 2, monstera 3, cushion 4.
  // Books held between the shelves: the shelf tops show, the one they would land on brighter.
  'place-drag': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [360, 250], { release: false })],
  // Books dropped on the top shelf, clear of the rail.
  'place-books-shelf': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [360, 250])],
  // The monstera held up on the back wall: the floor shows (minus the bed, lamp and chair), the plant drops onto it.
  'place-drag-floor': ['time=day&items=1', async (page) => dragRoom(page, [1975, 1350], [2050, 1000], { release: false })],
  // The monstera at the back of the floor (smaller) and at the front, by the bed.
  'place-plant-back': ['time=day&items=1', async (page) => dragRoom(page, [1975, 1350], [2050, 1000])],
  'place-plant-front': ['time=day&items=1', async (page) => dragRoom(page, [1975, 1350], [600, 1310])],
  // Shelf tops (261105 shelf pass). Books are grabbed 68 px above their anchor and stand
  // 14 px above it (foot), so a pointer at y puts their contact at y + 54. The middle plank
  // at x 300 runs from its back edge (y 445) to the front of its top face (y 468).
  // Held a little above the middle plank: its whole top glows as a band, the lip over the books.
  'shelf-drag-band': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [300, 382], { release: false }), [0, 160, 720, 520]],
  // Dropped at the back of the band, and at its front (tucked behind the lip).
  'shelf-books-back': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [300, 392]), [170, 340, 300, 170]],
  'shelf-books-front': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [300, 412]), [170, 340, 300, 170]],
  // Dropped 34 px above the plank's back edge: it still lands on that plank.
  'shelf-drop-above': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [300, 357]), [0, 160, 720, 520]],
  // 36 px past the middle plank's right end (x 524): it lands on that plank, kept in from the end.
  'shelf-drop-past-end': ['time=day&items=1', async (page) => dragRoom(page, [610, 950], [560, 425]), [0, 160, 720, 520]],
  // The books on the bed (their artist spot) and the succulent moved onto the bed: sunk into the duvet.
  'bed-books': ['time=day&items=1', null, [470, 860, 300, 190]],
  'bed-succulent': ['time=day&items=1', async (page) => dragRoom(page, [390, 430], [330, 965]), [220, 880, 520, 170]],
};

/** Room canvas px to page px (the room's canvases fill its scene box). */
async function roomToPage(page, [cx, cy]) {
  const box = await page.locator('[data-room-editor] canvas').first().boundingBox();
  const [w, h] = ROOM_CANVAS;
  return [box.x + (cx * box.width) / w, box.y + (cy * box.height) / h];
}

/** Grab the room at `from` and drag to `to` (canvas px); drop it unless release is false (then Escape lets go of the selection and closes the panel, so the room shows whole). */
async function dragRoom(page, from, to, { release = true } = {}) {
  const [sx, sy] = await roomToPage(page, from);
  const [tx, ty] = await roomToPage(page, to);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(sx + ((tx - sx) * i) / 12, sy + ((ty - sy) * i) / 12);
  await page.waitForTimeout(400);
  if (!release) return;
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}
const names = arg('shots', Object.keys(SHOTS).join(',')).split(',');
let ROOM_CANVAS = [2560, 1440];

function packServer(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (!p.startsWith(root + path.sep)) {
        res.writeHead(403, headers);
        return res.end();
      }
      fs.readFile(p, (err, buf) => {
        if (err) {
          res.writeHead(404, headers);
          return res.end();
        }
        const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.webp') ? 'image/webp' : 'image/png';
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function waitReady(page) {
  // The rail draws icons, so the editor is up once the rail is; an open panel
  // still shows image thumbnails, so wait until none is a placeholder (a
  // disabled "Soon" room card keeps its placeholder for good).
  await page.waitForSelector('[data-room-editor] nav', { timeout: 60_000 }).catch(() => console.log('editor never showed its rail'));
  await page
    .waitForFunction(() => !document.querySelector('[data-room-editor] section button:not(:disabled) [class*="Wait"]'), null, { timeout: 30_000 })
    .catch(() => console.log('panel never showed its thumbnails'));
  await page.waitForTimeout(1500);
}

async function perf(page, base) {
  await page.goto(`${base}&time=day&items=1&panel=curtains`, { waitUntil: 'load' });
  await waitReady(page);
  let cdp = null;
  if (PROFILE) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const result = await page.evaluate(async () => {
    const tasks = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(e.duration)));
    obs.observe({ entryTypes: ['longtask'] });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const input = document.querySelector('[data-room-editor] [data-slot="curtains"] input[type=color]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const run = async (fn, n) => {
      tasks.length = 0;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        fn(i);
        await frame();
      }
      await new Promise((r) => setTimeout(r, 400));
      const ms = performance.now() - t0;
      return { ms: Math.round(ms), perStep: Math.round(ms / n), longTasks: tasks.length, longest: Math.round(Math.max(0, ...tasks)) };
    };
    const tint = await run((i) => {
      const h = (i * 9) % 360;
      const c = `hsl(${h} 60% 60%)`;
      const el = document.createElement('div');
      el.style.color = c;
      document.body.appendChild(el);
      const rgb = getComputedStyle(el).color.match(/\d+/g).map(Number);
      el.remove();
      setter.call(input, '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 40);
    // Structural edits (swap the part back and forth) rebuild every layer.
    const opts = [...document.querySelectorAll('[data-room-editor] [data-slot="curtains"] button[aria-pressed]')];
    const swap = await run((i) => opts[i % 2]?.click(), 12);
    obs.disconnect();
    return { tint, swap };
  });
  console.log('perf (40 colour steps vs 12 part swaps):', JSON.stringify(result));
  if (cdp) {
    // Self time per function over the whole run (tint steps then swaps).
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n);
    const callers = new Map();
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      if (n.callFrame.functionName !== 'drawImage') return;
      const p = parent.get(n.id);
      const f = p?.callFrame;
      const key = f ? `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}` : '?';
      callers.set(key, (callers.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    for (const [k, ms] of [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  drawImage from ${k}: ${Math.round(ms)} ms`);
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    for (const [k, ms] of top) console.log(`  ${Math.round(ms).toString().padStart(6)} ms  ${k}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // --presets gamer,cozy picks the order (the first one is the room shown).
  const found = fs.readdirSync(PACKS).filter((d) => fs.existsSync(path.join(PACKS, d, 'manifest.json')));
  const order = arg('presets', '').split(',').filter((p) => found.includes(p));
  const presets = [...order, ...found.filter((p) => !order.includes(p))];
  ROOM_CANVAS = JSON.parse(fs.readFileSync(path.join(PACKS, presets[0], 'manifest.json'), 'utf8')).canvas ?? ROOM_CANVAS;
  const packs = await packServer(PACKS);
  const vite = await createServer({
    configFile: false,
    root: path.join(REPO, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(REPO, 'src/renderer/src'), '@shared': path.join(REPO, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
    logLevel: 'warn',
  });
  let browser;
  try {
    await vite.listen();
    const viteUrl = vite.resolvedUrls.local[0].replace(/\/$/, '');
    const packQ = presets.map((p) => `pack=${encodeURIComponent(`http://127.0.0.1:${packs.address().port}/${p}/`)}`).join('&');
    const base = `${viteUrl}/?seilink=1&editor=1&${packQ}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text().slice(0, 240)}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400) console.log(`[page ${r.status()}] ${r.url().slice(0, 200)}`);
    });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    for (const name of names) {
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const [q, act, crop] = shot;
      await page.goto(`${base}&${q}`, { waitUntil: 'load' });
      await waitReady(page);
      if (act) {
        await act(page);
        await page.waitForTimeout(500);
      }
      const file = path.join(OUT, `${name}.png`);
      let clip;
      if (crop) {
        const [x0, y0] = await roomToPage(page, [crop[0], crop[1]]);
        const [x1, y1] = await roomToPage(page, [crop[0] + crop[2], crop[1] + crop[3]]);
        const left = Math.max(0, x0);
        const top = Math.max(0, y0);
        clip = { x: left, y: top, width: Math.min(VW, x1) - left, height: Math.min(VH, y1) - top };
      }
      await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
      await page.mouse.up().catch(() => {});
      console.log(file);
    }
    if (PERF) await perf(page, base);
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
