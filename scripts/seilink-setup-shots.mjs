#!/usr/bin/env node
/**
 * Screenshots of the WorldLink setup surfaces (261110, product call 261110):
 * the move-in notice, the guided setup's steps in the room editor on the
 * desktop stage (room + view, the extras step while a shelf item is dragged,
 * so the placement outlines show), the call button by the talk box, and the
 * "lives on your desktop" card the first link ends on. Headless, no Electron.
 *
 *   node scripts/seilink-setup-shots.mjs [--out <dir>] [--shots a,b,...] [--dpr 1.5] [--lang en]
 *
 * Starts the renderer's Vite dev server, a CORS static server for the bundled
 * packs (resources/seilink-packs) and Chrome through playwright (CHROME_PATH,
 * default /usr/bin/google-chrome). 1280x720 CSS at --dpr (default 1.5, the
 * common Windows 150% scale) so blurry thumbnails show as they would there.
 * Everything it starts is closed before it exits.
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
const PACKS = path.join(REPO, 'resources/seilink-packs');
const OUT = path.resolve(arg('out', 'seilink-setup-shots'));
const DPR = Number(arg('dpr', '1.5'));
const LANG = arg('lang', null);
const PORTRAIT = path.join(REPO, 'vendor/skin-gen/examples/sui-input.png');

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

const step = (page, name) => page.waitForSelector(`[data-setup-step="${name}"]`, { timeout: 30_000 });
const next = (page) => page.locator('[data-setup-step] footer button').last().click();

/** name -> { url: (base) => string, scheme?, run(page) } */
const SHOTS = {
  'movein-light': { app: 'screen=home&modal=movein&theme=light', run: async (p) => p.waitForTimeout(1500) },
  'movein-dark': { app: 'screen=home&modal=movein&theme=dark', scheme: 'dark', run: async (p) => p.waitForTimeout(1500) },
  'movein-swap-dark': { app: 'screen=home&modal=movein&swap=1&theme=dark', scheme: 'dark', run: async (p) => p.waitForTimeout(1500) },
  'movein-ja-light': { app: 'screen=home&modal=movein&theme=light&lang=ja', run: async (p) => p.waitForTimeout(1500) },
  'step-room': {
    flow: 'phase=editor',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(5000);
    },
  },
  'step-room-picked': {
    flow: 'phase=editor',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(3000);
      await p.locator('[data-setup-step="room"] [data-preset="cozy"]').click();
      await p.waitForTimeout(4000);
    },
  },
  'step-room-light': {
    flow: 'phase=editor&time=day',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(5000);
    },
  },
  'step-furniture': {
    flow: 'phase=editor',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(1500);
      await next(p);
      await step(p, 'colours');
      await next(p);
      await step(p, 'furniture');
      await p.waitForTimeout(4000);
    },
  },
  'step-extras': {
    flow: 'phase=editor',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(1500);
      for (const s of ['colours', 'furniture']) {
        await next(p);
        await step(p, s);
      }
      // A furniture piece with shelves first, so the extras have tops to go on.
      const sections = p.locator('[data-setup-step="furniture"] [data-slot]');
      const ns = await sections.count();
      for (let i = 0; i < ns; i++) {
        const opt = sections.nth(i).locator('button[aria-pressed="false"]:not([aria-label="None"])');
        if ((await opt.count()) > 0) await opt.first().click();
        await p.waitForTimeout(200);
      }
      await next(p);
      await step(p, 'extras');
      await p.waitForTimeout(3500);
    },
  },
  'together-call': {
    flow: 'phase=editor&together=Sui',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(4000);
      await p.locator('[data-setup-call]').hover();
      await p.waitForTimeout(400);
    },
  },
  'together-call-consent': {
    flow: 'phase=editor&together=Sui&voicegate=consent',
    scheme: 'dark',
    run: async (p) => {
      await step(p, 'room');
      await p.waitForTimeout(3000);
      await p.locator('[data-setup-call]').click();
      await p.waitForSelector('[data-voice-card="consent"]', { timeout: 10_000 });
      await p.waitForTimeout(500);
    },
  },
  'together-extras': {
    flow: 'phase=editor&together=Sui',
    scheme: 'dark',
    run: async (p) => SHOTS['step-extras'].run(p),
  },
  'drag-shelf-item': {
    flow: 'phase=decorated',
    scheme: 'dark',
    run: async (p) => {
      await p.waitForSelector('[data-room-editor]', { timeout: 30_000 });
      await p.waitForTimeout(3500);
      // The books on the bed (the decorated room's shelf item), dragged towards the wall shelves.
      const [x, y] = [303, 476];
      await p.mouse.move(x, y);
      await p.mouse.down();
      for (let i = 1; i <= 12; i++) await p.mouse.move(x - 18 * i, y - 22 * i);
      await p.waitForTimeout(700);
    },
  },
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const names = arg('shots', Object.keys(SHOTS).join(',')).split(',');
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
    const packUrl = `http://127.0.0.1:${packs.address().port}/cozy/`;
    const portrait = `${viteUrl}/@fs${PORTRAIT}`;
    const lang = LANG ? `&lang=${LANG}` : '';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const name of names) {
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR, colorScheme: shot.scheme ?? 'light' });
      page.on('pageerror', (e) => console.log(`  [${name} page error] ${e.message.slice(0, 300)}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().includes('favicon')) console.log(`  [${name} console] ${m.text().slice(0, 240)}`);
      });
      const url = shot.app
        ? `${viteUrl}/?dashshot=screen&pack=${encodeURIComponent(packUrl)}&${shot.app}${lang}`
        : `${viteUrl}/?seilinkflow=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}&name=Sui&${shot.flow}${lang}`;
      try {
        await page.goto(url, { waitUntil: 'load' });
        await shot.run(page);
        const file = path.join(OUT, `${name}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      } catch (err) {
        console.log(`  ${name} failed: ${err.message.split('\n')[0]}`);
      }
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
