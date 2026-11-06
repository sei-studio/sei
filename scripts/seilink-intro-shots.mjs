#!/usr/bin/env node
/**
 * Review videos of the WorldLink first-link intro (261105, T337; 261106 the
 * eclipse aurora and its climax; 261106 v6 the status lines), rendered frame
 * by frame (no dropped frames) on a simulated link (DevIntroPreview &sim):
 * a 75 s bake ending on the black plain background (OS dark mode) and on the
 * white one (light mode), a 20 s bake, a failure, everything ready at once
 * (a replay), the reduced motion version, and a capture of the guide's
 * WorldLink tour. Each video's length is the intro's own
 * (window.__firstLinkLength) plus a short tail.
 * Headless, no Electron.
 *
 *   node scripts/seilink-intro-shots.mjs --out <dir>
 *        [--packs resources/seilink-packs] [--preset cozy]
 *        [--portrait <png>] [--name Lyra] [--faces <dir of facepacks> --face <id>]
 *        [--only worldlink,worldlink-light,fast,fail,fail-light,instant,reduced,reduced-light,tour]
 *        [--fps 30] [--lang <code>] [--keep-frames]
 *        [--stills 0,2500,5000,...]   only these frames (ms) as PNGs, no video
 *
 * Intro videos open `?seilinkintro=1&manual=1` (DevIntroPreview) and call
 * window.__firstLinkSeek(ms) for every frame, then ffmpeg encodes H.264 with
 * a silent AAC track (Telegram shows a silent mp4 as a GIF) and prints the
 * biggest frame-to-frame change of mean luminance (lumaReport: a hard cut
 * shows as a big one; `<name>-luma.txt` has every frame). The tour runs
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

/** The simulated links (DevIntroPreview: &sim = the bake done after that many ms, &simfail = it fails there). */
const VIDEOS = {
  worldlink: { q: 'hold=1&sim=75000', scheme: 'dark' },
  'worldlink-light': { q: 'hold=1&sim=75000', scheme: 'light' },
  fast: { q: 'hold=1&sim=20000', scheme: 'dark' },
  fail: { q: 'hold=1&sim=75000&simfail=30000&failure=bake_failed', scheme: 'dark' },
  'fail-light': { q: 'hold=1&sim=75000&simfail=30000&failure=bake_failed', scheme: 'light' },
  instant: { q: 'hold=1', scheme: 'dark' },
  reduced: { q: 'reduced=1&hold=1&sim=20000', scheme: 'dark' },
  'reduced-light': { q: 'reduced=1&hold=1&sim=20000', scheme: 'light' },
};
/** Rendered past the intro's own length. */
const TAIL_MS = 300;
const KEEP_FRAMES = process.argv.includes('--keep-frames');
const STILLS = arg('stills', null)?.split(',').map(Number) ?? null;
const only = arg('only', 'worldlink,worldlink-light,fast,fail,reduced,tour').split(',');
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

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

/**
 * Per-frame mean luminance of a video (ffmpeg signalstats YAVG, limited range
 * 16..235) into `<video>-luma.txt`, and the biggest frame-to-frame change.
 */
export function lumaReport(file) {
  const out = file.replace(/\.mp4$/, '-luma.txt');
  const raw = path.join(path.dirname(out), `.${path.basename(out)}.raw`);
  ffmpeg(['-i', file, '-vf', `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${raw}`, '-an', '-f', 'null', '-']);
  const ys = fs.readFileSync(raw, 'utf8').split('\n').filter((l) => l.includes('YAVG=')).map((l) => Number(l.split('=')[1]));
  fs.rmSync(raw, { force: true });
  let max = 0;
  let at = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = Math.abs(ys[i] - ys[i - 1]);
    if (d > max) {
      max = d;
      at = i;
    }
  }
  fs.writeFileSync(out, ys.map((y, i) => `${i}\t${y.toFixed(2)}\t${i ? (y - ys[i - 1]).toFixed(2) : '0'}`).join('\n') + '\n');
  console.log(`  ${path.basename(file)}: ${ys.length} frames, luma ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)}, max frame-to-frame delta ${max.toFixed(2)} at frame ${at}`);
  return { max, at, frames: ys.length };
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
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1, colorScheme: spec.scheme ?? 'dark' });
  listen(page, name);
  await page.goto(`${viteUrl}/?seilinkintro=1&manual=1&${base}&${spec.q}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log(`  ${name}: room never reported ready`));
  await page.waitForFunction(() => typeof window.__firstLinkSeek === 'function', null, { timeout: 30_000 });
  // Her face set loads after the room.
  await page.waitForTimeout(3500);
  const dir = path.join(OUT, `${name}-frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (STILLS) {
    for (const ms of STILLS) {
      await page.evaluate((t) => window.__firstLinkSeek(t), ms);
      const file = path.join(OUT, `${name}-${String(ms).padStart(5, '0')}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    await page.close();
    return dir;
  }
  const len = (await page.evaluate(() => window.__firstLinkLength)) || 0;
  if (!len) throw new Error(`${name}: no __firstLinkLength`);
  const n = Math.ceil(((len + TAIL_MS) / 1000) * FPS) + 1;
  console.log(`  ${name}: ${(len / 1000).toFixed(1)} s`);
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
  lumaReport(file);
  if (!KEEP_FRAMES) fs.rmSync(dir, { recursive: true, force: true });
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

if (IS_MAIN) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
