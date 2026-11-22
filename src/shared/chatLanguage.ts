/**
 * Conversation-language support (260709). One list, shared by the renderer
 * (voice previews, dictation model choice), main (chat prompt assembly, TTS,
 * STT language auto-switch), and the bot supervisor (init payload bridge).
 *
 * This is the CONVERSATION language only â€” what the companion speaks and
 * understands in chat, on voice calls, and in game. It is NOT the app/UI
 * locale (uiLanguage.ts), but since 261116 the UI language is its default
 * (userChatLanguage, companionLanguage).
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
  { code: 'zh', label: 'Chinese', native: 'ä¸­æ–‡' },
  { code: 'ja', label: 'Japanese', native: 'æ—¥æœ¬èªž' },
  { code: 'ko', label: 'Korean', native: 'í•œêµ­ì–´' },
  { code: 'fr', label: 'French', native: 'FranÃ§ais' },
  { code: 'es', label: 'Spanish', native: 'EspaÃ±ol' },
  // 261116: the UI languages added on 261104 (ru, pt-BR, it), so a companion's
  // default language can follow any UI language (userChatLanguage below).
  { code: 'ru', label: 'Russian', native: 'Ð ÑƒÑÑÐºÐ¸Ð¹' },
  { code: 'pt', label: 'Portuguese', native: 'PortuguÃªs' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
] as const;

export type ChatLanguage = (typeof CHAT_LANGUAGES)[number]['code'];

export const CHAT_LANGUAGE_CODES = CHAT_LANGUAGES.map((l) => l.code) as ChatLanguage[];

/**
 * Read a UserConfig.chat_language value defensively: the field is optional
 * (absent â‰¡ 'en' â€” the same not-defaulted convention as analytics_opt_out, so
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
  ru: 'ru', rus: 'ru',
  pt: 'pt', por: 'pt',
  it: 'it', ita: 'it',
});

export function detectedToChatLanguage(raw: unknown): ChatLanguage | null {
  if (typeof raw !== 'string') return null;
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return DETECTED_CODE_MAP[base] ?? null;
}

/**
 * 260730: per-CHARACTER language, stamped into `character.metadata.language`
 * at creation from the app's UI language ('zh' UI â†’ 'zh' characters). When
 * set, it PINS every AI surface for that character (persona generation, chat,
 * voice, chess, Draw!, the Minecraft bot) to that language, overriding the
 * auto-detected conversation language above. Absent/invalid â†’ null, meaning
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
 * 261116 (product call 261116): the conversation language a companion falls
 * back to is the player's UI language, not English. Each UI language maps to
 * the conversation language of the same name (pt-BR speaks 'pt').
 */
export function chatLanguageForUi(raw: unknown): ChatLanguage | null {
  if (typeof raw !== 'string') return null;
  const base = raw.toLowerCase().split(/[-_]/)[0];
  return (CHAT_LANGUAGE_CODES as string[]).includes(base) ? (base as ChatLanguage) : null;
}

/**
 * The PLAYER's language: the one they have been heard speaking on calls
 * (chat_language, written by voice/languageAutoSwitch.ts), else their UI
 * language, else English. Drives STT, voice previews and every companion
 * that has no language of its own.
 */
export function userChatLanguage(
  config: { chat_language?: unknown; ui_language?: unknown } | null | undefined,
): ChatLanguage {
  const heard = config?.chat_language;
  if ((CHAT_LANGUAGE_CODES as string[]).includes(heard as string)) return heard as ChatLanguage;
  return chatLanguageForUi(config?.ui_language) ?? 'en';
}

/**
 * Did this player write this companion? Their own (or a legacy owner-less
 * local) companion, yes; a built-in (Sui, Lyra, Marv) or one added from the
 * World tab (owner is someone else), no. `viewer` is the active profile
 * scope: the account id when signed in, 'local' (or null) when not.
 */
export function isOwnCharacter(
  c: { owner?: string | null; is_default?: boolean | null },
  viewer: string | null | undefined,
): boolean {
  if (c.is_default) return false;
  return c.owner == null || c.owner === viewer;
}

export interface CompanionLanguage {
  language: ChatLanguage;
  /**
   * Someone else wrote her (a World companion): her description may name a
   * language (Aria's creator wrote "Speak primarily in natural, casual
   * Spanish"), which is that person's choice, not this player's. The prompt
   * then says so (renderAdoptedLanguageNote) so the player's language wins.
   */
  adopted: boolean;
}

/**
 * The language an AI surface (chat, calls, TTS, the game bot, games, WorldLink
 * lines) runs in for a character (261116):
 *  1. her metadata.language pin (stamped at creation under the zh UI), only
 *     when this player made her: a pin on someone else's companion is the
 *     creator's UI language, not a choice this player made;
 *  2. else the player's own language (userChatLanguage: heard on calls, else
 *     the UI language).
 * Until 261116 a World companion took her creator's pin, and an English
 * default left her description's language instructions in charge.
 */
export function companionLanguage(
  c: { metadata?: unknown; owner?: string | null; is_default?: boolean | null },
  config: { chat_language?: unknown; ui_language?: unknown } | null | undefined,
  viewer: string | null | undefined,
): CompanionLanguage {
  const own = isOwnCharacter(c, viewer);
  const adopted = !own && !c.is_default;
  return { language: (own ? characterLanguage(c.metadata) : null) ?? userChatLanguage(config), adopted };
}




