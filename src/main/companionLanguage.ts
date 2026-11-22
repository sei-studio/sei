/**
 * The language a companion speaks to the player on every main-process surface
 * (chat, calls, TTS, the game bot, chess, Draw!, backseat, WorldLink lines),
 * 261116. The rules are pure (shared/chatLanguage.ts companionLanguage); this
 * adds the viewer: the active profile scope is the signed-in account id, or
 * 'local' signed out.
 */
import { companionLanguage, type CompanionLanguage } from '../shared/chatLanguage';
import { getActiveScope } from './paths';

export function companionLanguageFor(
  c: { metadata?: unknown; owner?: string | null; is_default?: boolean | null },
  config: { chat_language?: unknown; ui_language?: unknown } | null | undefined,
): CompanionLanguage {
  let viewer: string | null = null;
  try {
    viewer = getActiveScope();
  } catch {
    /* no scope yet: owner-less companions still count as hers */
  }
  return companionLanguage(c, config, viewer);
}




