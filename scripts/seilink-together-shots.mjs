#!/usr/bin/env node
/**
 * Decorating together (261105, T336): screenshots and one 1920x1080 video of
 * the shared room editor (RoomTogether), headless, no Electron.
 *
 *   node scripts/seilink-together-shots.mjs --out <dir> [--preset cozy] [--name Sui] [--time dusk]
 *
 * Opens `?seilink=1&editor=1&together=<name>` over the bundled pack and plays
 * a scripted session through the dev bridge (devHarnessStubs: __seiTogether):
 * a player edit and her live line in the bubble, the talk box ("make it
 * cozier"), her changes applied (crossfade, rings, "Undo {name}'s changes"),
 * undo, a suggestion ("Try {name}'s idea"), the call pill and the usage
 * limit. Her edits come from the real resolver (shared/seilinkDecorate.ts).
 * The mp4 has a silent AAC track. Run from the repo root. CHROME_PATH
 * overrides the browser. Everything it starts is closed before it exits.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const REPO = process.cwd();
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const OUT = path.resolve(arg('out', 'together-shots'));
const PACKS = path.join(REPO, 'resources/seilink-packs');
const PRESET = arg('preset', 'cozy');
const NAME = arg('name', 'Sui');
const VW = 1920;
const VH = 1080;

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
        const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.webp') ? 'image/webp' : 'image/png';
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
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
    const packQ = `pack=${encodeURIComponent(`http://127.0.0.1:${packs.address().port}/${PRESET}/`)}`;
    const url = `${viteUrl}/?seilink=1&editor=1&${packQ}&together=${NAME}&char=dev-preview&time=${arg('time', 'dusk')}&items=1`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' });
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, recordVideo: { dir: path.join(OUT, '_video'), size: { width: VW, height: VH } } });
    await ctx.addInitScript((r) => {
      window.__repo = r;
    }, REPO);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[page error] ${e.message.slice(0, 300)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[page error] ${m.text().slice(0, 240)}`);
    });
    const t0 = Date.now();
    const marks = [];
    const shot = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      marks.push([name, (Date.now() - t0) / 1000]);
      console.log(file);
    };
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-room-editor] nav', { timeout: 60_000 });
    await page.waitForFunction(() => !!window.__seiTogetherCtx, null, { timeout: 30_000 });
    await page.waitForTimeout(3500);
    const videoStart = (Date.now() - t0) / 1000 - 0.3;
    await shot('01-talk-box');

    // The player recolours the walls; a few seconds later her live line arrives in her chat.
    await page.evaluate(async () => {
      const m = await import('/@fs' + window.__repo + '/src/shared/seilinkDecorate.ts');
      const c = window.__seiTogetherCtx;
      const r = m.resolveDecorate(c.manifest, c.state, { mode: 'apply', changes: [{ do: 'color', target: 'walls', value: 'lavender' }] });
      c.commit(r.state);
    }).catch((e) => console.log('player edit failed', e.message));
    await page.waitForTimeout(2500);
    await page.evaluate((name) => window.__seiTogether.push('dev-preview', 'ooh lavender walls. very sleepy vibes, i approve'), NAME);
    await page.waitForTimeout(1800);
    await shot('02-live-bubble');
    await page.waitForTimeout(2600);

    // The talk box: "make it cozier". Her decorate call lands, then her reply.
    await page.evaluate(() => {
      window.__seiTogether.replyMs = 2600;
      window.__seiTogether.reply = () => 'warmer rug, sunny bed, and the cushion by the bed. better?';
    });
    const input = page.locator('input[placeholder^="Say something to"]');
    await input.click();
    await input.type('make it cozier', { delay: 70 });
    await page.waitForTimeout(400);
    await shot('03-typing');
    await input.press('Enter');
    await page.waitForTimeout(900);
    await shot('04-her-typing');
    await page.evaluate(async () => {
      const m = await import('/@fs' + window.__repo + '/src/shared/seilinkDecorate.ts');
      const c = window.__seiTogetherCtx;
      const r = m.resolveDecorate(c.manifest, c.state, {
        mode: 'apply',
        changes: [
          { do: 'color', target: 'rug', value: 'terracotta' },
          { do: 'move', target: 'floor cushion', value: 'left' },
          { do: 'color', target: 'bed', value: 'mustard' },
        ],
      });
      window.__lastDone = r.done.length;
      window.__seiTogether.emit({ token: 'dev', kind: 'edits', id: 'toolu_1', mode: 'apply', ops: r.ops, changes: r.done });
    });
    await page.waitForTimeout(350);
    await shot('05-her-changes-fading-in');
    await page.waitForTimeout(700);
    await shot('06-her-changes-highlight');
    await page.waitForTimeout(2600);
    await shot('07-reply-and-undo-chip');
    await page.waitForTimeout(1500);

    // Undo her changes.
    await page.getByRole('button', { name: new RegExp(`Undo ${NAME}'s changes`) }).click();
    await page.waitForTimeout(300);
    await shot('08-undo-fading');
    await page.waitForTimeout(1500);
    await shot('09-after-undo');

    // A suggestion: "Try her idea".
    await page.evaluate(async () => {
      const m = await import('/@fs' + window.__repo + '/src/shared/seilinkDecorate.ts');
      const c = window.__seiTogetherCtx;
      const r = m.resolveDecorate(c.manifest, c.state, { mode: 'suggest', changes: [{ do: 'pattern', target: 'curtains', value: 'gingham' }] });
      window.__seiTogether.emit({ token: 'dev', kind: 'edits', id: 'toolu_2', mode: 'suggest', ops: r.ops, changes: r.done });
      window.__seiTogether.push('dev-preview', 'what if the curtains were gingham? your call');
    });
    await page.waitForTimeout(2000);
    await shot('10-idea-chip');
    await page.getByRole('button', { name: new RegExp(`Try ${NAME}'s idea`) }).click();
    await page.waitForTimeout(1200);
    await shot('11-idea-applied');
    await page.waitForTimeout(1500);

    // On a call: the call pill replaces the talk box.
    await page.evaluate(() => {
      window.__seiTogetherStores.voice.setState({ participants: ['dev-preview'], status: 'live' });
    });
    await page.waitForTimeout(1500);
    await shot('12-on-call');
    await page.evaluate(() => {
      window.__seiTogetherStores.voice.setState({ participants: [], status: 'idle' });
      window.__seiTogetherStores.credits.setState({ over_limit: true });
    });
    await page.waitForTimeout(1500);
    await shot('13-over-limit');
    await page.waitForTimeout(800);
    const tracked = await page.evaluate(() => ({ tracked: window.__seiTogether.tracked, synced: window.__seiTogether.synced.length, done: window.__lastDone }));
    console.log('tracked', JSON.stringify(tracked));
    const vid = page.video();
    await ctx.close();
    const webm = await vid.path();
    const mp4 = path.join(OUT, 'decorating-together.mp4');
    execFileSync('timeout', ['180', 'ffmpeg', '-v', 'error', '-y', '-ss', Math.max(0, videoStart).toFixed(2), '-i', webm, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '64k', mp4]);
    fs.rmSync(path.join(OUT, '_video'), { recursive: true, force: true });
    console.log(mp4, JSON.stringify(marks.map(([n, t]) => [n, +(t - videoStart).toFixed(1)])));
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
    packs.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
