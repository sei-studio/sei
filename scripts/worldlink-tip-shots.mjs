#!/usr/bin/env node
/**
 * Stills of the chat header's Beta tag and the one-time "New" tip on the
 * WorldLink button (261119), and of the guide's WorldLink tour showing the
 * tip out of its way. Headless, no Electron, no IPC (DevScreenShot fixtures,
 * so nothing reaches analytics).
 *
 *   node scripts/worldlink-tip-shots.mjs --out <dir> [--lang <code>] [--theme dark|light]
 *
 * Writes: 1-chat-tip.png (the tip), 2-worldlink-tooltip.png (after Got it,
 * hovering WorldLink), 3-backseat-tooltip.png, 4-tour-offer.png (the tour's
 * first step, on Home), 5-tour-button.png (its WorldLink step in the chat:
 * no tip), 6-tour-sheet.png (its end: the move-in sheet), 7-after-tour.png
 * (the chat after Not now on the sheet: still no tip).
 * CHROME_PATH overrides the browser (default /usr/bin/google-chrome).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const OUT = path.resolve(arg('out', 'worldlink-tip-shots'));
const LANG = arg('lang', null);
const THEME = arg('theme', 'dark');
const SIZE = { width: 1280, height: 800 };
const HEADER = { x: 640, y: 0, width: 640, height: 300 };

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
    const url = vite.resolvedUrls.local[0].replace(/\/$/, '');
    const q = `seilink=on&theme=${THEME}${LANG ? `&lang=${LANG}` : ''}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    const shot = async (page, name, clip) => {
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
      console.log(file);
    };

    // The chat: the tip, then Got it and the two tooltips.
    {
      const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error('pageerror', e.message));
      await page.goto(`${url}/?dashshot=screen&screen=chat&${q}`, { waitUntil: 'load', timeout: 180_000 });
      await page.waitForSelector('[role="note"]', { timeout: 20_000 });
      await page.waitForTimeout(800);
      await shot(page, '1-chat-tip.png', HEADER);
      await shot(page, '1-chat-tip-full.png');
      await page.locator('[role="note"] button').click();
      await page.mouse.move(10, 400);
      await page.waitForTimeout(300);
      await page.hover('[data-tutorial="seilink-btn"]');
      await page.waitForTimeout(900);
      await shot(page, '2-worldlink-tooltip.png', HEADER);
      await page.hover('[data-tutorial="backseat-btn"]');
      await page.waitForTimeout(900);
      await shot(page, '3-backseat-tooltip.png', HEADER);
      await ctx.close();
    }

    // The guide's WorldLink tour, from a fresh profile (the tip is not retired).
    {
      const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error('pageerror', e.stack ?? e.message));
      await page.goto(`${url}/?dashshot=screen&tour=1&${q}`, { waitUntil: 'load', timeout: 180_000 });
      await page.waitForTimeout(3600);
      await shot(page, '4-tour-offer.png');
      await page.getByRole('button', { name: /./ }).filter({ hasText: /^(Sure|好呀|好啊|いいよ|Давай|Claro|Certo|Sì|Va bene)/ }).first().click({ timeout: 10_000 }).catch(async () => {
        await page.getByRole('button', { name: 'Sure', exact: true }).click({ timeout: 10_000 });
      });
      await page.waitForTimeout(3600);
      const tipDuringTour = await page.locator('[role="note"]').count();
      console.log(`tip during the tour's WorldLink step: ${tipDuringTour}`);
      await shot(page, '5-tour-button.png');
      // Click through its last line: the move-in sheet opens; close it and look at the chat again.
      await page.mouse.click(SIZE.width / 2, SIZE.height / 2);
      await page.waitForTimeout(3000);
      await page.mouse.click(SIZE.width / 2, SIZE.height / 2);
      await page.waitForTimeout(2500);
      await shot(page, '6-tour-sheet.png');
      // Not now on the sheet: back to the chat, where the tip must stay gone.
      await page.getByRole('button', { name: 'Not now', exact: true }).click({ timeout: 10_000 });
      await page.waitForTimeout(1200);
      const tipAfter = await page.locator('[role="note"]').count();
      console.log(`tip after the tour: ${tipAfter}`);
      await shot(page, '7-after-tour.png');
      await ctx.close();
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
