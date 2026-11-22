/**
 * Cap notices outside the app window (261120, v0.7.0 release gate).
 *
 * Two notices tell the player about money:
 *   - the credit wall (`credits:hard-stop`, HardStopModal): the Sei plan's
 *     weekly allowance is spent and the proxy answers 402.
 *   - the own-key spend alert (`usage:spend-alert`, SpendAlertBanner): this
 *     month's estimated own-key spend passed the "Alert me at $N a month"
 *     amount (usage/llmUsageLedger.ts).
 *
 * Both used to be one-shot pushes to whatever renderer windows existed, shown
 * only inside the app window. Two ways that left the player with no notice:
 *   1. No main window. macOS keeps Sei running with no window after the red
 *      close button, and Windows does too while her desktop room lives
 *      (keepRunningOnLastWindowClosed); a Minecraft session keeps playing.
 *      The push reached nobody, the spend alert was already marked fired for
 *      the month, and a window opened later started blank.
 *   2. Sei behind a full-screen game. The companion just left the world (the
 *      wall) or kept going (the alert) and nothing on screen said why.
 *
 * So main now keeps the latest notice PENDING until the renderer acknowledges
 * it (the modal's Close / CTA, the banner's click or x), and a window that
 * mounts later reads it back (peek*). And when the main window is not in
 * front (missing, hidden, minimized or not focused) it posts one OS
 * notification (Electron Notification: macOS Notification Center, Windows
 * toast, which needs the AppUserModelID set in boot.ts) plus a Dock bounce
 * (macOS) or taskbar flash (Windows). A click brings the window forward,
 * where the pending notice is waiting.
 *
 * Only `reason: 'depleted'` walls are kept and notified. A `rate_limited`
 * answer is a short time window whose retry clock is computed from the
 * moment it arrives, so replaying it later would show a wrong time, and the
 * window usually clears before anyone could act on a system notification.
 *
 * Pure apart from the deps passed in (no electron import), so it is unit
 * tested directly; index.ts installs the real deps.
 */
import type { CreditsHardStopEvent, SpendAlertPush } from '../shared/ipc';
import { CreditWallDeduper } from './creditWall';
import { formatUsd } from '../shared/llmUsage';
import { normalizeUiLanguage, type UiLanguage } from '../shared/uiLanguage';

/** A pending wall older than this is not replayed (the week may have reset). */
export const PENDING_HARD_STOP_TTL_MS = 12 * 60 * 60_000;
/** Same for the spend alert: it is about this month, a day later is stale enough. */
export const PENDING_SPEND_ALERT_TTL_MS = 24 * 60 * 60_000;

export type CapNoticeKind = 'credit_wall' | 'spend_alert';

/** OS notification copy per UI language. Same words as the in-app notices. */
export const CAP_NOTICE_COPY: Record<
  UiLanguage,
  { wallTitle: string; wallBody: string; spendTitle: string; spendBody: string }
> = {
  en: {
    wallTitle: 'Usage limit reached',
    wallBody: "You've used this week's allowance.",
    spendTitle: 'Spend alert',
    spendBody: 'Your own key spend passed {amount} this month.',
  },
  zh: {
    wallTitle: 'å·²è¾¾ä½¿ç”¨ä¸Šé™',
    wallBody: 'ä½ å·²ç”¨å®Œæœ¬å‘¨é¢åº¦ã€‚',
    spendTitle: 'èŠ±è´¹æé†’',
    spendBody: 'æœ¬æœˆä½ è‡ªå·±å¯†é’¥çš„èŠ±è´¹å·²è¶…è¿‡ {amount}ã€‚',
  },
  ja: {
    wallTitle: 'ä½¿ç”¨ä¸Šé™ã«åˆ°é”',
    wallBody: 'ä»Šé€±ã®ä»˜ä¸Žåˆ†ã‚’ä½¿ã„åˆ‡ã‚Šã¾ã—ãŸã€‚',
    spendTitle: 'è²»ç”¨ã‚¢ãƒ©ãƒ¼ãƒˆ',
    spendBody: 'ä»Šæœˆã®è‡ªåˆ†ã®ã‚­ãƒ¼ã§ã®è²»ç”¨ãŒ{amount}ã‚’è¶…ãˆã¾ã—ãŸã€‚',
  },
  ru: {
    wallTitle: 'Ð›Ð¸Ð¼Ð¸Ñ‚ Ð¸ÑÐ¿Ð¾Ð»ÑŒÐ·Ð¾Ð²Ð°Ð½Ð¸Ñ Ð¸ÑÑ‡ÐµÑ€Ð¿Ð°Ð½',
    wallBody: 'ÐšÑ€ÐµÐ´Ð¸Ñ‚Ñ‹ Ð·Ð° ÑÑ‚Ñƒ Ð½ÐµÐ´ÐµÐ»ÑŽ Ð·Ð°ÐºÐ¾Ð½Ñ‡Ð¸Ð»Ð¸ÑÑŒ.',
    spendTitle: 'ÐžÐ¿Ð¾Ð²ÐµÑ‰ÐµÐ½Ð¸Ðµ Ð¾ Ñ€Ð°ÑÑ…Ð¾Ð´Ð°Ñ…',
    spendBody: 'Ð Ð°ÑÑ…Ð¾Ð´Ñ‹ Ð¿Ð¾ Ñ‚Ð²Ð¾ÐµÐ¼Ñƒ ÐºÐ»ÑŽÑ‡Ñƒ Ð² ÑÑ‚Ð¾Ð¼ Ð¼ÐµÑÑÑ†Ðµ Ð¿Ñ€ÐµÐ²Ñ‹ÑÐ¸Ð»Ð¸ {amount}.',
  },
  'pt-BR': {
    wallTitle: 'Limite de uso atingido',
    wallBody: 'VocÃª usou os crÃ©ditos desta semana.',
    spendTitle: 'Alerta de gastos',
    spendBody: 'O gasto com sua prÃ³pria chave passou de {amount} este mÃªs.',
  },
  es: {
    wallTitle: 'LÃ­mite de uso alcanzado',
    wallBody: 'Ya usaste los crÃ©ditos de esta semana.',
    spendTitle: 'Alerta de gasto',
    spendBody: 'El gasto con tu propia clave superÃ³ {amount} este mes.',
  },
  it: {
    wallTitle: 'Limite di utilizzo raggiunto',
    wallBody: 'Hai esaurito la disponibilitÃ  di questa settimana.',
    spendTitle: 'Avviso di spesa',
    spendBody: 'La spesa con la tua chiave ha superato {amount} questo mese.',
  },
};

/** The OS notification text for one notice. Pure. */
export function capNoticeText(
  kind: CapNoticeKind,
  uiLanguage: unknown,
  limitUsd = 0,
): { title: string; body: string } {
  const c = CAP_NOTICE_COPY[normalizeUiLanguage(uiLanguage)];
  if (kind === 'credit_wall') return { title: c.wallTitle, body: c.wallBody };
  return { title: c.spendTitle, body: c.spendBody.replace('{amount}', formatUsd(limitUsd)) };
}

/** The bits of a BrowserWindow this module reads. */
export interface NoticeWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
}

/** Whether the player can see the app window right now (the in-app notice is enough). */
export function windowInFront(w: NoticeWindow | null): boolean {
  if (!w || w.isDestroyed()) return false;
  return w.isVisible() && !w.isMinimized() && w.isFocused();
}

export interface CapNoticeDeps {
  now: () => number;
  mainWindow: () => NoticeWindow | null;
  /** Electron Notification.isSupported(). */
  notificationSupported: () => boolean;
  /** Post one OS notification; `onClick` runs when the player clicks it. */
  showNotification: (text: { title: string; body: string }, onClick: () => void) => void;
  /** Dock bounce (macOS) / taskbar flash (Windows). Best-effort. */
  requestAttention: () => void;
  /** Bring the main window forward, making one if there is none (macOS). */
  revealMainWindow: () => void;
  /** UserConfig.ui_language of the active profile. */
  uiLanguage: () => Promise<unknown>;
  log?: (msg: string) => void;
}

export type NoticeOutcome = 'notified' | 'in_front' | 'unsupported' | 'repeat' | 'not_kept';

export function createCapNotices(deps: CapNoticeDeps) {
  const wallDeduper = new CreditWallDeduper();
  let pendingWall: { info: CreditsHardStopEvent; at: number } | null = null;
  let pendingSpend: { e: SpendAlertPush; at: number } | null = null;

  async function notify(kind: CapNoticeKind, limitUsd: number): Promise<NoticeOutcome> {
    if (windowInFront(deps.mainWindow())) return 'in_front';
    try {
      deps.requestAttention();
    } catch {
      /* attention is a nicety */
    }
    if (!deps.notificationSupported()) {
      deps.log?.(`[sei/cap-notice] ${kind}: OS notifications not supported here`);
      return 'unsupported';
    }
    let lang: unknown;
    try {
      lang = await deps.uiLanguage();
    } catch {
      lang = 'en';
    }
    deps.showNotification(capNoticeText(kind, lang, limitUsd), () => deps.revealMainWindow());
    deps.log?.(`[sei/cap-notice] ${kind}: OS notification posted`);
    return 'notified';
  }

  return {
    /** A credit wall was pushed to the renderer (emitCreditsHardStop). Never throws. */
    async hardStop(info: CreditsHardStopEvent): Promise<NoticeOutcome> {
      try {
        if (info.reason !== 'depleted') return 'not_kept';
        const now = deps.now();
        pendingWall = { info: { reason: 'depleted' }, at: now };
        // A wall arrives as a burst (every retry, every surface): one OS
        // notification per occurrence, same quiet gap as credit_wall_hit.
        if (!wallDeduper.take('depleted', now).ship) return 'repeat';
        return await notify('credit_wall', 0);
      } catch {
        return 'unsupported';
      }
    },
    /** The own-key spend alert fired (once a month per amount). Never throws. */
    async spendAlert(e: SpendAlertPush): Promise<NoticeOutcome> {
      try {
        pendingSpend = { e, at: deps.now() };
        return await notify('spend_alert', e.limitUsd);
      } catch {
        return 'unsupported';
      }
    },
    /** The wall a renderer that mounted after it should still show, or null. */
    peekHardStop(): CreditsHardStopEvent | null {
      if (!pendingWall) return null;
      if (deps.now() - pendingWall.at > PENDING_HARD_STOP_TTL_MS) {
        pendingWall = null;
        return null;
      }
      return pendingWall.info;
    },
    /** The player closed the wall (or it lifted): stop replaying it. */
    ackHardStop(): void {
      pendingWall = null;
    },
    peekSpendAlert(): SpendAlertPush | null {
      if (!pendingSpend) return null;
      if (deps.now() - pendingSpend.at > PENDING_SPEND_ALERT_TTL_MS) {
        pendingSpend = null;
        return null;
      }
      return pendingSpend.e;
    },
    ackSpendAlert(): void {
      pendingSpend = null;
    },
  };
}

export type CapNotices = ReturnType<typeof createCapNotices>;

// â”€â”€ Process-level instance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// index.ts installs the real one once the app is ready; before that (and in
// tests that never install one) every call is a no-op.

let instance: CapNotices | null = null;

export function installCapNotices(deps: CapNoticeDeps): CapNotices {
  instance = createCapNotices(deps);
  return instance;
}

export function capNoticeHardStop(info: CreditsHardStopEvent): void {
  if (instance) void instance.hardStop(info);
}

export function capNoticeSpendAlert(e: SpendAlertPush): void {
  if (instance) void instance.spendAlert(e);
}

export function peekPendingHardStop(): CreditsHardStopEvent | null {
  return instance ? instance.peekHardStop() : null;
}

export function ackPendingHardStop(): void {
  instance?.ackHardStop();
}

export function peekPendingSpendAlert(): SpendAlertPush | null {
  return instance ? instance.peekSpendAlert() : null;
}

export function ackPendingSpendAlert(): void {
  instance?.ackSpendAlert();
}

/** Test seam. */
export function _resetCapNoticesForTests(): void {
  instance = null;
}




