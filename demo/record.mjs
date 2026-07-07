// demo/record.mjs — controlled, high-res UI demo recorder for Sei.
//
// Pipeline:
//   1. Serve the React renderer standalone via Vite's Node API (no Electron).
//   2. Launch Chromium at deviceScaleFactor 2 with a mocked window.sei bridge
//      (demo/inject.js) so every screen state is scripted.
//   3. Drive a SYNTHETIC, eased cursor between elements in REAL TIME. Real
//      Playwright mouse input fires under it (so genuine :hover / click /
//      drag-rotate happen), while a DOM cursor overlay is what the camera sees.
//   4. Capture via the CDP screencast (Page.startScreencast) so the app's OWN
//      CSS transitions/animations (page slides, hover lifts, summon glints,
//      skinview3d spin) are recorded faithfully at 2x device resolution.
//   5. Encode frames -> demo/out/sei-demo.mp4 with ffmpeg, using each frame's
//      real swap timestamp so playback runs at true real-time speed.
//
// Flow (Party redesign):
//   1 party wall  2 settle on Sui (panel lift + Play reveal)  3 open Sui -> the
//   in-app chat  4 send a quick text -> Sui replies  5 tap Voice call -> the
//   "Set up voice calls" gate  6 Install -> the call connects  7 invite Marv ->
//   a group call  8 hang up -> back to chat
//
// Usage:  node demo/record.mjs

import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Knobs ───────────────────────────────────────────────────────────────────
const OUT_FPS = Number(process.env.FPS) || 60; // output (encode) frame rate
const VIEW = { width: 1180, height: 760 }; // the app's intended window size
const SCALE = 2; // render #root at 2x into a 2x viewport -> crisp 2360x1520 frames
const VP = { width: VIEW.width * SCALE, height: VIEW.height * SCALE };
const PORT = Number(process.env.PORT) || 5199;
const FRAMES_DIR = path.join(__dirname, 'frames');
const OUT = path.join(__dirname, 'out', 'sei-demo.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ── Fixtures from the REAL default characters (Sui / Lyra / Marv) ────────────
async function buildFixtures() {
  // 260707: the default characters are cloud-only (no bundled resources), so the
  // demo reads self-contained fixtures under demo/fixtures instead. Regenerate
  // them from the live cloud rows with demo/fixtures/refresh.sh.
  const dir = path.join(__dirname, 'fixtures/default-characters');
  // marv.json's display name is "Marv".
  const slugs = ['sui', 'lyra', 'marv'];
  const launched = {
    sui: { last: '2026-06-21T19:10:00.000Z', ms: 10_980_000 }, // 3h 3m
    lyra: { last: '2026-06-19T21:40:00.000Z', ms: 3_900_000 }, // 1h 5m
    marv: { last: '2026-06-20T18:30:00.000Z', ms: 5_460_000 }, // 1h 31m
  };
  const chars = [];
  for (const slug of slugs) {
    const c = JSON.parse(await readFile(path.join(dir, `${slug}.json`), 'utf8'));
    chars.push({
      id: c.id,
      name: c.name,
      // Drop the huge expanded prompt — the UI only shows source/description.
      persona: { source: c.persona?.source ?? '', expanded: '' },
      is_default: true,
      shared: false,
      slug: c.slug ?? slug,
      metadata: c.metadata ?? {},
      created: c.created ?? '2026-05-17T00:00:00.000Z',
      last_launched: launched[slug].last,
      playtime_ms: launched[slug].ms,
      portrait_image: c.portrait_image ?? null, // './img/<slug>.png' (Vite-served)
      skin: { source: 'bundled', mojang_username: null, png_sha256: slug, applied_at: null },
      username: c.username ?? c.name,
      owner: null,
      description: c.description ?? null,
    });
  }
  return chars;
}

// The three bundled defaults, so the party wall shows Sui / Lyra / Marv.
const DEFAULT_IDS = [
  'bbf5b66f-2f0f-4918-a953-a2cf66d5a586', // Sui
  'e4511df2-fd20-470b-9131-f8f9968e1c01', // Lyra
  '25770cd6-a50b-409d-a7e2-6cc2026dd673', // Marv (marv)
];

const config = {
  mc_username: 'Shawn',
  preferred_name: 'Shawn',
  provider: 'anthropic',
  provider_config: {},
  theme_mode: 'dark',
  linuxBasicTextWarnDismissed: false,
  ai_backend_kind: 'local',
  dev_console_visible: false,
  skin_setup_pending: false,
  removed_default_ids: [],
  added_world_ids: [],
  // Party redesign (260706): defaults are hidden from Home unless invited into a
  // slot (added_default_ids). Seed all three so the wall shows Sui / Lyra / Marv
  // + one empty "Awaken" slot.
  added_default_ids: DEFAULT_IDS,
  added_defaults_backfilled: true,
  feedback_reward_claimed: false,
  has_been_welcomed: true, // skip the welcome toast so the wall reads clean
  vision_mode: 'on-demand',
  realistic_typing: false, // snappy reply for the demo (no reading/typing pauses)
  total_playtime_ms: 20_340_000,
  total_playtime_backfilled: true,
};

// Demo-only substitution for the two voice modules that can't run headless:
// modelPrefetch (real 40 MB Whisper download) and dictation (real mic + worker).
// Swapping them for the stubs in demo/stubs lets the scripted call flow go live
// without a network download or a microphone. Production code is untouched.
const voiceStubPlugin = {
  name: 'demo-voice-stubs',
  enforce: 'pre',
  resolveId(source) {
    if (source.endsWith('voice/modelPrefetch')) return path.join(__dirname, 'stubs/modelPrefetch.js');
    if (source.endsWith('voice/dictation')) return path.join(__dirname, 'stubs/dictation.js');
    return null;
  },
};

async function main() {
  // 1 ── Vite dev server for the renderer ────────────────────────────────────
  const vite = await createViteServer({
    configFile: false,
    root: path.join(ROOT, 'src/renderer'),
    base: '/',
    resolve: {
      alias: {
        '@': path.join(ROOT, 'src/renderer/src'),
        '@shared': path.join(ROOT, 'src/shared'),
      },
    },
    plugins: [voiceStubPlugin, react()],
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
    define: {
      'import.meta.env.SUPABASE_URL': '""',
      'import.meta.env.SUPABASE_ANON_KEY': '""',
      'process.env.SEI_PROXY_URL': '""',
    },
  });
  await vite.listen();
  const url = `http://localhost:${PORT}/`;
  console.log(`[demo] renderer serving at ${url}`);

  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  // 2 ── Browser ─────────────────────────────────────────────────────────────
  const injectSrc = await readFile(path.join(__dirname, 'inject.js'), 'utf8');
  const fixtures = await buildFixtures();
  // Bundled skins by character name (the Skin-tab preview requests
  // /skins/<username>.png; username == name for the defaults).
  const skinBytesBySlug = {
    sui: await readFile(path.join(__dirname, 'fixtures/skins/sui.png')),
    lyra: await readFile(path.join(__dirname, 'fixtures/skins/lyra.png')),
    marv: await readFile(path.join(__dirname, 'fixtures/skins/marv.png')),
  };
  // Portraits (portrait_image = './img/<slug>.png') used to be Vite-served from
  // public/img; those bundled files were removed with the cloud-only defaults,
  // so serve the fixture portraits over a route instead (see context.route below).
  const portraitBySlug = {
    sui: await readFile(path.join(__dirname, 'fixtures/portraits/sui.png')),
    lyra: await readFile(path.join(__dirname, 'fixtures/portraits/lyra.png')),
    marv: await readFile(path.join(__dirname, 'fixtures/portraits/marv.png')),
  };
  const skinByName = {
    sui: skinBytesBySlug.sui,
    lyra: skinBytesBySlug.lyra,
    marv: skinBytesBySlug.marv,
  };

  const browser = await chromium.launch({
    // Hardware GPU under NEW headless: the `headless:false` + `--headless=new`
    // combo stops Playwright forcing old (GPU-less) headless, so SwiftShader's
    // raster cap is lifted — the heavy 2x UI + skinview3d WebGL render fast
    // enough to feed the screencast a smooth ~60fps. (SwiftShader fallback args
    // are kept commented below for machines without a usable GPU.)
    headless: false,
    args: [
      '--headless=new',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--ignore-gpu-blocklist',
      '--use-angle=metal',
      '--enable-gpu',
      // SwiftShader fallback (drop the four GPU lines above and use these):
      // '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ],
  });
  const context = await browser.newContext({
    // CDP screencast captures at the CSS-viewport size (ignores deviceScaleFactor),
    // so we make the viewport 2x and scale #root 2x (below) for crisp output.
    viewport: VP,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });

  // Serve the right bundled skin per request (RegExp so the ?sha=… query still
  // matches; a *.png glob would not).
  await context.route(/\/skins\/[^?]*\.png/, (route) => {
    const p = new URL(route.request().url()).pathname;
    const name = decodeURIComponent(path.basename(p, '.png')).toLowerCase();
    const body = skinByName[name] || skinByName.marv;
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body,
    });
  });

  // Serve the fixture portraits for `./img/<slug>.png` (public/img was removed
  // with the cloud-only defaults). RegExp so any ?v= cache-buster still matches.
  await context.route(/\/img\/(sui|lyra|marv)\.png/, (route) => {
    const p = new URL(route.request().url()).pathname;
    const slug = decodeURIComponent(path.basename(p, '.png')).toLowerCase();
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: portraitBySlug[slug] || portraitBySlug.marv,
    });
  });

  // Inject fixtures first, then the mocked bridge that consumes them.
  await context.addInitScript({
    content: `window.__seiFixtures = ${JSON.stringify(fixtures)}; window.__seiConfig = ${JSON.stringify(config)};`,
  });
  await context.addInitScript({ content: injectSrc });

  const page = await context.newPage();
  const mouse = page.mouse;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Local-mode bootstrap lands on the auth chooser; click "Continue locally →"
  // off-camera to reach Home before recording.
  await page
    .locator('button:has-text("Continue locally")')
    .first()
    .click({ timeout: 15000 })
    .catch(() => {});
  await page.waitForSelector('[aria-label="Open Marv"]', { timeout: 15000 });
  await page.waitForTimeout(700); // fonts + first paint settle

  // 3 ── Scale the app 2x into the 2x viewport + synthetic cursor overlay ─────
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      html, body { margin:0 !important; width:${VP.width}px; height:${VP.height}px; overflow:hidden; background:#0a0c10; }
      /* #root carries the transform, so it becomes the containing block for the
         app's position:fixed modals/toasts — they scale with the UI too. */
      #root { transform: scale(${SCALE}); transform-origin: 0 0; width:${VIEW.width}px; height:${VIEW.height}px; }
      /* Cursor lives OUTSIDE #root (unscaled), sized up to match the 2x UI. */
      #__democursor {
        position: fixed; left: 0; top: 0; z-index: 2147483647;
        width: 52px; height: 52px; margin: -4px 0 0 -4px;
        pointer-events: none; will-change: transform;
        transform: translate(-400px,-400px);
      }
      #__democursor svg { display:block; filter: drop-shadow(0 3px 6px rgba(0,0,0,.55)); }
      #__democursor .arrow { transition: transform .12s ease; transform-origin: 12px 8px; }
      #__democursor .ring {
        position:absolute; left:12px; top:8px; width:18px; height:18px;
        border:3px solid #7FB0FF; border-radius:50%;
        transform: translate(-50%,-50%) scale(0); opacity:0;
        transition: transform .2s ease, opacity .2s ease;
      }
      #__democursor.press .ring { transform: translate(-50%,-50%) scale(3); opacity:.9; }
      #__democursor.press .arrow { transform: scale(.85); }
    `,
  });
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = '__democursor';
    el.innerHTML = `
      <span class="ring"></span>
      <svg class="arrow" width="52" height="52" viewBox="0 0 24 24" fill="none">
        <path d="M5 2.5 L5 19 L9.2 15.2 L12 21 L14.6 19.8 L11.8 14.2 L17.5 14.2 Z"
              fill="#0b0d12" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
    document.body.appendChild(el);
    // In-page cursor engine: animate via requestAnimationFrame at the display's
    // native 60fps. No per-step node round-trips -> genuinely smooth motion that
    // the screencast captures frame-for-frame.
    window.__cur = { x: -400, y: -400 };
    const apply = (x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };
    window.__press = (on) => el.classList.toggle('press', !!on);
    window.__setCur = (x, y) => { window.__cur.x = x; window.__cur.y = y; apply(x, y); };
    window.__tween = (toX, toY, dur, easeName) =>
      new Promise((res) => {
        const fx = window.__cur.x, fy = window.__cur.y;
        const ez = easeName === 'linear'
          ? (t) => t
          : (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const t0 = performance.now();
        const step = (now) => {
          let t = (now - t0) / (dur * 1000);
          if (t > 1) t = 1;
          const e = ez(t);
          const x = fx + (toX - fx) * e, y = fy + (toY - fy) * e;
          window.__cur.x = x; window.__cur.y = y; apply(x, y);
          if (t < 1) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      });
  });

  // 4 ── Start CDP screencast (captures real animations at device resolution) ──
  const cdp = await context.newCDPSession(page);
  const frames = []; // { data: Buffer, t: seconds }
  cdp.on('Page.screencastFrame', async (f) => {
    const t = f.metadata && typeof f.metadata.timestamp === 'number' ? f.metadata.timestamp : Date.now() / 1000;
    frames.push({ data: Buffer.from(f.data, 'base64'), t });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: VP.width,
    maxHeight: VP.height,
    everyNthFrame: 1,
  });

  // ── Cursor helpers (motion runs in-page; node only sets targets) ───────────
  const setCur = async (x, y) => { await page.evaluate(([x, y]) => window.__setCur(x, y), [x, y]); };
  const glide = async (x, y, sec = 0.7) => {
    await page.evaluate(([x, y, s]) => window.__tween(x, y, s, 'ease'), [x, y, sec]);
    await mouse.move(x, y); // land real input so genuine :hover fires at the target
  };
  const press = async (on) => page.evaluate((v) => window.__press(v), on);
  const click = async () => {
    await press(true);
    await sleep(140);
    await mouse.down();
    await mouse.up();
    await sleep(120);
    await press(false);
    await sleep(140);
  };
  const boxOf = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    return b;
  };
  const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

  // ── 1. Party wall — brief establishing beat ────────────────────────────────
  await setCur(VP.width / 2, VP.height + 80);
  await sleep(600); // let the wall's portraits + presence rows settle

  // ── 2. Drift across the wall, settle on Sui (panel lift + Play reveal) ──────
  const suiBox = await boxOf('[aria-label="Open Sui"]');
  const suiC = center(suiBox);
  await glide(suiC.x, suiC.y, 0.85);
  await sleep(550); // hover lift + centred Play button fade in

  // ── 3. Open Sui -> the in-app chat (click LOW; the centre band is Play) ─────
  await glide(suiBox.x + suiBox.width * 0.5, suiBox.y + suiBox.height * 0.9, 0.42);
  await click();
  await page.waitForSelector('text=monologuing about entropy', { timeout: 8000 });
  await sleep(800); // page slide + message rise + presence panel settle

  // ── 4. Send a quick text -> Sui replies ────────────────────────────────────
  const composer = center(await boxOf('[aria-label="Message Sui"]'));
  await glide(composer.x, composer.y, 0.6);
  await click();
  await sleep(150);
  await page.keyboard.type('hop on a call?', { delay: 34 });
  await sleep(250);
  const sendBtn = center(await boxOf('[aria-label="Send"]'));
  await glide(sendBtn.x, sendBtn.y, 0.4);
  await click();
  // user bubble lands, the typing indicator flashes, then Sui's reply rises in
  await page.waitForSelector('text=hoping i manifest', { timeout: 8000 });
  await sleep(900); // read the reply

  // ── 5. Tap Voice call -> it needs setting up first ("Set up voice calls") ───
  const callBtn = center(await boxOf('[aria-label="Voice call"]'));
  await glide(callBtn.x, callBtn.y, 0.7);
  await click();
  await page.waitForSelector('text=Set up voice calls', { timeout: 8000 });
  await sleep(1200); // read the setup copy

  // ── 6. Install the voice module -> the call connects ───────────────────────
  const install = center(await boxOf('button:has-text("Install")'));
  await glide(install.x, install.y, 0.55);
  await click();
  // progress bar fills, the gate closes, the call rings then goes live
  await page.waitForSelector('text=Set up voice calls', { state: 'detached', timeout: 12000 });
  await sleep(2100); // ring -> connected; settle on the live 1:1 call (Sui + you)

  // ── 7. Invite Marv into the call ───────────────────────────────────────────
  const addBtn = center(await boxOf('[aria-label="Add a companion to the call"]'));
  await glide(addBtn.x, addBtn.y, 0.6);
  await click();
  await page.waitForSelector('text=Add to call', { timeout: 8000 });
  await sleep(500);
  const marvRow = center(await boxOf('button:has-text("Marv")'));
  await glide(marvRow.x, marvRow.y, 0.5);
  await click();
  // Marv joins -> a three-up group call (Sui + Marv + you)
  await page.waitForSelector('text=Group call', { timeout: 8000 });
  await sleep(1500); // settle on the group call

  // ── 8. Hang up -> back to chat ─────────────────────────────────────────────
  const hangup = center(await boxOf('[aria-label="Hang up"]'));
  await glide(hangup.x, hangup.y, 0.7);
  await click();
  await sleep(1000);

  // Stop capture + tear down.
  try { await cdp.send('Page.stopScreencast'); } catch {}
  await sleep(150);
  await browser.close();
  await vite.close();

  // 5 ── Encode with real per-frame timing ───────────────────────────────────
  frames.sort((a, b) => a.t - b.t);
  if (!frames.length) throw new Error('no frames captured');
  const t0 = frames[0].t;
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const name = String(i).padStart(6, '0') + '.jpg';
    await writeFile(path.join(FRAMES_DIR, name), frames[i].data);
    const next = i < frames.length - 1 ? frames[i + 1].t : frames[i].t + 0.1;
    const dur = Math.min(5, Math.max(0.001, next - frames[i].t));
    lines.push(`file '${name}'`);
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  // concat demuxer honours the last frame's duration only if the file is repeated.
  lines.push(`file '${String(frames.length - 1).padStart(6, '0')}.jpg'`);
  const listPath = path.join(FRAMES_DIR, 'frames.txt');
  await writeFile(listPath, lines.join('\n'));
  console.log(`[demo] captured ${frames.length} frames over ${(frames[frames.length - 1].t - t0).toFixed(1)}s`);

  await encode(listPath);
  console.log(`[demo] done -> ${OUT}`);
}

function encode(listPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      // Resample the real-timed (VFR) timeline to a clean constant frame rate.
      '-vf', `fps=${OUT_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '17',
      '-preset', 'slow',
      '-movflags', '+faststart',
      OUT,
    ];
    const ff = spawn('ffmpeg', args, { cwd: FRAMES_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', reject);
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

main().catch((err) => {
  console.error('[demo] failed:', err);
  process.exit(1);
});
