/**
 * Conversation-language support (260709). One list, shared by the renderer
 * (voice previews, dictation model choice), main (chat prompt assembly, TTS,
 * STT language auto-switch), and the bot supervisor (init payload bridge).
 *
 * This is the CONVERSATION language only — what the companion speaks and
 * understands in chat, on voice calls, and in game. It is NOT an app/UI
 * locale: every UI string stays English regardless of this setting.
 *
 * 260725: the user-facing picker (onboarding step + Settings row) was
 * removed. The language is now AUTO-DETECTED from the player's voice:
 * every ElevenLabs Scribe STT pass reports the language it heard, and
 * src/main/voice/languageAutoSwitch.ts persists a confident, repeated
 * detection into UserConfig.chat_language. Main is the only writer;
 * renderer wholesale saves preserve whatever is on disk
 * (configStore.saveConfigFromRenderer).
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

/**
 * Map a Scribe-detected language code onto the supported conversation set.
 * ElevenLabs reports ISO 639-1 or 639-3 depending on surface, sometimes with
 * a region suffix; anything outside the six supported languages returns null
 * (the auto-switch keeps the current language for unsupported speech).
 *
 * 260725: null-prototype map. The lookup key is an UNTRUSTED upstream code
 * (Scribe, or the proxy relaying it); on a plain object literal 'constructor'
 * / 'toString' / '__proto__' / 'hasOwnProperty' would resolve to inherited
 * members instead of falling through to null.
 */
const DETECTED_CODE_MAP: Record<string, ChatLanguage> = Object.assign(Object.create(null), {
  en: 'en', eng: 'en',
  zh: 'zh', zho: 'zh', cmn: 'zh', chi: 'zh',
  ja: 'ja', jpn: 'ja',
  ko: 'ko', kor: 'ko',
  fr: 'fr', fra: 'fr', fre: 'fr',
  es: 'es', spa: 'es',
});

export function detectedToChatLanguage(raw: unknown): ChatLanguage | null {
  if (typeof raw !== 'string') return null;
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return DETECTED_CODE_MAP[base] ?? null;
}

/**
 * 260730: per-CHARACTER language, stamped into `character.metadata.language`
 * at creation from the app's UI language ('zh' UI → 'zh' characters). When
 * set, it PINS every AI surface for that character (persona generation, chat,
 * voice, chess, Draw!, the Minecraft bot) to that language, overriding the
 * auto-detected conversation language above. Absent/invalid → null, meaning
 * "no pin, follow chat_language". Read defensively like everything else on
 * metadata (free-form record, may hold junk from older clients).
 */
export function characterLanguage(metadata: unknown): ChatLanguage | null {
  const raw = (metadata as { language?: unknown } | null | undefined)?.language;
  return (CHAT_LANGUAGE_CODES as string[]).includes(raw as string)
    ? (raw as ChatLanguage)
    : null;
}

/**
 * The language an AI surface should run in for a character: the character's
 * own pin when present, else the auto-detected conversation language.
 */
export function surfaceLanguage(metadata: unknown, chatLanguageRaw: unknown): ChatLanguage {
  return characterLanguage(metadata) ?? clampChatLanguage(chatLanguageRaw);
}
