/**
 * Chat-side MEMORY.md compaction (260810).
 *
 * The Minecraft bot has compacted MEMORY.md since 260703 (compactor.js, fired
 * after remember() when the file exceeds memory.compaction_trigger_bytes =
 * 8192). The chat-family surfaces (chat, voice, chess, Draw!, backseat) never
 * did: they append via the same memoryLog.js but only ever READ a 12000-byte
 * tail (readMemoryTail). So a character that is never summoned grows MEMORY.md
 * forever — old real memories fall off the visible tail while the file bloats
 * (measured: Sui at 43 KB after a week of backseat sessions, with everything
 * before Aug 7 invisible to every prompt).
 *
 * This module is the main-process trigger. It REUSES the bot's compactor
 * wholesale (createMemoryCompactor is plain ESM over node:fs + the pure
 * promptLibrary — main already imports memoryLog.js from the same directory),
 * adapting main's chat SDK (cloud-proxy vs BYOK aware, same plumbing as every
 * chat turn) to the compactor's `anthropic.call()` interface. One compactor,
 * one prompt, two surfaces.
 *
 * RACE GUARD — the bot process may be compacting the same file:
 *   - The file lock serializing MEMORY.md writers (fileLock.js) is IN-PROCESS
 *     only, so main must not compact while a bot for this character is live.
 *     isCharacterSummoned (botSupervisor, includes pending summons) gates every
 *     pass; the summon side needs no gate because the bot only compacts after
 *     its own remember() calls, which cannot happen before main's pass ends...
 *     except across the summon boundary — for that window the compactor's own
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

/**
 * Trigger threshold, deliberately 4x the bot's 8192.
 *
 * The bot compacts at 8 KB because it reads MEMORY.md nearly whole into every
 * loop seed, so an oversized file costs every single turn. The chat surfaces
 * read only a fixed 12000-byte TAIL, so there is no per-turn urgency at all —
 * the only job here is to keep the file from growing without bound and to
 * fold weeks-old entries back into the visible tail before they are lost to
 * every prompt. Compacting late (32 KB) preserves full detail for longer,
 * spends the Sonnet call rarely, and the compactor's ~one-third target lands
 * the result (~11 KB) back inside the 12000-byte tail, so right after a pass
 * the surfaces see the character's WHOLE memory again.
 */
export const CHAT_COMPACTION_TRIGGER_BYTES = 32768;

/** Chat turns get 30s (CHAT_TIMEOUT_MS); a rare background Sonnet call over a
 *  big segment deserves the same, not the bot's 20s. */
const COMPACTION_TIMEOUT_MS = 30_000;

/** Output budget per segment call. The bot keeps its 1024 (8 KB trigger); a
 *  32 KB file's dominant segment can need a one-third target well past that. */
const COMPACTION_MAX_TOKENS = 3000;

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
  }): Promise<{ text: string }> {
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
      const modelRejected = /invalid_model|model/i.test(msg) && /\b400\b|not_found|invalid/i.test(msg);
      if (!modelRejected) throw err;
      // Lazy sdk re-import for the fallback model id only: several existing
      // test files mock './sdk' with just { buildChatSdk }, and a static
      // named import of CHAT_MODEL here would break their module graphs.
      const sdkMod = (await import('./sdk')) as { CHAT_MODEL?: string };
      const fallbackModel = sdkMod.CHAT_MODEL ?? 'claude-haiku-4-5';
      console.warn(`[sei] compaction model ${opts.model} rejected (${msg}); compacting with ${fallbackModel}`);
      res = await run(fallbackModel);
    }
    const text = res.content
      .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
      .join('');
    return { text };
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
const compactors = new Map<string, { personaKey: string; compactor: CompactorLike }>();

function getCompactor(characterId: string, filePath: string, personaExpanded: string): CompactorLike {
  const cached = compactors.get(characterId);
  if (cached && cached.personaKey === personaExpanded) return cached.compactor;
  const compactor = createMemoryCompactor({
    anthropic: chatAnthropicAdapter,
    memoryLog: { path: filePath },
    config: {
      anthropic: { timeout_ms: COMPACTION_TIMEOUT_MS },
      memory: {
        compaction_trigger_bytes: CHAT_COMPACTION_TRIGGER_BYTES,
        compaction_max_tokens: COMPACTION_MAX_TOKENS,
      },
      ...(personaExpanded ? { persona: { expanded: personaExpanded } } : {}),
    },
    logger: console,
  }) as CompactorLike;
  compactors.set(characterId, { personaKey: personaExpanded, compactor });
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
    // Size gate FIRST — it is the hot path (fired after every chat reply via
    // foldIfDue) and must stay a single stat() with no other module loads.
    let size = 0;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return false; // no MEMORY.md yet
    }
    if (size < CHAT_COMPACTION_TRIGGER_BYTES) return false;

    // Race guard: never compact while this character's bot process is live —
    // it runs its own compactor over the same file and the write lock is
    // in-process only. Dynamic import keeps the module graph acyclic
    // (botSupervisor statically imports continuity, which imports this file).
    const { isCharacterSummoned } = await import('../botSupervisor');
    if (isCharacterSummoned(characterId)) return false;

    // Persona (for the compacted entries' voice) — best-effort; compaction
    // without a persona is still correct.
    let personaExpanded = '';
    try {
      const { getCharacter } = await import('../characterStore');
      const character = await getCharacter(characterId);
      personaExpanded = character?.persona?.expanded ?? '';
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
