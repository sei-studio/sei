/**
 * Pure helpers for OnboardApp's local (BYOK) setup wizard (260817,
 * china-compat W6). Kept out of the component so the load-bearing choices —
 * which speech packs a language needs, how a byte count reads in the
 * "Download? (XX MB)" confirm, how a typed llm:test error maps to copy — are
 * unit-testable without mounting the scene.
 *
 * Pack SIZES are never hardcoded here: the renderer reads exact archive bytes
 * off speech:pack-status (main's src/main/speech/packs.ts is the single
 * source of truth). Pack IDS are string literals because the SpeechPackId
 * type lives in src/main and the renderer must not import from there; the
 * main-side zod gate (SpeechPackIdSchema) rejects a drifted id loudly.
 */
import type { SpeechPackStatePush } from '@shared/ipc';

export type SttEngineChoice = 'scribe' | 'whisper' | 'sensevoice';
export type TtsEngineChoice = 'elevenlabs' | 'local';

/** What the finished wizard hands back to OnboardApp's runLocalSetup. Absent
 * stt/tts = "decide later": the config fields stay unwritten, which means
 * Whisper-fallback STT semantics and ElevenLabs TTS semantics. */
export interface LocalSetupChoices {
  provider: string;
  model: string;
  stt?: SttEngineChoice;
  tts?: TtsEngineChoice;
  /** Set when the user pressed "Continue anyway" on a REJECTED key at the
   * key-step probe: runLocalSetup skips generateUnique outright (reduced
   * tutorial) instead of burning the generation timeout on a call that
   * cannot authenticate. An unreachable-provider continue does NOT set it,
   * because the network may be back by setup time and generation failure
   * already degrades silently. */
  skipGeneration?: boolean;
}

/** The SenseVoice STT pack (zh-strong local recognition). */
export const SENSEVOICE_PACK_ID = 'stt-sensevoice';

/**
 * Which local TTS packs a UI language needs. zh needs BOTH gendered packs
 * (the companion this onboarding is about to generate has no gender yet, and
 * later adoptions can be either); en is one pack carrying both genders via
 * speaker ids. Other languages fall back to the English voice at synthesis
 * time (localVoice.ts), so 'en' is the right download for them too.
 */
export function ttsPackIdsFor(lang: 'en' | 'zh'): string[] {
  return lang === 'zh' ? ['tts-zh-f', 'tts-zh-m'] : ['tts-en'];
}

/** Whole-megabyte label for an exact byte count (floored at 1). */
export function mbLabel(bytes: number): string {
  return String(Math.max(1, Math.round(bytes / 1048576)));
}

/** Sum of the archive bytes for `packIds`, or null while any is unknown. */
export function packsTotalBytes(
  packIds: readonly string[],
  packs: Record<string, SpeechPackStatePush> | null,
): number | null {
  if (!packs) return null;
  let sum = 0;
  for (const id of packIds) {
    const p = packs[id];
    if (!p) return null;
    sum += p.bytes;
  }
  return sum;
}

/**
 * Aggregate download progress across `packIds` in whole percents, weighted by
 * archive bytes so the big pack dominates the bar honestly. 'ready' counts as
 * 100, 'absent' as 0, 'downloading' as its pushed pct (0 while unset).
 */
export function packsPct(
  packIds: readonly string[],
  packs: Record<string, SpeechPackStatePush> | null,
): number {
  if (!packs) return 0;
  let total = 0;
  let done = 0;
  for (const id of packIds) {
    const p = packs[id];
    if (!p) continue;
    const weight = Math.max(1, p.bytes);
    total += weight;
    const pct = p.state === 'ready' ? 100 : p.state === 'downloading' ? (p.pct ?? 0) : 0;
    done += (weight * Math.min(100, Math.max(0, pct))) / 100;
  }
  if (total === 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** True once every pack in `packIds` reports 'ready'. */
export function allPacksReady(
  packIds: readonly string[],
  packs: Record<string, SpeechPackStatePush> | null,
): boolean {
  if (!packs) return false;
  return packIds.every((id) => packs[id]?.state === 'ready');
}

/**
 * Which IPC the key-step probe rides when Continue is pressed (260817).
 * OpenRouter's GET /models is PUBLIC — a bad key still lists — so it is the
 * one provider probed with a real 1-token llm:test instead. Everyone else
 * uses llm:list-models: fast, free, and auth-gated on every other provider
 * (Anthropic/OpenAI-compat 401, Gemini 400). For Ollama the listing doubles
 * as a reachability check, since there is no key to reject.
 */
export function keyProbeTransport(provider: string): 'list' | 'test' {
  return provider === 'openrouter' ? 'test' : 'list';
}

export type KeyProbeVerdict = 'ok' | 'rejected' | 'unreachable';

/**
 * Probe outcome → verdict. `token` is the typed error vocabulary from
 * listModels.ts `typedError` (null = the call succeeded). Only DEFINITE
 * verdicts block the wizard: ambiguous tokens (http_NNN, unknown) mean the
 * key authenticated far enough that the failure is not about the key — a
 * missing default model, a provider hiccup — and the model step's Test is
 * the right place to diagnose those. Ollama has no key, so every failure
 * there reads as "can't reach it".
 */
export function keyProbeVerdict(provider: string, token: string | null): KeyProbeVerdict {
  if (!token) return 'ok';
  if (provider === 'ollama') return 'unreachable';
  if (token === 'unauthorized' || token === 'no_api_key') return 'rejected';
  // Gemini answers an invalid key with HTTP 400 (API_KEY_INVALID), not 401.
  if (provider === 'gemini' && token === 'http_400') return 'rejected';
  if (token === 'timeout' || token === 'network') return 'unreachable';
  return 'ok';
}

/** First line of the key-probe popup. */
export function keyProbeLine(provider: string, verdict: 'rejected' | 'unreachable'): string {
  if (verdict === 'rejected') return 'The provider rejected this API key.';
  return provider === 'ollama'
    ? "Couldn't reach Ollama on your computer. Make sure Ollama is running."
    : "Couldn't reach the provider. Check your connection.";
}

/** Second line of the key-probe popup: the consequence. A rejected key makes
 * generation IMPOSSIBLE (will); an unreachable provider might recover by
 * setup time (may) — generation is still attempted there. */
export function keyProbeConsequence(verdict: 'rejected' | 'unreachable'): string {
  return verdict === 'rejected'
    ? 'We will not be able to match you with a unique companion.'
    : 'We may not be able to match you with a unique companion.';
}

/**
 * Typed llm:test error token → English copy key (t() translates). The token
 * vocabulary is listModels.ts `typedError`; http_NNN and unknown fold into
 * the generic line rather than surfacing a raw status code.
 */
export function llmTestErrorCopy(token: string): string {
  switch (token) {
    case 'no_api_key':
      return 'No API key saved. Go back a step and paste your key.';
    case 'unauthorized':
      return 'The provider rejected this API key.';
    case 'timeout':
      return 'The test timed out. Check your connection and try again.';
    case 'network':
      return "Couldn't reach the provider. Check your connection.";
    default:
      return 'The test failed. Check the model name and your key.';
  }
}
