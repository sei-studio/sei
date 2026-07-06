/**
 * Per-character chat transcript persistence. Append-only JSONL at
 * <profileRoot>/memory/<characterId>/chat.jsonl — lives inside the per-character
 * memory dir so it is already per-user/per-profile and travels with memory. Raw
 * transcripts stay local (never cloud-synced), per the carried runtime-memory
 * rule and the roadmap's "transcripts are a surface concern" decision.
 */
import { appendFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';
import type { ChatMessage } from '../../shared/ipc';

function chatPath(characterId: string): string {
  return path.join(paths.memoryDir(characterId), 'chat.jsonl');
}

export async function appendMessage(characterId: string, msg: ChatMessage): Promise<void> {
  const p = chatPath(characterId);
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(msg) + '\n', 'utf8');
}

/**
 * Drops legacy UI-only system rows from a read. Builds before 260703 persisted
 * `{ role: 'system', text: '<name> joined your world', ts }` (and the LAN
 * join-failure counterpart) via an `emitJoinAck` that was removed in commit
 * 2418088. Those rows carry no `event` field. Every system row the current
 * code writes — see `emitPlaySession` in src/main/index.ts — always sets
 * `event: { kind: 'play', ... }`, so an event-less system row is unambiguously
 * one of the old join-ack lines. They should neither render in the chat UI nor
 * reach the model as history, so scrub them at read time rather than rewriting
 * transcripts on disk.
 */
export function filterLegacySystemRows(rows: ChatMessage[]): ChatMessage[] {
  return rows.filter((m) => m.role !== 'system' || m.event !== undefined);
}

export async function readAll(characterId: string): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(chatPath(characterId), 'utf8');
    const rows = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ChatMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is ChatMessage => m !== null);
    return filterLegacySystemRows(rows);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function readRecent(characterId: string, n: number): Promise<ChatMessage[]> {
  const all = await readAll(characterId);
  return all.slice(-n);
}

/**
 * Cheap read of the LAST renderable chat message for roster previews
 * (chat:previews / Party redesign §2). Scans lines from the end and
 * short-circuits on the first parseable, non-legacy row — so it never
 * materializes the whole transcript into a filtered array. Legacy event-less
 * system rows are skipped (see filterLegacySystemRows), as are voice-call rows
 * (voice === true), which the chat view hides — otherwise the roster preview
 * could surface a spoken line (e.g. a garbled Whisper transcript) that never
 * appears in the visible transcript. Returns null when the file is missing or
 * holds no renderable message.
 */
export async function readLast(characterId: string): Promise<ChatMessage | null> {
  let raw: string;
  try {
    raw = await readFile(chatPath(characterId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let msg: ChatMessage;
    try {
      msg = JSON.parse(line) as ChatMessage;
    } catch {
      continue;
    }
    // Skip legacy join-ack system rows (no `event`) — same rule as filterLegacySystemRows.
    if (msg.role === 'system' && msg.event === undefined) continue;
    // Skip voice-call rows — the chat view hides them, so they must not surface
    // as the roster "last message" preview.
    if (msg.voice === true) continue;
    return msg;
  }
  return null;
}

export async function clear(characterId: string): Promise<void> {
  try {
    await rm(chatPath(characterId));
  } catch {
    // ENOENT / already gone — fine.
  }
}
