import { describe, it, expect } from 'vitest';
import {
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
