#!/usr/bin/env node
/**
 * Screenshots of the Playtime page (261110), headless, no Electron.
 *
 *   node scripts/playtime-shots.mjs [--out playtime-shots] [--prefix name-]
 *                                   [--shots sei,chatgpt,...] [--size 1280x800]
 *                                   [--query '<extra params>'] [--full 1]
 *
 * Same machinery as profile-shots.mjs: the renderer's Vite dev server and
 * Chrome through playwright, opening the `?dashshot=playtime` harness
 * (DevPlaytimeShot). `--full 1` captures the whole scrolled page body.
 * Everything it starts is closed before it exits. CHROME_PATH overrides the
 * browser (default /usr/bin/google-chrome). Analytics are stubbed.
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
const OUT = path.resolve(arg('out', 'playtime-shots'));
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const PREFIX = arg('prefix', '');
const QUERY = arg('query', '');
const FULL = arg('full', '') === '1';
const SHOTS = {
  sei: 'setup=cloud&plan=quest',
  'sei-free': 'setup=cloud',
  'sei-inactive': 'setup=mykeys&tab=sei',
  chatgpt: 'setup=chatgpt',
  'chatgpt-device': 'setup=chatgpt&voice=device&engine=kokoro',
  'chatgpt-none': 'setup=cloud&tab=chatgpt&gpt=none',
  'chatgpt-limited': 'setup=chatgpt&gpt=limited',
  mykeys: 'setup=mykeys&alert=1',
  'mykeys-eleven': 'setup=mykeys&voice=elevenlabs&key=1',
  'mykeys-fish': 'setup=mykeys&voice=fish',
  'mykeys-inactive': 'setup=cloud&tab=mykeys',
  'mykeys-ollama': 'setup=mykeys&provider=ollama',
  banner: 'setup=mykeys&alert=1&banner=1',
  settings: 'setup=cloud&part=settings',
  'mykeys-zh': 'setup=mykeys&alert=1&lang=zh',
  'mykeys-ru': 'setup=mykeys&alert=1&lang=ru',
  'chatgpt-ja': 'setup=chatgpt&lang=ja',
};
const CLICKS = {};
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
    page.on('response', (r) => {
      if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url().slice(0, 240)}`);
    });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    for (const name of names) {
      const q = SHOTS[name];
      if (!q) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const url = `${viteUrl}/?dashshot=playtime&${q}${QUERY ? `&${QUERY}` : ''}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector('main h1, main h2, main h3', { timeout: 60_000 }).catch(() => console.log(`${name}: no page title`));
      // Let the page's open animation, the portrait and the rows' reads settle.
      await page.waitForTimeout(1600);
      if (CLICKS[name]) {
        await page.click(CLICKS[name]).catch((e) => console.log(`${name}: click failed: ${e.message.slice(0, 120)}`));
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
      }
      const file = path.join(OUT, `${PREFIX}${name}.png`);
      if (FULL) {
        // Grow the viewport to the scrolled body's height so nothing is cut.
        const h = await page.evaluate(() => {
          const el = [...document.querySelectorAll('main *')].find((n) => n.scrollHeight > n.clientHeight + 4);
          return el ? el.scrollHeight + 120 : 0;
        });
        if (h > VH) await page.setViewportSize({ width: VW, height: h });
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: file });
      if (FULL) await page.setViewportSize({ width: VW, height: VH });
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
