// demo/shots.mjs — clean, cursor-free 2x screenshots of two app screens for the
// marketing site (Companions grid + a character DETAILS page). Reuses the demo
// renderer setup from record.mjs (standalone Vite + mocked window.sei bridge),
// but takes still screenshots with rounded, transparent window corners instead
// of recording a screencast.
//
// Usage:  node demo/shots.mjs   ->  demo/out/app-home.png, demo/out/app-character.png

import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VIEW = { width: 1180, height: 760 }; // the app's intended window size
const PORT = Number(process.env.PORT) || 5198;
const OUT = path.join(__dirname, 'out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildFixtures() {
  const dir = path.join(ROOT, 'resources/default-characters');
  const slugs = ['sui', 'lyra', 'clawd']; // clawd.json's display name is "Marv"
  const launched = {
    sui: { last: '2026-06-21T19:10:00.000Z', ms: 10_980_000 },
    lyra: { last: '2026-06-19T21:40:00.000Z', ms: 3_900_000 },
    clawd: { last: '2026-06-20T18:30:00.000Z', ms: 5_460_000 },
  };
  const chars = [];
  for (const slug of slugs) {
    const c = JSON.parse(await readFile(path.join(dir, `${slug}.json`), 'utf8'));
    chars.push({
      id: c.id, name: c.name,
      persona: { source: c.persona?.source ?? '', expanded: '' },
      is_default: true, shared: false, slug: c.slug ?? slug, metadata: c.metadata ?? {},
      created: c.created ?? '2026-05-17T00:00:00.000Z',
      last_launched: launched[slug].last, playtime_ms: launched[slug].ms,
      portrait_image: c.portrait_image ?? null,
      skin: { source: 'bundled', mojang_username: null, png_sha256: slug, applied_at: null },
      username: c.username ?? c.name, owner: null, description: c.description ?? null,
    });
  }
  return chars;
}

// The three bundled defaults, so the party wall shows Sui / Lyra / Marv.
const DEFAULT_IDS = [
  'bbf5b66f-2f0f-4918-a953-a2cf66d5a586', // Sui
  'e4511df2-fd20-470b-9131-f8f9968e1c01', // Lyra
  '25770cd6-a50b-409d-a7e2-6cc2026dd673', // Marv (clawd)
];

const config = {
  mc_username: 'Shawn', preferred_name: 'Shawn', provider: 'anthropic', provider_config: {},
  theme_mode: 'dark', linuxBasicTextWarnDismissed: false, ai_backend_kind: 'local',
  dev_console_visible: false, skin_setup_pending: false, removed_default_ids: [], added_world_ids: [],
  // Party redesign (260706): defaults are hidden from Home unless invited into a
  // slot (added_default_ids). Seed all three so the wall shows Sui / Lyra / Marv
  // + one empty "Awaken" slot (MAX_COMPANION_SLOTS = 4).
  added_default_ids: DEFAULT_IDS, added_defaults_backfilled: true, feedback_reward_claimed: false,
  has_been_welcomed: true, // skip the welcome toast for a clean still
  vision_mode: 'on-demand', total_playtime_ms: 20_340_000, total_playtime_backfilled: true,
};

async function main() {
  const vite = await createViteServer({
    configFile: false,
    root: path.join(ROOT, 'src/renderer'),
    base: '/',
    resolve: { alias: { '@': path.join(ROOT, 'src/renderer/src'), '@shared': path.join(ROOT, 'src/shared') } },
    plugins: [react()],
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
  console.log(`[shots] renderer serving at ${url}`);
  await mkdir(OUT, { recursive: true });

  const injectSrc = await readFile(path.join(__dirname, 'inject.js'), 'utf8');
  const fixtures = await buildFixtures();
  const skinByName = {
    sui: await readFile(path.join(ROOT, 'resources/skins/sui.png')),
    lyra: await readFile(path.join(ROOT, 'resources/skins/lyra.png')),
    marv: await readFile(path.join(ROOT, 'resources/skins/clawd.png')),
  };

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
  await context.route(/\/skins\/[^?]*\.png/, (route) => {
    const name = decodeURIComponent(path.basename(new URL(route.request().url()).pathname, '.png')).toLowerCase();
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: skinByName[name] || skinByName.marv });
  });
  await context.addInitScript({ content: `window.__seiFixtures = ${JSON.stringify(fixtures)}; window.__seiConfig = ${JSON.stringify(config)};` });
  await context.addInitScript({ content: injectSrc });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('button:has-text("Continue locally")').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForSelector('[aria-label="Open Marv"]', { timeout: 20000 });
  await page.waitForTimeout(900); // fonts + first paint settle

  // round the window corners + make the page background transparent so the
  // screenshot's corners come out transparent (the app floats on the site).
  await page.addStyleTag({ content: `
    * { caret-color: transparent !important; }
    html, body { background: transparent !important; }
    #root { border-radius: 26px; overflow: hidden; }
  ` });
  await page.waitForTimeout(200);

  // 1 ── Companions grid -> app-home
  await page.mouse.move(300, 6); // park the cursor on the (non-interactive) title bar — no hover states
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'app-home.png'), omitBackground: true });
  console.log('[shots] app-home.png');

  // 2 ── open Sui (click LOW on the panel; the centre band is the Play button) ->
  //       the in-app chat, the primary surface (Party redesign).
  const box = await page.locator('[aria-label="Open Sui"]').first().boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await page.waitForSelector('text=race you there', { timeout: 10000 });
  await page.waitForTimeout(1100); // page-enter slide + message rise settle
  await page.mouse.move(300, 6); // park cursor away so no tooltip/hover shows in the still
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'app-chat.png'), omitBackground: true });
  console.log('[shots] app-chat.png');

  // 3 ── voice calls (260705): the phone icon opens the call view; with no model
  //       cached the consent gate asks before the ~40 MB download.
  try {
    await page.locator('[aria-label="Voice call"]').first().click({ timeout: 5000 });
    await page.waitForSelector('text=Set up voice calls', { timeout: 8000 });
    await page.waitForTimeout(700);
    await page.mouse.move(300, 6);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'app-voice.png'), omitBackground: true });
    console.log('[shots] app-voice.png');
    // dismiss the consent gate -> back to chat
    await page.locator('button:has-text("Not now")').first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
  } catch (e) {
    console.log('[shots] app-voice.png skipped:', e.message.split('\n')[0]);
  }

  // 4 ── open the character profile from the presence panel.
  await page.locator('button:has-text("Profile")').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('text=Bonded', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.mouse.move(300, 6);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'app-character.png'), omitBackground: true });
  console.log('[shots] app-character.png');

  await browser.close();
  await vite.close();
  console.log('[shots] done');
}

main().catch((err) => { console.error('[shots] failed:', err); process.exit(1); });
