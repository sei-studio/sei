#!/usr/bin/env node
/**
 * The first-room flow (261106) on a simulated desktop, as stills and one mp4:
 * the end of the link intro, her blank room on the wallpaper under the
 * desktop icons, her decorate-together offer, the room editor on the desktop
 * stage covering the icons, then the editor closed with the icons back over
 * the decorated room. Also stills of the two other paths (the offer in UI
 * copy, "Not now"). Headless, no Electron.
 *
 *   node scripts/seilink-first-room-flow.mjs [--out <dir>] [--intro <aurora.mp4>]
 *                                            [--portrait <png>] [--name Sui] [--lang en]
 *
 * Opens `?seilinkflow=1` (DevFirstRoomFlow) on its own Vite dev server, the
 * packs over a CORS static server, Chrome through playwright (CHROME_PATH,
 * default /usr/bin/google-chrome), and ffmpeg for the mp4 (h264 + a silent
 * AAC track). With --intro, its last seconds open the video. Everything it
 * starts is closed before it exits.
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
const INTRO = arg('intro', null) ? path.resolve(arg('intro')) : null;
const PORTRAIT = path.resolve(arg('portrait', path.join(REPO, 'vendor/skin-gen/examples/sui-input.png')));
const NAME = arg('name', 'Sui');
const LANG = arg('lang', null);
const LINE = "it's so empty in here. wanna decorate it with me?";

/** name -> phase query + when to shoot (ms after the room first draws). */
const SHOTS = [
  { name: '02-blank-room', q: 'phase=desktop', at: [2500] },
  { name: '03-offer', q: `phase=offer&line=${encodeURIComponent(LINE)}&press=decorate&pressat=6200`, at: [1000, 2800, 6500] },
  { name: '04-editor', q: 'phase=editor', at: [3000] },
  { name: '05-editor-decorated', q: 'phase=decorated', at: [3000] },
  { name: '06-closed', q: 'phase=closed', at: [3000] },
  { name: 'alt-offer-ui-copy', q: 'phase=prompt', at: [2500] },
  { name: 'alt-not-now', q: `phase=later&line=${encodeURIComponent(LINE)}&pressat=4200`, at: [4700] },
];
/** The video: [still, seconds on screen]. */
const VIDEO = [
  ['02-blank-room-02500', 2.6],
  ['03-offer-01000', 1.4],
  ['03-offer-02800', 3.4],
  ['03-offer-06500', 1.4],
  ['04-editor-03000', 2.6],
  ['05-editor-decorated-03000', 2.8],
  ['06-closed-03000', 3.4],
];
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

function buildVideo() {
  const tmp = path.join(OUT, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const clips = [];
  if (INTRO) {
    // The intro's last 3.5 s (the light settling, then the desktop).
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', INTRO]).toString().trim());
    const clip = path.join(tmp, 'intro-tail.mp4');
    ffmpeg(['-ss', String(Math.max(0, dur - 3.5)), '-i', INTRO, '-an', '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', clip]);
    clips.push([clip, 3.5]);
  }
  for (const [still, secs] of VIDEO) {
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
  const file = path.join(OUT, 'first-room-flow.mp4');
  ffmpeg([
    ...inputs,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex', chain.replace(/;$/, ''),
    '-map', '[v]', '-map', `${n}:a`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart',
    file,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(file);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const packs = await packServer(PACKS);
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
    const packUrl = `http://127.0.0.1:${packs.address().port}/cozy/`;
    const portrait = `${viteUrl}/@fs${PORTRAIT}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    for (const shot of SHOTS) {
      // 1280x720 CSS at 1.5x: 1920x1080 stills, the intro's size.
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
      page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 300)}`));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 240)}`);
      });
      page.on('response', (r) => {
        if (r.status() >= 400) console.log(`  [${r.status()}] ${r.url().slice(0, 200)}`);
      });
      const url =
        `${viteUrl}/?seilinkflow=1&pack=${encodeURIComponent(packUrl)}&portrait=${encodeURIComponent(portrait)}` +
        `&name=${encodeURIComponent(NAME)}${LANG ? `&lang=${LANG}` : ''}&${shot.q}`;
      await page.goto(url, { waitUntil: 'load' });
      const editor = shot.q.startsWith('phase=editor') || shot.q.startsWith('phase=decorated');
      if (!editor) await page.waitForSelector('[data-room-ready="1"]', { timeout: 60_000 }).catch(() => console.log(`  ${shot.name}: room never reported ready`));
      const t0 = Date.now();
      for (const at of shot.at) {
        await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
        const file = path.join(OUT, `${shot.name}-${String(at).padStart(5, '0')}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
  }
  buildVideo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
