#!/usr/bin/env node
/**
 * Screenshots of the WorldLink wallpaper widgets and lighting (261119),
 * headless, no Electron.
 *
 *   node scripts/seilink-widgets-shots.mjs [--packs resources/seilink-packs] [--out seilink-widgets-shots]
 *                                          [--shots editor-clock,desktop,...] [--preset cozy]
 *
 * Starts the renderer's Vite dev server, a CORS static server for the packs
 * and headless Chrome (playwright). Editor shots open the room editor
 * (`?seilink=1&editor=1`, DevRoomPreview: widgets=demo, widget=<id>,
 * light.*=); desktop shots open the wallpaper page with its fake host bridge
 * (`?seilinkhost=1`, DevHostPreview) with the room passed as `state=<json>`,
 * so widgets and lighting go through the same sanitizer as a saved room. The
 * clock is pinned (Playwright's fixed time) so the shots read 9:41 PM.
 * Everything it starts is closed before it exits. CHROME_PATH overrides the
 * browser.
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
const PACKS = path.resolve(arg('packs', path.join(REPO, 'resources/seilink-packs')));
const OUT = path.resolve(arg('out', 'seilink-widgets-shots'));
const PRESET = arg('preset', 'cozy');
const PINNED = new Date(2026, 10, 19, 21, 41, 7);

/** The desktop as someone might set it up: a big clock with its date, a quote line, day progress. */
const DESKTOP_WIDGETS = [
  { id: 'clock', kind: 'clock', x: 0.93, y: 0.2, align: 'right', font: 'system', color: '#ffffff', size: 130, weight: 300, opacity: 0.95, shadow: true, hour12: true, pad: false, seconds: false, ampm: true, date: 'long' },
  { id: 'progress', kind: 'progress', x: 0.07, y: 0.1, align: 'left', font: 'system', color: '#ffffff', size: 20, weight: 600, opacity: 0.85, shadow: true, span: 'day' },
  { id: 'text', kind: 'text', x: 0.92, y: 0.93, align: 'right', font: 'serif', color: '#f5efe3', size: 26, weight: 400, opacity: 0.9, shadow: true, text: 'one thing at a time' },
];
const DIM = { brightness: -10, dim: 55, warmth: 0, character: false };
const stateQ = (extra = {}) => `state=${encodeURIComponent(JSON.stringify({ widgets: DESKTOP_WIDGETS, ...extra }))}`;

/** name -> { kind: 'editor' | 'host', q, size, act? } */
const SHOTS = {
  'editor-clock': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=misc&widget=clock', size: [1280, 800] },
  'editor-clock-scrolled': {
    kind: 'editor',
    q: 'time=night&items=1&widgets=demo&panel=misc&widget=clock',
    size: [1280, 800],
    act: async (page) => {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-room-editor] section')].find((s) => s.scrollHeight > s.clientHeight);
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  },
  'editor-clock-day': { kind: 'editor', q: 'time=day&items=1&widgets=demo&panel=misc&widget=clock', size: [1280, 800] },
  'editor-clock-day-scrolled': {
    kind: 'editor',
    q: 'time=day&items=1&widgets=demo&panel=misc&widget=clock',
    size: [1280, 800],
    act: async (page) => {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-room-editor] section')].find((s) => s.scrollHeight > s.clientHeight);
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  },
  'editor-misc-night': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=misc', size: [1280, 800] },
  'editor-text-night': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=misc&widget=text', size: [1280, 800] },
  'editor-lighting-day': { kind: 'editor', q: 'time=day&items=1&widgets=demo&panel=lighting&light.dim=20&light.brightness=-10&light.warmth=15', size: [1280, 800] },
  // The clock's colour, weight and size go through to the big digits: Bold, the amber swatch, a larger size.
  'editor-clock-styled': {
    kind: 'editor',
    q: 'time=night&items=1&widgets=demo&panel=misc&widget=clock',
    size: [1280, 800],
    act: async (page) => {
      await page.locator('[data-widget-settings="clock"] [role="radio"][aria-label="Bold"]').click();
      await page.locator('[data-widget-settings="clock"] [role="radio"][aria-label="#ffd28a"]').click();
      const size = page.locator('[data-widget-settings="clock"] input[aria-label="Size"]');
      await size.focus();
      for (let i = 0; i < 40; i++) await size.press('ArrowRight');
    },
  },
  'editor-misc-add': { kind: 'editor', q: 'time=day&items=1&widgets=demo&panel=misc', size: [1280, 800] },
  'editor-text': { kind: 'editor', q: 'time=day&items=1&widgets=demo&panel=misc&widget=text', size: [1280, 800] },
  'editor-lighting': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=lighting&light.dim=45&light.brightness=-10', size: [1280, 800] },
  'editor-clock-ja': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=misc&widget=clock&lang=ja', size: [1280, 800] },
  'editor-clock-ru': { kind: 'editor', q: 'time=night&items=1&widgets=demo&panel=misc&widget=clock&lang=ru', size: [1280, 800] },
  'editor-lighting-ru': { kind: 'editor', q: 'time=night&items=1&panel=lighting&light.dim=45&lang=ru', size: [1280, 800] },
  // Drag the text line up under the progress bar: held within 10 px of its right edge, it snaps and the guide shows.
  'editor-drag-snap': {
    kind: 'editor',
    q: 'time=night&items=1&widgets=demo&panel=misc&widget=text',
    size: [1280, 800],
    act: async (page) => {
      const box = await page.locator('[data-widget-id="text"]').boundingBox();
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(sx - i * 13.8, sy - i * 30);
      await page.waitForTimeout(300);
    },
  },
  desktop: { kind: 'host', q: `time=night&${stateQ()}`, size: [1440, 900] },
  'desktop-day': { kind: 'host', q: `time=day&${stateQ()}`, size: [1440, 900] },
  'lighting-before': { kind: 'host', q: `time=day&${stateQ()}`, size: [1440, 900] },
  'lighting-after': { kind: 'host', q: `time=day&${stateQ({ lighting: DIM })}`, size: [1440, 900] },
  'lighting-after-warm': { kind: 'host', q: `time=day&${stateQ({ lighting: { ...DIM, dim: 35, warmth: 40 } })}`, size: [1440, 900] },
};
const names = arg('shots', Object.keys(SHOTS).join(',')).split(',');

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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
    const packUrl = `http://127.0.0.1:${packs.address().port}/${PRESET}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const name of names) {
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const [w, h] = shot.size;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(PINNED);
      page.on('pageerror', (e) => console.log(`[${name} page error] ${e.message.slice(0, 300)}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`[${name} console] ${m.text().slice(0, 240)}`);
      });
      if (shot.kind === 'editor') {
        await page.goto(`${viteUrl}/?seilink=1&editor=1&fps=0&pack=${encodeURIComponent(packUrl)}&${shot.q}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await page.waitForSelector('[data-room-editor] nav', { timeout: 60_000 }).catch(() => console.log(`  ${name}: editor never showed its rail`));
        await page.waitForTimeout(2500);
      } else {
        await page.goto(`${viteUrl}/?seilinkhost=1&pack=${encodeURIComponent(packUrl)}&${shot.q}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
        await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log(`  ${name}: room never reported ready`));
        await page.waitForTimeout(2500);
      }
      if (shot.act) {
        await shot.act(page);
        await page.waitForTimeout(500);
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await ctx.close();
    }
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
