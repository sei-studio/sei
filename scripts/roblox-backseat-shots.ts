/**
 * Screenshots of the Roblox backseat tile flow (260929), for review.
 *
 *   npx tsx scripts/roblox-backseat-shots.ts [--url http://127.0.0.1:5173] [--out dir]
 *
 * Needs the renderer dev server running (the `?dashshot=roblox` harness,
 * components/backseat/DevRobloxShot.tsx) and a Chrome for playwright-core.
 * The pick step's lookups go through the REAL main-side Roblox client
 * (src/main/backseat/games/robloxClient.ts, with Node's fetch), exposed to
 * the page, so the screenshots show live Roblox data. Roblox search allows
 * about one request a minute per address, so the search shot may show the
 * popular-pool fallback note; that is the shipped behavior.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRobloxClient } from '../src/main/backseat/games/robloxClient';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:5173');
const OUT = arg('out', path.resolve('roblox-backseat-shots'));
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const client = createRobloxClient({ fetch: globalThis.fetch.bind(globalThis) });

async function open(page: Page, part: string, lang?: string): Promise<void> {
  const q = new URLSearchParams({ dashshot: 'roblox', part, ...(lang ? { lang } : {}) });
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'networkidle' });
}

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('wrote', file);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.DISPLAY });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: 'dark' });
  await ctx.exposeFunction('__seiDevRobloxResolve', (input: string) => client.resolve(input));
  await ctx.exposeFunction('__seiDevRobloxPopular', () => client.popular());
  await ctx.exposeFunction('__seiDevRobloxDetails', (id: number) => client.details(id));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));

  // 1. The games picker, and the Roblox tile's info popup.
  await open(page, 'picker');
  const tile = page.getByRole('button', { name: 'Roblox (Backseat)' });
  await tile.waitFor();
  await page.waitForTimeout(400);
  await shot(page, '1-picker');
  await page.getByLabel('About Roblox (Backseat)').hover();
  await page.waitForTimeout(700);
  await shot(page, '1b-picker-info');

  // 2. First click: the one-time intro, reached by clicking the real tile.
  await open(page, 'intro');
  await page.getByText('Roblox is available via Backseat').waitFor();
  await page.waitForTimeout(300);
  await shot(page, '2-intro');

  // 3. Continue -> the pick step with the live popular list.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Popular right now').waitFor();
  await page.locator('button:has(img)').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot(page, '3-pick-popular');

  // 4. A pasted link resolves to one game with its details.
  const box = page.getByRole('textbox');
  await box.fill('https://www.roblox.com/games/4924922222/Brookhaven-RP');
  await box.press('Enter');
  await page.getByText('Brookhaven 🏡RP').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot(page, '4-pick-link');

  // 5. A name search (live, or the popular-pool fallback when rate limited).
  await page.getByRole('button', { name: 'Change' }).click();
  await box.fill('blox fruits');
  await box.press('Enter');
  await page.getByText('Results').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot(page, '5-pick-search');

  // 6. The share picker with the Roblox window preselected.
  await open(page, 'share');
  await page.getByText('Roblox', { exact: true }).first().waitFor();
  await page.waitForTimeout(500);
  await shot(page, '6-share-preselected');

  // 7. zh copy.
  await open(page, 'picker', 'zh');
  await page.waitForTimeout(600);
  await shot(page, '7-zh-picker');
  await open(page, 'intro', 'zh');
  await page.waitForTimeout(600);
  await shot(page, '8-zh-intro');
  await page.getByRole('button', { name: '继续' }).click();
  await page.waitForTimeout(2500);
  await shot(page, '9-zh-pick');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
