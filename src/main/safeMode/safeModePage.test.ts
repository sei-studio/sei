import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SAFE_MODE_CHECK_TIMEOUT_MS,
  SAFE_MODE_COPY,
  SAFE_MODE_CSP,
  renderSafeModeHtml,
  safeModeDataUrl,
  safeModeLang,
  safeModeTheme,
  type SafeModePageOptions,
} from './safeModePage';
import { SAFE_MODE_ACTIONS } from '../../preload/safeMode';

const base: SafeModePageOptions = { lang: 'en', cause: 'repeated', theme: 'system', version: '0.7.0', packaged: true };

describe('safe-mode page copy', () => {
  it('has the same keys in every language', () => {
    expect(Object.keys(SAFE_MODE_COPY.zh).sort()).toEqual(Object.keys(SAFE_MODE_COPY.en).sort());
  });

  it('follows the copy rules: no em dash, no "friend", nothing empty', () => {
    for (const [lang, copy] of Object.entries(SAFE_MODE_COPY)) {
      for (const [key, text] of Object.entries(copy)) {
        expect(text, `${lang}.${key}`).not.toContain('—');
        expect(text.toLowerCase(), `${lang}.${key}`).not.toContain('friend');
        expect(text.trim().length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('says what the brief asks for', () => {
    expect(SAFE_MODE_COPY.en.title).toBe('Sei had trouble starting');
    expect(SAFE_MODE_COPY.en.check).toBe('Check for updates');
    expect(SAFE_MODE_COPY.en.openLogs).toBe('Open logs folder');
    expect(SAFE_MODE_COPY.en.reset).toBe('Reset settings');
    expect(SAFE_MODE_COPY.en.normal).toBe('Try normal start');
  });
});

describe('renderSafeModeHtml', () => {
  it('renders every button, and every button action is one the preload allows', () => {
    const html = renderSafeModeHtml(base);
    for (const id of ['btn-check', 'btn-download', 'btn-install', 'btn-logs', 'btn-reset', 'btn-reset-yes', 'btn-reset-no', 'btn-normal']) {
      expect(html).toContain(`id="${id}"`);
    }
    const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(actions).toEqual([...SAFE_MODE_ACTIONS].sort());
  });

  it('carries the CSP and loads nothing external', () => {
    const html = renderSafeModeHtml(base);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(SAFE_MODE_CSP).toContain("default-src 'none'");
    expect(html).not.toMatch(/\b(src|href)="https?:/);
    expect(html).not.toContain('<link');
  });

  it('writes the chosen language and cause', () => {
    const zh = renderSafeModeHtml({ ...base, lang: 'zh', cause: 'forced' });
    expect(zh).toContain('lang="zh-CN"');
    expect(zh).toContain(SAFE_MODE_COPY.zh.title);
    expect(zh).toContain(SAFE_MODE_COPY.zh.bodyForced);
    expect(renderSafeModeHtml(base)).toContain(SAFE_MODE_COPY.en.bodyRepeated);
  });

  it('pins a theme only when one is known', () => {
    expect(renderSafeModeHtml(base)).toContain('<html lang="en">');
    expect(renderSafeModeHtml({ ...base, theme: 'light' })).toContain('<html lang="en" data-theme="light">');
  });

  it('escapes the version in markup and in the inline script', () => {
    const html = renderSafeModeHtml({ ...base, version: '1.0.0</script><b>' });
    expect(html).not.toContain('1.0.0</script><b>');
    expect(html).toContain('1.0.0&lt;/script&gt;&lt;b&gt;');
    expect(html).toContain('1.0.0\\u003c/script>\\u003cb>');
  });

  it('a data: URL round-trips to the same page', () => {
    const url = safeModeDataUrl(base);
    expect(url.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
    const html = Buffer.from(url.split(',')[1]!, 'base64').toString('utf8');
    expect(html).toBe(renderSafeModeHtml(base));
  });

  it('the inline script parses', () => {
    const html = renderSafeModeHtml(base);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBe(2);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });
});

describe('helpers', () => {
  it('picks zh only for a Chinese locale', () => {
    expect(safeModeLang('zh-CN')).toBe('zh');
    expect(safeModeLang('zh-TW')).toBe('zh');
    expect(safeModeLang('en-US')).toBe('en');
    expect(safeModeLang('')).toBe('en');
    expect(safeModeLang(undefined)).toBe('en');
  });

  it('maps the app theme setting', () => {
    expect(safeModeTheme('midnight')).toBe('dark');
    expect(safeModeTheme('ice')).toBe('light');
    expect(safeModeTheme('acorn')).toBe('light');
    expect(safeModeTheme('mint')).toBe('light');
    expect(safeModeTheme('system')).toBe('system');
    expect(safeModeTheme(42)).toBe('system');
  });
});

/**
 * Run the page script against a stub DOM and a stub window.seiSafeMode (no
 * DOM library in this repo). Timers are vitest's fake ones.
 */
function bootPage(opts: Partial<SafeModePageOptions> = {}) {
  const html = renderSafeModeHtml({ ...base, ...opts });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const els = new Map<string, Record<string, unknown>>();
  const el = (id: string) => {
    let e = els.get(id);
    if (!e) {
      const handlers: Record<string, () => void> = {};
      e = {
        id,
        textContent: '',
        className: '',
        hidden: false,
        disabled: false,
        style: {},
        handlers,
        addEventListener: (type: string, fn: () => void) => { handlers[type] = fn; },
        focus: () => {},
      };
      els.set(id, e);
    }
    return e;
  };
  let push: ((kind: string, p?: unknown) => void) | null = null;
  const actions: string[] = [];
  const win: Record<string, unknown> = {
    seiSafeMode: {
      action: (name: string) => { actions.push(name); return Promise.resolve({ ok: true }); },
      onUpdate: (cb: (kind: string, p?: unknown) => void) => { push = cb; },
      ready: () => {},
    },
  };
  const doc = { getElementById: el };
  for (const src of scripts) new Function('window', 'document', src)(win, doc);
  return {
    status: () => el('upd-status').textContent as string,
    checkDisabled: () => el('btn-check').disabled as boolean,
    click: (id: string) => (el(id).handlers as Record<string, () => void>).click!(),
    push: (kind: string, p?: unknown) => push!(kind, p),
    actions,
  };
}

describe('safe-mode page: a check that never hears back (T280)', () => {
  afterEach(() => vi.useRealTimers());
  const C = SAFE_MODE_COPY.en;

  it('the startup check gives the button back after the timeout, with a plain message', () => {
    vi.useFakeTimers();
    const page = bootPage();
    expect(page.actions).toEqual(['check']);
    expect(page.status()).toBe(C.checking);
    expect(page.checkDisabled()).toBe(true);
    vi.advanceTimersByTime(SAFE_MODE_CHECK_TIMEOUT_MS - 1);
    expect(page.checkDisabled()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.status()).toBe(C.checkTimeout);
    expect(page.checkDisabled()).toBe(false);
    // And it can be tried again.
    page.click('btn-check');
    expect(page.actions).toEqual(['check', 'check']);
    expect(page.status()).toBe(C.checking);
  });

  it('any updater answer cancels the timeout', () => {
    vi.useFakeTimers();
    const page = bootPage();
    page.push('available', { version: '0.7.1' });
    vi.advanceTimersByTime(SAFE_MODE_CHECK_TIMEOUT_MS * 2);
    expect(page.status()).toBe('Sei 0.7.1 is available.');
  });

  it("an updater 'checking' push restarts the wait", () => {
    vi.useFakeTimers();
    const page = bootPage();
    vi.advanceTimersByTime(SAFE_MODE_CHECK_TIMEOUT_MS - 1000);
    page.push('checking');
    vi.advanceTimersByTime(2000);
    expect(page.status()).toBe(C.checking);
    vi.advanceTimersByTime(SAFE_MODE_CHECK_TIMEOUT_MS);
    expect(page.status()).toBe(C.checkTimeout);
  });

  it('dev builds never start a check', () => {
    vi.useFakeTimers();
    const page = bootPage({ packaged: false });
    vi.advanceTimersByTime(SAFE_MODE_CHECK_TIMEOUT_MS * 2);
    expect(page.actions).toEqual([]);
    expect(page.status()).toBe(C.updatesDev);
  });
});
