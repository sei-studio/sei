/**
 * 260816 (china-compat): first-launch UI language detection.
 *
 * Rule (user-confirmed): a CHINESE system locale switches the app UI to
 * Chinese; every other locale stays English. It applies only while the user
 * has never chosen a language — `ui_language` absent — so one write ends the
 * detection forever: after it, either the detected 'zh' sits in config, or
 * the user's own Settings/onboarding choice does, and both are respected.
 * (Absent ≡ 'en' everywhere ui_language is read, so non-zh systems need no
 * write at all — writing 'en' would masquerade as an explicit choice.)
 *
 * zh-TW/zh-HK also match: the dictionary is Simplified, but Simplified
 * Chinese UI is closer to right for a Traditional-locale user than English.
 */
import { app } from 'electron';
import { loadConfig, updateConfig } from './configStore';

/** Pure decision: should this launch write ui_language:'zh'? */
export function shouldSwitchToZh(
  currentUiLanguage: string | undefined,
  systemLanguages: readonly string[],
): boolean {
  if (currentUiLanguage !== undefined) return false;
  const primary = systemLanguages[0];
  return typeof primary === 'string' && primary.toLowerCase().startsWith('zh');
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
    if (shouldSwitchToZh(cfg.ui_language, effective)) {
      await updateConfig((c) => ({ ...c, ui_language: 'zh' as const }));
    }
  } catch {
    /* detection is never worth failing boot over */
  }
}
