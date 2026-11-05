#!/usr/bin/env node
/**
 * Review videos of the SeiLink first-link intro (261105, T337; 261106 soft
 * light styles), rendered
 * frame by frame (no dropped frames): one mp4 per treatment plus the reduced
 * motion version, and a capture of the guide's SeiLink tour.
 * Headless, no Electron.
 *
 *   node scripts/seilink-intro-shots.mjs --out <dir>
 *        [--packs resources/seilink-packs] [--preset cozy]
 *        [--portrait <png>] [--name Lyra] [--faces <dir of facepacks> --face <id>]
 *        [--only aurora,bloom,tide,reduced,tour] [--fps 30] [--lang <code>]
 *
 * Intro videos open `?seilinkintro=1&manual=1` (DevIntroPreview) and call
 * window.__firstLinkSeek(ms) for every frame, then ffmpeg encodes H.264 with
 * a silent AAC track (Telegram shows a silent mp4 as a GIF). The tour runs
 * live in `?dashshot=screen&tour=1&seilink=on` (DevScreenShot), clicked
 * through like a person, recorded by Playwright and stills taken on the way.
 *
 * Starts the renderer's Vite dev server, a CORS static server for the packs
 * and face sets, and Chrome through playwright; everything is closed before
 * it exits. CHROME_PATH overrides the browser (default /usr/bin/google-chrome).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const OUT = path.resolve(arg('out', 'seilink-intro-shots'));
const PORTRAIT = arg('portrait', null) ? path.resolve(arg('portrait')) : null;
const NAME = arg('name', 'Lyra');
const FACES = arg('faces', null) ? path.resolve(arg('faces')) : null;
const FACE = arg('face', null);
const FPS = Number(arg('fps', '30'));
const LANG = arg('lang', null);
const SIZE = { width: 1920, height: 1080 };

/** Matches introTimeline.ts (FULL_TIMELINE.end, CALM_TIMELINE.end) plus a short tail. */
const VIDEOS = {
  aurora: { q: 'style=aurora&hold=1', ms: 11_200 + 300 },
  bloom: { q: 'style=bloom&hold=1', ms: 11_200 + 300 },
  tide: { q: 'style=tide&hold=1', ms: 11_200 + 300 },
  reduced: { q: 'style=aurora&reduced=1&hold=1', ms: 8_300 + 300 },
};
const only = arg('only', [...Object.keys(VIDEOS), 'tour'].join(',')).split(',');

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

function ffmpeg(args) {
  const r = spawnSync('timeout', ['600', 'ffmpeg', '-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
}

function listen(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${label} page error] ${m.text().slice(0, 240)} ${m.location()?.url ?? ''}`);
  });
  page.on('pageerror', (e) => console.log(`  [${label} page error] ${e.message.slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`  [${label} ${r.status()}] ${r.url().slice(0, 200)}`);
  });
}

async function renderVideo(browser, viteUrl, base, name, spec) {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  listen(page, name);
  await page.goto(`${viteUrl}/?seilinkintro=1&manual=1&${base}&${spec.q}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log(`  ${name}: room never reported ready`));
  await page.waitForFunction(() => typeof window.__firstLinkSeek === 'function', null, { timeout: 30_000 });
  // Her face set loads after the room.
  await page.waitForTimeout(3500);
  const dir = path.join(OUT, `${name}-frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.ceil((spec.ms / 1000) * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const ms = (i * 1000) / FPS;
    await page.evaluate((t) => window.__firstLinkSeek(t), ms);
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  console.log(`  ${name}: ${n} frames in ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.close();
  const file = path.join(OUT, `${name}.mp4`);
  ffmpeg([
    '-framerate', String(FPS), '-i', path.join(dir, '%05d.jpg'),
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', file,
  ]);
  console.log(file);
  return dir;
}

async function captureTour(browser, viteUrl, packUrl) {
  const vdir = path.join(OUT, 'tour-video');
  fs.rmSync(vdir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: SIZE } });
  const page = await ctx.newPage();
  listen(page, 'tour');
  const still = async (n) => {
    const file = path.join(OUT, `tour-${n}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };
  await page.goto(`${viteUrl}/?dashshot=screen&tour=1&seilink=on&theme=dark&pack=${encodeURIComponent(packUrl)}${LANG ? `&lang=${LANG}` : ''}`, { waitUntil: 'load' });
  await page.waitForTimeout(3600);
  await still('1-offer');
  await page.getByRole('button', { name: 'Sure', exact: true }).click({ timeout: 10_000 });
  await page.waitForTimeout(3600);
  await still('2-button');
  await page.mouse.click(SIZE.width / 2, SIZE.height / 2);
  await page.waitForTimeout(3000);
  await still('3-room');
  await page.mouse.click(SIZE.width / 2, SIZE.height / 2);
  await page.waitForSelector('img', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2200);
  await still('4-sheet');
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const file = path.join(OUT, 'tour.mp4');
  ffmpeg(['-i', webm, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', file]);
  console.log(file);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await staticServer(PACKS);
  const faces = FACES ? await staticServer(FACES) : null;
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
    const portrait = `${viteUrl}/@fs${PORTRAIT ?? `${REPO}/vendor/skin-gen/examples/sui-input.png`}`;
    const base =
      `pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}&name=${encodeURIComponent(NAME)}` +
      (faces && FACE ? `&faces=${encodeURIComponent(`http://127.0.0.1:${faces.address().port}/`)}&face=${encodeURIComponent(FACE)}` : '') +
      (LANG ? `&lang=${LANG}` : '');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const name of only) {
      if (VIDEOS[name]) await renderVideo(browser, viteUrl, base, name, VIDEOS[name]);
      else if (name === 'tour') await captureTour(browser, viteUrl, packUrl);
      else console.log(`unknown: ${name}`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
    faces?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
