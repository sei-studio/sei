/**
 * Cross-surface continuity bridge (design: docs/design/app-chat-and-memory.md §4).
 *
 * Three tiers carry memory across the chat and Minecraft surfaces:
 *   1. MEMORY.md — durable, shared, already compacted (read directly by both).
 *   2. bridge.json — a recursive rolling summary of conversation that has aged
 *      past the recent window (cap ~150 words). Updated incrementally
 *      (new = f(old, evicted)) with a watermark, so an unchanged window costs 0.
 *   3. recent window — every not-yet-summarized message, verbatim.
 *
 * Compaction cadence (260702): folds run in BATCHES of 50, not per-message.
 * The unsummarized tail grows from 50 up to 99 verbatim messages; when it
 * reaches 100 (window 50 + batch 50) the oldest messages fold into the summary,
 * leaving exactly the last 50 verbatim. So context right after a compaction is
 * summary + 50 lines, and a single aged-out message never costs an LLM call.
 *
 * WHO folds: only the chat surface, in the BACKGROUND — chatService fires
 * foldIfDue() after each reply is persisted, so compaction runs while the
 * player is typing and no turn ever waits on it. Reads (readChatContext for
 * chat turns, buildLaunchContinuity for MC launches) are PURE — disk only,
 * never an LLM call — so Minecraft summoning is completely decoupled from
 * compaction. A fold backlog (e.g. a long in-game chat session appending
 * messages without chat turns) just means the next read ships a bigger
 * verbatim tail until the next chat turn drains it.
 *
 * The fold is written by Haiku 5.5 with adaptive thinking (261024; it was
 * Sonnet 5 before). It receives the persona so the summary is in the
 * companion's own voice, and it is told to record only what was actually
 * said: an earlier Haiku 4.5 fold asserted "we're playing now" off a join that
 * never landed, and that false fact was re-injected into every later turn.
 * The switch was gated on scripts/summary-model-eval.ts (12 synthetic call and
 * chat batches built around traps, 3 runs each, judged by Opus): with the
 * 261024 prompt and thinking on, Haiku invented less than Sonnet did on the old
 * prompt, never asserted a trap, and costs about a twelfth as much per fold.
 * The fold was the largest Sonnet cost on free voice calls.
 */
import { readFile, writeFile, mkdir, rm, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../../shared/ipc';
import { paths, getActiveScope } from '../paths';
import { isAccountTeardownActive } from '../profile/scopeBarrier';
import { readAll } from './chatStore';
import { CHAT_MODEL } from './sdk';
import { COMPANION_MODEL } from '../../shared/llmCatalog';
// The multi-provider layer (china-compat W1). Anthropic (cloud + BYOK) rides
// the exact old SDK path inside it; other local providers ignore the SUMMARY
// model override and fold with their single configured model.
import { buildLlmProvider } from '../llm';
import { formatChatTimestamp, type FoldMsg } from './foldPrompt';
import {
  chatContextFrom,
  launchContinuityFrom,
  runFold,
  selectFold,
  windowOf,
  type BridgeState,
  type LaunchContinuity,
} from './continuityCore';
import { isModelRequestRejection } from './modelRejection';
import { maybeCompactChatMemory } from './memoryCompaction';
import { memoryForFold, saveFacts, type FactSave } from './memoryFacts';
import { capture } from '../analytics';
import { resolvePersonaText } from './personaText';

// Re-export for the existing consumers (chatService and friends import it from
// here). The definition moved to foldPrompt.ts (260810) so the offline fold
// eval can build byte-identical prompts without dragging in electron.
export { formatChatTimestamp };
export type { LaunchContinuity };

// RECENT_WINDOW (50), FOLD_BATCH (50), MAX_UNSUMMARIZED (150) and
// FOLD_MAX_MESSAGES (300) live in continuityCore.ts with the pure selection
// they drive (261113).
/**
 * The summary fold's model (261024): the companion model, Haiku 5.5, with
 * adaptive thinking (SUMMARY_EXTRA). Measured on scripts/summary-model-eval.ts
 * against claude-sonnet-5, which folded before: over 72 runs per arm Haiku
 * with thinking invented a fact in 20 runs (Sonnet 43), hit no trap (Sonnet
 * 2), and its worst case was 2 of 3 runs on one batch (Sonnet 3 of 3 on
 * several). It drops more side details (a pet's quirk, a joke's backstory);
 * names, dates, plans and requests held. Without thinking Haiku asserted traps
 * (a wrong birthday, "you promised I could come") and stayed off. Cost per
 * fold on the eval batches: about $0.0008 against $0.009.
 * Cloud-proxy note: this rides the metered /v1/messages route, so the proxy's
 * PRICING table must know this model id (it does: every chat turn uses it).
 */
const SUMMARY_MODEL = COMPANION_MODEL;
/** Haiku 5 defaults thinking off in this app (anthropicModelDefaults.js); the fold asks for it. */
const SUMMARY_EXTRA = { thinking: { type: 'adaptive' } };
/**
 * Thinking tokens count against max_tokens, and a summary cut off by the cap
 * is discarded (see the max_tokens check in foldIntoSummary). The eval's
 * largest fold output with thinking was about 1,450 tokens; 4000 leaves room.
 * (260810: Sonnet's hidden thinking had already pushed this from 400 to 800.)
 */
// SUMMARY_MAX_TOKENS (4000) lives in continuityCore.ts runFold.
const SUMMARY_TIMEOUT_MS = 30_000;


function bridgePath(id: string): string {
  return path.join(paths.memoryDir(id), 'bridge.json');
}

/** One-generation backup of the previous bridge, kept beside it (260810). */
function prevBridgePath(id: string): string {
  return path.join(paths.memoryDir(id), 'bridge.prev.json');
}

async function readBridge(id: string): Promise<BridgeState> {
  try {
    const parsed = JSON.parse(await readFile(bridgePath(id), 'utf8'));
    return { summary: String(parsed.summary ?? ''), summarizedCount: Number(parsed.summarizedCount ?? 0) };
  } catch {
    return { summary: '', summarizedCount: 0 };
  }
}

/**
 * 260810 fold safety: the bridge is the ONLY copy of everything already folded
 * (the folded messages themselves are past the watermark and never re-read), so
 * a torn write here is permanent summary loss. Two protections:
 *   1. tmp + rename (same-directory, so the rename is atomic) — a crash
 *      mid-write leaves the old bridge.json intact, never a partial file.
 *   2. a one-generation bridge.prev.json copy before every overwrite — the
 *      260808 incident (20 consecutive folds over phantom voice rows eroding a
 *      good summary) had NO recovery path because each fold overwrote the only
 *      copy. prev.json is not read by the app; it exists for manual recovery.
 */
async function writeBridge(id: string, s: BridgeState): Promise<void> {
  const dest = bridgePath(id);
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await copyFile(dest, prevBridgePath(id));
  } catch {
    /* first write — nothing to back up */
  }
  const tmp = path.join(path.dirname(dest), `.bridge.json.tmp.${process.pid}.${Date.now()}`);
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
  await rename(tmp, dest);
}

/** Current rolling summary text (read-only; for the chat surface). */
export async function readSummary(id: string): Promise<string> {
  return (await readBridge(id)).summary;
}

/**
 * 260705: per-character clear generation — supersede guard for the fold's LLM
 * gap. foldIntoSummary snapshots the transcript, then spends up to
 * SUMMARY_TIMEOUT_MS in the summarizer; a chat:clear landing inside that gap
 * deletes bridge.json, and an unconditional writeBridge afterwards would
 * RESURRECT a summary of the wiped conversation. Same shape as chatService's
 * inflight controller: capture before the call, compare after, drop the write
 * when superseded.
 */
const clearEpochs = new Map<string, number>();
const clearEpoch = (id: string): number => clearEpochs.get(id) ?? 0;

/**
 * Drop the rolling summary + watermark for a character. Called from chat:clear
 * alongside chatStore.clear so wiping the transcript also wipes the derived
 * summary — otherwise a later summon would re-seed a stale summary of a
 * conversation the player already cleared.
 */
export async function clearContinuity(id: string): Promise<void> {
  clearEpochs.set(id, clearEpoch(id) + 1);
  await rm(bridgePath(id), { force: true });
  // The one-generation backup describes the same wiped conversation.
  await rm(prevBridgePath(id), { force: true });
}

/**
 * Shared read core: transcript + bridge + clamped watermark. PURE — never
 * folds, never calls an LLM. 260705: a bridge whose watermark outran the
 * transcript (a clear racing a fold, manual edits) is treated as a RESET, so a
 * shrunken transcript degrades to "no summary", never "no history"; and the
 * watermark is lower-clamped to counted - MAX_UNSUMMARIZED so a persistently
 * failing fold drops the oldest messages instead of growing context until
 * every turn 400s (continuityCore.ts effectiveBridge / windowOf).
 */
async function readWindow(
  characterId: string,
): Promise<{ bridge: BridgeState; raw: ChatMessage[]; watermark: number }> {
  const raw = await readAll(characterId);
  const { bridge, watermark } = windowOf(raw, await readBridge(characterId));
  return { bridge, raw, watermark };
}

/**
 * Characters with a fold currently in flight. foldIfDue is fired without await
 * from chat turns; if the player sends several messages while a fold's LLM
 * call runs, the extra triggers must not each fold the same batch (double
 * spend + duplicated content in the summary).
 */
const foldInFlight = new Set<string>();

/**
 * Run one batch fold if due — the ONLY compaction entry point. Fired in the
 * background (fire-and-forget) by chatService after a reply is persisted, so
 * it runs while the player is typing. Folds everything except the newest
 * RECENT_WINDOW (bounded per call by FOLD_MAX_MESSAGES, so a huge backlog
 * drains incrementally across calls rather than in one unbounded fold), so
 * the verbatim tail normally resets to exactly 50. No-op when under the
 * trigger or when a fold for this character is already running.
 */
/**
 * 260810: hard cap on messages drained by ONE fold call. A huge backlog (a
 * marathon backseat session appends thousands of rows with no chat turns; the
 * 260808 session left summarizedCount 2000+ behind) used to fold in a single
 * unbounded LLM call — a transcript that big both risks the context window and
 * hands one bad batch the power to rewrite the whole summary at once. Capped,
 * the backlog drains incrementally: foldIfDue fires after every reply and at
 * every surface's end choke point, so successive calls each take one bounded
 * bite until the tail is back to RECENT_WINDOW.
 */
export async function foldIfDue(characterId: string, personaExpanded?: string): Promise<void> {
  // 260926: deferred, not dropped, while an account switch is ending the old
  // account's sessions. authState has already applied the NEW session by then,
  // so an LLM fold (or compaction) here would bill the incoming account for
  // the outgoing account's summary. The watermark stays put; the next fold in
  // the old account folds these rows.
  if (isAccountTeardownActive()) return;
  // Chat-side MEMORY.md compaction (260810) piggybacks on the fold cadence:
  // foldIfDue is already fired (fire-and-forget) by every surface that appends
  // memory in main — chat turns, chess, Draw!, backseat — so this one hook
  // covers them all without touching each service. Self-single-flighted and
  // it exits on a cheap stat() when under threshold; never blocks the fold.
  void maybeCompactChatMemory(characterId).catch(() => {});
  if (foldInFlight.has(characterId)) return;
  foldInFlight.add(characterId);
  try {
    // 260705: capture BEFORE the transcript read — a clear landing between
    // this snapshot and the summarizer's return must invalidate the fold.
    const epoch = clearEpoch(characterId);
    // 260926: and the profile scope, compared before the write like the epoch.
    const scope = getActiveScope();
    const raw = await readAll(characterId);
    // Same stale-bridge reset as readWindow (shrunken transcript → the summary
    // describes messages that no longer exist): degrade to "no summary" rather
    // than folding fresh messages into a stale one. 261113: the batch carries
    // the play rows among its messages (continuityCore.ts selectFold).
    const batch = selectFold(raw, await readBridge(characterId));
    if (!batch) return;
    // The reads above can straddle an account switch too: a transcript read
    // in one scope must never be folded against another scope's bridge.
    if (getActiveScope() !== scope) return;
    // 261013: card {{user}}/{{char}} placeholders, filled (no lookup when absent).
    const persona = await resolvePersonaText(characterId, personaExpanded);
    if (getActiveScope() !== scope) return;
    await foldIntoSummary(characterId, batch.bridge, batch.msgs, batch.counted, epoch, persona, scope);
  } finally {
    foldInFlight.delete(characterId);
  }
}

/**
 * Context window for a CHAT turn: the rolling summary + every raw transcript
 * row (including system rows, which toMessages needs for play events) from the
 * watermark onward. Pure read — compaction happens separately via foldIfDue.
 */
export async function readChatContext(
  characterId: string,
): Promise<{ summary: string; history: ChatMessage[]; base: number }> {
  // System rows (play sessions, call rows) ride along with the era they
  // belong to; rows older than the watermark are already covered by the fold.
  // base (261024): the absolute position, among user/companion rows, of the
  // first such row in `history`. The voice window counts its steps from it so
  // they stay put when the front of `history` moves (voiceWindowStart).
  return chatContextFrom(await readAll(characterId), await readBridge(characterId));
}

/**
 * Build the MC-launch handoff: { summary, recent } where `recent` is the full
 * unsummarized tail (50-99 messages between folds), and (261113) the game
 * sessions among them with what happened in each, so the next game knows the
 * last one. Returns null when there is nothing yet. PURE READ — a summon never
 * runs compaction; it ships whatever the chat surface's background folds have
 * produced so far.
 */
export async function buildLaunchContinuity(
  characterId: string,
): Promise<LaunchContinuity | null> {
  return launchContinuityFrom(await readAll(characterId), await readBridge(characterId));
}

async function foldIntoSummary(
  id: string,
  bridge: BridgeState,
  newMsgs: FoldMsg[],
  // 261113: how many user/companion rows the batch holds (the watermark's
  // step); its play rows never count.
  counted: number,
  // 260705: the clear epoch foldIfDue captured BEFORE snapshotting the
  // transcript; compared before writeBridge.
  epoch: number,
  personaExpanded?: string,
  // 260926: the profile scope foldIfDue started in (see the check below).
  scope: string = getActiveScope(),
): Promise<BridgeState> {
  try {
    const llm = await buildLlmProvider();
    // 261113 (v0.7 D2): the fold also returns the durable facts of the batch
    // that memory does not have yet (memoryFacts.ts). It is shown the memory
    // the chat reads, and the path is fixed here, in the scope the fold began.
    const memoryFile = path.join(paths.memoryDir(id), 'MEMORY.md');
    let memoryBody = '';
    try {
      memoryBody = await readFile(memoryFile, 'utf8');
    } catch {
      /* no memory yet */
    }
    // Prompt text + transcript formatting live in foldPrompt.ts (pure) so the
    // offline eval harness runs the byte-identical prompt. The 260810
    // noise-robustness instruction (low-signal batches must not displace
    // durable facts) is part of buildFoldSystem.
    // A model-rejection 400 must not pin the watermark and silently stop folds
    // forever (the cloud proxy only meters an allowlist of model ids, and a
    // BYOK key may refuse a request shape). Retry once with CHAT_MODEL and no
    // thinking, the exact request a chat turn sends, so folds still drain.
    // Real errors (timeouts, auth) still surface to the catch below.
    // The summary rides inside <summary> tags so a stray preamble can never be
    // stored as summary text (extractSummaryTag, see foldPrompt.ts).
    const res = await runFold({
      llm,
      summary: bridge.summary,
      msgs: newMsgs,
      memory: memoryForFold(memoryBody),
      persona: personaExpanded,
      model: SUMMARY_MODEL,
      extra: SUMMARY_EXTRA,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      fallbackModel: () => CHAT_MODEL,
      isRejection: isModelRequestRejection,
      onFallback: (msg) =>
        console.warn(`[sei] summary fold request rejected (${msg}); folding with ${CHAT_MODEL} without thinking`),
    });
    // 260810: a summary cut off by the token cap is WORSE than no fold — the
    // truncated text would be stored verbatim and poison every future prompt
    // until the next fold overwrites it (the live corpus had exactly this).
    // Treat it like a failed fold: keep the old summary AND the watermark so
    // the batch is retried. Should be rare at 800 tokens; see SUMMARY_MAX_TOKENS.
    if (res.status === 'max_tokens') {
      console.warn(`[sei] chat summary fold for ${id} hit max_tokens — discarding truncated output, will retry`);
      return bridge;
    }
    // clearContinuity ran while the summarizer was in flight: the snapshot this
    // fold summarized was wiped, and writing would resurrect the deleted bridge.
    if (clearEpoch(id) !== epoch) {
      console.warn(`[sei] chat summary fold for ${id} superseded by clear — dropping`);
      return bridge;
    }
    // The account changed while the summarizer ran (260926). bridgePath()
    // resolves against the ACTIVE scope, so writing now would put this
    // account's summary into the next account's bridge for the same id (the
    // bundled defaults share ids across profiles). Drop it: the old account's
    // watermark never moved, so its next fold redoes this batch.
    if (getActiveScope() !== scope) {
      console.warn(`[sei] chat summary fold for ${id} crossed an account switch — dropping`);
      return bridge;
    }
    // 260810 fold safety: an empty/unusable fold output used to keep the OLD
    // summary text while STILL advancing the watermark — the evicted messages
    // were silently skipped forever, with no log. Treat it as a failed fold:
    // keep both the summary and the watermark so the next fold retries the
    // same batch. A persistently-empty model degrades via MAX_UNSUMMARIZED
    // like any other persistent failure.
    if (res.status !== 'ok') {
      console.warn(`[sei] chat summary fold for ${id} returned empty output — keeping watermark, will retry`);
      return bridge;
    }
    // Facts first: the summary about to be written is the lossy copy.
    // Stamped with the newest message of the batch, when they were last said.
    const lastTs = newMsgs.reduce((t, m) => (typeof m.ts === 'number' && m.ts > t ? m.ts : t), 0);
    const facts: FactSave = await saveFacts(memoryFile, res.facts, { section: 'app', when: lastTs || undefined });
    if (facts.saved > 0) void maybeCompactChatMemory(id).catch(() => {});
    // Shape only (no text): how much each fold saves and how often it repeats memory.
    capture('fold_facts', {
      character_id: id,
      batch: counted,
      session_rows: newMsgs.length - counted,
      returned: facts.returned,
      saved: facts.saved,
      dupes: facts.dupes,
    });
    const next: BridgeState = {
      summary: res.summary,
      summarizedCount: bridge.summarizedCount + counted,
    };
    await writeBridge(id, next);
    return next;
  } catch (err) {
    // Keep old summary + watermark so the next fold retries. Warn (was 100%
    // silent) so a persistent failure — which pins the watermark and drives the
    // MAX_UNSUMMARIZED clamp — is diagnosable rather than invisible.
    console.warn(`[sei] chat summary fold failed for ${id}: ${(err as Error)?.message ?? err}`);
    return bridge;
  }
}
