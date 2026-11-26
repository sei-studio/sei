/**
 * 261125 (O5 chat latency): while the player types, ask main to keep the chat
 * upstream connection warm (chat:prewarm, proxyPrewarm.ts), so the send's LLM
 * request does not pay a fresh TCP+TLS setup. Throttled here too so a fast
 * typist costs one IPC per second, not one per keystroke; main throttles the
 * network side (3 s) and skips it off the cloud backend.
 */
import { sei } from './ipcClient';

export const CHAT_PREWARM_IPC_INTERVAL_MS = 1_000;

let lastAt = 0;

/** Returns whether the IPC was sent (tests). */
export function noteComposerTyping(text: string, now: number = Date.now()): boolean {
  if (!text.trim()) return false;
  if (now - lastAt < CHAT_PREWARM_IPC_INTERVAL_MS) return false;
  lastAt = now;
  void sei.chatPrewarm?.().catch(() => {});
  return true;
}

/** Tests only. */
export function _resetComposerTyping(): void {
  lastAt = 0;
}
