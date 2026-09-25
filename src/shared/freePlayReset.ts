/**
 * "Free play resets in N days (Tuesday, Sep 30)." The credit wall's pause
 * line (260926).
 *
 * Analytics 260926: 17% of active users hit the weekly free allowance, and of
 * those 16 only 1 ever came back. The wall read as an exit: nothing on it said
 * that free play comes back by itself every week. Every wall surface (the
 * usage-limit popup, the plan screen, the voice error, the Draw! pause, the
 * chess quiet notice) now carries this one line, so the answer to "when can I
 * play again" is always on screen.
 *
 * The timestamp is `CreditsStatus.resets_at`, which the `my_plan` view already
 * derives server-side (period start + 7 days). It is '' when unknown (signed
 * out, a brand-new account with no usage row yet, a failed read), and then
 * every helper here returns null so callers simply omit the line.
 *
 * Shared because main (the chess notice) and the renderer (everything else)
 * both need it, and both need the same wording. Pure apart from Intl, and every
 * date is read in LOCAL time: "tomorrow" means the user's tomorrow.
 */

export type ResetLang = 'en' | 'zh';
export type ResetPlan = 'free' | 'quest' | 'party';

const DAY_MS = 86_400_000;

/**
 * Calendar days from `nowMs` to `resetsAt` in local time (0 = later today,
 * 1 = tomorrow), plus the parsed instant. null when the stamp is missing,
 * unparseable, or already in the past (a stale snapshot must not promise a
 * reset that has happened).
 */
export function resetCountdown(
  resetsAt: string | null | undefined,
  nowMs: number,
): { days: number; atMs: number } | null {
  if (!resetsAt) return null;
  const atMs = Date.parse(resetsAt);
  if (!Number.isFinite(atMs) || atMs <= nowMs) return null;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  // round, not floor: a DST day is 23 or 25 hours long.
  const days = Math.max(0, Math.round((startOfDay(atMs) - startOfDay(nowMs)) / DAY_MS));
  return { days, atMs };
}

function locale(lang: ResetLang): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

/** "Tuesday, Sep 30" / "9月30日星期二". */
export function formatResetDate(atMs: number, lang: ResetLang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(atMs));
}

function formatResetTime(atMs: number, lang: ResetLang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: lang !== 'zh',
  }).format(new Date(atMs));
}

/**
 * The full sentence, period included, or null when there is no usable reset
 * time. Free accounts read "Free play resets..."; a subscriber who spent the
 * week's allowance reads "Your weekly allowance resets...", because for them
 * nothing about it is free.
 *
 *   en: Free play resets in 3 days (Tuesday, Sep 30).
 *       Free play resets tomorrow (Saturday, Sep 27).
 *       Free play resets today at 9:30 PM.
 *   zh: 免费游玩将在3天后重置（9月30日星期二）。
 */
export function formatResetLine(
  resetsAt: string | null | undefined,
  nowMs: number,
  opts: { lang: ResetLang; plan?: ResetPlan },
): string | null {
  const c = resetCountdown(resetsAt, nowMs);
  if (!c) return null;
  const { lang } = opts;
  const free = (opts.plan ?? 'free') === 'free';
  if (lang === 'zh') {
    const subject = free ? '免费游玩' : '每周额度';
    if (c.days === 0) return `${subject}将在今天${formatResetTime(c.atMs, lang)}重置。`;
    const date = formatResetDate(c.atMs, lang);
    if (c.days === 1) return `${subject}将在明天重置（${date}）。`;
    return `${subject}将在${c.days}天后重置（${date}）。`;
  }
  const subject = free ? 'Free play' : 'Your weekly allowance';
  if (c.days === 0) return `${subject} resets today at ${formatResetTime(c.atMs, lang)}.`;
  const date = formatResetDate(c.atMs, lang);
  if (c.days === 1) return `${subject} resets tomorrow (${date}).`;
  return `${subject} resets in ${c.days} days (${date}).`;
}

/**
 * The one system line a game surface posts when the companion goes quiet on
 * the wall but the game keeps going (chess: the engine keeps moving, 260926).
 * Carries the reset line when known.
 */
export function quietCompanionNotice(opts: {
  name: string;
  lang: ResetLang;
  plan?: ResetPlan;
  resetsAt: string | null | undefined;
  nowMs: number;
}): string {
  const { name, lang } = opts;
  const free = (opts.plan ?? 'free') === 'free';
  const reset = formatResetLine(opts.resetsAt, opts.nowMs, { lang, plan: opts.plan });
  if (lang === 'zh') {
    const lead = free
      ? `你的免费游玩已用完，${name}会继续安静地陪你下完这局，但暂时不会聊天。`
      : `本周额度已用完，${name}会继续安静地陪你下完这局，但暂时不会聊天。`;
    return `${lead}${reset ?? ''}充值或升级可以让TA更早开口。`;
  }
  const lead = free
    ? `You're out of free play for now, so ${name} will keep playing quietly, with no chat.`
    : `This week's allowance is used up, so ${name} will keep playing quietly, with no chat.`;
  return `${lead}${reset ? ` ${reset}` : ''} Top up or upgrade to bring them back sooner.`;
}

/**
 * "Your free play is back" launch banner bookkeeping (260926). Pure so the
 * rules are testable without a store:
 *
 *   - `stored` is the reset time remembered the last time the account was seen
 *     AT the wall (config.free_play_wall_resets_at), or null.
 *   - At the wall: remember the current resets_at (keep the old one when the
 *     snapshot has none).
 *   - Off the wall with a remembered reset that has PASSED: show the banner
 *     once and forget it.
 *   - Off the wall BEFORE the remembered reset: the wall was lifted by a top up
 *     or an upgrade, not by the weekly reset, so "free play is back" would be
 *     wrong. Forget it silently.
 *   - Unknown snapshots (failed read, BYOK, signed out) change nothing.
 *
 * `store` is the value to persist: a string, null to clear, or undefined to
 * leave config untouched.
 */
export function decideFreePlayBanner(
  stored: string | null | undefined,
  snap: { cloud: boolean; snapshotFailed: boolean; over_limit: boolean; resets_at: string },
  nowMs: number,
): { show: boolean; store: string | null | undefined } {
  if (!snap.cloud || snap.snapshotFailed) return { show: false, store: undefined };
  if (snap.over_limit) {
    const next = snap.resets_at || stored || null;
    return { show: false, store: next !== (stored ?? null) ? next : undefined };
  }
  if (!stored) return { show: false, store: undefined };
  const at = Date.parse(stored);
  if (Number.isFinite(at) && at <= nowMs) return { show: true, store: null };
  return { show: false, store: null };
}
