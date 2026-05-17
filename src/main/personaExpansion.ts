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
 *   - Fixed model: 'claude-haiku-4-5-20251001' (matches src/bot/config.js D-20).
 *   - Wall-clock timeout: 30s (per CLAUDE.md "every external call has a
 *     timeout"). Plumbed through the SDK's request-level `timeout` option,
 *     which the SDK enforces internally (no Promise.race wrapper needed).
 *   - Output must include all six section headers (# IDENTITY, # VOICE,
 *     # DEFAULT DYNAMIC WITH THE PLAYER, # PROACTIVENESS, # REACTIONS,
 *     # MEMORY — write in YOUR voice). Missing any → throw
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

export const EXPANSION_MODEL = 'claude-haiku-4-5-20251001';
export const EXPANSION_TIMEOUT_MS = 30_000;
export const EXPANSION_MAX_TOKENS = 2048;

/**
 * System prompt for the expansion call. Stable — does NOT include any
 * per-call data (no player name, no session data, no live config). The
 * model is instructed to produce exactly six markdown sections in order,
 * stay in second-person (addressing the bot's identity as "you"), and
 * avoid meta-references to LLMs / AI / assistants / Anthropic.
 */
export const EXPANSION_SYSTEM = [
  'You are a persona prompt expander. The user gives you a short blurb describing a Minecraft companion character. You expand it into a structured prompt that will be fed as a system block to that character\'s LLM at every turn.',
  '',
  'Output EXACTLY these six markdown sections in this order. Each section MUST begin with the header line shown below (verbatim, including the leading `# `):',
  '',
  '1. `# IDENTITY` — name, who they are, brief backstory (2-3 sentences).',
  '2. `# VOICE` — register, casing, punctuation preferences, and 5 to 7 sample one-line utterances in their voice (each on its own line).',
  '3. `# DEFAULT DYNAMIC WITH THE PLAYER` — their default relationship stance toward the human player (servant, rival, friend, lover, stranger, etc.) and how it shapes the way they talk to the player.',
  '4. `# PROACTIVENESS` — when this character initiates conversation versus when they stay silent. Be specific: idle ticks, post-action moments, the player joining, etc.',
  '5. `# REACTIONS` — bullet list keyed by: commanded, insulted, praised, ignored, attacked. One short line per key describing how this character reacts.',
  '6. `# MEMORY` — how this character writes MEMORY.md entries (always in their own voice, first-person, subjective). Show 2 good vs 2 bad example entries for THIS character. Good entries are in their voice and capture what they would actually remember about a moment with the player. Bad entries are flat / generic / out-of-character. Show, do not tell.',
  '',
  'Style rules:',
  '- Address the prompt to "you" — the character\'s identity, second person.',
  '- Do NOT invent specific player names, biome names, or session details. The bot will fill in particulars from snapshot + memory at runtime.',
  '- Do NOT include meta-references to LLMs, AI, assistants, Anthropic, or "the model". The character is a real person from their own point of view; never break that frame.',
  '- Keep each section terse and specific. Sample lines must be short and feel like in-game chat, not narration.',
  '- Output ONLY the six sections. No preamble, no closing summary, no commentary about your task.',
].join('\n');

export interface ExpandPersonaInput {
  source: string;
  priorExpanded?: string;
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Test-only seam: factory that produces an object exposing
   * `messages.create({...}, { signal, timeout })`. Production calls
   * `new Anthropic({ apiKey })`.
   */
  _clientFactory?: (apiKey: string) => {
    messages: { create: (req: unknown, opts?: unknown) => Promise<unknown> };
  };
}

export interface ExpandPersonaResult {
  expanded: string;
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
  { name: 'IDENTITY',       re: /^\s*#+\s*IDENTITY\b/im },
  { name: 'VOICE',          re: /^\s*#+\s*VOICE\b/im },
  { name: 'DEFAULT DYNAMIC', re: /^\s*#+\s*DEFAULT\s+DYNAMIC\b/im },
  { name: 'PROACTIVENESS',  re: /^\s*#+\s*PROACTIVENESS\b/im },
  { name: 'REACTIONS',      re: /^\s*#+\s*REACTIONS\b/im },
  // MEMORY header may use em-dash, en-dash, or hyphen between MEMORY and
  // the qualifier — accept any. Also accept MEMORY alone (no qualifier).
  { name: 'MEMORY',         re: /^\s*#+\s*MEMORY\b/im },
];

/**
 * Build the per-call user message. The source is the primary input;
 * priorExpanded (when present) is appended as a voice-continuity reference
 * for the regeneration-on-edit path.
 */
export function buildExpansionUserMessage(source: string, priorExpanded?: string): string {
  const lines: string[] = [
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
  lines.push('', 'Expand into the six-section prompt now.');
  return lines.join('\n');
}

/**
 * Expand a persona blurb into a structured long-form prompt via Anthropic.
 * Throws on missing API key, incomplete response, or SDK error.
 */
export async function expandPersona(input: ExpandPersonaInput): Promise<ExpandPersonaResult> {
  const { source, priorExpanded, apiKey, signal, _clientFactory } = input;

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('persona expansion failed: missing apiKey');
  }
  if (!source || typeof source !== 'string' || !source.trim()) {
    throw new Error('persona expansion failed: source blurb is empty');
  }

  const client = _clientFactory
    ? _clientFactory(apiKey)
    // Production path: construct the SDK client INSIDE this module so the
    // bot's createAnthropicClient (which is utilityProcess-only) is not
    // imported here. The main and bot sides each construct their own SDK
    // instance; that's fine — the SDK is a thin HTTP wrapper.
    : (new Anthropic({ apiKey }) as unknown as {
        messages: { create: (req: unknown, opts?: unknown) => Promise<unknown> };
      });

  const userMessage = buildExpansionUserMessage(source, priorExpanded);

  let resp: unknown;
  try {
    resp = await client.messages.create(
      {
        model: EXPANSION_MODEL,
        max_tokens: EXPANSION_MAX_TOKENS,
        system: EXPANSION_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      },
      // Per CLAUDE.md "every external call has a timeout". The Anthropic SDK
      // honors `timeout` at the request level and aborts the underlying
      // fetch when it elapses. `signal` (if passed) is also plumbed so
      // a renderer-side cancel (e.g., user closes the modal mid-call) can
      // unblock the await.
      { timeout: EXPANSION_TIMEOUT_MS, signal },
    );
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : String(err);
    throw new Error(`persona expansion failed: ${msg}`);
  }

  // Pull the first text block out of the SDK response. The SDK returns
  //   { content: [{ type: 'text', text: '...' }, ...], ... }
  // We don't rely on @anthropic-ai/sdk types here (tsconfig.node.json's
  // allowJs makes that awkward across compiler boundaries); a narrow
  // duck-type check is enough.
  const content =
    resp && typeof resp === 'object' && 'content' in resp
      ? (resp as { content?: unknown }).content
      : null;
  if (!Array.isArray(content)) {
    throw new Error('persona expansion failed: response missing content array');
  }
  const firstText = content.find(
    (b): b is { type: 'text'; text: string } =>
      b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  );
  const text = (firstText?.text ?? '').trim();
  if (!text) {
    console.error('[personaExpansion] empty text in response:', JSON.stringify(resp).slice(0, 500));
    throw new Error('persona expansion failed: empty response from model');
  }
  // Validate the six required sections are present via tolerant regex.
  const missing = REQUIRED_SECTION_HEADERS.filter(h => !h.re.test(text)).map(h => h.name);
  if (missing.length > 0) {
    console.error('[personaExpansion] missing sections:', missing.join(', '));
    console.error('[personaExpansion] model returned:\n' + text);
    throw new Error(`persona expansion failed: missing sections (${missing.join(', ')})`);
  }
  return { expanded: text };
}
