#!/usr/bin/env node
/**
 * Screenshots of the companion profile page (profile v2, product call 261110),
 * headless, no Electron.
 *
 *   node scripts/profile-shots.mjs [--out profile-shots] [--prefix name-]
 *                                  [--shots world,builtin,own-look,...] [--size 1280x800]
 *                                  [--query '<extra params>']
 *
 * Starts the renderer's Vite dev server on its own (no electron-vite) and
 * Chrome through playwright, then opens the `?dashshot=screen` harnesses
 * (DevWorldShot for a World companion, DevScreenShot for Sui as a built-in
 * or as your own companion) and writes `<prefix><shot>.png` for each shot.
 * Everything it starts is closed before it exits. CHROME_PATH overrides the browser (default
 * /usr/bin/google-chrome). Analytics are stubbed by the harnesses.
 */
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
const OUT = path.resolve(arg('out', 'profile-shots'));
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const PREFIX = arg('prefix', '');
const QUERY = arg('query', '');
const SHOTS = {
  world: 'screen=worldprofile&who=Aria',
  'world-noart': 'screen=worldprofile&who=Solphivia',
  builtin: 'screen=character&who=builtin',
  'builtin-settings': 'screen=character&who=builtin&tab=settings',
  'builtin-worldlink': 'screen=character&who=builtin&tab=worldlink&seilink=on',
  'builtin-more': 'screen=character&who=builtin&tab=more&seilink=on',
  'own-look': 'screen=character&tab=look',
  'own-voice': 'screen=character&tab=voice',
  'own-personality': 'screen=character&tab=personality',
  'own-games': 'screen=character&tab=games',
  'own-worldlink': 'screen=character&tab=worldlink&seilink=on&movedin=1',
  'own-more': 'screen=character&tab=more&seilink=on',
  'own-custom-image': 'screen=character&tab=look&img=custom',
};
const names = arg('shots', Object.keys(SHOTS).join(',')).split(',');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
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
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text().slice(0, 240)}`);
    });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    for (const name of names) {
      const q = SHOTS[name];
      if (!q) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const url = `${viteUrl}/?dashshot=screen&${q}${QUERY ? `&${QUERY}` : ''}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector('main h1', { timeout: 60_000 }).catch(() => console.log(`${name}: no page title`));
      // Let the page's open animation, the portrait and the rows' reads settle.
      await page.waitForTimeout(1600);
      const file = path.join(OUT, `${PREFIX}${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
