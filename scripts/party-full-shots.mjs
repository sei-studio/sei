#!/usr/bin/env node
/**
 * Screenshots of the party-full states (261124: the "Free a slot" hint),
 * headless, no Electron.
 *
 *   node scripts/party-full-shots.mjs [--out party-full-shots] [--prefix name-]
 *                                     [--shots world,invite,...] [--size 1280x800]
 *                                     [--query '<extra params, e.g. theme=light&lang=ru>']
 *
 * Starts the renderer's Vite dev server on its own and Chrome through
 * playwright, opens the `?dashshot=screen` harnesses with a full party and
 * writes `<prefix><shot>.png` for each shot:
 *   world       World tab header ("Party full" + Free a slot)
 *   invite      a World companion's profile after Invite to party
 *   picker      the Free a slot picker over the World tab
 *   picked      Marv picked in it: his page, open on the Danger tab
 *   notice      the own-key import notice (App banner)
 *   settings    Settings, the "Companions from before you signed in" row
 * A shot that needs a selector the page does not have (an older build) is
 * still written, with a console note. CHROME_PATH overrides the browser
 * (default /usr/bin/google-chrome). Analytics are stubbed by the harnesses.
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
const OUT = path.resolve(arg('out', 'party-full-shots'));
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const PREFIX = arg('prefix', '');
const QUERY = arg('query', '');
/** name -> [query, wait-for selector, click selector(s) or null, scroll-into-view selector or null] */
const SHOTS = {
  world: ['screen=world&full=1', '[class*="slots"]', null, null],
  invite: ['screen=worldprofile&who=Aria&full=1', 'main h1', 'button:has-text("Invite to party")', null],
  picker: ['screen=world&full=1', '[class*="slots"]', '[data-free-slot]', null],
  picked: ['screen=world&full=1', '[class*="slots"]', ['[data-free-slot]', '[data-free-slot-picker] button:has-text("Marv")'], null],
  notice: ['screen=home&partyfull=1', 'main', null, null],
  settings: ['screen=settings&localimport=full', 'main', null, '[data-local-import]'],
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
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const [q, waitFor, click, scrollTo] = shot;
      const url = `${viteUrl}/?dashshot=screen&${q}${QUERY ? `&${QUERY}` : ''}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForSelector(waitFor, { timeout: 60_000 }).catch(() => console.log(`${name}: no ${waitFor}`));
      await page.waitForTimeout(1600);
      for (const sel of click ? [click].flat() : []) {
        await page
          .click(sel, { timeout: 5000 })
          .catch((e) => console.log(`${name}: click failed: ${e.message.split('\n')[0].slice(0, 120)}`));
        await page.mouse.move(0, 0);
        await page.waitForTimeout(900);
      }
      if (scrollTo) {
        await page
          .locator(scrollTo)
          .first()
          .scrollIntoViewIfNeeded({ timeout: 5000 })
          .catch(() => console.log(`${name}: no ${scrollTo}`));
        await page.waitForTimeout(300);
      }
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
