#!/usr/bin/env node
/**
 * Screenshots of SeiLink M4 (261104): the wallpaper page with its dock and
 * speech bubble, the Labs setting, the move-in sheet and the companion menu.
 * Headless, no Electron.
 *
 *   node scripts/seilink-host-shots.mjs [--packs resources/seilink-packs] [--preset cozy]
 *                                       [--out seilink-host-shots] [--shots a,b,...]
 *
 * Starts the renderer's Vite dev server on its own, a CORS static server for
 * <packs>, and Chrome through playwright. Wallpaper shots open
 * `?seilinkhost=1&pack=<url>` (DevHostPreview, a fake host bridge); app shots
 * open `?dashshot=screen` (DevScreenShot) with `&seilink=` and `&modal=movein`.
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
const PACKS = path.resolve(arg('packs', path.join(REPO, 'resources/seilink-packs')));
const PRESET = arg('preset', 'cozy');
const OUT = path.resolve(arg('out', 'seilink-host-shots'));

const LINE = 'oh hey. I was just rearranging the shelf again, it never looks right';
const LINE_JA = 'あ、おかえり。棚の並べ方、まだしっくりこないんだよね';

/**
 * name -> { kind: 'host' | 'app', q: query, size?, wait?, act? }.
 * Host shots: day reads as the light room, night as the dark one.
 */
const SHOTS = {
  'host-day': { kind: 'host', q: 'time=day' },
  'host-day-line': { kind: 'host', q: `time=day&line=${encodeURIComponent(LINE)}` },
  'host-night-line': { kind: 'host', q: `time=night&line=${encodeURIComponent(LINE)}` },
  'host-night-confirm': { kind: 'host', q: 'time=night&confirm=1' },
  'host-day-deafen-caption': { kind: 'host', q: 'time=day&press=deafen' },
  'host-night-deafened-caption': { kind: 'host', q: 'time=night&deafened=1&press=deafen' },
  'host-dusk-edit-caption': { kind: 'host', q: 'time=dusk&press=edit' },
  'host-ja-confirm-line': { kind: 'host', q: `time=day&lang=ja&confirm=1&line=${encodeURIComponent(LINE_JA)}` },
  'host-taskbar0-line': { kind: 'host', q: `time=day&taskbar=0&line=${encodeURIComponent(LINE)}`, size: { width: 1000, height: 800 } },
  'settings-on-light': { kind: 'app', q: 'screen=settings&seilink=on&theme=light', act: 'labs' },
  'settings-on-dark': { kind: 'app', q: 'screen=settings&seilink=on&theme=dark', act: 'labs' },
  'settings-off-dark': { kind: 'app', q: 'screen=settings&seilink=off&theme=dark', act: 'labs' },
  'settings-unsupported-light': { kind: 'app', q: 'screen=settings&seilink=unsupported&theme=light', act: 'labs' },
  'movein-light': { kind: 'app', q: 'screen=home&modal=movein&theme=light', act: 'thumb' },
  'movein-dark': { kind: 'app', q: 'screen=home&modal=movein&theme=dark', act: 'thumb' },
  'movein-swap-dark': { kind: 'app', q: 'screen=home&modal=movein&swap=1&theme=dark', act: 'thumb' },
  'movein-ru-light': { kind: 'app', q: 'screen=home&modal=movein&theme=light&lang=ru', act: 'thumb' },
  'character-menu-dark': { kind: 'app', q: 'screen=character&seilink=on&theme=dark', act: 'menu' },
  'character-menu-light': { kind: 'app', q: 'screen=character&seilink=on&theme=light', act: 'menu' },
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
        const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.webp') ? 'image/webp' : p.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function act(page, what) {
  if (what === 'labs') {
    const found = await page.evaluate(() => {
      // Put the Labs group in the middle so the rows around it show too.
      const el = [...document.querySelectorAll('h3')].find((h) => h.textContent === 'Labs');
      el?.scrollIntoView({ block: 'center' });
      return Boolean(el);
    });
    if (!found) console.log('  no Labs group');
    await page.waitForTimeout(300);
  } else if (what === 'thumb') {
    await page.waitForSelector('img', { timeout: 15_000 }).catch(() => console.log('  no thumbnail'));
    await page.waitForTimeout(800);
  } else if (what === 'menu') {
    const gear = page.getByRole('button', { name: 'Companion settings', exact: true }).first();
    await gear.click({ timeout: 10_000 }).catch(() => console.log('  no gear menu button'));
    await page.waitForTimeout(400);
  }
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
    const portrait = `${viteUrl}/@fs${REPO}/vendor/skin-gen/examples/sui-input.png`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const name of names) {
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const page = await browser.newPage({ viewport: shot.size ?? { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  [page error] ${m.text().slice(0, 240)}`);
      });
      page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
      page.on('response', (r) => {
        if (r.status() >= 400) console.log(`  [${r.status()}] ${r.url().slice(0, 200)}`);
      });
      const url =
        shot.kind === 'host'
          ? `${viteUrl}/?seilinkhost=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}&${shot.q}`
          : `${viteUrl}/?dashshot=screen&pack=${encodeURIComponent(packUrl)}&${shot.q}`;
      await page.goto(url, { waitUntil: 'load' });
      if (shot.kind === 'host') {
        await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log(`  ${name}: room never reported ready`));
        // The fake bridge shows the line at 1.8 s and presses at 2.6 s.
        await page.waitForTimeout(3200);
      } else {
        await page.waitForTimeout(1500);
        await act(page, shot.act);
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
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
