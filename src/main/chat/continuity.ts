/**
 * Cross-surface continuity bridge (design: .planning/design/app-chat-and-memory.md §4).
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
 * The fold is written by the LATEST SONNET (not the chat Haiku): it receives
 * the persona so the summary is in the companion's own voice, and it is told
 * to record only what was actually said — an earlier Haiku fold asserted
 * "we're playing now" off a join that never landed, and that false fact was
 * re-injected into every subsequent turn.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../../shared/ipc';
import { paths } from '../paths';
import { readAll } from './chatStore';
import { buildChatSdk, CHAT_MODEL } from './sdk';

/** Verbatim tail preserved after a fold. */
const RECENT_WINDOW = 50;
/** A fold fires only once this many messages have piled up BEYOND the window. */
const FOLD_BATCH = 50;
/**
 * Hard ceiling on the verbatim tail a read may ever ship (1.5× the normal max of
 * RECENT_WINDOW + FOLD_BATCH - 1 = 99). Safety valve for the case where folds
 * persistently FAIL: the watermark only advances via foldIntoSummary, so if every
 * fold 400s (e.g. a BYOK key that can call the chat Haiku but not SUMMARY_MODEL)
 * the unsummarized tail would otherwise grow without bound until the chat model's
 * context window overflows → permanent "sorry, i couldn't reply" with no recovery.
 * Clamping the effective watermark from below degrades that failure to "the oldest
 * unsummarized messages fall out of context" instead. foldIfDue reads the bridge
 * directly (not readWindow), so the TRUE backlog still drains fully once folds
 * recover — this clamp only bounds what READS surface, never what the fold covers.
 */
const MAX_UNSUMMARIZED = 150;
/**
 * Latest Sonnet family alias for the summary fold (260702) — quality matters
 * more than cost here (it runs at most once per 50 messages and its output is
 * re-read every turn). The interactive chat stays on CHAT_MODEL (Haiku).
 * Cloud-proxy note: this rides the metered /v1/messages route, so the proxy's
 * PRICING table must know this model id.
 */
const SUMMARY_MODEL = 'claude-sonnet-5';
const SUMMARY_MAX_TOKENS = 400;
const SUMMARY_TIMEOUT_MS = 20_000;

interface BridgeState {
  summary: string;
  /** Count of user/companion messages already folded into `summary`. */
  summarizedCount: number;
}

export interface LaunchContinuity {
  summary: string;
  /** ts (epoch ms) rides along so the bot's continuity block can show WHEN
   *  each line was said — a "hop on" after an overnight gap reads differently
   *  from one ten seconds later. */
  recent: Array<{ role: 'user' | 'companion'; text: string; ts?: number }>;
}

/**
 * Compact human timestamp for model-facing message stamps: "3 Jul 10:34"
 * (local time — main and the bot both run on the player's machine). Shared by
 * the chat prompt builder, the summary fold, and the launch continuity block.
 */
export function formatChatTimestamp(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${hh}:${mm}`;
}

function bridgePath(id: string): string {
  return path.join(paths.memoryDir(id), 'bridge.json');
}

async function readBridge(id: string): Promise<BridgeState> {
  try {
    const parsed = JSON.parse(await readFile(bridgePath(id), 'utf8'));
    return { summary: String(parsed.summary ?? ''), summarizedCount: Number(parsed.summarizedCount ?? 0) };
  } catch {
    return { summary: '', summarizedCount: 0 };
  }
}

async function writeBridge(id: string, s: BridgeState): Promise<void> {
  await mkdir(path.dirname(bridgePath(id)), { recursive: true });
  await writeFile(bridgePath(id), JSON.stringify(s, null, 2) + '\n', 'utf8');
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
}

const isCounted = (m: ChatMessage): boolean => m.role === 'user' || m.role === 'companion';

/**
 * Shared read core: transcript + bridge + clamped watermark. PURE — never
 * folds, never calls an LLM. A bridge whose watermark outran the transcript
 * (shrunken transcript) is treated as reset — see the 260705 comment below.
 */
async function readWindow(
  characterId: string,
): Promise<{ bridge: BridgeState; raw: ChatMessage[]; watermark: number }> {
  const raw = await readAll(characterId);
  const counted = raw.filter(isCounted);
  let bridge = await readBridge(characterId);
  // 260705: summarizedCount ABOVE the live transcript means the transcript shrank
  // underneath the bridge (a clear racing a fold, manual edits) — the summary
  // describes messages that no longer exist. min() would pin the watermark at
  // counted.length: ZERO history, every send 400s ("at least one message
  // required") until the fresh conversation outgrows the stale count. Treat it
  // as a RESET — a shrunken transcript degrades to "no summary", never "no
  // history".
  if (bridge.summarizedCount >= counted.length && bridge.summarizedCount > 0) {
    bridge = { summary: '', summarizedCount: 0 };
  }
  // Lower-clamp to counted.length - MAX_UNSUMMARIZED so a persistently-failing
  // fold degrades to dropping the oldest messages rather than growing context
  // until every turn 400s (see MAX_UNSUMMARIZED).
  const watermark = Math.max(bridge.summarizedCount, counted.length - MAX_UNSUMMARIZED);
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
 * RECENT_WINDOW, so the verbatim tail resets to exactly 50; normally that is
 * one 50-batch, but it also drains any backlog in a single call. No-op when
 * under the trigger or when a fold for this character is already running.
 */
export async function foldIfDue(characterId: string, personaExpanded?: string): Promise<void> {
  if (foldInFlight.has(characterId)) return;
  foldInFlight.add(characterId);
  try {
    // 260705: capture BEFORE the transcript read — a clear landing between
    // this snapshot and the summarizer's return must invalidate the fold.
    const epoch = clearEpoch(characterId);
    const raw = await readAll(characterId);
    const counted = raw.filter(isCounted);
    let bridge = await readBridge(characterId);
    // Same stale-bridge reset as readWindow (shrunken transcript → the summary
    // describes messages that no longer exist): degrade to "no summary" rather
    // than folding fresh messages into a stale one.
    if (bridge.summarizedCount >= counted.length && bridge.summarizedCount > 0) {
      bridge = { summary: '', summarizedCount: 0 };
    }
    const unsummarized = counted.slice(bridge.summarizedCount);
    if (unsummarized.length < RECENT_WINDOW + FOLD_BATCH) return;
    const evicted = unsummarized
      .slice(0, unsummarized.length - RECENT_WINDOW)
      .map((m) => ({ role: m.role as 'user' | 'companion', text: m.text, ts: m.ts }));
    await foldIntoSummary(characterId, bridge, evicted, epoch, personaExpanded);
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
): Promise<{ summary: string; history: ChatMessage[] }> {
  const { bridge, raw, watermark } = await readWindow(characterId);
  const history: ChatMessage[] = [];
  let seen = 0;
  for (const m of raw) {
    if (isCounted(m)) {
      seen++;
      if (seen > watermark) history.push(m);
    } else if (seen >= watermark) {
      // System rows (play sessions, join acks) ride along with the era they
      // belong to; rows older than the watermark are already covered by the fold.
      history.push(m);
    }
  }
  return { summary: bridge.summary, history };
}

/**
 * Build the MC-launch handoff: { summary, recent } where `recent` is the full
 * unsummarized tail (50-99 messages between folds). Returns null when there is
 * no conversation yet. PURE READ — a summon never runs compaction; it ships
 * whatever the chat surface's background folds have produced so far.
 */
export async function buildLaunchContinuity(
  characterId: string,
): Promise<LaunchContinuity | null> {
  const { bridge, raw, watermark } = await readWindow(characterId);
  const counted = raw.filter(isCounted);
  if (counted.length === 0) return null;
  const recent = counted
    .slice(watermark)
    .map((m) => ({ role: m.role as 'user' | 'companion', text: m.text, ts: m.ts }));
  return { summary: bridge.summary, recent };
}

async function foldIntoSummary(
  id: string,
  bridge: BridgeState,
  newMsgs: Array<{ role: 'user' | 'companion'; text: string; ts?: number }>,
  // 260705: the clear epoch foldIfDue captured BEFORE snapshotting the
  // transcript; compared before writeBridge.
  epoch: number,
  personaExpanded?: string,
): Promise<BridgeState> {
  try {
    const { client } = await buildChatSdk();
    const transcript = newMsgs
      .map((m) => {
        const who = m.role === 'user' ? 'Player' : 'You';
        const when = typeof m.ts === 'number' ? ` (${formatChatTimestamp(m.ts)})` : '';
        return `${who}${when}: ${m.text}`;
      })
      .join('\n');
    const personaBlock =
      personaExpanded && personaExpanded.trim()
        ? '\n\nWrite the summary in the companion\'s own voice. The companion\'s persona:\n' +
          personaExpanded.trim()
        : '';
    const system =
      'You maintain a running summary of the relationship and conversation between a game companion ("You") and their player. ' +
      'Fold the new messages into the existing summary. Keep it under 150 words, written first-person from the companion\'s point of view. ' +
      'Prioritise durable facts about the player, ongoing plans, running jokes, and emotional beats; drop small talk. ' +
      'Record only what was actually said — never assert current world/game state (e.g. do not write "we\'re playing now"); ' +
      'an announced join can fail after the fact. Output only the updated summary text.' +
      personaBlock;
    const userText = `Existing summary:\n${bridge.summary || '(none yet)'}\n\nNew messages:\n${transcript}`;
    // The fold prefers Sonnet for quality, but the cloud proxy only meters an
    // allowlist of model ids — a build pointed at a proxy that hasn't listed
    // SUMMARY_MODEL 400s with `invalid_model`, which would pin the watermark and
    // silently break compaction forever. Fall back to CHAT_MODEL (Haiku, always
    // allowlisted since the interactive chat rides it) so folds still drain. One
    // retry, only for a model-rejection 400 — real errors (timeouts, auth) still
    // surface to the catch below.
    const runFold = (model: string) =>
      client.messages.create(
        { model, max_tokens: SUMMARY_MAX_TOKENS, system, messages: [{ role: 'user', content: userText }] },
        { timeout: SUMMARY_TIMEOUT_MS },
      );
    let res: Awaited<ReturnType<typeof runFold>>;
    try {
      res = await runFold(SUMMARY_MODEL);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const modelRejected = /invalid_model|model/i.test(msg) && /\b400\b|not_found|invalid/i.test(msg);
      if (modelRejected) {
        console.warn(`[sei] summary model ${SUMMARY_MODEL} rejected (${msg}); folding with ${CHAT_MODEL}`);
        res = await runFold(CHAT_MODEL);
      } else {
        throw err;
      }
    }
    const text = res.content
      .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
      .join('')
      .trim();
    // clearContinuity ran while the summarizer was in flight: the snapshot this
    // fold summarized was wiped, and writing would resurrect the deleted bridge.
    if (clearEpoch(id) !== epoch) {
      console.warn(`[sei] chat summary fold for ${id} superseded by clear — dropping`);
      return bridge;
    }
    const next: BridgeState = {
      summary: text || bridge.summary,
      summarizedCount: bridge.summarizedCount + newMsgs.length,
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
