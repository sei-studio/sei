#!/usr/bin/env node
/**
 * Screenshots of your own companion's Voice tab (261120), headless, no
 * Electron. Same harness as profile-shots.mjs (`?dashshot=screen`, Sui as
 * your own companion), plus the steps a state needs: open the "..." menu,
 * or paste a Voice Library link and look it up.
 *
 *   node scripts/voice-tab-shots.mjs [--out voice-shots] [--prefix new-]
 *                                    [--shots voice,voice-menu,...] [--size 1280x800]
 *
 * Writes `<prefix><shot>.png`. Everything it starts is closed before it
 * exits. CHROME_PATH overrides the browser (default /usr/bin/google-chrome).
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
const OUT = path.resolve(arg('out', 'voice-shots'));
const [VW, VH] = arg('size', '1280x800').split('x').map(Number);
const PREFIX = arg('prefix', '');
const BASE = 'screen=character&tab=voice&seilink=on';
const LINK = 'https://elevenlabs.io/app/voice-library?voiceId=LibVoice0000000000aa';

const menu = async (page) => {
  await page.click('[aria-label="Voice options"]');
};
const paste = async (page) => {
  await page.fill('[data-testid="library-voice-card"] input', LINK);
  await page.press('[data-testid="library-voice-card"] input', 'Enter');
  // Blur, as after a click elsewhere: the field shows the link's start.
  await page.waitForTimeout(300);
  await page.locator('[data-testid="library-voice-card"] input').blur();
};
const auto = async (page) => {
  await menu(page);
  await page.click('[role="menuitemradio"] >> nth=0');
  await page.waitForTimeout(200);
  await menu(page);
};
const SHOTS = {
  voice: { q: '' },
  'voice-auto': { q: '', step: auto },
  'voice-menu': { q: '', step: menu },
  'voice-library': { q: '', step: paste },
  'voice-library-rejected': { q: 'lib=rejected', step: paste },
  'voice-zh': { q: 'lang=zh' },
  'voice-zh-menu': { q: 'lang=zh', step: menu },
  'voice-zh-library': { q: 'lang=zh', step: paste },
  'voice-ownkey': { q: 'backend=local&ownkey=1' },
  'voice-nokey': { q: 'backend=local&ownkey=0' },
  'voice-removed': { q: 'lib=removed' },
  'voice-light': { q: 'theme=light' },
  'voice-light-menu': { q: 'theme=light', step: menu },
  // The same picker on its own, as creation shows it (DevVoiceKeyShot).
  'picker-create': { url: 'dashshot=voicekey&part=picker', step: null, bare: true },
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
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    for (const name of names) {
      const shot = SHOTS[name];
      if (!shot) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      const q = shot.url ?? `dashshot=screen&${BASE}${shot.q ? `&${shot.q}` : ''}`;
      await page.goto(`${viteUrl}/?${q}`, { waitUntil: 'load' });
      if (!shot.bare) {
        await page.waitForSelector('main h1', { timeout: 60_000 }).catch(() => console.log(`${name}: no page title`));
      }
      // Let the page's open animation, the portrait and the rows' reads settle.
      await page.waitForTimeout(1600);
      if (shot.step) {
        await shot.step(page).catch((e) => console.log(`${name}: step failed: ${e.message.slice(0, 160)}`));
        await page.mouse.move(0, 0);
        await page.waitForTimeout(600);
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
