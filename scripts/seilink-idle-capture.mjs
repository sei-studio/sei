#!/usr/bin/env node
/**
 * WorldLink idle capture (261116, product call 261116): her idle on the
 * wallpaper page as a short video, and a CPU reading of the same page.
 * Headless Chrome through playwright, no Electron; the page is the host
 * preview (`?seilinkhost=1`, DevHostPreview with its fake bridge).
 *
 *   node scripts/seilink-idle-capture.mjs --out <dir> [--name idle] [--preset cozy]
 *        [--facepacks <dir> --facepack-id <id>] [--portrait <png>] [--size 1280x720]
 *        [--seconds 18] [--cpu-seconds 20] [--no-video] [--no-cpu] [--shot] [--time day]
 *
 * Video: <out>/<name>.mp4 (h264 + a silent AAC track, so chat apps play it as
 * video), trimmed to start once her face set has drawn. CPU: renderer main
 * thread busy time (CDP Performance TaskDuration) per second of wall time, and
 * the CPU seconds of every Chrome process (/proc, Linux) over the window.
 * Headless Linux draws WebGL with SwiftShader (software), so the GPU process
 * number is an upper bound, not what a Mac or Windows GPU spends.
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
const argv = process.argv;
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const PACKS = path.resolve(arg('packs', path.join(REPO, 'resources/seilink-packs')));
const PRESET = arg('preset', 'cozy');
const OUT = path.resolve(arg('out', 'seilink-idle-capture'));
const NAME = arg('name', 'idle');
const [VW, VH] = arg('size', '1280x720').split('x').map(Number);
const SECONDS = Number(arg('seconds', '18'));
const CPU_SECONDS = Number(arg('cpu-seconds', '20'));
const FACEPACKS = arg('facepacks', null) ? path.resolve(arg('facepacks')) : null;
const FACEPACK_ID = arg('facepack-id', null);
const PORTRAIT = arg('portrait', null) ? path.resolve(arg('portrait')) : null;
const TIME = arg('time', 'day');
const EXTRA = arg('query', '');

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

/** CPU seconds (user + system) of a pid and all its descendants, Linux only. */
function treeCpuSeconds(rootPid) {
  const tick = 100;
  const kids = new Map();
  const stats = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      const cpu = (Number(rest[11]) + Number(rest[12])) / tick;
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      const type = /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser';
      stats.set(Number(d), { cpu, type });
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch {
      /* gone */
    }
  }
  const out = {};
  const walk = (pid) => {
    const st = stats.get(pid);
    if (st) out[st.type] = (out[st.type] ?? 0) + st.cpu;
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(rootPid);
  return out;
}

const TAG = `${process.pid}-${Date.now()}`;

/** The browser process launched with our tag (playwright's Browser does not expose its pid). */
function findTagged(tag) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (cmd.includes(`--seilink-capture-tag=${tag}`) && !cmd.includes('--type=')) return Number(d);
    } catch {
      /* gone */
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await packServer(PACKS);
  const faces = FACEPACKS ? await packServer(FACEPACKS) : null;
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
    const face = faces && FACEPACK_ID ? `&facepacks=${encodeURIComponent(`http://127.0.0.1:${faces.address().port}/`)}&facepackid=${encodeURIComponent(FACEPACK_ID)}&facepackat=0` : '';
    const url = `${viteUrl}/?seilinkhost=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}${face}&time=${TIME}&taskbar=0${EXTRA ? `&${EXTRA}` : ''}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', `--seilink-capture-tag=${TAG}`],
    });
    const settle = async (page) => {
      await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log('  room never reported ready'));
      if (face) await page.waitForSelector('[data-avatar-kind="facepack"]', { timeout: 30_000 }).catch(() => console.log('  face set never showed'));
      // The portrait-to-face-set crossfade and the first texture uploads.
      await page.waitForTimeout(2500);
      const renderer = await page.evaluate(() => document.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null);
      if (renderer) console.log(`  face renderer: ${renderer}`);
    };

    if (flag('shot')) {
      const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
      await settle(page);
      const file = path.join(OUT, `${NAME}.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
      return;
    }

    if (!flag('no-video')) {
      const vdir = path.join(OUT, `.video-${NAME}`);
      fs.rmSync(vdir, { recursive: true, force: true });
      const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: VW, height: VH } } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
      await settle(page);
      const start = (Date.now() - t0) / 1000;
      await page.waitForTimeout(SECONDS * 1000);
      await page.screenshot({ path: path.join(OUT, `${NAME}.png`) });
      const video = page.video();
      await ctx.close();
      const webm = await video.path();
      const mp4 = path.join(OUT, `${NAME}.mp4`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-ss', String(start), '-i', webm, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t', String(SECONDS), '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-crf', '20', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4,
      ], { timeout: 300_000 });
      fs.rmSync(vdir, { recursive: true, force: true });
      console.log(mp4);
    }

    if (!flag('no-cpu')) {
      const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
      await settle(page);
      await page.waitForTimeout(2000);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const pid = findTagged(TAG);
      const p0 = pid ? treeCpuSeconds(pid) : null;
      const m0 = await metric();
      const w0 = Date.now();
      await page.waitForTimeout(CPU_SECONDS * 1000);
      const m1 = await metric();
      const p1 = pid ? treeCpuSeconds(pid) : null;
      const wall = (Date.now() - w0) / 1000;
      const per = (k) => (((m1[k] ?? 0) - (m0[k] ?? 0)) / wall) * 100;
      const procs = {};
      if (p0 && p1) for (const k of Object.keys(p1)) procs[k] = +((((p1[k] ?? 0) - (p0[k] ?? 0)) / wall) * 100).toFixed(1);
      const result = {
        name: NAME,
        size: `${VW}x${VH}`,
        wallSeconds: +wall.toFixed(1),
        mainThreadBusyPct: +per('TaskDuration').toFixed(2),
        scriptPct: +per('ScriptDuration').toFixed(2),
        layoutPct: +per('LayoutDuration').toFixed(2),
        styleRecalcPct: +per('RecalcStyleDuration').toFixed(2),
        processCpuPct: procs,
        jsHeapMB: +((m1.JSHeapUsedSize ?? 0) / 1048576).toFixed(1),
      };
      fs.writeFileSync(path.join(OUT, `${NAME}-cpu.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      await ctx.close();
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
