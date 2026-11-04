#!/usr/bin/env node
/**
 * Screenshots of the SeiLink room preview (261104), headless, no Electron.
 *
 *   node scripts/seilink-room-shots.mjs --packs <dir> [--preset cozy] [--out seilink-shots]
 *                                       [--shots day,dusk,night,...] [--size 1280x720]
 *
 * Starts the renderer's Vite dev server on its own (no electron-vite), a small
 * CORS static server for <packs>/<preset>/, and Chrome through playwright,
 * then opens the `?seilink=1&pack=<url>` preview (DevRoomPreview) per shot.
 * Everything it starts is closed before it exits. CHROME_PATH overrides the
 * browser (default /usr/bin/google-chrome).
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
const PRESET = arg('preset', 'cozy');
const OUT = path.resolve(arg('out', 'seilink-shots'));
const [VW, VH] = arg('size', '1280x720').split('x').map(Number);
const SHOTS = {
  day: 'time=day',
  dusk: 'time=dusk',
  night: 'time=night',
  'night-items': 'time=night&items=1',
  'day-tint': 'time=day&items=1&tint.curtains=3f8f6a&tint.shell=b9d2f0&tint.rug=e8c35a',
  'contain-dusk': 'time=dusk&fit=contain&items=1', // shot at 1000x800 so the letterbox shows
  'night-clean': 'time=night&items=1&hud=0',
  'fade-day-night': 'time=day&items=1',
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
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text().slice(0, 240)}`);
    });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    for (const name of names) {
      const q = SHOTS[name];
      if (!q) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      await page.setViewportSize(name === 'contain-dusk' ? { width: 1000, height: 800 } : { width: VW, height: VH });
      await page.goto(`${viteUrl}/?seilink=1&pack=${encodeURIComponent(packUrl)}&${q}`, { waitUntil: 'load' });
      try {
        await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 });
      } catch {
        console.log(`${name}: room never reported ready`);
      }
      await page.waitForTimeout(600);
      if (name === 'fade-day-night') {
        // Mid-crossfade: pick night from day and catch the 1.2 s fade halfway.
        await page.getByRole('button', { name: 'night', exact: true }).click();
        await page.waitForTimeout(Number(process.env.SEILINK_FADE_WAIT_MS ?? 600));
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
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
