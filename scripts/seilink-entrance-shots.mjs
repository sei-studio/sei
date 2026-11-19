#!/usr/bin/env node
/**
 * Her entrance on the desktop (261119): a recording and timed frames of the
 * wallpaper page (DevHostPreview, `arrival=`), headless, no Electron.
 *
 *   node scripts/seilink-entrance-shots.mjs --facepacks <dir> --facepack-id <an-...>
 *        [--packs resources/seilink-packs] [--preset cozy] [--out seilink-entrance-shots]
 *        [--portrait <png>] [--name <her name>] [--scenes wait,ready,quiet,reduced]
 *
 * Scenes:
 *   wait     a move-in while her look bakes: the waiting line types in, its dots
 *            cycle, her face set lands at 6 s and she comes in (`arrival=sim`).
 *   ready    a move-in with her look ready: she comes in once the room is up.
 *   quiet    the waiting line past LINK_TIMEOUT_MS (dimmer), then she comes in.
 *   reduced  `wait` under reduced motion (a plain fade).
 * Each scene is recorded (<out>/<scene>.webm, Playwright's video) and shot at
 * fixed times from the page's start (<out>/<scene>-<ms>.png). The page's
 * arrived report is printed. Everything it starts is closed before it exits.
 * CHROME_PATH overrides the browser (default /usr/bin/google-chrome).
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
const OUT = path.resolve(arg('out', 'seilink-entrance-shots'));
const FACEPACKS = arg('facepacks', null) ? path.resolve(arg('facepacks')) : null;
const FACEPACK_ID = arg('facepack-id', null);
const PORTRAIT = path.resolve(arg('portrait', path.join(REPO, 'vendor/skin-gen/examples/sui-input.png')));
const NAME = arg('name', 'Sui');
const SIZE = { width: 1280, height: 720 };

/** Her face set lands (facepackat, from the room's first frame) a little before she comes in (arriveat, from the page's start). */
const ENTER_SHOTS = [6200, 6600, 7000, 7400, 7800, 8200, 8600, 9000, 9600, 10_800];
const SCENES = {
  wait: { q: 'arrival=sim&arriveat=6000&facepackat=3000', shots: [700, 1400, 2400, 4200, 5600, ...ENTER_SHOTS], length: 12_500 },
  ready: { q: 'arrival=enter&facepackat=0', shots: [300, 1000, 1500, 2000, 2500, 3000, 3600, 4400, 6000], length: 7000 },
  quiet: { q: 'arrival=sim&quietat=2500&arriveat=6000&facepackat=3000', shots: [2000, 4500, 7400, 11_000], length: 12_000 },
  reduced: { q: 'arrival=sim&arriveat=6000&facepackat=3000&reduced=1', shots: [2000, 6400, 6800, 7200, 7600, 8400], length: 10_000 },
};
const scenes = arg('scenes', 'wait,ready').split(',');

function staticServer(root) {
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

async function main() {
  if (!FACEPACKS || !FACEPACK_ID) throw new Error('--facepacks <dir> and --facepack-id <id> are required (her face set lands mid-scene)');
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await staticServer(PACKS);
  const faces = await staticServer(FACEPACKS);
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
    const facesUrl = `http://127.0.0.1:${faces.address().port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    // Warm Vite's module graph once, so the recordings start on a page that loads at app speed.
    {
      const warm = await browser.newPage({ viewport: SIZE });
      await warm.goto(`${viteUrl}/?seilinkhost=1&pack=${encodeURIComponent(packUrl)}`, { waitUntil: 'load' });
      await warm.waitForSelector('[data-room-ready="1"]', { timeout: 120_000 }).catch(() => console.log('  warm-up: room never ready'));
      await warm.close();
    }
    for (const name of scenes) {
      const scene = SCENES[name];
      if (!scene) {
        console.log(`unknown scene ${name}`);
        continue;
      }
      const ctx = await browser.newContext({
        viewport: SIZE,
        deviceScaleFactor: 1,
        recordVideo: { dir: OUT, size: SIZE },
        reducedMotion: name === 'reduced' ? 'reduce' : 'no-preference',
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 240)}`);
      });
      const url =
        `${viteUrl}/?seilinkhost=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(`${viteUrl}/@fs${PORTRAIT}`)}` +
        `&name=${encodeURIComponent(NAME)}&facepacks=${encodeURIComponent(facesUrl)}&facepackid=${encodeURIComponent(FACEPACK_ID)}&time=day&${scene.q}`;
      await page.goto(url, { waitUntil: 'load' });
      // Times are from the page's load (its own clock for arriveat/quietat starts about then).
      const t0 = Date.now();
      for (const at of scene.shots) {
        await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
        const file = path.join(OUT, `${name}-${String(at).padStart(5, '0')}.png`);
        await page.screenshot({ path: file });
        const kind = await page.evaluate(() => document.querySelector('[data-avatar-kind]')?.getAttribute('data-avatar-kind') ?? '-');
        console.log(`${file} t=${Date.now() - t0} kind=${kind}`);
      }
      await page.waitForTimeout(Math.max(0, scene.length - (Date.now() - t0)));
      const arrived = await page.evaluate(() => document.body.dataset.arrived ?? null);
      console.log(`${name}: arrived ${arrived}`);
      const video = page.video();
      await ctx.close();
      if (video) {
        const to = path.join(OUT, `${name}.webm`);
        await video.saveAs(to);
        await video.delete().catch(() => {});
        console.log(`${to}`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
    faces.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
