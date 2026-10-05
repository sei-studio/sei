/**
 * Words for the refill notification and the tray menu (261005). Pure.
 *
 * The notification is the companion talking, so it follows the CONVERSATION
 * language (config.chat_language, six languages) with the app UI language as
 * the fallback for a Chinese UI whose player never spoke on a call. The tray
 * menu is app chrome, so it follows the UI language (en / zh), like every
 * other renderer string.
 *
 * Copy rules: one plain line, no emoji, no em dash, no hype.
 */
import type { ChatLanguage } from '../../shared/chatLanguage';

export type NotifyLang = ChatLanguage;

/** Conversation language when set (and not the default), else zh for a Chinese UI, else en. */
export function notificationLanguage(cfg: {
  chat_language?: string | null;
  ui_language?: string | null;
}): NotifyLang {
  const chat = cfg.chat_language;
  if (chat === 'zh' || chat === 'ja' || chat === 'ko' || chat === 'fr' || chat === 'es') return chat;
  return cfg.ui_language === 'zh' ? 'zh' : 'en';
}

const FREE: Record<NotifyLang, string> = {
  en: 'Free play is back. Want to jump in?',
  zh: '免费游玩恢复了，要一起玩吗？',
  ja: '無料プレイが戻ったよ。一緒に遊ぶ？',
  ko: '무료 플레이가 다시 열렸어. 같이 할래?',
  fr: 'Le jeu gratuit est de retour. On y va ?',
  es: 'El juego gratis ha vuelto. ¿Jugamos?',
};

// A subscriber who spent the week's allowance: nothing about it is free.
const PAID: Record<NotifyLang, string> = {
  en: 'Your weekly allowance is back. Want to jump in?',
  zh: '本周额度恢复了，要一起玩吗？',
  ja: '今週の利用枠が戻ったよ。一緒に遊ぶ？',
  ko: '이번 주 이용량이 다시 채워졌어. 같이 할래?',
  fr: 'Ton forfait de la semaine est de retour. On y va ?',
  es: 'Tu cuota semanal ha vuelto. ¿Jugamos?',
};

/**
 * Title + body. The title is the companion's name (the OS shows "Sei" as the
 * source), so the notification reads "{name}: Free play is back. Want to
 * jump in?". No companion → title "Sei".
 */
export function refillNotificationText(opts: {
  name: string | null | undefined;
  lang: NotifyLang;
  plan: 'free' | 'quest' | 'party';
}): { title: string; body: string } {
  const body = (opts.plan === 'free' ? FREE : PAID)[opts.lang] ?? FREE.en;
  const name = opts.name?.trim();
  return { title: name || 'Sei', body };
}

/**
 * The "active companion": the one the player talked to or played with most
 * recently (max of last_chatted / last_launched), else the first in the
 * roster. null for an empty roster.
 */
export function pickActiveCompanion<
  C extends { name: string; last_chatted?: string | null; last_launched?: string | null },
>(chars: readonly C[]): C | null {
  if (chars.length === 0) return null;
  const stamp = (c: C): number => {
    const a = c.last_chatted ? Date.parse(c.last_chatted) : NaN;
    const b = c.last_launched ? Date.parse(c.last_launched) : NaN;
    const best = Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(b) ? b : -Infinity);
    return best;
  };
  let best = chars[0];
  let bestAt = stamp(best);
  for (const c of chars.slice(1)) {
    const at = stamp(c);
    if (at > bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
}

export type MenuLang = 'en' | 'zh';

const MENU = {
  en: { open: 'Open Sei', quit: 'Quit Sei', update: 'Restart to update' },
  zh: { open: '打开 Sei', quit: '退出 Sei', update: '重启以完成更新' },
} as const;

export function trayMenuText(lang: MenuLang): { open: string; quit: string; update: string } {
  return MENU[lang] ?? MENU.en;
}
