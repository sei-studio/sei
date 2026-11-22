/**
 * Home "up next" strip renders for the plans in scripts/next-step-examples.ts
 * results (261014), through the `?dashshot=home&name=&text=&surface=` harness.
 *
 *   npx tsx scripts/next-step-examples-strips.ts --results <out>/results.json --ids S1,S4,S6,S8,S9 [--url http://127.0.0.1:5173] [--out dir] [--width 1200] [--scheme dark|light] [--prefix name]
 *
 * Needs the renderer dev server running and a Chrome for playwright. Writes
 * one full Home shot, one strip crop and one strip-plus-wall crop per
 * example, plus strips-stacked.png when ImageMagick `convert` is on PATH.
 * The player line is checked the way main checks it before storing it
 * (acceptPlayerLine, with the example's companion and 'Alex' as the player).
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planDisplayText } from '../src/main/homeNextStep';
import { acceptPlayerLine } from '../src/bot/brain/nextStep.js';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:5173');
const RESULTS = arg('results', '');
const OUT = arg('out', path.dirname(RESULTS));
const IDS = arg('ids', '').split(',').filter(Boolean);
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const WIDTH = Number(arg('width', '1200')) || 1200;
const SCHEME = arg('scheme', 'dark') === 'light' ? 'light' : 'dark';
const PREFIX = arg('prefix', '');
const SUFFIX = (WIDTH === 1200 ? '' : `-w${WIDTH}`) + (SCHEME === 'dark' ? '' : `-${SCHEME}`);

async function main(): Promise<void> {
  const data = JSON.parse(readFileSync(RESULTS, 'utf8')) as {
    results: Array<{ id: string; name: string; surface: 'game' | 'call'; plan: string | null; line?: string | null }>;
  };
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 760 }, colorScheme: SCHEME, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  const crops: string[] = [];
  for (const id of IDS) {
    const r = data.results.find((x) => x.id === id);
    if (!r?.plan) {
      console.log(`${id}: no plan, skipped`);
      continue;
    }
    // The card text the app shows (homeNextStep.ts pickNextStep): the line
    // written to the player when there is one, else the note.
    const line = acceptPlayerLine(r.line ?? null, { character: r.name, players: ['Alex'] });
    if (r.line && !line) console.log(`${id}: player line rejected, showing the note: ${JSON.stringify(r.line)}`);
    const text = line || planDisplayText(r.plan);
    const q = new URLSearchParams({ dashshot: 'home', name: r.name, text, surface: r.surface });
    await page.goto(`${BASE}/?${q}`, { waitUntil: 'networkidle' });
    const strip = page.locator('[data-home-next-step]');
    await strip.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(700); // fade-up animation
    const full = path.join(OUT, `${PREFIX}home-${id}-${r.name.toLowerCase()}${SUFFIX}.png`);
    await page.screenshot({ path: full });
    const crop = path.join(OUT, `${PREFIX}strip-${id}-${r.name.toLowerCase()}${SUFFIX}.png`);
    await strip.screenshot({ path: crop });
    // The strip with the top of the party wall under it, for type next to the tiles.
    const box = await strip.boundingBox();
    if (box) {
      await page.screenshot({
        path: path.join(OUT, `${PREFIX}wall-${id}-${r.name.toLowerCase()}${SUFFIX}.png`),
        clip: { x: 0, y: Math.max(0, box.y - 8), width: WIDTH, height: Math.min(760 - box.y, box.height + 330) },
      });
    }
    const clamped = await strip.locator('span').nth(1).evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    console.log(`${id} ${r.name}: ${full}${clamped ? ' (TEXT CLAMPED)' : ''}`);
    crops.push(crop);
  }
  await browser.close();
  if (crops.length) {
    const stacked = path.join(OUT, `${PREFIX}strips-stacked${SUFFIX}.png`);
    try {
      execFileSync('convert', [...crops, '-background', '#000000', '-splice', '0x8', '-append', '-chop', '0x8', stacked]);
      console.log('wrote', stacked);
    } catch (e) {
      console.error('convert failed:', (e as Error).message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});




