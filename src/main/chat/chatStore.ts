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

export async function readAll(characterId: string): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(chatPath(characterId), 'utf8');
    return raw
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function readRecent(characterId: string, n: number): Promise<ChatMessage[]> {
  const all = await readAll(characterId);
  return all.slice(-n);
}

export async function clear(characterId: string): Promise<void> {
  try {
    await rm(chatPath(characterId));
  } catch {
    // ENOENT / already gone — fine.
  }
}
