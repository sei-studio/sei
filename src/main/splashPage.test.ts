/**
 * product call (261108): no startup splash on a normal launch; the Windows
 * update splash keeps its status line, now readable on a light desktop.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLOW_RGB,
  GLOW_STATUS_FONT_PX,
  GLOW_WIDE_RGB,
  SEI_LIGHT_BLUE_RGB,
  SPLASH_SIZE,
  SPLASH_STATUS_STYLE,
  type SplashStatusStyle,
  launchSplashStatus,
  msSinceProcessStart,
  splashHtml,
} from './splashPage';
import { overlayFrameLooksRight, overlayFrames } from './velopackFastApply';
import { UI_LANGUAGES } from '../shared/uiLanguage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

describe('launchSplashStatus', () => {
  it('a normal launch shows no splash', () => {
    expect(launchSplashStatus(false, () => undefined)).toBeUndefined();
    expect(launchSplashStatus(false, () => '')).toBeUndefined();
  });

  it('the launch right after Update.exe restarted Sei shows the update splash', () => {
    expect(launchSplashStatus(false, () => 'Updating…')).toBe('Updating…');
    expect(launchSplashStatus(false, () => "Couldn't update. Opening Sei…")).toBe("Couldn't update. Opening Sei…");
  });

  it('a login launch shows nothing and leaves the one-shot update note alone', () => {
    const read = vi.fn(() => 'Updating…');
    expect(launchSplashStatus(true, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('index.ts only makes a splash window for an update status', () => {
    const src = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');
    expect(src).toContain('const splashStatus = launchSplashStatus(login, updateSplashStatusForLaunch);');
    expect(src).toContain('splashWindow = splashStatus ? createSplashWindow(splashStatus) : null;');
    expect(src.match(/createSplashWindow\(/g)).toHaveLength(1);
  });
});

describe('splashHtml', () => {
  it('ships the near-black blue glow by default (product call 261108)', () => {
    expect(SPLASH_STATUS_STYLE).toBe('glow');
  });

  it("glow: Sei's near-black blues from the theme tokens, bigger status line, no backdrop", () => {
    const tokens = readFileSync(resolve(ROOT, 'src/renderer/src/styles/tokens.css'), 'utf-8');
    const hex = (name: string): string => {
      const h = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i').exec(tokens)![1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
    };
    expect(GLOW_RGB).toBe(hex('art-ink'));
    // --bg3 is defined per theme; the glow uses the dark theme's value.
    expect(tokens).toMatch(/--bg3:\s*#101a2e/i);
    expect(GLOW_WIDE_RGB).toBe('16,26,46');
    const html = splashHtml('AAAA', { status: 'Updating…', style: 'glow' });
    expect(html).not.toContain('background:rgba(');
    expect(html).toContain(`text-shadow:0 0 1px rgba(${GLOW_RGB},1)`);
    expect(html).toContain(`data-fs="${GLOW_STATUS_FONT_PX}"`);
    expect(GLOW_STATUS_FONT_PX).toBeGreaterThan(13);
  });

  it("uses Sei's light blue from the theme tokens, not a new color", () => {
    const tokens = readFileSync(resolve(ROOT, 'src/renderer/src/styles/tokens.css'), 'utf-8');
    const rail = /--sei-light-blue:\s*#([0-9a-f]{6})/i.exec(tokens)?.[1];
    expect(rail).toBeTruthy();
    const rgb = [0, 2, 4].map((i) => parseInt(rail!.slice(i, i + 2), 16)).join(',');
    expect(SEI_LIGHT_BLUE_RGB).toBe(rgb);
  });

  it('pill: a translucent light blue fill behind the status line, no border', () => {
    const html = splashHtml('AAAA', { status: 'Updating…', style: 'pill' });
    expect(html).toContain(`background:rgba(${SEI_LIGHT_BLUE_RGB},`);
    expect(html).toMatch(/border-radius:\d+px/);
    expect(html).not.toMatch(/border:|border-(width|style|color|top|right|bottom|left):/);
    expect(html).toContain('>Updating…</div>');
  });

  it('shadow: no backdrop, a strong shadow under the line', () => {
    const html = splashHtml('AAAA', { status: 'Updating…', style: 'shadow' });
    expect(html).not.toContain('background:rgba(');
    expect(html).toContain('text-shadow:0 0 2px rgba(0,0,0,.95)');
  });

  it('escapes the status line and keeps the page backdrop transparent', () => {
    const html = splashHtml('AAAA', { status: '<b>"x"</b>' });
    expect(html).not.toContain('<b>');
    expect(html).toContain('background:transparent');
  });

  it('has no fade (the update screen must match the overlay frame exactly)', () => {
    const html = splashHtml('AAAA', { status: 'Updating…' });
    expect(html).not.toContain('opacity');
    expect(html).not.toContain('transition');
  });
});

describe('msSinceProcessStart', () => {
  it('measures from the process creation time when known', () => {
    expect(msSinceProcessStart(10_000, 8_500, 99)).toBe(1500);
  });
  it('falls back to process.uptime()', () => {
    expect(msSinceProcessStart(10_000, undefined, 1.2345)).toBe(1235);
    expect(msSinceProcessStart(10_000, 0, 2)).toBe(2000);
    expect(msSinceProcessStart(10_000, 20_000, 2)).toBe(2000);
  });
});

/**
 * The overlay frames Update.exe shows are this page rendered offscreen
 * (windowChrome.renderSplashFrames), and a frame that fails
 * overlayFrameLooksRight is dropped. Render the real page in Chrome, every
 * UI language's widest frames, and check each one passes and nothing is
 * clipped. Runs where Chrome is installed (CI's ubuntu image, dev machines).
 */
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) =>
  existsSync(p),
);

describe.skipIf(!CHROME)('update overlay frames, rendered in Chrome', () => {
  it('every frame passes overlayFrameLooksRight in every style, nothing clipped', async () => {
    const { chromium } = await import('playwright');
    const logo = readFileSync(resolve(ROOT, 'src/renderer/public/img/sei-text.png')).toString('base64');
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
    });
    const problems: string[] = [];
    try {
      // Decodes a screenshot PNG to RGBA in the browser (no image library in node).
      const decoder = await browser.newPage();
      const pixelsOf = async (png: Buffer): Promise<Uint8Array> => {
        const rgba64 = await decoder.evaluate(async (b64) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let bin = '';
          for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
          return btoa(bin);
        }, png.toString('base64'));
        return new Uint8Array(Buffer.from(rgba64, 'base64'));
      };
      // Per language: "Updating…", the error line and the longest time
      // estimate (the widest lines). The default style at 1x and 2x, the
      // other at 1x.
      const runs: Array<[SplashStatusStyle, number, readonly string[]]> = [
        [SPLASH_STATUS_STYLE, 1, UI_LANGUAGES],
        [SPLASH_STATUS_STYLE, 2, ['en', 'ja', 'ru']],
        ...(['pill', 'shadow', 'glow'] as const)
          .filter((st) => st !== SPLASH_STATUS_STYLE)
          .map((st): [SplashStatusStyle, number, readonly string[]] => [st, 1, UI_LANGUAGES]),
      ];
      const widest = (lang: (typeof UI_LANGUAGES)[number]): Array<[string, string]> => {
        const { updating, error, ...eta } = overlayFrames(lang);
        const longest = Object.entries(eta).sort((a, b) => b[1].length - a[1].length)[0];
        return [['updating', updating], ['error', error], longest];
      };
      for (const [style, scale, langs] of runs) {
        const ctx = await browser.newContext({
          viewport: { ...SPLASH_SIZE },
          deviceScaleFactor: scale,
        });
        const page = await ctx.newPage();
        for (const lang of langs as Array<(typeof UI_LANGUAGES)[number]>) {
          for (const [name, status] of widest(lang)) {
            await page.setContent(splashHtml(logo, { status, style }));
            await page.evaluate(() => Promise.all([document.fonts.ready, document.querySelector('img')!.decode()]));
            const clipped = await page.evaluate(() => {
              const s = document.getElementById('status')!;
              const r = s.getBoundingClientRect();
              return s.scrollWidth > s.clientWidth + 1 || r.left < 0 || r.right > innerWidth || r.bottom > innerHeight;
            });
            const ok = overlayFrameLooksRight(await pixelsOf(await page.screenshot({ omitBackground: true })));
            if (!ok || clipped) problems.push(`${style} ${scale}x ${lang} ${name}: ok=${ok} clipped=${clipped}`);
          }
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
