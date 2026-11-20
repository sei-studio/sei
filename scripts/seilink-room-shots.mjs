#!/usr/bin/env node
/**
 * Screenshots of the SeiLink room preview (261104), headless, no Electron.
 *
 *   node scripts/seilink-room-shots.mjs --packs <dir> [--preset cozy] [--out seilink-shots]
 *                                       [--shots day,dusk,night,...] [--size 1280x720]
 *                                       [--serve <dir>] [--query '<extra params>']
 *                                       [--video <seconds> --stills 2,9,15 --name idle]
 *
 * Her avatar (261104): --serve starts a second CORS static server over <dir>
 * and `{SERVE}` in --query becomes its URL, e.g.
 *   --serve faces --query 'faces={SERVE}/packs&face=sui&walk=6&away=12'
 * (see DevRoomPreview for the avatar params). --video records the first shot
 * for that many seconds (from the moment the room is ready) into
 * <out>/<name>.mp4, H.264 with a silent AAC track (Telegram shows a
 * soundless mp4 as a GIF), plus a still at each --stills second.
 *
 * Starts the renderer's Vite dev server on its own (no electron-vite), a small
 * CORS static server for <packs>/<preset>/, and Chrome through playwright,
 * then opens the `?seilink=1&pack=<url>` preview (DevRoomPreview) per shot.
 * Everything it starts is closed before it exits. CHROME_PATH overrides the
 * browser (default /usr/bin/google-chrome).
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
const PACKS = path.resolve(arg('packs', 'seilink-dev-packs'));
const PRESET = arg('preset', 'cozy');
const OUT = path.resolve(arg('out', 'seilink-shots'));
const [VW, VH] = arg('size', '1280x720').split('x').map(Number);
const SHOTS = {
  day: 'time=day',
  dusk: 'time=dusk',
  night: 'time=night',
  'night-items': 'time=night&items=1',
  'day-tint': 'time=day&items=1&tint.curtains=3f8f6a&tint.shell=b9d2f0&tint.rug=e8c35a',
  'contain-dusk': 'time=dusk&fit=contain&items=1', // shot at 1000x800 so the letterbox shows
  'night-clean': 'time=night&items=1&hud=0',
  'fade-day-night': 'time=day&items=1',
};
const names = arg('shots', Object.keys(SHOTS).join(',')).split(',');
const SERVE = arg('serve', null);
const QUERY = arg('query', '');
const VIDEO_S = Number(arg('video', 0));
const STILLS = arg('stills', '').split(',').filter(Boolean).map(Number);
const NAME = arg('name', 'idle');

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

/** Record one shot as an mp4 with a silent audio track, plus stills. */
async function recordVideo(browser, url) {
  const dir = fs.mkdtempSync(path.join(OUT, '.video-'));
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: VW, height: VH } } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 });
  // Let her art decode before the clip starts.
  await page.waitForTimeout(1500);
  const offset = (Date.now() - t0) / 1000;
  const start = Date.now();
  for (const at of [...STILLS].sort((a, b) => a - b)) {
    const wait = at * 1000 - (Date.now() - start);
    if (wait > 0) await page.waitForTimeout(wait);
    const file = path.join(OUT, `${NAME}-${String(at).padStart(2, '0')}s.png`);
    await page.screenshot({ path: file });
    const phase = await page.getAttribute('[data-avatar-phase]', 'data-avatar-phase').catch(() => null);
    console.log(`${file} (${phase})`);
  }
  const rest = VIDEO_S * 1000 - (Date.now() - start);
  if (rest > 0) await page.waitForTimeout(rest);
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const mp4 = path.join(OUT, `${NAME}.mp4`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    'timeout',
    ['300', 'ffmpeg', '-y', '-loglevel', 'error', '-ss', offset.toFixed(2), '-i', webm, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(VIDEO_S), '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '64k', '-shortest', mp4],
    { stdio: 'inherit' },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
  console.log(mp4);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await packServer(PACKS);
  const served = SERVE ? await packServer(path.resolve(SERVE)) : null;
  const extra = QUERY.replaceAll('{SERVE}', served ? `http://127.0.0.1:${served.address().port}` : '');
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
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text().slice(0, 240)}`);
    });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    if (VIDEO_S > 0) {
      const q = SHOTS[names[0]] ?? names[0];
      await recordVideo(browser, `${viteUrl}/?seilink=1&pack=${encodeURIComponent(packUrl)}&${q}${extra ? `&${extra}` : ''}`);
      return;
    }
    for (const name of names) {
      const q = SHOTS[name];
      if (!q) {
        console.log(`unknown shot ${name}`);
        continue;
      }
      await page.setViewportSize(name === 'contain-dusk' ? { width: 1000, height: 800 } : { width: VW, height: VH });
      await page.goto(`${viteUrl}/?seilink=1&pack=${encodeURIComponent(packUrl)}&${q}${extra ? `&${extra}` : ''}`, { waitUntil: 'load' });
      try {
        await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 });
      } catch {
        console.log(`${name}: room never reported ready`);
      }
      await page.waitForTimeout(600);
      if (name === 'fade-day-night') {
        // Mid-crossfade: pick night from day and catch the 1.2 s fade halfway.
        await page.getByRole('button', { name: 'night', exact: true }).click();
        await page.waitForTimeout(Number(process.env.SEILINK_FADE_WAIT_MS ?? 600));
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
    served?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
