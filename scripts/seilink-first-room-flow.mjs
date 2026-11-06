#!/usr/bin/env node
/**
 * The first-room flow (261106; v3: plain spawn + guided setup) on a simulated
 * desktop, as stills and one mp4 per OS theme: the end of the link intro, her
 * on the plain background (black in dark mode, white in light mode) under the
 * desktop icons, her offer to set up the room together, the guided setup in
 * the room editor on the desktop stage (room, colours, furniture, little
 * extras, each clicked through like a person), then Done: the icons back over
 * her new room. Also stills of the two other offer paths (the offer in UI
 * copy, "Not now"). Headless, no Electron.
 *
 *   node scripts/seilink-first-room-flow.mjs [--out <dir>] [--intro <dark intro.mp4>] [--intro-light <light intro.mp4>]
 *        [--schemes dark,light] [--room cozy] [--portrait <png>] [--faces <dir> --face <id>] [--name Sui] [--lang en]
 *
 * Opens `?seilinkflow=1&live=1` (DevFirstRoomFlow) on its own Vite dev
 * server, the packs over a CORS static server, Chrome through playwright
 * (CHROME_PATH, default /usr/bin/google-chrome) with prefers-color-scheme set
 * per theme, and ffmpeg for the mp4 (h264 + a silent AAC track). With
 * --intro, its last seconds open the video. Everything it starts is closed
 * before it exits.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const OUT = path.resolve(arg('out', 'seilink-first-room-flow'));
const INTRO = { dark: arg('intro', null), light: arg('intro-light', null) };
const SCHEMES = arg('schemes', 'dark,light').split(',');
const ROOM = arg('room', 'cozy');
const PORTRAIT = path.resolve(arg('portrait', path.join(REPO, 'vendor/skin-gen/examples/sui-input.png')));
const FACES = arg('faces', null) ? path.resolve(arg('faces')) : null;
const FACE = arg('face', null);
const NAME = arg('name', 'Sui');
const LANG = arg('lang', null);
const LINE = 'hi! nothing here yet. wanna set up my room with me?';
const FADE = 0.45;

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

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit', timeout: 300_000 });
}

/** Stills [name, seconds on screen] into one mp4 with soft crossfades, the intro's tail first. */
function buildVideo(scheme, shots) {
  const tmp = path.join(OUT, `tmp-${scheme}`);
  fs.mkdirSync(tmp, { recursive: true });
  const clips = [];
  const intro = INTRO[scheme] ? path.resolve(INTRO[scheme]) : null;
  if (intro) {
    // The intro's last 4 s (the light settling into the plain colour, her linked).
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', intro]).toString().trim());
    const clip = path.join(tmp, 'intro-tail.mp4');
    ffmpeg(['-ss', String(Math.max(0, dur - 4)), '-i', intro, '-an', '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', clip]);
    clips.push([clip, 4]);
  }
  for (const [still, secs] of shots) {
    const clip = path.join(tmp, `${still}.mp4`);
    ffmpeg(['-loop', '1', '-t', String(secs), '-i', path.join(OUT, `${still}.png`), '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', clip]);
    clips.push([clip, secs]);
  }
  const inputs = clips.flatMap(([c]) => ['-i', c]);
  let chain = '';
  let prev = '[0:v]';
  let offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += clips[i - 1][1] - FADE;
    const out = i === clips.length - 1 ? '[v]' : `[x${i}]`;
    chain += `${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}${out};`;
    prev = out;
  }
  const n = clips.length;
  const file = path.join(OUT, `first-room-flow-${scheme}.mp4`);
  ffmpeg([
    ...inputs,
    '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=44100',
    '-filter_complex', chain.replace(/;$/, ''),
    '-map', '[v]', '-map', `${n}:a`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart',
    file,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(file);
}

function listen(page, label) {
  page.on('pageerror', (e) => console.log(`  [${label} page error] ${e.message.slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) console.log(`  [${label} console] ${m.text().slice(0, 240)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) console.log(`  [${label} ${r.status()}] ${r.url().slice(0, 200)}`);
  });
}

async function newPage(browser, scheme) {
  // 1280x720 CSS at 1.5x: 1920x1080 stills, the intro's size.
  return browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: scheme });
}

/** The live flow for one theme: returns the video's [still, seconds] list. */
async function liveFlow(browser, base, scheme) {
  const page = await newPage(browser, scheme);
  listen(page, scheme);
  const shots = [];
  const still = async (name, secs) => {
    const file = `${scheme}-${name}`;
    await page.screenshot({ path: path.join(OUT, `${file}.png`) });
    console.log(path.join(OUT, `${file}.png`));
    shots.push([file, secs]);
  };
  // Her spawn on the plain background, before she says anything (the dock as usual).
  await page.goto(`${base}&phase=desktop`, { waitUntil: 'load' });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log('  room never reported ready'));
  await page.waitForTimeout(1500);
  await still('01-spawn', 2.6);
  // Then the live run: her offer, "Set up together" pressed, the guided setup.
  await page.goto(`${base}&live=1&phase=offer&line=${encodeURIComponent(LINE)}&press=decorate&pressat=6400`, { waitUntil: 'load' });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log('  room never reported ready'));
  const t0 = Date.now();
  await page.waitForTimeout(Math.max(0, 3600 - (Date.now() - t0)));
  await still('02-offer', 3.4);
  const step = (name) => page.waitForSelector(`[data-setup-step="${name}"]`, { timeout: 20_000 });
  const next = () => page.locator('[data-setup-step] footer button').last().click();
  // 1. Pick a room: the cards show each room bare; pick one.
  await step('room');
  // The room cards draw each room bare; give their thumbnails time.
  await page.waitForTimeout(4500);
  await still('04-step-room', 2.6);
  await page.locator(`[data-setup-step="room"] [data-preset="${ROOM}"]`).click();
  await page.waitForTimeout(2600);
  await still('05-step-room-picked', 2.8);
  await next();
  // 2. Choose colours: a wall colour, then the first fabric's.
  await step('colours');
  await page.waitForTimeout(1500);
  await still('06-step-colours', 2.2);
  const swatches = page.locator('[data-setup-step="colours"] [data-slot] button[role="radio"][title^="#"]');
  const nsw = await swatches.count();
  if (nsw > 3) await swatches.nth(3).click();
  const second = page.locator('[data-setup-step="colours"] [data-slot]').nth(1).locator('button[role="radio"][title^="#"]');
  if ((await second.count()) > 2) await second.nth(2).click();
  await page.waitForTimeout(1800);
  await still('07-step-colours-picked', 2.8);
  await next();
  // 3. Add furniture: one piece in each section.
  await step('furniture');
  await page.waitForTimeout(1800);
  await still('08-step-furniture', 2.2);
  const sections = page.locator('[data-setup-step="furniture"] [data-slot]');
  const ns = await sections.count();
  for (let i = 0; i < ns; i++) {
    const opt = sections.nth(i).locator('button[aria-pressed="false"]:not([aria-label="None"])');
    if ((await opt.count()) > 0) await opt.first().click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2200);
  await still('09-step-furniture-picked', 2.8);
  await next();
  // 4. Little extras: a few things.
  await step('extras');
  await page.waitForTimeout(1500);
  await still('10-step-extras', 2.0);
  const items = page.locator('[data-setup-step="extras"] button[title]:not([role="radio"])');
  const ni = await items.count();
  for (const i of [0, 2, 4].filter((x) => x < ni)) {
    await items.nth(i).click();
    await page.waitForTimeout(400);
  }
  await page.mouse.click(1000, 120);
  await page.waitForTimeout(2200);
  await still('11-step-extras-picked', 3.0);
  // Done: saved, the editor closes onto the wallpaper, the icons back on top.
  await next();
  await page.waitForSelector('[data-desktop-chrome]', { timeout: 20_000 });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  await still('12-done', 3.6);
  await page.close();
  return shots;
}

async function offerStills(browser, base, scheme) {
  for (const [name, q, ms] of [
    ['alt-offer-ui-copy', 'phase=prompt', 2500],
    ['alt-not-now', `phase=later&line=${encodeURIComponent(LINE)}&pressat=4200`, 4700],
  ]) {
    const page = await newPage(browser, scheme);
    listen(page, name);
    await page.goto(`${base}&${q}`, { waitUntil: 'load' });
    await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(ms);
    const file = path.join(OUT, `${scheme}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
    await page.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await packServer(PACKS);
  const faces = FACES ? await packServer(FACES) : null;
  const vite = await createServer({
    configFile: false,
    root: path.join(REPO, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(REPO, 'src/renderer/src'), '@shared': path.join(REPO, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
    logLevel: 'warn',
  });
  let browser;
  const videos = {};
  try {
    await vite.listen();
    const viteUrl = vite.resolvedUrls.local[0].replace(/\/$/, '');
    const packUrl = `http://127.0.0.1:${packs.address().port}/cozy/`;
    const portrait = `${viteUrl}/@fs${PORTRAIT}`;
    const base =
      `${viteUrl}/?seilinkflow=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}` +
      `&name=${encodeURIComponent(NAME)}${LANG ? `&lang=${LANG}` : ''}` +
      (faces && FACE ? `&faces=${encodeURIComponent(`http://127.0.0.1:${faces.address().port}/`)}&face=${encodeURIComponent(FACE)}` : '');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const scheme of SCHEMES) {
      videos[scheme] = await liveFlow(browser, base, scheme);
      await offerStills(browser, base, scheme);
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
    faces?.close();
  }
  for (const scheme of Object.keys(videos)) buildVideo(scheme, videos[scheme]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
