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
 *   - an own voice  → (261019) a voice from the user's own ElevenLabs
 *                     account: metadata.voiceId = its id PLUS the
 *                     metadata.voiceOwn marker (shared/voiceIds.ts
 *                     applyVoicePick), which keeps the runtime from treating
 *                     it as unknown and re-rolling it.
 */
import type { OwnVoiceInfo, OwnVoiceList, VoiceInfo } from '@shared/ipc';
import { NO_VOICE_ID, applyVoicePick, type OwnVoicePick } from '@shared/voiceIds';
import { CHAT_LANGUAGE_CODES } from '@shared/chatLanguage';
import { isPoolVoiceId } from '@shared/poolVoiceIds';

export { NO_VOICE_ID, applyVoicePick };
export type { OwnVoicePick };

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
 * True when `selection` names a voice the picker does not list — a legacy id
 * assigned before the 260707 pool curation, or (261019) an own ElevenLabs
 * voice whose list cannot be read right now (key removed, cloud backend,
 * voice deleted in ElevenLabs). The picker renders a dedicated "Current
 * voice" row for it so editing never silently drops it. Pass the pool AND the
 * own-voice list.
 */
export function isUnlistedVoice(selection: VoiceSelection, voices: Array<{ id: string }>): boolean {
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

// ── Own ElevenLabs voices (261019) ─────────────────────────────────────────

/** Tab key for the "Your ElevenLabs voices" tab (beside the gender groups). */
export const OWN_TAB_KEY = 'own';
export type VoiceTabKey = VoiceGroup['key'] | typeof OWN_TAB_KEY;

/** The marker to persist when `id` is picked from the own-voice list, or null
 * for any other selection (pool voice, Auto, No voice). A Sei pool id is
 * never an own voice even when the user's ElevenLabs library lists it (Sei's
 * pool voices can sit in an ElevenLabs library as copies, "Sei — Josh"), so
 * re-picking a pool voice never tags it (261024). */
export function ownVoicePickFor(id: VoiceSelection, own: OwnVoiceInfo[]): OwnVoicePick | null {
  if (id === null || isPoolVoiceId(id)) return null;
  const v = own.find((x) => x.id === id);
  if (!v) return null;
  return { name: v.name, ...(v.gender ? { gender: v.gender } : {}) };
}

/** English UI label for an ElevenLabs voice category (callers pass it through
 * t()). Unknown categories get the generic label rather than a raw token. */
export function ownVoiceCategoryLabel(category: string): string {
  switch (category) {
    case 'cloned':
      return 'Cloned voice';
    case 'professional':
      return 'Professional clone';
    case 'generated':
      return 'Designed voice';
    case 'famous':
    case 'high_quality':
      return 'Library voice';
    default:
      return 'Your voice';
  }
}

/** One-line detail under an own voice: its ElevenLabs description, else its
 * labels ("female, young, american"). Data from the user's account, shown as
 * written. Empty string when ElevenLabs has nothing. */
export function ownVoiceDetail(v: OwnVoiceInfo): string {
  if (v.description) return v.description;
  return [v.gender, v.age, v.accent].filter((x): x is string => !!x).join(', ');
}

/**
 * What the picker shows for the own-voice list state:
 *   - 'tab'    → render the "Your ElevenLabs voices" tab (it may be empty,
 *                then it carries the "nothing here yet" hint).
 *   - 'hint'   → no tab, one quiet line (key refused / list unreadable).
 *   - 'none'   → nothing at all (no direct key route, or still loading).
 * The built-in list renders in every case.
 */
export function ownVoicesView(list: OwnVoiceList | null): 'tab' | 'hint' | 'none' {
  if (!list) return 'none';
  if (list.status === 'ok') return 'tab';
  if (list.status === 'bad_key' || list.status === 'error') return 'hint';
  return 'none';
}

/** Whether Sei's pool voices are being spoken through the user's own key
 * (the own-voice list is reachable, i.e. the direct route is active), which
 * is when the free-plan hint above the pool applies. 261020 (T158): only on
 * the LOCAL backend. On Sei Cloud a saved key lists the user's own voices
 * too, but Sei's pool keeps playing through the proxy and never bills it. */
export function poolUsesOwnKey(
  list: OwnVoiceList | null,
  backend: 'local' | 'cloud-proxy' | null | undefined,
): boolean {
  return backend === 'local' && list !== null && list.status !== 'unavailable';
}

/** Whether the picker shows the "Have your own ElevenLabs voices? Add your
 * key in Settings" pointer (261020, T158): both backends, once the key probe
 * has answered "no key" (null = still probing, say nothing). Local voice-pack
 * mode has no ElevenLabs list at all. */
export function elevenKeyHintShown(hasKey: boolean | null, localTtsMode: boolean): boolean {
  return !localTtsMode && hasKey === false;
}

/** Default tab: the tab holding the selection, else the own tab when it has
 * voices (a user who brought a key came for those), else the first group. A
 * pool voice opens its gender tab even when the own list also holds a copy of
 * it (261024), since it is saved as a pool voice. */
export function defaultVoiceTab(
  value: VoiceSelection,
  groups: VoiceGroup[],
  own: OwnVoiceInfo[] | null,
): VoiceTabKey | null {
  const g = groups.find((x) => x.voices.some((v) => v.id === value));
  if (g) return g.key;
  if (own && value !== null && own.some((v) => v.id === value)) return OWN_TAB_KEY;
  if (own && own.length > 0) return OWN_TAB_KEY;
  return groups[0]?.key ?? (own ? OWN_TAB_KEY : null);
}

/**
 * Where Settings shows the ElevenLabs key field (261020, T158):
 *   - 'byok'           → local (My key) backend with the ElevenLabs engine:
 *                        the key powers every voice and Scribe, so a missing
 *                        key is a warning (unchanged since 260725).
 *   - 'cloud-optional' → Sei Cloud: an OPTIONAL key, only for voices from the
 *                        user's own ElevenLabs account. Sei's pool and speech
 *                        recognition stay on the proxy.
 *   - 'hidden'         → local voice packs, or the backend not reported yet.
 */
export function elevenKeySettingMode(
  backend: 'local' | 'cloud-proxy' | null | undefined,
  ttsEngine: 'elevenlabs' | 'local',
): 'byok' | 'cloud-optional' | 'hidden' {
  if (backend === 'cloud-proxy') return 'cloud-optional';
  if (backend === 'local' && ttsEngine === 'elevenlabs') return 'byok';
  return 'hidden';
}
