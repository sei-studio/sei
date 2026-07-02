/**
 * Cross-surface continuity bridge (design: .planning/design/app-chat-and-memory.md §4).
 *
 * Three tiers carry memory across the chat and Minecraft surfaces:
 *   1. MEMORY.md — durable, shared, already compacted (read directly by both).
 *   2. bridge.json — a recursive rolling summary of conversation that has aged
 *      past the recent window (cap ~150 words). Updated incrementally
 *      (new = f(old, evicted)) with a watermark, so an unchanged window costs 0.
 *   3. recent window — the last N verbatim messages.
 *
 * At MC launch, botSupervisor seeds { summary, recent } into the bot's init so
 * the companion knows what you were just talking about. The in-app chat reads the
 * same MEMORY.md + summary, so game memory flows back into chat. This improves on
 * the literal "summarize everything older than 50 every launch" idea by making
 * the summary recursive + watermarked (no redundant re-summarization).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import { readAll } from './chatStore';
import { buildChatSdk } from './sdk';

const RECENT_WINDOW = 50;
const SUMMARY_MAX_TOKENS = 400;
const SUMMARY_TIMEOUT_MS = 20_000;

interface BridgeState {
  summary: string;
  /** Count of older-than-window messages already folded into `summary`. */
  summarizedCount: number;
}

export interface LaunchContinuity {
  summary: string;
  recent: Array<{ role: 'user' | 'companion'; text: string }>;
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
 * Build the launch handoff: refresh the rolling summary iff messages have aged
 * past the window since the last summary, then return { summary, recent }.
 * Returns null when there is no conversation yet. Best-effort — a summary failure
 * keeps the old summary and leaves the watermark so the next launch retries.
 */
export async function buildLaunchContinuity(characterId: string): Promise<LaunchContinuity | null> {
  const all = (await readAll(characterId)).filter((m) => m.role === 'user' || m.role === 'companion');
  if (all.length === 0) return null;

  const recentStart = Math.max(0, all.length - RECENT_WINDOW);
  const older = all.slice(0, recentStart);
  const recent = all
    .slice(recentStart)
    .map((m) => ({ role: m.role as 'user' | 'companion', text: m.text }));

  let bridge = await readBridge(characterId);
  if (older.length > bridge.summarizedCount) {
    const newlyEvicted = older
      .slice(bridge.summarizedCount)
      .map((m) => ({ role: m.role as 'user' | 'companion', text: m.text }));
    bridge = await foldIntoSummary(characterId, bridge, newlyEvicted);
  }
  return { summary: bridge.summary, recent };
}

async function foldIntoSummary(
  id: string,
  bridge: BridgeState,
  newMsgs: Array<{ role: 'user' | 'companion'; text: string }>,
): Promise<BridgeState> {
  try {
    const { client, model } = await buildChatSdk();
    const transcript = newMsgs.map((m) => `${m.role === 'user' ? 'Player' : 'You'}: ${m.text}`).join('\n');
    const system =
      'You maintain a running summary of the relationship and conversation between a game companion ("You") and their player. ' +
      'Fold the new messages into the existing summary. Keep it under 150 words, written first-person from the companion\'s point of view. ' +
      'Prioritise durable facts about the player, ongoing plans, running jokes, and emotional beats; drop small talk. Output only the updated summary text.';
    const userText = `Existing summary:\n${bridge.summary || '(none yet)'}\n\nNew messages:\n${transcript}`;
    const res = await client.messages.create(
      { model, max_tokens: SUMMARY_MAX_TOKENS, system, messages: [{ role: 'user', content: userText }] },
      { timeout: SUMMARY_TIMEOUT_MS },
    );
    const text = res.content
      .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
      .join('')
      .trim();
    const next: BridgeState = {
      summary: text || bridge.summary,
      summarizedCount: bridge.summarizedCount + newMsgs.length,
    };
    await writeBridge(id, next);
    return next;
  } catch {
    // Keep old summary + watermark so the next launch retries the fold.
    return bridge;
  }
}
