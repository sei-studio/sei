/**
 * Conversation-language auto-switch (260725).
 *
 * The chat-language picker was removed from onboarding and Settings; the
 * conversation language now follows the player's VOICE. Every cloud STT pass
 * (ElevenLabs Scribe, voice/stt.ts) reports the language it detected for the
 * utterance, and the voice:stt IPC handler feeds that detection here. This
 * module turns per-utterance detections into the persisted
 * UserConfig.chat_language:
 *
 *   - Only the six supported codes count (detectedToChatLanguage in
 *     shared/chatLanguage.ts). An unsupported detection (German speech,
 *     noise) resets the streak and changes nothing.
 *   - A switch needs CONSECUTIVE_REQUIRED confident detections in a row of
 *     the SAME language: probability >= MIN_PROBABILITY and a transcript of
 *     at least MIN_TEXT_CHARS chars. One stray foreign sentence, a short
 *     "ok"/"si", or a low-confidence pass never flips the config.
 *   - The write is configStore.updateConfig (atomic RMW under the file
 *     lock). Chat prompts, chess prompts, and TTS read the config per turn,
 *     so they follow on the next message. The in-game companion picks the
 *     change up on its next summon (same fork-time bridging as vision_mode),
 *     and the local Whisper decode pin on the next call.
 *
 * Main is the ONLY writer of chat_language; renderer wholesale saves
 * preserve whatever is on disk (configStore.saveConfigFromRenderer), so a
 * stale Settings copy cannot revert a switch that landed mid-call.
 */
import { loadConfig, updateConfig } from '../configStore';
import {
  clampChatLanguage,
  detectedToChatLanguage,
  type ChatLanguage,
} from '../../shared/chatLanguage';

const MIN_PROBABILITY = 0.8;
const MIN_TEXT_CHARS = 6;
const CONSECUTIVE_REQUIRED = 2;

let streak: { lang: ChatLanguage; count: number } | null = null;

/** Test hook: clear the consecutive-detection streak. */
export function resetLanguageAutoSwitch(): void {
  streak = null;
}

/**
 * Record one utterance's detection and persist a language switch once the
 * streak policy is satisfied. Never throws — a failed config write costs a
 * switch, not an utterance.
 */
export async function noteDetectedLanguage(detection: {
  text: string;
  languageCode?: string;
  languageProbability?: number;
}): Promise<void> {
  // Too short to trust the detector ("ok", "si", a laugh); the streak keeps.
  if (detection.text.trim().length < MIN_TEXT_CHARS) return;
  const lang = detectedToChatLanguage(detection.languageCode);
  if (!lang) {
    // No detection relayed (proxy without the field) or unsupported speech.
    streak = null;
    return;
  }
  // Absent probability (a proxy relaying only the code) counts as confident;
  // the consecutive-utterance rule is the real guard.
  if ((detection.languageProbability ?? 1) < MIN_PROBABILITY) return;
  streak = streak?.lang === lang ? { lang, count: streak.count + 1 } : { lang, count: 1 };
  if (streak.count < CONSECUTIVE_REQUIRED) return;
  try {
    const current = clampChatLanguage((await loadConfig()).chat_language);
    if (current === lang) return;
    await updateConfig((cfg) =>
      clampChatLanguage(cfg.chat_language) === lang ? cfg : { ...cfg, chat_language: lang },
    );
    console.log(`[sei/voice] chat language auto-switched ${current} -> ${lang}`);
  } catch (err) {
    console.warn(`[sei/voice] language auto-switch failed: ${(err as Error).message}`);
  }
}
