/**
 * 261123: the boot splash's mark fades in on the launch clock, in the static
 * copy (index.html inline script) and in BootSplash alike.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BOOT_MARK_AT_MS, BOOT_MARK_FADE_MS, bootMarkDelayMs } from './bootMark';
import { BOOT_THEME_KEY } from './theme';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');

/** Runs index.html's inline boot script with a fake page; returns the CSS delay it set, if any. */
function runInlineScript(opts: {
  startedAt?: unknown;
  now: number;
  search?: string;
  bootTheme?: string | null;
  systemDark?: boolean;
}): {
  delay: string | undefined;
  noBoot: boolean;
  theme?: string;
  scheme?: string;
} {
  const m = html.match(/<script>\s*(\/\/ 261123 boot splash[\s\S]*?)<\/script>/);
  if (!m) throw new Error('inline boot script not found');
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      classList: { add: (c: string) => classes.add(c) },
      style: { setProperty: (k: string, v: string) => props.set(k, v) },
    },
  };
  const window = {
    sei: opts.startedAt === undefined ? undefined : { launchStartedAt: opts.startedAt },
    matchMedia: () => ({ matches: opts.systemDark === true }),
  };
  const location = { search: opts.search ?? '' };
  const DateFake = { now: () => opts.now };
  const localStorage = { getItem: (k: string) => (k === BOOT_THEME_KEY ? (opts.bootTheme ?? null) : null) };
  new Function('window', 'document', 'location', 'Date', 'localStorage', m[1])(
    window,
    document,
    location,
    DateFake,
    localStorage,
  );
  const out: ReturnType<typeof runInlineScript> = {
    delay: props.get('--sei-boot-mark-delay'),
    noBoot: classes.has('sei-no-boot'),
  };
  if (attrs.has('data-theme')) out.theme = attrs.get('data-theme');
  if (attrs.has('data-scheme')) out.scheme = attrs.get('data-scheme');
  return out;
}

describe('bootMarkDelayMs', () => {
  it('waits the rest of the 1.2 s when the window is up early', () => {
    expect(bootMarkDelayMs(10_000, 10_300)).toBe(BOOT_MARK_AT_MS - 300);
  });
  it('shows the mark at once on a slow launch', () => {
    expect(bootMarkDelayMs(10_000, 14_000)).toBe(-BOOT_MARK_FADE_MS);
  });
  it('picks a fade under way up where it is', () => {
    expect(bootMarkDelayMs(10_000, 11_500)).toBe(-300);
  });
  it('falls back to the plain delay without a usable launch time', () => {
    expect(bootMarkDelayMs(undefined, 5)).toBe(BOOT_MARK_AT_MS);
    expect(bootMarkDelayMs('x', 5)).toBe(BOOT_MARK_AT_MS);
    expect(bootMarkDelayMs(10_000, 9_000)).toBe(BOOT_MARK_AT_MS);
    expect(bootMarkDelayMs(0, 60 * 60_000)).toBe(BOOT_MARK_AT_MS);
  });
});

describe('index.html static boot splash', () => {
  it('runs the same rule as bootMarkDelayMs', () => {
    for (const elapsed of [0, 150, 1199, 1200, 1700, 5000, 599_000]) {
      const { delay } = runInlineScript({ startedAt: 1_000_000, now: 1_000_000 + elapsed });
      expect(delay).toBe(`${bootMarkDelayMs(1_000_000, 1_000_000 + elapsed)}ms`);
    }
  });
  it('leaves the CSS default without a launch time', () => {
    expect(runInlineScript({ now: 5 }).delay).toBeUndefined();
    expect(runInlineScript({ startedAt: 10, now: 700_000 }).delay).toBeUndefined();
  });
  it('is hidden in the overlay and preview windows (they load with a query)', () => {
    expect(runInlineScript({ startedAt: 1, now: 2, search: '?overlay=1' })).toEqual({ delay: undefined, noBoot: true });
  });
  it("paints in the user's last theme, not the dark default", () => {
    expect(runInlineScript({ now: 5, bootTheme: 'ice' })).toMatchObject({ theme: 'ice', scheme: 'light' });
    expect(runInlineScript({ now: 5, bootTheme: 'midnight' })).toMatchObject({ theme: 'midnight', scheme: 'dark' });
    expect(runInlineScript({ now: 5, bootTheme: 'system', systemDark: false })).toMatchObject({ theme: 'ice' });
    expect(runInlineScript({ now: 5, bootTheme: 'system', systemDark: true })).toMatchObject({ theme: 'midnight' });
    expect(runInlineScript({ now: 5, bootTheme: 'junk' }).theme).toBeUndefined();
    expect(runInlineScript({ now: 5 }).theme).toBeUndefined();
    expect(runInlineScript({ now: 5, bootTheme: 'ice', search: '?overlay=1' }).theme).toBeUndefined();
  });
  it('paints the mark with an img (a non-empty first paint) inside #root', () => {
    expect(html).toMatch(/<div id="root"><div class="sei-boot"[^>]*><img class="sei-boot-mark" src="\/img\/sei-text.png"/);
    expect(html).toContain('var(--sei-boot-mark-delay, 1200ms)');
  });
});
