// Take-the-wheel pilot: a private virtual display + Chrome per run.
// Own Xvfb display and a throwaway Chrome profile; never touches :99 or the
// shared browser profile. CDP is used only for setup and grading, never to
// give the model state.
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SCREEN = { width: 1024, height: 576 };

// Hosts that only serve ads or trackers. Blocked so a stray click cannot
// leave the game, and so the screen stays the game.
const AD_HOSTS = [
  'googlesyndication', 'doubleclick', 'googleadservices', 'adservice', 'adnxs',
  'amazon-adsystem', 'criteo', 'taboola', 'outbrain', 'pubmatic', 'rubicon',
  'openx', 'adsafeprotected', 'moatads', 'scorecardresearch', 'quantserve',
  'google-analytics', 'googletagmanager', 'googletagservices', 'fundingchoices',
  'cmp.', 'consensu', 'playwire', 'cpmstar', 'nitropay', 'ezoic',
];

export async function startDisplay(display) {
  const lock = `/tmp/.X${display}-lock`;
  if (existsSync(lock)) throw new Error(`display :${display} is in use`);
  const proc = spawn('Xvfb', [`:${display}`, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !existsSync(lock); i++) await sleep(100);
  await sleep(300);
  return { proc, display, stop: () => { try { proc.kill('SIGTERM'); } catch {} } };
}

export async function startChrome({ display, url, cdpPort = 9431, extraArgs = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'ttw-chrome-'));
  const args = [
    '-n', '10', 'google-chrome',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter', '--disable-sync', '--password-store=basic',
    `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1',
    '--window-position=0,0', `--window-size=${SCREEN.width},${SCREEN.height}`, '--kiosk',
    '--mute-audio', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ...extraArgs, 'about:blank',
  ];
  const proc = spawn('nice', args, { env: { ...process.env, DISPLAY: `:${display}` }, stdio: 'ignore', detached: true });
  let browser;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); break; } catch {}
  }
  if (!browser) throw new Error('chrome did not open CDP');
  const ctx = browser.contexts()[0];
  let page = ctx.pages()[0];
  for (let i = 0; !page && i < 20; i++) { await sleep(200); page = ctx.pages()[0]; }
  await ctx.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (AD_HOSTS.some((h) => host.includes(h))) return route.abort();
    return route.continue();
  });
  // A click that opens a new tab would leave the game: close any new page.
  ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return {
    browser, page, proc,
    stop: async () => {
      try { await browser.close(); } catch {}
      try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
      await sleep(800);
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

// Screen recorder for the run video (x11grab of the whole private display).
export function startRecorder(display, outFile, fps = 8) {
  const proc = spawn('nice', ['-n', '10', 'ffmpeg', '-loglevel', 'error', '-y',
    '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${SCREEN.width}x${SCREEN.height}`,
    '-i', `:${display}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', outFile],
  { stdio: ['pipe', 'ignore', 'ignore'] });
  return {
    stop: () => new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 8000);
      proc.on('exit', () => { clearTimeout(t); resolve(); });
      try { proc.stdin.write('q'); proc.stdin.end(); } catch { proc.kill('SIGINT'); }
    }),
  };
}

// Add a silent AAC track (Telegram shows silent-less mp4s as GIFs) and
// optionally speed the clip up.
export async function finalizeVideo(rawFile, outFile, { speed = 1 } = {}) {
  const vf = speed !== 1 ? ['-filter:v', `setpts=PTS/${speed}`] : [];
  await pexec('timeout', ['300', 'ffmpeg', '-loglevel', 'error', '-y', '-i', rawFile,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    ...vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', outFile]);
}
