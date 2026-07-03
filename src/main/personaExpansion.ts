/**
 * 260516-0yw: Main-process persona expansion.
 *
 * Takes a short user-written persona blurb (`source`) and expands it into a
 * structured long-form persona prompt (`expanded`) used by the bot at every
 * Haiku call. The expansion runs in the MAIN Electron process (NOT renderer,
 * NOT utilityProcess) because main is the only side that holds the
 * Anthropic API key (decrypted from safeStorage via apiKeyStore).
 *
 * Contract:
 *   - Fixed model: 'claude-sonnet-5' — latest Sonnet family alias (260702;
 *     was claude-haiku-4-5). MUST stay in lockstep with the proxy /free
 *     route's ALLOWED_EXPANSION_MODELS (forwardFree.ts).
 *   - Wall-clock timeout: 60s (per CLAUDE.md "every external call has a
 *     timeout"). Plumbed through the SDK's request-level `timeout` option,
 *     which the SDK enforces internally (no Promise.race wrapper needed).
 *     Matches the proxy's UPSTREAM_TIMEOUT_MS so a legitimately long
 *     generation (big output + Fly cold start) isn't aborted client-side
 *     before the proxy would have returned it.
 *   - STREAMING: the call streams (stream:true) and accumulates text deltas.
 *     This doesn't shorten wall-clock generation time, but it lets the
 *     caller drive a live progress bar via `onProgress` and makes the wait
 *     feel responsive instead of a single opaque block. The accumulated text
 *     is validated exactly as before once the stream closes. Cloud-proxy
 *     users stream through the proxy's /free SSE passthrough; BYOK users
 *     stream straight from api.anthropic.com.
 *   - Output must include all four base-personality section headers
 *     (# CORE, # VOICE, # EXTERNAL, # INTERNAL). Missing any → throw
 *     'persona expansion failed: incomplete response'.
 *   - System prompt is STABLE across calls (no player name, no session data,
 *     no live config) so it's safe to cache key-by-key in the API layer.
 *   - On edit (regeneration), `priorExpanded` is passed as voice-continuity
 *     reference in the USER message — never in the SYSTEM message — so the
 *     stable system prompt stays cacheable.
 *
 * Dependency-injection seam: `_clientFactory` lets tests swap in a fake
 * Anthropic client without monkey-patching the SDK module. Production path
 * uses `new Anthropic({ apiKey })` directly inside this module.
 */
import Anthropic from '@anthropic-ai/sdk';
// Persona-expansion prompt text lives in the single editable prompt document
// (src/bot/brain/promptLibrary.js). main bundles it at build time; re-exported
// below so existing importers of `./personaExpansion` keep working.
import { EXPANSION_SYSTEM as EXPANSION_SYSTEM_TEXT } from '../bot/brain/promptLibrary.js';

// 260702: bumped from claude-haiku-4-5 — persona quality compounds (the
// expansion is re-read by every bot and chat call for the character's
// lifetime), so it's worth the latest Sonnet. MUST stay in lockstep with the
// proxy's forwardFree.ts ALLOWED_EXPANSION_MODELS (add claude-sonnet-5 there
// BEFORE shipping this, or cloud-proxy expansion will be rejected).
export const EXPANSION_MODEL = 'claude-sonnet-5';
// 60s (was 30s): matches the proxy's UPSTREAM_TIMEOUT_MS. The 30s client cap
// could abort an otherwise-successful long generation (large output + Fly
// cold start, possibly with one SDK retry) while the proxy was still waiting.
export const EXPANSION_TIMEOUT_MS = 60_000;
export const EXPANSION_MAX_TOKENS = 2048;

/**
 * System prompt for the expansion call. Stable — does NOT include any per-call
 * data (no player name, no session data, no live config) so it stays cacheable.
 * The text lives in the single editable prompt document; re-exported here so
 * existing importers (and tests) keep resolving `EXPANSION_SYSTEM` from this
 * module. 260630: produces the four base-personality sections
 * (CORE / VOICE / EXTERNAL / INTERNAL).
 */
export const EXPANSION_SYSTEM = EXPANSION_SYSTEM_TEXT;

/**
 * Cloud-proxy mode mirrors the bot's `anthropicClient.js` wiring:
 *   - baseURL points at the Sei Fly.io proxy
 *   - authToken is the user's Supabase access_token (sent as `Authorization: Bearer …`)
 *   - apiKey is left null so no `X-Api-Key` header is emitted
 * When set, `apiKey` is ignored.
 */
export interface ExpandPersonaCloudMode {
  baseURL: string;
  authToken: string;
}

/**
 * Live progress for the streaming expansion call. `fraction` is a 0..1
 * monotonic-ish estimate suitable for a progress bar; `section` is a short
 * human label of what the model is currently writing (e.g. "Voice & samples")
 * so the UI can show meaningful status alongside the bar. Computed purely from
 * the accumulated text so far — see `computeExpansionProgress`.
 */
export interface ExpansionProgress {
  fraction: number;
  section: string;
}

export interface ExpandPersonaInput {
  source: string;
  /**
   * ITEM 12 (quick/260523-t8d): the character's NAME, plumbed through to the
   * user message so the expansion LLM has franchise context (e.g. naming a
   * character "Pikachu" or "Goku" lets the model write a recognizable CORE
   * and VOICE without the user needing to spell it out in the source blurb).
   * Required — no default — so a missing name surfaces as a clear TypeScript
   * compile error at every call site rather than silently disabling the hint.
   */
  name: string;
  priorExpanded?: string;
  /** BYOK mode. Ignored when `cloudMode` is set. */
  apiKey?: string;
  /** Cloud-proxy mode (Phase 13). When set, the SDK routes via baseURL + Bearer JWT. */
  cloudMode?: ExpandPersonaCloudMode;
  signal?: AbortSignal;
  /**
   * Streaming progress sink. Invoked (throttled) as text deltas arrive so the
   * caller can drive a progress bar. Fires once with fraction≈0 right before
   * the stream opens ("connecting") and then on meaningful advances. Never
   * called after `expandPersona` resolves/rejects. Optional — when omitted the
   * call still streams internally (same result), it just emits no progress.
   */
  onProgress?: (p: ExpansionProgress) => void;
  /**
   * Test-only seam: factory that produces an object exposing
   * `messages.create({...}, { signal, timeout })`. Production calls
   * `new Anthropic(...)`.
   */
  _clientFactory?: (sdkOpts: { apiKey?: string | null; baseURL?: string; authToken?: string }) => {
    messages: { create: (req: unknown, opts?: unknown) => Promise<unknown> };
  };
}

export interface ExpandPersonaResult {
  /** The four-section persona text, with the leading PROACTIVENESS line stripped
   *  (that line is config-only and never reaches the bot). */
  expanded: string;
  /** The proactiveness level the expander chose (0 passive / 1 reactive /
   *  2 agentic), parsed from the leading `PROACTIVENESS:` line. This seeds the
   *  runtime dial (the manual dial can override it later). Defaults to 1 when the
   *  line is absent or unrecognized. */
  proactiveness: number;
}

/** Map the expander's leading `PROACTIVENESS: <word>` line to the numeric level
 *  the runtime uses, and the persona text with that line removed. Defaults to
 *  reactive (1) when the line is missing/unrecognized so a non-compliant model
 *  response still yields a valid character. */
const PROACTIVENESS_WORD_TO_LEVEL: Record<string, number> = { passive: 0, reactive: 1, agentic: 2 };
export function parseProactivenessLine(text: string): { level: number; body: string } {
  const m = text.match(/^\s*PROACTIVENESS:\s*(passive|reactive|agentic)\b[^\n]*\n?/im);
  if (!m) return { level: 1, body: text };
  const level = PROACTIVENESS_WORD_TO_LEVEL[m[1].toLowerCase()] ?? 1;
  const body = (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim();
  return { level, body };
}

/**
 * Tolerant section-header detectors. Haiku 4.5 doesn't always render the
 * exact byte sequence we asked for: em-dashes become hyphens, casing can
 * drift, leading `#` may be `##`, and trailing punctuation comes and goes.
 * Each entry is a regex that asserts the section is present *somewhere*
 * in the output. We anchor to a leading `#` so we don't false-positive on
 * the header words appearing inside a body sentence.
 */
const REQUIRED_SECTION_HEADERS: { name: string; re: RegExp }[] = [
  { name: 'CORE',     re: /^\s*#+\s*CORE\b/im },
  { name: 'VOICE',    re: /^\s*#+\s*VOICE\b/im },
  { name: 'EXTERNAL', re: /^\s*#+\s*EXTERNAL\b/im },
  { name: 'INTERNAL', re: /^\s*#+\s*INTERNAL\b/im },
];

/**
 * Short, friendly labels for each of the four sections, in order. Parallel to
 * REQUIRED_SECTION_HEADERS — index i is the label shown while the model is
 * writing section i. Surfaced next to the progress bar so the user sees what's
 * happening ("Writing voice & samples…") rather than a bare percentage.
 */
const SECTION_LABELS = [
  'Core',
  'Voice & samples',
  'How others see you',
  'Values & needs',
];

/** Rough expected character length of a single section's body, used to ease
 *  the bar forward smoothly WITHIN a section (between header milestones). A
 *  loose estimate is fine — the per-section milestone is the load-bearing
 *  signal; this only controls intra-section creep. */
const EXPECTED_SECTION_CHARS = 420;

/**
 * Estimate streaming progress from the accumulated expansion text so far.
 *
 * The system prompt guarantees four sections in a fixed order, so the count of
 * RECOGNIZED section headers is a meaningful, honest milestone signal. We split
 * the bar into four equal segments (one per section) and ease forward within the
 * current segment using characters emitted since the last recognized header.
 * Capped at 0.97 while streaming so the bar only snaps to 1.0 once the stream
 * closes and the result validates.
 *
 * Monotonic across growing prefixes: we anchor `within` to the last RECOGNIZED
 * header (not any `#` line), so a partially-streamed header like "# DEFAULT
 * DYN…" doesn't reset the offset before its section actually counts. `within`
 * is capped below 1.0, so when the next header is recognized (`completed`
 * increments and `within` resets toward 0) the fraction still rises. Exported
 * for unit testing.
 */
export function computeExpansionProgress(text: string): ExpansionProgress {
  const total = REQUIRED_SECTION_HEADERS.length; // 4
  let seen = 0;
  let lastHeaderIdx = -1;
  for (const h of REQUIRED_SECTION_HEADERS) {
    // Non-global regexes — `.exec` is stateless and yields the first match's
    // index. Headers appear in order, so the max index is the current section.
    const m = h.re.exec(text);
    if (m) {
      seen++;
      if (m.index > lastHeaderIdx) lastHeaderIdx = m.index;
    }
  }
  // The `seen`-th section is the one currently being written; everything
  // before it is complete.
  const completed = Math.max(0, seen - 1);
  let within: number;
  if (seen >= 1 && lastHeaderIdx >= 0) {
    const sinceHeader = text.length - lastHeaderIdx;
    within = Math.min(0.95, sinceHeader / EXPECTED_SECTION_CHARS);
  } else {
    // Preamble before the first header — small creep so the bar isn't frozen
    // at 0 during the model's opening tokens.
    within = Math.min(0.5, text.length / 120);
  }
  const fraction = Math.min(0.97, (completed + within) / total);
  const section = seen >= 1 ? (SECTION_LABELS[seen - 1] ?? 'Writing') : 'Warming up';
  return { fraction, section };
}

/**
 * Build the per-call user message. The source is the primary input;
 * priorExpanded (when present) is appended as a voice-continuity reference
 * for the regeneration-on-edit path.
 *
 * ITEM 12 (quick/260523-t8d): `name` is now the FIRST argument and lands in
 * the user message as a "Character name: <name>" header line. The closing
 * instruction also nudges the model to use franchise context when the name
 * matches a known character (Pikachu, Goku, etc.).
 */
export function buildExpansionUserMessage(
  name: string,
  source: string,
  priorExpanded?: string,
): string {
  const lines: string[] = [
    `Character name: ${name}`,
    '',
    'Source persona (user-written blurb):',
    source,
  ];
  if (priorExpanded && priorExpanded.trim()) {
    lines.push(
      '',
      'Prior expanded persona (for voice-continuity reference — match its voice patterns where consistent with the new source, but do not preserve content that contradicts the new source):',
      priorExpanded,
    );
  }
  lines.push(
    '',
    'Expand into the four-section prompt now. If the name matches a known franchise character (e.g. Pikachu, Goku), let that context inform the CORE and VOICE sections.',
  );
  return lines.join('\n');
}

/** Type guard: does `x` expose an async iterator? Distinguishes the SDK's
 *  streaming `Stream` (production, `create({stream:true})`) from a plain
 *  message object returned by a `_clientFactory` test fake. */
function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
  return (
    x != null &&
    typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/** Pull the text out of a streaming `content_block_delta` event, or null for
 *  any other event type (message_start/stop, ping, content_block_start, …). */
function extractTextDelta(event: unknown): string | null {
  if (event == null || typeof event !== 'object') return null;
  const e = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  if (
    e.type === 'content_block_delta' &&
    e.delta != null &&
    e.delta.type === 'text_delta' &&
    typeof e.delta.text === 'string'
  ) {
    return e.delta.text;
  }
  return null;
}

/**
 * Expand a persona blurb into a structured long-form prompt via Anthropic.
 * Streams the response (so callers can drive a progress bar via `onProgress`)
 * and validates the accumulated text once the stream closes. Throws on missing
 * API key, incomplete response, or SDK error.
 */
export async function expandPersona(input: ExpandPersonaInput): Promise<ExpandPersonaResult> {
  const { name, source, priorExpanded, apiKey, cloudMode, signal, onProgress, _clientFactory } = input;

  if (cloudMode) {
    if (!cloudMode.baseURL || !cloudMode.authToken) {
      throw new Error('persona expansion failed: cloud-proxy mode requires baseURL and authToken');
    }
  } else if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('persona expansion failed: missing apiKey');
  }
  if (!source || typeof source !== 'string' || !source.trim()) {
    throw new Error('persona expansion failed: source blurb is empty');
  }
  // ITEM 12 (quick/260523-t8d): name is required so franchise context can
  // flow through. Missing/empty is a programmer error — CharacterSchema
  // (name.min(1)) enforces it upstream.
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('persona expansion failed: name is empty');
  }

  // Mirrors src/bot/brain/anthropicClient.js buildSdkOptions: in cloud-proxy
  // mode pass apiKey:null so the SDK does not emit X-Api-Key alongside the
  // Bearer header.
  const sdkOpts = cloudMode
    ? { baseURL: cloudMode.baseURL, authToken: cloudMode.authToken, apiKey: null as unknown as string | null }
    : { apiKey: apiKey! };

  const client = _clientFactory
    ? _clientFactory(sdkOpts)
    // Production path: construct the SDK client INSIDE this module so the
    // bot's createAnthropicClient (which is utilityProcess-only) is not
    // imported here. The main and bot sides each construct their own SDK
    // instance; that's fine — the SDK is a thin HTTP wrapper.
    : (new Anthropic(sdkOpts as unknown as ConstructorParameters<typeof Anthropic>[0]) as unknown as {
        messages: { create: (req: unknown, opts?: unknown) => Promise<unknown> };
      });

  const userMessage = buildExpansionUserMessage(name, source, priorExpanded);

  // Emit an immediate "connecting" tick so the renderer can paint the progress
  // bar the moment the IPC call lands — before the first token arrives (covers
  // network latency + a possible Fly proxy cold start). Small non-zero value so
  // there's visible motion right away.
  onProgress?.({ fraction: 0.02, section: 'Connecting' });

  // Throttle: text deltas arrive many times per second. Forward a tick only
  // when the fraction advances ≥1% or the section label changes — bounds IPC
  // chatter to ~100 events across a full expansion while staying smooth.
  let lastFraction = 0.02;
  let lastSection = 'Connecting';
  const emitProgress = (accumulated: string): void => {
    if (!onProgress) return;
    const raw = computeExpansionProgress(accumulated);
    // Never let the bar jump backward: the first chunks (before any header) can
    // compute a fraction below the initial "connecting" tick. Floor at the last
    // emitted value so the bar only ever advances.
    const fraction = Math.max(lastFraction, raw.fraction);
    if (fraction - lastFraction >= 0.01 || raw.section !== lastSection) {
      lastFraction = fraction;
      lastSection = raw.section;
      onProgress({ fraction, section: raw.section });
    }
  };

  // Accumulated assistant text. Set via the streaming path (production) or the
  // non-streaming fallback (test seam) below.
  let streamedText: string | null = null;
  let nonStreamResult: unknown = null;
  try {
    const result = await client.messages.create(
      {
        model: EXPANSION_MODEL,
        max_tokens: EXPANSION_MAX_TOKENS,
        system: EXPANSION_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        // Stream so we can drive a live progress bar. Cloud-proxy users stream
        // via the proxy's /free SSE passthrough; BYOK streams direct from
        // api.anthropic.com.
        stream: true,
      },
      // Per CLAUDE.md "every external call has a timeout". The Anthropic SDK
      // honors `timeout` at the request level and aborts the underlying fetch
      // when it elapses. `signal` (if passed) is plumbed so a renderer-side
      // cancel (e.g. closing the modal mid-call) unblocks the await.
      //
      // maxRetries:0 in cloud-proxy mode — a persona_daily 429 won't clear for
      // hours, so the SDK's default retry-with-backoff would just freeze the
      // progress bar at ~2% before eventually erroring. Fail fast so the caller
      // surfaces the limit modal immediately. BYOK keeps the SDK default (a
      // transient Anthropic 5xx is still worth retrying).
      { timeout: EXPANSION_TIMEOUT_MS, signal, maxRetries: cloudMode ? 0 : undefined },
    );

    if (isAsyncIterable(result)) {
      // Production: accumulate `text_delta` bodies as they stream in, ticking
      // the throttled progress sink after each one.
      let acc = '';
      for await (const event of result) {
        const delta = extractTextDelta(event);
        if (delta) {
          acc += delta;
          emitProgress(acc);
        }
      }
      streamedText = acc;
    } else {
      // Test seam: a `_clientFactory` fake returned a plain message object
      // ({ content: [...] }) rather than a Stream. Read it as a one-shot
      // response so existing fakes keep working without async-iterator plumbing.
      nonStreamResult = result;
    }
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const msg = (err instanceof Error) ? err.message : String(err);
    // Daily persona-expansion cap (proxy persona_daily 429). Throw a STABLE
    // sentinel the renderer pattern-matches to show the "come back tomorrow"
    // modal instead of the raw SDK error string.
    if (status === 429 || /rate_limited|persona_daily/i.test(msg)) {
      throw new Error('persona expansion failed: daily_limit_reached');
    }
    throw new Error(`persona expansion failed: ${msg}`);
  }

  // Derive the final text. For the non-streaming fallback, mirror the original
  // duck-typed extraction — kept OUTSIDE the try so these validation errors
  // aren't double-prefixed with "persona expansion failed:".
  let text: string;
  if (streamedText !== null) {
    text = streamedText.trim();
  } else {
    const content =
      nonStreamResult && typeof nonStreamResult === 'object' && 'content' in nonStreamResult
        ? (nonStreamResult as { content?: unknown }).content
        : null;
    if (!Array.isArray(content)) {
      throw new Error('persona expansion failed: response missing content array');
    }
    const firstText = content.find(
      (b): b is { type: 'text'; text: string } =>
        b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    );
    text = (firstText?.text ?? '').trim();
  }
  if (!text) {
    console.error('[personaExpansion] empty text in response');
    throw new Error('persona expansion failed: empty response from model');
  }
  // Cluster K (260525-tia) M18 — real-person likeness refusal sentinel.
  // EXPANSION_SYSTEM instructs the model to emit ONLY the literal
  // 'REFUSED:REAL_PERSON' when it detects a real living/recently-deceased
  // public figure in the source blurb. Detect that sentinel here BEFORE the
  // section validator (which would otherwise reject the refusal as
  // 'missing sections' — wrong error class for the user).
  //
  // Friendly message intentionally lowercase + casual to match the renderer's
  // existing error-chip register. The 'persona expansion failed:' prefix
  // is preserved so callers that pattern-match on it (e.g. characterStore)
  // continue to behave identically.
  //
  // Defensive note: a determined user can rewrite the source to disguise the
  // real-person reference. This guard adds friction and creates a documented
  // good-faith effort for right-of-publicity defense; it is NOT a perfect
  // filter. The strict-equality check is correct given the .trim() above —
  // no separate regex needed (Test 4 trailing-whitespace case covered).
  if (text === 'REFUSED:REAL_PERSON') {
    throw new Error(
      "persona expansion failed: you can't create characters of real people — " +
      'please use a fictional name and persona.',
    );
  }
  // Split off the leading `PROACTIVENESS: <word>` line — it's config-only and
  // must NOT ship in the persona text shown to the bot. `body` is the four
  // sections; `level` seeds the runtime dial (caller can override later).
  const { level: proactiveness, body: rawBody } = parseProactivenessLine(text);
  // Hard-drop em/en-dashes from the shipped persona, independent of model
  // compliance. The bot mirrors this prompt's register, so a stray dash here
  // teaches it to use them; normalize to a plain hyphen.
  const body = rawBody.replace(/[—–]/g, '-');
  // Validate the four required sections are present via tolerant regex.
  const missing = REQUIRED_SECTION_HEADERS.filter(h => !h.re.test(body)).map(h => h.name);
  if (missing.length > 0) {
    console.error('[personaExpansion] missing sections:', missing.join(', '));
    console.error('[personaExpansion] model returned:\n' + text);
    throw new Error(`persona expansion failed: missing sections (${missing.join(', ')})`);
  }
  return { expanded: body, proactiveness };
}
