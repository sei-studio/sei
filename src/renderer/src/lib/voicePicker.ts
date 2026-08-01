/**
 * Voice-picker pure logic (260720) — grouping + selection, no React.
 *
 * Selection model (what AddCharacterScreen / EditCharacterModal persist to
 * character.metadata.voiceId — the same shape unique-cast writes):
 *   - null          → Auto: metadata.voiceId stays unset; the runtime assigns
 *                     a deterministic, roster-deduped pool voice on first use.
 *   - NO_VOICE_ID   → silent companion: metadata.voiceId = 'none'; TTS never
 *                     synthesizes for them.
 *   - any other id  → pinned pool voice: metadata.voiceId = that id.
 */
import type { VoiceInfo } from '@shared/ipc';
import { NO_VOICE_ID } from '@shared/voiceIds';
import { CHAT_LANGUAGE_CODES } from '@shared/chatLanguage';

export { NO_VOICE_ID };

export type VoiceSelection = string | null;

export interface VoiceGroup {
  key: 'female' | 'male' | 'neutral';
  /** Tab label ("Feminine"). Internal keys stay 'female' | 'male' | 'neutral'. */
  title: string;
  voices: VoiceInfo[];
}

const GROUP_ORDER: Array<{ key: VoiceGroup['key']; title: string }> = [
  { key: 'female', title: 'Feminine' },
  { key: 'male', title: 'Masculine' },
  { key: 'neutral', title: 'Neutral' },
];

/**
 * Group the pool by gender for the picker's tabs. Feminine / masculine /
 * neutral, in that order; a voice with an unknown gender label lands in the
 * neutral bucket rather than disappearing. Empty groups are omitted. Order
 * within a group preserves the pool order.
 */
export function groupVoices(voices: VoiceInfo[]): VoiceGroup[] {
  const buckets: Record<VoiceGroup['key'], VoiceInfo[]> = { female: [], male: [], neutral: [] };
  for (const v of voices) {
    const key: VoiceGroup['key'] = v.gender === 'female' || v.gender === 'male' ? v.gender : 'neutral';
    buckets[key].push(v);
  }
  return GROUP_ORDER.filter((g) => buckets[g.key].length > 0).map((g) => ({
    key: g.key,
    title: g.title,
    voices: buckets[g.key],
  }));
}

/**
 * Click semantics for every selectable row (pool voice, "No voice"): clicking
 * an unselected row selects it; clicking the selected row again reverts to
 * Auto (null). The Auto row itself always maps to null directly.
 */
export function reduceSelection(current: VoiceSelection, clickedId: string): VoiceSelection {
  return current === clickedId ? null : clickedId;
}

/**
 * True when `selection` names a voice the picker's pool does not list — a
 * legacy id assigned before the 260707 pool curation. The picker renders a
 * dedicated "Current voice" row for it so editing never silently drops it.
 */
export function isUnlistedVoice(selection: VoiceSelection, voices: VoiceInfo[]): boolean {
  return (
    selection !== null && selection !== NO_VOICE_ID && !voices.some((v) => v.id === selection)
  );
}

/**
 * Bundled-sample asset path (260720). Every curated-pool voice ships a
 * pre-generated sample mp3 per conversation language under
 * renderer/public/voice-previews/, so the picker plays samples instantly with
 * no network, no sign-in, and no TTS spend. Relative './...' matches how other
 * public assets are referenced (see lib/games.ts image paths). A language the
 * bundle does not cover falls back to the English sample.
 */
export function assetPathFor(voiceId: string, lang: string): string {
  const supported = (CHAT_LANGUAGE_CODES as string[]).includes(lang) ? lang : 'en';
  return `./voice-previews/${voiceId}-${supported}.mp3`;
}

/**
 * Voice playground params (260725). Absent key = engine default; only
 * non-default values are ever stored (persisted to character.metadata as
 * voicePitch / voiceStability).
 *
 *   - pitch:    frequency multiplier in [0.85, 1.4]; 1 = as recorded. A local,
 *               pace-preserving shift applied at playback (lib/voice/pitchBus.ts),
 *               so it never reaches synthesis and a preview can be shifted
 *               without re-synthesizing.
 *   - calmness: ElevenLabs stability in [0, 1]; higher is steadier. This one
 *               does change the synthesized bytes.
 */
export interface VoiceParams {
  pitch?: number;
  calmness?: number;
}

export const PITCH_DEFAULT = 1;
export const CALMNESS_DEFAULT = 0.5;

/** Drop keys sitting at their engine default so absent-means-default holds. */
export function normalizeVoiceParams(p: VoiceParams): VoiceParams {
  const out: VoiceParams = {};
  if (p.pitch !== undefined && p.pitch !== PITCH_DEFAULT) out.pitch = p.pitch;
  if (p.calmness !== undefined && p.calmness !== CALMNESS_DEFAULT) out.calmness = p.calmness;
  return out;
}
