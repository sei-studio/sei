/**
 * The plan usage row's reset countdown (moved out of CreditsScreen 261104 so
 * it can be tested without the IPC bridge).
 */
import { t } from './i18n';

/**
 * "2d 23h" / "4h 30m" / "30m" / "soon" (in the UI language) from the resets_at ISO
 * stamp (260725 wording). Two largest units only; minute precision is all the
 * surface needs, and the screen re-renders on a 60s tick while open. Empty
 * string on a bad date so the sub-line simply doesn't render.
 */
export function formatResetsIn(resetsAt: string, nowMs: number): string {
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return '';
  const left = at - nowMs;
  if (left <= 60_000) return RESETS_SOON;
  const mins = Math.floor(left / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  // Compact consistent units (260725): "3d 4h" / "4h 30m" / "30m". The unit
  // letters are translated (261104): "2d 23h" read as English in every UI.
  if (d > 0) return h > 0 ? t('{d}d {h}h', { d, h }) : t('{n}d', { n: d });
  if (h > 0) return m > 0 ? t('{h}h {m}m', { h, m }) : t('{n}h', { n: h });
  return t('{n}m', { n: m });
}

/** formatResetsIn's answer when the reset is under a minute away. */
export const RESETS_SOON = 'soon';

/** The usage row's sub-line: "Resets in 2d 23h", or "Resets soon". */
export function resetsInLine(resetsIn: string): string {
  return resetsIn === RESETS_SOON ? t('Resets soon') : t('Resets in {time}', { time: resetsIn });
}

