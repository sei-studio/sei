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
//
// --scene host (261119, the product demo): the real wallpaper page instead (DevHostPreview,
// `?seilinkhost=1`): her room (--room cozy, --time night), her face set at DESKTOP_STAGE, a clock
// and date widget (--state <room json> overrides), a slim menu bar (--menubar 0 drops it), her
// line in a bubble after the click (--line, --lineat s), and the room lighting easing on at
// --dimat s (--dimms long). The page clock starts at --at (local time, default 21:41 today).
//
// 261120: --seed <n> makes the page's Math.random a seeded generator, so two runs (an old and a new
// pack, the same cursor path) glance, blink and sway alike for a side-by-side. --timeline <json file>
// changes the room on cue (host scene): [{ "at": s, "widgets": [...] }, { "at": s, "ms": 1800,
// "lighting": { "warmth": 40 } }]; widgets replace the room's list at once, lighting numbers ease from
// what they were over `ms`. --path tour (host scene) keeps the cursor moving after the click.
//
// 261120 (iris layer): --path sweep moves the cursor slowly across her (left, right, back, then up,
// down, back) with no click, for comparing how her irises follow. --dpr <n> renders at that device
// scale, and --clip face screenshots only her head (the top --cliph share of her box, default 0.42),
// so the eyes are sharp in a close-up; --clipy starts it that share of her box down.
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
const SCENE = arg('scene', 'flow');
const ROOM = arg('room', 'cozy');
const TIME = arg('time', 'night');
const LINE = arg('line', null);
const LINE_AT = Number(arg('lineat', String(CLICK_AT + 0.8)));
const DIM_AT = Number(arg('dimat', '-1'));
const DIM_MS = Number(arg('dimms', '2600'));
const DIM = JSON.parse(arg('dim', '{"brightness":-8,"dim":50,"warmth":12,"character":false}'));
const MENUBAR = arg('menubar', '1') === '1';
const SEED = arg('seed', null);
const PATH = arg('path', 'default');
const DPR = Number(arg('dpr', '1'));
const CLIP = arg('clip', null);
const CLIP_H = Number(arg('cliph', '0.42'));
const CLIP_Y = Number(arg('clipy', '0'));
const TIMELINE = arg('timeline', null) ? JSON.parse(fs.readFileSync(arg('timeline'), 'utf8')) : [];
const START_AT = (() => {
  const d = new Date();
  const [h, m] = arg('at', '21:41').split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
})();
/** The desktop as someone might set it up: a big clock with its date, top right. */
const HOST_STATE = arg('state', null)
  ? JSON.parse(fs.readFileSync(arg('state'), 'utf8'))
  : {
      widgets: [{ id: 'clock', kind: 'clock', x: 0.93, y: 0.16, align: 'right', font: 'system', color: '#ffffff', size: 120, weight: 300, opacity: 0.95, shadow: true, hour12: true, pad: false, seconds: false, ampm: true, date: 'long' }],
    };

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

/** The host scene's cursor (page px) at time t (s): slow and fast arcs, a click on her, then a long rest. */
function hostCursorAt(t, her) {
  const fx = her.x + her.w / 2;
  const fy = her.y + her.h * 0.2;
  const W = WIDTH;
  const H = HEIGHT;
  const C = CLICK_AT;
  // [time, x, y, bend]: bend bows the move sideways (fraction of its length), so it is an arc.
  const way = [
    [0, W * 0.82, H * 0.62, 0],
    [1.6, W * 0.82, H * 0.62, 0],
    [4.6, W * 0.14, H * 0.3, 0.35],
    [5.8, W * 0.14, H * 0.3, 0],
    [6.7, W * 0.7, H * 0.8, -0.25],
    [8.0, W * 0.7, H * 0.8, 0],
    [11.0, W * 0.28, H * 0.72, 0.5],
    [11.6, W * 0.28, H * 0.72, 0],
    [C - 0.8, fx + her.w * 0.06, fy + her.h * 0.1, 0.2],
    [C + 2.2, fx + her.w * 0.06, fy + her.h * 0.1, 0],
    [C + 3.4, W * 0.9, H * 0.86, -0.3],
    ...(PATH === 'tour'
      ? [
          // 261120 --path tour: she keeps following it after the click, past the widgets as they come on.
          [C + 5.0, W * 0.9, H * 0.86, 0],
          [C + 7.6, W * 0.12, H * 0.2, 0.3],
          [C + 9.0, W * 0.12, H * 0.2, 0],
          [C + 11.4, W * 0.86, H * 0.42, -0.35],
          [C + 13.0, W * 0.86, H * 0.42, 0],
          [C + 15.4, W * 0.2, H * 0.84, 0.3],
          [C + 16.6, W * 0.2, H * 0.84, 0],
          [C + 19.0, W * 0.92, H * 0.88, -0.2],
        ]
      : []),
    [999, W * 0.9, H * 0.86, 0],
  ];
  for (let i = 0; i < way.length - 1; i++) {
    const [t0, x0, y0] = way[i];
    const [t1, x1, y1, bend] = way[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const k = u * u * u * (u * (u * 6 - 15) + 10);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const off = Math.sin(Math.PI * k) * (bend ?? 0);
      return { x: x0 + dx * k - dy * off, y: y0 + dy * k + dx * off };
    }
  }
  return { x: way[0][1], y: way[0][2] };
}

/** --path sweep: slow sweeps across her face, left and right then up and down, with rests. */
function sweepCursorAt(t, her) {
  const fx = her.x + her.w / 2;
  const fy = her.y + her.h * 0.2;
  const W = WIDTH;
  const H = HEIGHT;
  const way = [
    [0, fx, fy],
    [1.0, fx, fy],
    [3.4, W * 0.03, fy],
    [3.9, W * 0.03, fy],
    [7.6, W * 0.97, fy],
    [8.1, W * 0.97, fy],
    [9.6, fx, fy],
    [10.0, fx, fy],
    [11.6, fx, H * 0.02],
    [12.0, fx, H * 0.02],
    [14.4, fx, H * 0.98],
    [14.8, fx, H * 0.98],
    [16.0, fx, fy],
    [999, fx, fy],
  ];
  for (let i = 0; i < way.length - 1; i++) {
    const [t0, x0, y0] = way[i];
    const [t1, x1, y1] = way[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const k = u * u * (3 - 2 * u);
      return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
    }
  }
  return { x: way[0][1], y: way[0][2] };
}

/** A slim menu bar over the top edge (headless has no desktop): the app menu and the time. */
async function addMenuBar(page) {
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = '__demo_menubar';
    bar.style.cssText =
      'position:fixed;left:0;top:0;right:0;height:25px;z-index:2147483646;pointer-events:none;display:flex;align-items:center;gap:20px;padding:0 14px;' +
      'background:rgba(28,26,36,0.42);backdrop-filter:blur(18px) saturate(1.4);color:rgba(255,255,255,0.92);' +
      'font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;letter-spacing:0.1px';
    const left = ['Files', 'File', 'Edit', 'View', 'Go', 'Window', 'Help'];
    bar.innerHTML = left.map((w, i) => `<span style="${i === 0 ? 'font-weight:700' : ''}">${w}</span>`).join('') + '<span style="flex:1"></span><span id="__demo_menutime"></span>';
    document.body.appendChild(bar);
    const tick = () => {
      const d = new Date();
      const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      document.getElementById('__demo_menutime').textContent = `${day}  ${time}`;
    };
    tick();
    // Often enough that it turns over with the clock widget (which ticks just past each minute).
    setInterval(tick, 100);
  });
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
    const url =
      SCENE === 'host'
        ? `${viteUrl}/?seilinkhost=1&cursorfeed=1&taskbar=0&time=${TIME}&pack=${encodeURIComponent(`http://127.0.0.1:${rooms.address().port}/${ROOM}/`)}&name=${encodeURIComponent(NAME)}${portraitQ}${faceQ}&state=${encodeURIComponent(JSON.stringify(HOST_STATE))}`
        : `${viteUrl}/?seilinkflow=1&phase=desktop&cursorfeed=1&pack=${encodeURIComponent(roomUrl)}&name=${encodeURIComponent(NAME)}${portraitQ}${faceQ}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR, colorScheme: 'dark' });
    // Nothing leaves this machine (no analytics, no CDNs).
    await ctx.route('**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return r.continue();
      return r.abort();
    });
    const page = await ctx.newPage();
    if (SEED !== null)
      await page.addInitScript((seed) => {
        // mulberry32: the same sequence every run.
        let a = seed >>> 0;
        Math.random = () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }, Number(SEED));
    await page.clock.install(SCENE === 'host' ? { time: START_AT } : undefined);
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
    if (SCENE === 'host' && MENUBAR) await addMenuBar(page);
    // Freeze a moment ahead of the page's clock (this process's may be behind it).
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1500);
    let lined = false;
    let lightNow = { brightness: 0, dim: 0, warmth: 0, character: false, ...(HOST_STATE.lighting ?? {}) };
    const n = Math.round(SECONDS * FPS);
    const rows = [];
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const t = i / FPS;
      const cur = PATH === 'sweep' ? sweepCursorAt(t, her) : SCENE === 'host' ? hostCursorAt(t, her) : cursorAt(t, her);
      await page.mouse.move(cur.x, cur.y);
      await page.evaluate(({ x, y }) => {
        document.getElementById('__demo_cursor').style.transform = `translate(${x - 2}px, ${y - 2}px)`;
      }, cur);
      if (!clicked && t >= CLICK_AT) {
        clicked = true;
        await page.evaluate(() => window.__seiDevPoke?.('click'));
      }
      if (LINE && !lined && t >= LINE_AT) {
        lined = true;
        await page.evaluate((text) => window.__seiDevLine?.(text), LINE);
      }
      if (DIM_AT >= 0 && t >= DIM_AT && t <= DIM_AT + DIM_MS / 1000 + 1 / FPS) {
        const u = Math.min(1, ((t - DIM_AT) * 1000) / DIM_MS);
        const k = u * u * (3 - 2 * u);
        const light = { ...DIM };
        for (const key of ['brightness', 'dim', 'warmth']) if (typeof DIM[key] === 'number') light[key] = Math.round(DIM[key] * k);
        await page.evaluate((lighting) => window.__seiDevRoom?.({ lighting }), light);
      }
      for (const ev of TIMELINE) {
        if (t < ev.at) continue;
        if (ev.widgets && !ev.done) {
          ev.done = true;
          await page.evaluate((widgets) => window.__seiDevRoom?.({ widgets }), ev.widgets);
        }
        if (ev.lighting && !ev.finished) {
          ev.from ??= { ...lightNow };
          const u = ev.ms > 0 ? Math.min(1, ((t - ev.at) * 1000) / ev.ms) : 1;
          const k = u * u * (3 - 2 * u);
          const light = { ...ev.from, ...ev.lighting };
          for (const key of Object.keys(ev.lighting)) if (typeof ev.lighting[key] === 'number') light[key] = Math.round((ev.from[key] ?? 0) + (ev.lighting[key] - (ev.from[key] ?? 0)) * k);
          await page.evaluate((lighting) => window.__seiDevRoom?.({ lighting }), light);
          if (u >= 1) {
            ev.finished = true;
            lightNow = light;
          }
        }
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
      const clip = CLIP === 'face' ? { x: Math.round(her.x), y: Math.max(0, Math.round(her.y + her.h * CLIP_Y)), width: Math.round(her.w), height: Math.round(her.h * CLIP_H) } : undefined;
      await page.screenshot({ path: path.join(OUT, 'frames', `f${String(i).padStart(5, '0')}.png`), clip });
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
    fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify({ fps: FPS, clickAt: CLICK_AT, scene: SCENE, lineAt: LINE ? LINE_AT : null, dimAt: DIM_AT, her, rows }));
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
