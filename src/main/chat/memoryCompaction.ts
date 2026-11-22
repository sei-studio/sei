/**
 * Chat-side MEMORY.md compaction (260810).
 *
 * The Minecraft bot has compacted MEMORY.md since 260703 (compactor.js, fired
 * after remember() when the file exceeds memory.compaction_trigger_bytes =
 * 8192). The chat-family surfaces (chat, voice, chess, Draw!, backseat) never
 * did: they append via the same memoryLog.js but only ever READ a 12000-byte
 * tail (readMemoryTail). So a character that is never summoned grows MEMORY.md
 * forever â€” old real memories fall off the visible tail while the file bloats
 * (measured: Sui at 43 KB after a week of backseat sessions, with everything
 * before Aug 7 invisible to every prompt).
 *
 * This module is the main-process trigger. It REUSES the bot's compactor
 * wholesale (createMemoryCompactor is plain ESM over node:fs + the pure
 * promptLibrary â€” main already imports memoryLog.js from the same directory),
 * adapting main's chat SDK (cloud-proxy vs BYOK aware, same plumbing as every
 * chat turn) to the compactor's `anthropic.call()` interface. One compactor,
 * one prompt, two surfaces.
 *
 * RACE GUARD â€” the bot process may be compacting the same file:
 *   - The file lock serializing MEMORY.md writers (fileLock.js) is IN-PROCESS
 *     only, so main must not compact while a bot for this character is live.
 *     isCharacterSummoned (botSupervisor, includes pending summons) gates every
 *     pass; the summon side needs no gate because the bot only compacts after
 *     its own remember() calls, which cannot happen before main's pass ends...
 *     except across the summon boundary â€” for that window the compactor's own
 *     lost-update guard (re-read + discard on drift before writing) bounds the
 *     damage to "this pass is discarded", never a lost entry.
 *   - Single-flight per character within main (this module's inFlight set, on
 *     top of the compactor instance's own inFlight flag).
 *
 * Failures are silent no-ops (log only) and never block a chat turn: the sole
 * caller is fire-and-forget from foldIfDue / honorRememberCalls.
 */
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { paths } from '../paths';
import { buildLlmProvider } from '../llm';
import { createMemoryCompactor } from '../../bot/brain/memory/compactor.js';
import { COMPANION_MODEL } from '../../shared/llmCatalog';
import { isModelRequestRejection } from './modelRejection';

/**
 * Trigger threshold, deliberately 4x the bot's 8192.
 *
 * The bot compacts at 8 KB because it reads MEMORY.md nearly whole into every
 * loop seed, so an oversized file costs every single turn. The chat surfaces
 * read only a fixed 12000-byte TAIL, so there is no per-turn urgency at all â€”
 * the only job here is to keep the file from growing without bound and to
 * fold weeks-old entries back into the visible tail before they are lost to
 * every prompt. Compacting late (32 KB) preserves full detail for longer,
 * spends the Sonnet call rarely, and the compactor's ~one-third target lands
 * the result (~11 KB) back inside the 12000-byte tail, so right after a pass
 * the surfaces see the character's WHOLE memory again.
 */
export const CHAT_COMPACTION_TRIGGER_BYTES = 32768;

/** Background only. 261024: raised from 30s, since a chunk's reply with
 *  Sonnet's thinking can run to ~5k tokens (measured 4,728 on a 10 KB chunk),
 *  about a minute. */
const COMPACTION_TIMEOUT_MS = 120_000;

/** Output budget per compaction call (the bot's default is 4096 at its 8 KB trigger).
 *  261024: sized with COMPACTION_CHUNK_BYTES so a nearly verbatim reply plus
 *  Sonnet's default thinking still fits: a reply cut off here is thrown away
 *  (the chunk keeps its originals), so a cap that is too small means the chunk
 *  never compacts. */
const COMPACTION_MAX_TOKENS = 8000;

/** 261024: most entry text sent in one compaction call (about 2,900 input
 *  tokens). At the 32 KB trigger a mostly-chat user has one section of about
 *  290 entries; sent whole, its reply ran past the old 3000-token cap (Sonnet
 *  kept 240 of 255 entries on one eval file) and the entries after the cut
 *  were lost. Measured on that file with chunks of this size: 3 calls, no
 *  cut-off, 19.6 KB down to 6.5-6.9 KB, replies of 650-4,730 output tokens
 *  (Sonnet's thinking included). */
const COMPACTION_CHUNK_BYTES = 10_240;

interface CompactorLike {
  maybeCompact(): Promise<boolean>;
}

/**
 * Adapter: the compactor's `anthropic.call({systemBlocks, messages, ...})` on
 * top of main's chat SDK. Credentials are read fresh per call (buildChatSdk),
 * so a cloud<->local switch or JWT rotation mid-pass is picked up. Mirrors
 * continuity.ts's model-rejection fallback: a cloud proxy that has not
 * allowlisted the Sonnet id must degrade to CHAT_MODEL, not silently disable
 * compaction forever.
 */
const chatAnthropicAdapter = {
  async call(opts: {
    systemBlocks: Array<{ type: string; text: string }>;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    timeoutMs: number;
    maxTokens: number;
    model: string;
  }): Promise<{ text: string; stopReason: string | null }> {
    const llm = await buildLlmProvider();
    const system = opts.systemBlocks.map((b) => b.text).join('\n\n');
    const run = (model: string) =>
      llm.call({
        model,
        maxTokens: opts.maxTokens,
        system,
        messages: opts.messages,
        timeoutMs: opts.timeoutMs,
      });
    let res: Awaited<ReturnType<typeof run>>;
    try {
      res = await run(opts.model);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!isModelRequestRejection(msg)) throw err;
      // Lazy sdk re-import for the fallback model id only: several existing
      // test files mock './sdk' with just { buildChatSdk }, and a static
      // named import of CHAT_MODEL here would break their module graphs.
      const sdkMod = (await import('./sdk')) as { CHAT_MODEL?: string };
      const fallbackModel = sdkMod.CHAT_MODEL ?? COMPANION_MODEL;
      console.warn(`[sei] compaction model ${opts.model} rejected (${msg}); compacting with ${fallbackModel}`);
      res = await run(fallbackModel);
    }
    // 261024: the stop reason goes back to the compactor, which keeps the
    // originals when a reply was cut off at maxTokens (a partial list).
    const text = res.content
      .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
      .join('');
    return { text, stopReason: res.stopReason ?? null };
  },
};

/** Single-flight per character within main (see module doc). */
const inFlight = new Set<string>();

/**
 * Per-character compactor instances, kept so the plateau backoff inside
 * createMemoryCompactor survives across triggers (without it, a file that
 * cannot shrink would re-pay futile Sonnet calls on every remember()).
 * Rebuilt when the persona text changes (rare; the plateau state is an
 * acceptable loss there).
 */
const compactors = new Map<string, { personaKey: string; filePath: string; compactor: CompactorLike }>();

function getCompactor(characterId: string, filePath: string, personaExpanded: string): CompactorLike {
  const cached = compactors.get(characterId);
  // The file path is part of the key (260926): it carries the profile scope,
  // and the bundled defaults share ids (and personas) across profiles, so a
  // compactor cached under one account would otherwise go on compacting that
  // account's MEMORY.md after a switch to another.
  if (cached && cached.personaKey === personaExpanded && cached.filePath === filePath) {
    return cached.compactor;
  }
  const compactor = createMemoryCompactor({
    anthropic: chatAnthropicAdapter,
    memoryLog: { path: filePath },
    config: {
      anthropic: { timeout_ms: COMPACTION_TIMEOUT_MS },
      memory: {
        compaction_trigger_bytes: CHAT_COMPACTION_TRIGGER_BYTES,
        compaction_max_tokens: COMPACTION_MAX_TOKENS,
        compaction_chunk_bytes: COMPACTION_CHUNK_BYTES,
        compaction_timeout_ms: COMPACTION_TIMEOUT_MS,
      },
      ...(personaExpanded ? { persona: { expanded: personaExpanded } } : {}),
    },
    logger: console,
  }) as CompactorLike;
  compactors.set(characterId, { personaKey: personaExpanded, filePath, compactor });
  return compactor;
}

/**
 * Fire-and-forget compaction check. Cheap when under threshold (one stat()),
 * so callers may invoke it on every fold/remember without thought. Never
 * throws. Returns whether a pass actually rewrote the file (for tests).
 */
export async function maybeCompactChatMemory(characterId: string): Promise<boolean> {
  if (inFlight.has(characterId)) return false;
  inFlight.add(characterId);
  try {
    const filePath = path.join(paths.memoryDir(characterId), 'MEMORY.md');
    // Size gate FIRST â€” it is the hot path (fired after every chat reply via
    // foldIfDue) and must stay a single stat() with no other module loads.
    let size = 0;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return false; // no MEMORY.md yet
    }
    if (size < CHAT_COMPACTION_TRIGGER_BYTES) return false;

    // Race guard: never compact while this character's bot process is live â€”
    // it runs its own compactor over the same file and the write lock is
    // in-process only. Dynamic import keeps the module graph acyclic
    // (botSupervisor statically imports continuity, which imports this file).
    const { isCharacterSummoned } = await import('../botSupervisor');
    if (isCharacterSummoned(characterId)) return false;

    // Persona (for the compacted entries' voice) â€” best-effort; compaction
    // without a persona is still correct.
    let personaExpanded = '';
    try {
      const { getCharacter } = await import('../characterStore');
      const character = await getCharacter(characterId);
      personaExpanded = character?.persona?.expanded ?? '';
      // 261013: card {{user}}/{{char}} placeholders (no lookup when absent).
      if (personaExpanded) {
        const { resolvePersonaText } = await import('./personaText');
        personaExpanded = await resolvePersonaText(characterId, personaExpanded);
      }
    } catch {
      /* persona stays empty */
    }

    const compactor = getCompactor(characterId, filePath, personaExpanded);
    return await compactor.maybeCompact();
  } catch (err) {
    console.warn(
      `[sei] chat memory compaction failed for ${characterId}: ${(err as Error)?.message ?? err}`,
    );
    return false;
  } finally {
    inFlight.delete(characterId);
  }
}




