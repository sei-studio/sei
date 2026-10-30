/**
 * notices.ts (261027): the feed's `popup` field drives the startup popup.
 * Pins the open-once flow (owed until recorded, never again after), take-down,
 * an unreachable feed keeping the last state, and the dev-only feed override.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isPackaged: false,
  version: '0.6.10',
  /** What the next feed GET answers: a JSON value, or 'error' / a status code. */
  feed: undefined as unknown,
  requested: [] as string[],
  state: { version: 1, notices: [], announcedIds: [], readIds: [], popupShownIds: [] as string[] },
  sent: [] as unknown[],
  /** The ChatGPT plan status skipIf 'chatgpt-connected' reads ('throw' = a broken check). */
  chatgpt: { activeId: null as string | null, accounts: [] as unknown[] } as unknown,
}));

vi.mock('./chatgptPlan', () => ({
  chatgptSession: () => ({
    status: async () => {
      if (h.chatgpt === 'throw') throw new Error('vault locked');
      return h.chatgpt;
    },
  }),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    getVersion: () => h.version,
  },
  net: {
    request: ({ url }: { url: string }) => {
      h.requested.push(url);
      const req = new EventEmitter() as EventEmitter & { end: () => void; abort: () => void };
      req.abort = () => undefined;
      req.end = () => {
        queueMicrotask(() => {
          if (h.feed === 'error') {
            req.emit('error', new Error('offline'));
            return;
          }
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = typeof h.feed === 'number' ? h.feed : 200;
          req.emit('response', res);
          // A string is sent as the raw body (to test unparseable feeds).
          const body = typeof h.feed === 'string' ? h.feed : JSON.stringify(h.feed);
          if (typeof h.feed !== 'number') res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

vi.mock('./noticesStore', () => ({
  loadNoticesState: async () => structuredClone(h.state),
  saveNoticesState: async (next: typeof h.state) => {
    h.state = structuredClone(next);
  },
}));

type NoticesModule = typeof import('./notices');

/** A fresh module = a fresh app launch (the feed popup is held in memory). */
async function launch(): Promise<NoticesModule> {
  vi.resetModules();
  const mod = await import('./notices');
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: unknown) => h.sent.push(payload) },
  };
  mod.initNotices({ getMainWindow: () => win as never });
  return mod;
}

const POPUP = { id: '261101-halloween', url: 'https://sei.gg/popup/261101-halloween' };
const OLD_NOTICES = [{ id: 'n1', title: 'T', date: '2026-07-25', body: 'hi' }];

beforeEach(() => {
  h.isPackaged = false;
  h.version = '0.6.10';
  h.feed = { notices: OLD_NOTICES };
  h.requested = [];
  h.sent = [];
  h.state = { version: 1, notices: [], announcedIds: [], readIds: [], popupShownIds: [] };
  h.chatgpt = { activeId: null, accounts: [] };
  delete process.env.SEI_NOTICES_URL;
});

afterEach(() => {
  delete process.env.SEI_NOTICES_URL;
});

describe('feedPopupField', () => {
  it('reads `popup` off an object feed only', async () => {
    const { feedPopupField } = await launch();
    expect(feedPopupField({ notices: [], popup: POPUP })).toEqual(POPUP);
    expect(feedPopupField({ notices: [] })).toBeUndefined();
    expect(feedPopupField([POPUP])).toBeUndefined();
    expect(feedPopupField(null)).toBeUndefined();
  });
});

describe('startup popup feed', () => {
  it('owes nothing when the feed has no popup', async () => {
    const m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('pushes a new popup, then shows it once per install', async () => {
    h.feed = { notices: OLD_NOTICES, popup: POPUP };
    let m = await launch();
    await m.refreshNotices('startup');
    expect(h.sent).toEqual([POPUP]);
    expect(await m.getStartupPopup()).toEqual(POPUP);

    // The same id on a later refresh is not pushed again.
    await m.refreshNotices('focus');
    expect(h.sent).toHaveLength(1);

    await m.markStartupPopupShown(POPUP.id);
    expect(h.state.popupShownIds).toEqual([POPUP.id]);
    expect(await m.getStartupPopup()).toBeNull();

    // Next launch: the feed still has it, the install already showed it.
    h.sent = [];
    m = await launch();
    await m.refreshNotices('startup');
    expect(h.sent).toEqual([null]);
    expect(await m.getStartupPopup()).toBeNull();
  });

  it('a popup that never loaded is still owed next launch', async () => {
    h.feed = { popup: POPUP };
    let m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toEqual(POPUP);
    m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toEqual(POPUP);
  });

  it('recording is idempotent', async () => {
    const m = await launch();
    await m.markStartupPopupShown('a');
    await m.markStartupPopupShown('a');
    expect(h.state.popupShownIds).toEqual(['a']);
  });

  it('a new id after a shown one is owed', async () => {
    h.state.popupShownIds = [POPUP.id];
    h.feed = { popup: { id: 'next', url: 'https://sei.gg/popup/next' } };
    const m = await launch();
    await m.refreshNotices('startup');
    expect((await m.getStartupPopup())?.id).toBe('next');
  });

  it('taking the popup down pushes null', async () => {
    h.feed = { popup: POPUP };
    const m = await launch();
    await m.refreshNotices('startup');
    h.feed = { notices: OLD_NOTICES };
    await m.refreshNotices('focus');
    expect(h.sent).toEqual([POPUP, null]);
    expect(await m.getStartupPopup()).toBeNull();
  });

  it('an unreachable or broken feed keeps the last state', async () => {
    h.feed = { popup: POPUP };
    const m = await launch();
    await m.refreshNotices('startup');
    for (const bad of ['error', 404, 'not json at all', '"a json string"', '42']) {
      h.feed = bad;
      await m.refreshNotices('focus');
    }
    expect(h.sent).toEqual([POPUP]);
    expect(await m.getStartupPopup()).toEqual(POPUP);
  });

  it('ignores popups outside this version range or off the allow-list', async () => {
    h.feed = { popup: { ...POPUP, minVersion: '0.7.0' } };
    let m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toBeNull();

    h.feed = { popup: { ...POPUP, url: 'https://example.com/popup/x' } };
    m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toBeNull();
  });
});

describe('skipIf chatgpt-connected', () => {
  const SKIP = { ...POPUP, skipIf: 'chatgpt-connected' };
  const account = (signedIn: boolean, planEnabled: boolean) => ({
    activeId: 'a1',
    accounts: [{ id: 'a1', signedIn, planEnabled }],
  });

  it('is owed to an install with no ChatGPT plan connected', async () => {
    h.feed = { popup: SKIP };
    const m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toEqual(SKIP);
    h.chatgpt = account(true, false);
    expect(await m.getStartupPopup()).toEqual(SKIP);
    h.chatgpt = account(false, true);
    expect(await m.getStartupPopup()).toEqual(SKIP);
  });

  it('is not owed (and not pushed) while the plan is connected, and not recorded', async () => {
    h.chatgpt = account(true, true);
    h.feed = { popup: SKIP };
    const m = await launch();
    await m.refreshNotices('startup');
    expect(h.sent).toEqual([null]);
    expect(await m.getStartupPopup()).toBeNull();
    expect(h.state.popupShownIds).toEqual([]);
    // Disconnecting later makes it owed again.
    h.chatgpt = { activeId: null, accounts: [] };
    expect(await m.getStartupPopup()).toEqual(SKIP);
  });

  it('a check that throws shows the popup', async () => {
    h.chatgpt = 'throw';
    h.feed = { popup: SKIP };
    const m = await launch();
    await m.refreshNotices('startup');
    expect(await m.getStartupPopup()).toEqual(SKIP);
  });
});

describe('dev feed override', () => {
  const DEV_FEED = 'http://127.0.0.1:8765/notices.json';

  it('is honoured in dev, with its origin allowed for popup pages', async () => {
    process.env.SEI_NOTICES_URL = DEV_FEED;
    h.feed = { popup: { id: 'dev', url: 'http://127.0.0.1:8765/popup/dev' } };
    const m = await launch();
    await m.refreshNotices('startup');
    expect(h.requested).toEqual([DEV_FEED]);
    expect(m.isPopupFrameUrl('http://127.0.0.1:8765/popup/dev')).toBe(true);
    expect((await m.getStartupPopup())?.id).toBe('dev');
  });

  it('is ignored in a packaged build', async () => {
    h.isPackaged = true;
    process.env.SEI_NOTICES_URL = DEV_FEED;
    h.feed = { popup: { id: 'dev', url: 'http://127.0.0.1:8765/popup/dev' } };
    const m = await launch();
    await m.refreshNotices('startup');
    expect(h.requested).toEqual(['https://sei.gg/notices.json']);
    expect(m.isPopupFrameUrl('http://127.0.0.1:8765/popup/dev')).toBe(false);
    expect(await m.getStartupPopup()).toBeNull();
  });
});
