#!/usr/bin/env node
// Record her on the WorldLink desktop (DevFirstRoomFlow phase=desktop, the real host page,
// RoomAvatar and the WebGL face set) with a scripted, drawn mouse cursor that her eyes follow
// (the harness's &cursorfeed=1 makes the gaze feed the way the host does: 150 ms polls), one
// click on her (window.__seiDevPoke: the press, then the click 560 ms later) and her idle life.
// The page clock is frozen and stepped one video frame at a time, so the video is true 30 fps
// even though software WebGL is slow. Writes frames/fNNNNN.png, trace.json (per frame: face
// loop params from window.__seiFaceTrace, her body transform, the cursor) and, with ffmpeg on
// PATH, demo.mp4 (h264 + a silent AAC track).
//
//   node scripts/seilink-avatar-demo.mjs --facepacks <packs dir> --facepack-id <an-...> \
//        --portrait <png> --out <dir> [--seconds 26] [--fps 30] [--clickat 15.5] [--width 1440 --height 900]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const OUT = path.resolve(arg('out', 'out'));
const FACEPACKS = path.resolve(arg('facepacks'));
const FACEPACK_ID = arg('facepack-id');
const PORTRAIT = arg('portrait', null);
const NAME = arg('name', 'Sui');
const SECONDS = Number(arg('seconds', '26'));
const FPS = Number(arg('fps', '30'));
const CLICK_AT = Number(arg('clickat', '15.5'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const SETTLE_S = Number(arg('settle', '3'));

function fileServer(root) {
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

/** The cursor path (page px) at time t (s): smooth moves between waypoints, with rests. */
function cursorAt(t, her) {
  const fx = her.x + her.w / 2;
  const fy = her.y + her.h * 0.22;
  // [time, x, y]: moves ease between consecutive waypoints (minimum jerk).
  const W = WIDTH;
  const H = HEIGHT;
  const way = [
    [0, W * 0.78, H * 0.3],
    [2.0, W * 0.78, H * 0.3],
    [4.2, W * 0.16, H * 0.24],
    [5.4, W * 0.16, H * 0.24],
    [7.4, W * 0.24, H * 0.82],
    [8.6, W * 0.24, H * 0.82],
    [10.6, W * 0.86, H * 0.74],
    [11.4, W * 0.86, H * 0.74],
    [13.6, W * 0.55, H * 0.12],
    [14.6, fx + her.w * 0.05, fy + her.h * 0.12],
    [CLICK_AT + 0.9, fx + her.w * 0.05, fy + her.h * 0.12],
    [CLICK_AT + 3.0, W * 0.9, H * 0.45],
    [CLICK_AT + 4.4, W * 0.9, H * 0.45],
    [CLICK_AT + 7.2, W * 0.1, H * 0.55],
    [CLICK_AT + 8.0, W * 0.1, H * 0.55],
    [CLICK_AT + 10.0, W * 0.62, H * 0.2],
    [999, W * 0.62, H * 0.2],
  ];
  for (let i = 0; i < way.length - 1; i++) {
    const [t0, x0, y0] = way[i];
    const [t1, x1, y1] = way[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const k = u * u * u * (u * (u * 6 - 15) + 10);
      return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
    }
  }
  return { x: way[0][1], y: way[0][2] };
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const rooms = await fileServer(path.join(REPO, 'resources/seilink-packs'));
  const faces = await fileServer(FACEPACKS);
  const vite = await createServer({
    configFile: false,
    // Its own cache outside the repo (a worktree's node_modules is often a symlink shared with others).
    cacheDir: path.join(os.tmpdir(), 'sei-avatar-demo-vite'),
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
    const roomUrl = `http://127.0.0.1:${rooms.address().port}/cozy/`;
    const faceQ = `&facepacks=${encodeURIComponent(`http://127.0.0.1:${faces.address().port}/`)}&facepackid=${encodeURIComponent(FACEPACK_ID)}&facepackat=0`;
    const portraitQ = PORTRAIT ? `&portrait=${encodeURIComponent(`${viteUrl}/@fs${path.resolve(PORTRAIT)}`)}` : '';
    const url = `${viteUrl}/?seilinkflow=1&phase=desktop&cursorfeed=1&pack=${encodeURIComponent(roomUrl)}&name=${encodeURIComponent(NAME)}${portraitQ}${faceQ}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'dark' });
    // Nothing leaves this machine (no analytics, no CDNs).
    await ctx.route('**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return r.continue();
      return r.abort();
    });
    const page = await ctx.newPage();
    await page.clock.install();
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  [console error] ${m.text().slice(0, 240)}`);
    });
    await page.goto(url, { waitUntil: 'load', timeout: 240_000 });
    await page.waitForSelector('[data-room-ready="1"]', { timeout: 120_000 });
    await page.waitForSelector('[data-avatar-kind="facepack"] canvas[data-renderer]', { timeout: 120_000 });
    await page.waitForTimeout(SETTLE_S * 1000);
    const her = await page.evaluate(() => {
      const r = document.querySelector('[data-seilink-hit]').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, renderer: document.querySelector('canvas[data-renderer]')?.getAttribute('data-renderer') };
    });
    console.log('her box', JSON.stringify(her));
    // A drawn cursor (headless has none): a plain arrow, always on top, never hit-tested.
    await page.evaluate(() => {
      const c = document.createElement('div');
      c.id = '__demo_cursor';
      c.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:36px;z-index:2147483647;pointer-events:none;will-change:transform';
      c.innerHTML =
        '<svg width="24" height="36" viewBox="0 0 24 36"><path d="M2 2 L2 28 L8.5 22 L13 33 L17.5 31 L13 20.5 L22 20.5 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.body.appendChild(c);
      window.__seiFaceTrace = [];
    });
    // Freeze a moment ahead of both clocks (the page's can run ahead of this process's).
    const now = Math.max(Date.now(), await page.evaluate(() => Date.now()));
    await page.clock.pauseAt(now + 1500);
    const n = Math.round(SECONDS * FPS);
    const rows = [];
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const t = i / FPS;
      const cur = cursorAt(t, her);
      await page.mouse.move(cur.x, cur.y);
      await page.evaluate(({ x, y }) => {
        document.getElementById('__demo_cursor').style.transform = `translate(${x - 2}px, ${y - 2}px)`;
      }, cur);
      if (!clicked && t >= CLICK_AT) {
        clicked = true;
        await page.evaluate(() => window.__seiDevPoke?.('click'));
      }
      const frameMs = Math.round((1000 * (i + 1)) / FPS) - Math.round((1000 * i) / FPS);
      await page.clock.runFor(frameMs);
      // Web Animations (her click reaction, transitions) run on the real compositor clock, not the
      // stepped one: hold each and move it on one video frame at a time, or a 280 ms reaction
      // would finish between two screenshots.
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          if (!a.__demoStepped) {
            a.__demoStepped = true;
            a.pause();
            a.currentTime = 0;
          } else a.currentTime = (Number(a.currentTime) || 0) + ms;
        }
      }, frameMs);
      await page.waitForTimeout(15);
      await page.screenshot({ path: path.join(OUT, 'frames', `f${String(i).padStart(5, '0')}.png`) });
      const st = await page.evaluate(() => {
        const tr = window.__seiFaceTrace;
        const face = tr.length ? tr[tr.length - 1] : null;
        tr.length = 0;
        const body = document.querySelector('[data-avatar-kind] > div');
        const hit = document.querySelector('[data-seilink-hit]');
        const r = hit?.getBoundingClientRect();
        const anims = hit ? hit.getAnimations().map((a) => Math.round(Number(a.currentTime) || 0)) : [];
        return { face, body: body?.style.transform ?? '', hitTransform: hit ? getComputedStyle(hit).transform : '', hit: r ? [r.x, r.y, r.width, r.height] : null, anims };
      });
      rows.push({ i, t, cursor: cur, clicked: clicked && t - CLICK_AT < 1 / FPS ? 1 : 0, ...st });
      if (i % 60 === 0) console.log(`frame ${i}/${n}`);
    }
    fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify({ fps: FPS, clickAt: CLICK_AT, her, rows }));
    console.log(`stepped ${n} frames at ${FPS} fps`);
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    rooms.close();
    faces.close();
  }
  const ff = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(OUT, 'frames', 'f%05d.png'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path.join(OUT, 'demo.mp4')],
    { stdio: 'inherit' },
  );
  if (ff.status === 0) console.log(`wrote ${path.join(OUT, 'demo.mp4')}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
