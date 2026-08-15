/**
 * Usage-limit detection for the main-process game surfaces (260730).
 *
 * The Minecraft bot has had mid-session 402/429 handling since 260616 (the
 * orchestrator latches, botSupervisor relays, HardStopModal pops). The chat,
 * chess, draw and voice surfaces run their LLM calls in MAIN through
 * buildChatSdk, and until now a depleted ledger just made every turn throw
 * into a `log and continue` catch: the character went silent and the game
 * looked frozen.
 *
 * classifyUsageLimit reads the Anthropic SDK error shape (`.status` on
 * APIError): 402 is the proxy's depleted ledger, 429 its rate / abuse gate.
 * raiseUsageLimitPopup additionally gates on cloud mode — a BYOK user's 429
 * is Anthropic's own transient rate limit, and showing them a billing popup
 * for it would be wrong — then fans out the same `credits:hard-stop` push the
 * bot path uses, so the one HardStopModal serves every surface.
 */
import { getAiBackendKind } from '../apiKeyStore';

export type UsageLimitReason = 'depleted' | 'rate_limited';

/** 402 → depleted, 429 → rate_limited, anything else → null. */
export function classifyUsageLimit(err: unknown): UsageLimitReason | null {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 402) return 'depleted';
  if (status === 429) return 'rate_limited';
  return null;
}

/**
 * Best-effort retry window in seconds off an SDK error; undefined when absent.
 *
 * Priority (260810): the JSON body's `retry_after_seconds` first, then the
 * Retry-After header. The proxy puts the HONEST window in the body of every
 * client-facing 429 and deliberately caps the header at 10s (retry SDKs sleep
 * the full header value un-abortably), so the body is the truthful one when
 * both exist. The Anthropic SDK surfaces the parsed body on `err.error` (same
 * shape the bot orchestrator reads for daily_dollar).
 *
 * Exported for the unit test.
 */
export function retryAfterSeconds(err: unknown): number | undefined {
  const body = (err as { error?: unknown } | null)?.error;
  if (body && typeof body === 'object') {
    const sec = Number((body as { retry_after_seconds?: unknown }).retry_after_seconds);
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  const headers = (err as { headers?: unknown } | null)?.headers;
  let raw: unknown;
  if (headers && typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('retry-after');
  } else if (headers && typeof headers === 'object') {
    raw = (headers as Record<string, unknown>)['retry-after'];
  }
  const sec = Number(raw);
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

/**
 * If `err` is a cloud usage-limit failure, raise the HardStopModal in every
 * renderer window and return the reason; otherwise return null. Never throws.
 */
export async function raiseUsageLimitPopup(err: unknown): Promise<UsageLimitReason | null> {
  const reason = classifyUsageLimit(err);
  if (!reason) return null;
  try {
    if ((await getAiBackendKind()) !== 'cloud-proxy') return null;
    const { emitCreditsHardStop } = await import('../ipc');
    emitCreditsHardStop(
      // 260810: the no-Retry-After fallback is 60s, not 3600. A 429 with no
      // header is almost always Cloudflare's flood guard, whose window is 10
      // SECONDS — the old 1-hour guess had HardStopModal presenting a precise
      // wall-clock time a full hour out for a limit that clears in moments.
      // The modal also treats short windows as "try again in a moment" rather
      // than formatting a clock time out of a guess.
      reason === 'rate_limited'
        ? { reason: 'rate_limited', retry_after_seconds: retryAfterSeconds(err) ?? 60 }
        : { reason: 'depleted' },
    );
    return reason;
  } catch {
    return null;
  }
}
