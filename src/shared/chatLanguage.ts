/**
 * Conversation-language support (260709). One list, shared by the renderer
 * (onboarding picker + Settings), main (chat prompt assembly, TTS), and the
 * bot supervisor (init payload bridge).
 *
 * This is the CONVERSATION language only — what the companion speaks and
 * understands in chat, on voice calls, and in game. It is NOT an app/UI
 * locale: every UI string stays English regardless of this setting.
 *
 * The bot process cannot import this TS module (it ships as raw ESM under
 * src/bot), so the LLM-facing directive text lives in
 * src/bot/brain/promptLibrary.js (CHAT_LANGUAGE_NAMES / renderLanguageDirective)
 * and this file mirrors only the code list. Keep the two code lists in sync.
 */

export const CHAT_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'zh', label: 'Chinese', native: '中文' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'es', label: 'Spanish', native: 'Español' },
] as const;

export type ChatLanguage = (typeof CHAT_LANGUAGES)[number]['code'];

export const CHAT_LANGUAGE_CODES = CHAT_LANGUAGES.map((l) => l.code) as ChatLanguage[];

/**
 * Read a UserConfig.chat_language value defensively: the field is optional
 * (absent ≡ 'en' — the same not-defaulted convention as analytics_opt_out, so
 * the many manual UserConfig literals don't all need to spell it out), and a
 * junk value from a hand-edited config.json falls back to English rather than
 * crashing a prompt build.
 */
export function clampChatLanguage(raw: unknown): ChatLanguage {
  return (CHAT_LANGUAGE_CODES as string[]).includes(raw as string)
    ? (raw as ChatLanguage)
    : 'en';
}
