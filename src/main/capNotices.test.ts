/**
 * capNotices (261120): the credit wall and the own-key spend alert reach the
 * player outside the app window (OS notification when Sei is not in front)
 * and survive a window that opens after them (pending replay until ack).
 */
import { describe, expect, it, vi } from 'vitest';
import { UI_LANGUAGES } from '../shared/uiLanguage';
import {
  CAP_NOTICE_COPY,
  PENDING_HARD_STOP_TTL_MS,
  capNoticeText,
  createCapNotices,
  windowInFront,
  type CapNoticeDeps,
  type NoticeWindow,
} from './capNotices';

function win(over: Partial<Record<keyof NoticeWindow, boolean>> = {}): NoticeWindow {
  const v = { isDestroyed: false, isVisible: true, isMinimized: false, isFocused: true, ...over };
  return {
    isDestroyed: () => v.isDestroyed,
    isVisible: () => v.isVisible,
    isMinimized: () => v.isMinimized,
    isFocused: () => v.isFocused,
  };
}

function harness(opts: { window?: NoticeWindow | null; supported?: boolean; lang?: string } = {}) {
  let t = 1_000_000;
  const shown: Array<{ title: string; body: string; click: () => void }> = [];
  const deps: CapNoticeDeps = {
    now: () => t,
    mainWindow: () => (opts.window === undefined ? win({ isFocused: false }) : opts.window),
    notificationSupported: () => opts.supported ?? true,
    showNotification: (text, onClick) => shown.push({ ...text, click: onClick }),
    requestAttention: vi.fn(),
    revealMainWindow: vi.fn(),
    uiLanguage: async () => opts.lang ?? 'en',
  };
  const n = createCapNotices(deps);
  return { n, deps, shown, advance: (ms: number) => (t += ms) };
}

describe('windowInFront', () => {
  it('only a visible, unminimized, focused window counts', () => {
    expect(windowInFront(win())).toBe(true);
    expect(windowInFront(null)).toBe(false);
    expect(windowInFront(win({ isDestroyed: true }))).toBe(false);
    expect(windowInFront(win({ isVisible: false }))).toBe(false);
    expect(windowInFront(win({ isMinimized: true }))).toBe(false);
    expect(windowInFront(win({ isFocused: false }))).toBe(false);
  });
});

describe('credit wall', () => {
  it('no window at all (macOS after the close button): OS notification, click reveals the window', async () => {
    const h = harness({ window: null });
    expect(await h.n.hardStop({ reason: 'depleted' })).toBe('notified');
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].title).toBe('Usage limit reached');
    expect(h.shown[0].body).toBe("You've used this week's allowance.");
    expect(h.deps.requestAttention).toHaveBeenCalledTimes(1);
    h.shown[0].click();
    expect(h.deps.revealMainWindow).toHaveBeenCalledTimes(1);
  });

  it('Sei behind a game (window not focused) also notifies', async () => {
    const h = harness({ window: win({ isFocused: false }) });
    expect(await h.n.hardStop({ reason: 'depleted' })).toBe('notified');
  });

  it('Sei in front: the modal is enough, no OS notification', async () => {
    const h = harness({ window: win() });
    expect(await h.n.hardStop({ reason: 'depleted' })).toBe('in_front');
    expect(h.shown).toHaveLength(0);
    expect(h.deps.requestAttention).not.toHaveBeenCalled();
  });

  it('a burst of 402s is one notification', async () => {
    const h = harness();
    await h.n.hardStop({ reason: 'depleted' });
    h.advance(30_000);
    expect(await h.n.hardStop({ reason: 'depleted' })).toBe('repeat');
    expect(h.shown).toHaveLength(1);
  });

  it('rate_limited is neither notified nor kept', async () => {
    const h = harness({ window: null });
    expect(await h.n.hardStop({ reason: 'rate_limited', retry_after_seconds: 10 })).toBe('not_kept');
    expect(h.shown).toHaveLength(0);
    expect(h.n.peekHardStop()).toBeNull();
  });

  it('kept for a window that mounts later until acknowledged, and expires', async () => {
    const h = harness({ window: null });
    await h.n.hardStop({ reason: 'depleted' });
    expect(h.n.peekHardStop()).toEqual({ reason: 'depleted' });
    expect(h.n.peekHardStop()).toEqual({ reason: 'depleted' }); // peek, not take
    h.n.ackHardStop();
    expect(h.n.peekHardStop()).toBeNull();
    await h.n.hardStop({ reason: 'depleted' });
    h.advance(PENDING_HARD_STOP_TTL_MS + 1);
    expect(h.n.peekHardStop()).toBeNull();
  });

  it('unsupported notifications still keep the notice and ask for attention', async () => {
    const h = harness({ window: null, supported: false });
    expect(await h.n.hardStop({ reason: 'depleted' })).toBe('unsupported');
    expect(h.deps.requestAttention).toHaveBeenCalled();
    expect(h.n.peekHardStop()).toEqual({ reason: 'depleted' });
  });

  it('a throwing notification never escapes', async () => {
    const h = harness({ window: null });
    h.deps.showNotification = () => {
      throw new Error('boom');
    };
    await expect(h.n.hardStop({ reason: 'depleted' })).resolves.toBe('unsupported');
  });
});

describe('spend alert', () => {
  it('notifies with the amount in the UI language and is kept until ack', async () => {
    const h = harness({ window: null, lang: 'ja' });
    expect(await h.n.spendAlert({ limitUsd: 20, spendMonthUsd: 20.4 })).toBe('notified');
    expect(h.shown[0].title).toBe(CAP_NOTICE_COPY.ja.spendTitle);
    expect(h.shown[0].body).toContain('$20.00');
    expect(h.n.peekSpendAlert()).toEqual({ limitUsd: 20, spendMonthUsd: 20.4 });
    h.n.ackSpendAlert();
    expect(h.n.peekSpendAlert()).toBeNull();
  });

  it('in front: banner only', async () => {
    const h = harness({ window: win() });
    expect(await h.n.spendAlert({ limitUsd: 5, spendMonthUsd: 6 })).toBe('in_front');
    expect(h.n.peekSpendAlert()).not.toBeNull();
  });
});

describe('copy', () => {
  it('every UI language has all four lines, no em dash, and the {amount} slot', () => {
    for (const lang of UI_LANGUAGES) {
      const c = CAP_NOTICE_COPY[lang];
      for (const v of Object.values(c)) {
        expect(v.length).toBeGreaterThan(0);
        expect(v).not.toContain('—');
      }
      expect(c.spendBody).toContain('{amount}');
    }
  });

  it('an unknown language falls back to English', () => {
    expect(capNoticeText('credit_wall', 'xx').title).toBe('Usage limit reached');
  });
});
