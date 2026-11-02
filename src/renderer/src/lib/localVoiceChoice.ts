/**
 * Settings > Voice > Local voice (261102): the pure decisions behind the
 * Fast / Kokoro choice, kept out of SettingsScreen so they can be tested.
 */
import type { LocalTtsModel } from '@shared/ttsEngine';

/** The Kokoro local voice pack id (src/main/speech/packs.ts). */
export const KOKORO_PACK_ID = 'tts-kokoro';

type PackState = 'absent' | 'downloading' | 'ready' | undefined;

/**
 * What picking a local model does: Fast always saves at once; Kokoro saves at
 * once only when its pack is on disk, otherwise it offers the download first
 * and saves once the pack is ready (cancelling keeps Fast).
 */
export function localModelPickAction(
  next: LocalTtsModel,
  kokoroPackState: PackState,
): 'save' | 'offer-download' {
  return next === 'kokoro' && kokoroPackState !== 'ready' ? 'offer-download' : 'save';
}

/**
 * Whether the Kokoro pack row shows: while Kokoro is chosen, and while its
 * pack is downloading or installed, so a user who switched back to Fast can
 * still uninstall it. The Fast packs always show.
 */
export function showTtsPackRow(
  packId: string,
  localModel: LocalTtsModel,
  kokoroPackState: PackState,
): boolean {
  if (packId !== KOKORO_PACK_ID) return true;
  return localModel === 'kokoro' || (kokoroPackState ?? 'absent') !== 'absent';
}
