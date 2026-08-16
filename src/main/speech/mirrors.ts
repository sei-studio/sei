/**
 * Speech model download bases (260816, china-compat W3+W4).
 *
 * Every speech model asset is tried MIRROR FIRST: `dl.sei.gg` is our R2 bucket
 * behind Cloudflare (free egress, reachable from mainland China), while the
 * canonical copies live on k2-fsa/sherpa-onnx GitHub release assets, which are
 * unreliable-to-dead from CN. The mirror may not exist yet for a given asset,
 * so the mirror attempt carries a SHORT connect timeout and any failure falls
 * through to the origin URL: code must work with origin only.
 *
 * ONE constants module on purpose: the updater-feed and Maia-model mirror work
 * (W8) reuses `DL_MIRROR_BASE`; keep the base here and derive per-surface
 * prefixes from it.
 */

/** Root of the dl.sei.gg mirror (R2 behind Cloudflare). */
export const DL_MIRROR_BASE = 'https://dl.sei.gg';

/** Speech model assets live under this prefix on the mirror. */
export const SPEECH_MIRROR_BASE = `${DL_MIRROR_BASE}/speech`;

/** Connect budget for the mirror attempt. The mirror is an optimization; a
 * mirror that has not been stood up yet must cost seconds, not a stall. */
export const MIRROR_CONNECT_TIMEOUT_MS = 8_000;

export interface SpeechSource {
  url: string;
  /** Abort the whole attempt if headers have not landed inside this window.
   * Absent = the caller's default (generous) timeout. */
  connectTimeoutMs?: number;
}

/**
 * Ordered download sources for one speech asset: mirror first (bounded
 * connect), then the canonical origin URL.
 */
export function speechSources(asset: string, originUrl: string): SpeechSource[] {
  return [
    { url: `${SPEECH_MIRROR_BASE}/${asset}`, connectTimeoutMs: MIRROR_CONNECT_TIMEOUT_MS },
    { url: originUrl },
  ];
}
