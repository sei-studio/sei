/**
 * 260926: a provider's OWN request timeout must not look like a user cancel.
 *
 * The local providers (ollama.ts, openaiCompat.ts, gemini.ts) enforce
 * `timeoutMs` by aborting their fetch. That surfaced as an AbortError ("This
 * operation was aborted"), and every surface reads an abort-shaped error as
 * an interrupt: chat turned it into the CHAT_ABORTED sentinel, so a local
 * model that took too long produced no reply, no failure line and no
 * surface_error. They now throw this instead when their timer fired and the
 * caller's signal did not. A real cancel (the caller's signal) still throws
 * the AbortError it always did.
 *
 * The message deliberately carries no "abort": the chat and backseat abort
 * checks sniff the message. `LLM_TIMEOUT` is the sentinel the renderer and
 * the surface_error classifier read (same convention as LOCAL_NO_API_KEY).
 */
export const LLM_TIMEOUT = 'LLM_TIMEOUT';

export class LlmTimeoutError extends Error {
  readonly code = LLM_TIMEOUT;
  constructor(kind: string, timeoutMs: number) {
    super(`${LLM_TIMEOUT}: the ${kind} model did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * A request deadline tied to an AbortController. `fired` tells a catch block
 * whether the deadline (not the caller) aborted the request.
 */
export function requestDeadline(
  controller: AbortController,
  timeoutMs: number,
): { rearm: () => void; clear: () => void; readonly fired: boolean } {
  let fired = false;
  const arm = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      fired = true;
      controller.abort();
    }, timeoutMs);
  let timer = arm();
  return {
    rearm: () => {
      clearTimeout(timer);
      timer = arm();
    },
    clear: () => clearTimeout(timer),
    get fired() {
      return fired;
    },
  };
}

/**
 * Map an error thrown while a deadline was armed: the deadline's own abort
 * becomes an LlmTimeoutError, anything else (a caller cancel included) passes
 * through unchanged.
 */
export function timeoutOr(
  err: unknown,
  deadline: { readonly fired: boolean },
  callerSignal: AbortSignal | undefined,
  kind: string,
  timeoutMs: number,
): unknown {
  if (deadline.fired && !callerSignal?.aborted) return new LlmTimeoutError(kind, timeoutMs);
  return err;
}
