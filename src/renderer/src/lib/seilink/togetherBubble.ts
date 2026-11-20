/**
 * Her bubble in the shared editor (261105, T336): which chat line it shows.
 * Everything she says while the editor is open lands in her normal chat (a
 * live line, a talk-box reply, a spoken call line), so the bubble is just the
 * newest companion line that was not there when the editor opened.
 */
import type { ChatMessage } from '@shared/ipc';

/** A bubble stays up for a while, longer for a longer line. */
export function bubbleMs(text: string): number {
  return Math.min(12_000, 4_000 + text.length * 70);
}

/**
 * The newest companion line among `messages` that `seen` does not hold yet,
 * or null. Every new id is added to `seen` (the player's own rows and system
 * rows too, so they never come round again).
 */
export function freshCompanionLine(seen: Set<string>, messages: readonly ChatMessage[]): { id: string; text: string } | null {
  let last: ChatMessage | null = null;
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.role === 'companion' && m.text.trim()) last = m;
  }
  return last ? { id: last.id, text: last.text.trim() } : null;
}
