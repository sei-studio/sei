/**
 * Startup popup rules (261027): the url allow-list, feed coercion, the
 * show-once filter and the frame load tracker.
 */
import { describe, it, expect } from 'vitest';
import {
  PopupFrameTracker,
  coerceStartupPopup,
  isAllowedPopupUrl,
  popupActionFromUrl,
  popupToShow,
  routeSubframeNavigation,
} from './startupPopup';
import { POPUP_ACTIONS, isPopupAction } from '../shared/popupActions';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ctx = { appVersion: '0.6.10', now: NOW };
const DEV = 'http://127.0.0.1:8765';

describe('isAllowedPopupUrl', () => {
  it('allows https://sei.gg pages under /popup/', () => {
    expect(isAllowedPopupUrl('https://sei.gg/popup/261101-halloween')).toBe(true);
    expect(isAllowedPopupUrl('https://sei.gg/popup/a.html?x=1#top')).toBe(true);
    // The default port normalizes away.
    expect(isAllowedPopupUrl('https://sei.gg:443/popup/a')).toBe(true);
  });

  it('rejects other schemes, hosts, ports and paths', () => {
    expect(isAllowedPopupUrl('http://sei.gg/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://www.sei.gg/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://evil.sei.gg/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg.evil.com/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg:8443/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg/')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg/popup')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg/download')).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg/popup/../download')).toBe(false);
    expect(isAllowedPopupUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedPopupUrl('file:///popup/a')).toBe(false);
    expect(isAllowedPopupUrl('not a url')).toBe(false);
    expect(isAllowedPopupUrl('')).toBe(false);
  });

  it('rejects credentials', () => {
    expect(isAllowedPopupUrl('https://user:pw@sei.gg/popup/a')).toBe(false);
    expect(isAllowedPopupUrl('https://user@sei.gg/popup/a')).toBe(false);
  });

  it('allows a dev origin only when passed, and only under /popup/', () => {
    expect(isAllowedPopupUrl(`${DEV}/popup/a`)).toBe(false);
    expect(isAllowedPopupUrl(`${DEV}/popup/a`, [DEV])).toBe(true);
    expect(isAllowedPopupUrl(`${DEV}/other`, [DEV])).toBe(false);
    expect(isAllowedPopupUrl('http://127.0.0.1:9999/popup/a', [DEV])).toBe(false);
  });
});

describe('popup actions', () => {
  const ACTION = 'https://sei.gg/popup/_action/chatgpt-plan';
  const PAGE = 'https://sei.gg/popup/261101-siwc';

  it('the allow-list is exactly the shipped actions', () => {
    expect([...POPUP_ACTIONS]).toEqual(['chatgpt-plan']);
    expect(isPopupAction('chatgpt-plan')).toBe(true);
    for (const v of ['', 'ChatGPT-plan', 'chatgpt-plan ', 'nope', null, undefined, 7, {}]) {
      expect(isPopupAction(v)).toBe(false);
    }
  });

  it('reads the action name off the url, ignoring query and hash', () => {
    expect(popupActionFromUrl(ACTION)).toBe('chatgpt-plan');
    expect(popupActionFromUrl(`${ACTION}?x=1#y`)).toBe('chatgpt-plan');
    expect(popupActionFromUrl(`${DEV}/popup/_action/chatgpt-plan`, [DEV])).toBe('chatgpt-plan');
  });

  it('an action url with a name off the list is unknown', () => {
    expect(popupActionFromUrl('https://sei.gg/popup/_action/nope')).toBe('unknown');
    expect(popupActionFromUrl('https://sei.gg/popup/_action/')).toBe('unknown');
    expect(popupActionFromUrl(`${ACTION}/more`)).toBe('unknown');
    expect(popupActionFromUrl(`${ACTION}/`)).toBe('unknown');
  });

  it('only sei.gg (or a dev origin in dev) has action urls', () => {
    for (const url of [
      PAGE,
      'https://sei.gg/_action/chatgpt-plan',
      'http://sei.gg/popup/_action/chatgpt-plan',
      'https://sei.gg:8443/popup/_action/chatgpt-plan',
      'https://www.sei.gg/popup/_action/chatgpt-plan',
      'https://user@sei.gg/popup/_action/chatgpt-plan',
      'https://evil.example/popup/_action/chatgpt-plan',
      `${DEV}/popup/_action/chatgpt-plan`,
      'not a url',
    ]) {
      expect(popupActionFromUrl(url)).toBeNull();
    }
  });

  it('an action url is never a page the frame may load', () => {
    expect(isAllowedPopupUrl(ACTION)).toBe(false);
    expect(isAllowedPopupUrl('https://sei.gg/popup/_action/nope')).toBe(false);
    expect(isAllowedPopupUrl(`${DEV}/popup/_action/chatgpt-plan`, [DEV])).toBe(false);
  });

  it('routes a known action only when the navigating frame shows a popup page', () => {
    expect(routeSubframeNavigation(ACTION, PAGE)).toEqual({ kind: 'action', action: 'chatgpt-plan' });
    for (const from of ['', 'about:blank', 'https://example.com/', 'https://sei.gg/', ACTION]) {
      expect(routeSubframeNavigation(ACTION, from)).toEqual({ kind: 'block' });
    }
  });

  it('blocks an unknown action, even from the popup page', () => {
    expect(routeSubframeNavigation('https://sei.gg/popup/_action/nope', PAGE)).toEqual({ kind: 'block' });
  });

  it('routes pages and ordinary links as before', () => {
    expect(routeSubframeNavigation(PAGE, '')).toEqual({ kind: 'allow' });
    expect(routeSubframeNavigation('about:blank', '')).toEqual({ kind: 'allow' });
    expect(routeSubframeNavigation('https://sei.gg/pricing', PAGE)).toEqual({ kind: 'external' });
    expect(routeSubframeNavigation('https://sei.gg/pricing', '')).toEqual({ kind: 'block' });
  });
});

describe('coerceStartupPopup', () => {
  const base = { id: 'p1', url: 'https://sei.gg/popup/p1' };

  it('keeps a minimal well-formed popup', () => {
    expect(coerceStartupPopup(base, ctx)).toEqual(base);
  });

  it('returns null for missing or malformed values', () => {
    expect(coerceStartupPopup(undefined, ctx)).toBeNull();
    expect(coerceStartupPopup(null, ctx)).toBeNull();
    expect(coerceStartupPopup('p1', ctx)).toBeNull();
    expect(coerceStartupPopup([base], ctx)).toBeNull();
    expect(coerceStartupPopup({ url: base.url }, ctx)).toBeNull();
    expect(coerceStartupPopup({ id: '   ', url: base.url }, ctx)).toBeNull();
    expect(coerceStartupPopup({ id: 7, url: base.url }, ctx)).toBeNull();
    expect(coerceStartupPopup({ id: 'x'.repeat(201), url: base.url }, ctx)).toBeNull();
    expect(coerceStartupPopup({ id: 'p1' }, ctx)).toBeNull();
  });

  it('keeps a known skipIf and drops a popup with an unknown one (fail closed)', () => {
    expect(coerceStartupPopup({ ...base, skipIf: 'chatgpt-connected' }, ctx)).toEqual({
      ...base,
      skipIf: 'chatgpt-connected',
    });
    expect(coerceStartupPopup({ ...base, skipIf: 'signed-in' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, skipIf: 7 }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, skipIf: null }, ctx)).toBeNull();
  });

  it('trims the id', () => {
    expect(coerceStartupPopup({ ...base, id: '  p1 ' }, ctx)?.id).toBe('p1');
  });

  it('drops a popup whose url is off the allow-list', () => {
    expect(coerceStartupPopup({ ...base, url: 'https://example.com/popup/p1' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, url: 'https://sei.gg/p1' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, url: `${DEV}/popup/p1` }, ctx)).toBeNull();
    expect(
      coerceStartupPopup({ ...base, url: `${DEV}/popup/p1` }, { ...ctx, devOrigins: [DEV] }),
    ).toEqual({ id: 'p1', url: `${DEV}/popup/p1` });
  });

  it('applies an inclusive version range', () => {
    const at = (appVersion: string, range: object) =>
      coerceStartupPopup({ ...base, ...range }, { ...ctx, appVersion }) !== null;
    expect(at('0.6.10', { minVersion: '0.6.10' })).toBe(true);
    expect(at('0.6.9', { minVersion: '0.6.10' })).toBe(false);
    expect(at('0.6.10', { maxVersion: '0.6.10' })).toBe(true);
    expect(at('0.6.11', { maxVersion: '0.6.10' })).toBe(false);
    expect(at('0.7.0', { minVersion: '0.6.10', maxVersion: '0.7.0' })).toBe(true);
    expect(at('0.6.10', { minVersion: 'v0.6.10' })).toBe(true);
    // A prerelease sorts below its release.
    expect(at('0.7.0-beta.1', { minVersion: '0.7.0' })).toBe(false);
    expect(at('0.7.0-beta.1', { minVersion: '0.6.10' })).toBe(true);
  });

  it('fails closed on a version that does not parse', () => {
    expect(coerceStartupPopup({ ...base, minVersion: 'soon' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, maxVersion: 7 }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, minVersion: '0.6.0' }, { ...ctx, appVersion: '?' })).toBeNull();
    // No range: the app version is not consulted.
    expect(coerceStartupPopup(base, { ...ctx, appVersion: '?' })).not.toBeNull();
  });

  it('hides a popup after `until`, and fails closed on a bad date', () => {
    expect(coerceStartupPopup({ ...base, until: '2026-10-28T00:00:00Z' }, ctx)).not.toBeNull();
    expect(coerceStartupPopup({ ...base, until: '2026-10-27T11:59:59Z' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, until: 'next week' }, ctx)).toBeNull();
    expect(coerceStartupPopup({ ...base, until: 1767225600000 }, ctx)).toBeNull();
  });

  it('keeps a declared size only as an in-bounds pair, rounded', () => {
    expect(coerceStartupPopup({ ...base, width: 960, height: 540 }, ctx)).toEqual({
      ...base,
      width: 960,
      height: 540,
    });
    expect(coerceStartupPopup({ ...base, width: 960.4, height: 539.6 }, ctx)).toMatchObject({
      width: 960,
      height: 540,
    });
    const noSize = (extra: object) => {
      const p = coerceStartupPopup({ ...base, ...extra }, ctx);
      return p !== null && p.width === undefined && p.height === undefined;
    };
    expect(noSize({ width: 960 })).toBe(true);
    expect(noSize({ width: 960, height: '540' })).toBe(true);
    expect(noSize({ width: 50, height: 540 })).toBe(true);
    expect(noSize({ width: 960, height: 9000 })).toBe(true);
    expect(noSize({ width: Number.NaN, height: 540 })).toBe(true);
  });
});

describe('popupToShow', () => {
  const p = { id: 'p1', url: 'https://sei.gg/popup/p1' };

  it('owes a popup until its id is recorded, then never again', () => {
    expect(popupToShow(p, [])).toBe(p);
    expect(popupToShow(p, ['other'])).toBe(p);
    expect(popupToShow(p, ['p1'])).toBeNull();
    expect(popupToShow(null, [])).toBeNull();
  });

  it('a new id is owed even after an older one was shown', () => {
    expect(popupToShow({ ...p, id: 'p2' }, ['p1'])).not.toBeNull();
  });

  it('is not owed while its skipIf condition holds', () => {
    const skip = { ...p, skipIf: 'chatgpt-connected' as const };
    expect(popupToShow(skip, [], () => true)).toBeNull();
    expect(popupToShow(skip, [], () => false)).toBe(skip);
    // No condition named: the check is never consulted.
    expect(popupToShow(p, [], () => true)).toBe(p);
    // Default: nothing holds.
    expect(popupToShow(skip, [])).toBe(skip);
  });
});

describe('PopupFrameTracker', () => {
  const allowed = (url: string) => isAllowedPopupUrl(url);
  const url = 'https://sei.gg/popup/p1';

  it('is ok only after a 2xx commit of an allowed page', () => {
    const t = new PopupFrameTracker(allowed);
    expect(t.loadedOk()).toBe(false);
    t.onStart(url);
    expect(t.loadedOk()).toBe(false);
    t.onCommit(url, 200);
    expect(t.loadedOk()).toBe(true);
  });

  it('a 404, a 500 or a failed load is not ok', () => {
    for (const code of [404, 500, 301, 0]) {
      const t = new PopupFrameTracker(allowed);
      t.onStart(url);
      t.onCommit(url, code);
      expect(t.loadedOk()).toBe(false);
    }
    const t = new PopupFrameTracker(allowed);
    t.onStart(url);
    t.onFail(url);
    expect(t.loadedOk()).toBe(false);
  });

  it('a new load resets an earlier success', () => {
    const t = new PopupFrameTracker(allowed);
    t.onStart(url);
    t.onCommit(url, 200);
    t.onStart('https://sei.gg/popup/p2');
    expect(t.loadedOk()).toBe(false);
  });

  it('ignores frames that are not popup pages', () => {
    const t = new PopupFrameTracker(allowed);
    t.onStart(url);
    t.onCommit(url, 200);
    t.onStart('https://example.com/');
    t.onCommit('https://example.com/', 500);
    t.onFail('about:blank');
    expect(t.loadedOk()).toBe(true);
  });
});
