/**
 * 260816 (china-compat), 261104 (ja, ru, pt-BR, es): first-launch UI
 * language detection.
 *
 * Rule: a system locale whose language Sei has a UI for switches the app UI
 * to it (`uiLanguageForLocale` in shared/uiLanguage.ts: zh*, ja*, ru*, every
 * pt* locale to pt-BR, every es* locale to the neutral es); every other
 * locale stays English. It applies only while the user has never chosen a
 * language (`ui_language` absent), so one write ends the detection forever:
 * after it, either the detected language sits in config, or the user's own
 * Settings/onboarding choice does, and both are respected. (Absent = 'en'
 * everywhere ui_language is read, so English systems need no write at all;
 * writing 'en' would masquerade as an explicit choice.)
 *
 * Only the PRIMARY system language counts, as it did for zh: a Korean system
 * with Chinese second stays English.
 *
 * zh-TW/zh-HK also match: the dictionary is Simplified, but Simplified
 * Chinese UI is closer to right for a Traditional-locale user than English.
 * pt-PT maps to pt-BR for the same reason.
 */
import { app } from 'electron';
import { loadConfig, updateConfig } from './configStore';
import { uiLanguageForLocale, type UiLanguage } from '../shared/uiLanguage';

/** Pure decision: the ui_language this launch should write, or null for none. */
export function detectUiLanguage(
  currentUiLanguage: string | undefined,
  systemLanguages: readonly string[],
): UiLanguage | null {
  if (currentUiLanguage !== undefined) return null;
  return uiLanguageForLocale(systemLanguages[0]);
}

/** Boot step: detect and persist. Best-effort, never throws. */
export async function applyLocaleDetection(): Promise<void> {
  try {
    const cfg = await loadConfig();
    // getPreferredSystemLanguages() reflects the OS-level ordered list;
    // app.getLocale() is Chromium's resolved single locale and serves as the
    // fallback on platforms where the list comes back empty.
    const langs = app.getPreferredSystemLanguages?.() ?? [];
    const effective = langs.length > 0 ? langs : [app.getLocale()];
    const detected = detectUiLanguage(cfg.ui_language, effective);
    if (detected) {
      // Re-check inside the locked write: a Settings choice that landed
      // between the read and here wins.
      await updateConfig((c) => (c.ui_language === undefined ? { ...c, ui_language: detected } : c));
    }
  } catch {
    /* detection is never worth failing boot over */
  }
}
