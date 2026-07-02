/**
 * useChatStore — per-character in-app chat transcripts (Phase 18/19).
 *
 * Holds the message arrays the ChatScreen renders, an `awaiting` flag per
 * character that drives the typing indicator while a reply is in flight, and a
 * `loaded` flag so history is fetched at most once per character.
 *
 * The persisted transcript lives in main (chat:history / chat:send / chat:clear
 * over `window.sei`); this store is the renderer-side cache + optimistic-append
 * layer. `send()` appends the user message immediately (temp id), flips
 * `awaiting` on, awaits the companion reply, then appends it. Errors degrade to
 * an apologetic companion message so the UI never gets stuck "typing".
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useDataStore } from './useDataStore';
import type { ChatMessage, ChatReplyRef, ChatSendResult } from '@shared/ipc';

interface ChatState {
  /** characterId → ordered message list (oldest first). */
  messages: Record<string, ChatMessage[]>;
  /** characterId → true while a reply is in flight (drives the typing dots). */
  awaiting: Record<string, boolean>;
  /** characterId → history already fetched (idempotent load guard). */
  loaded: Record<string, boolean>;

  /** Fetch the persisted transcript once. No-op if already loaded. */
  load: (characterId: string) => Promise<void>;
  /**
   * Optimistically append the user message, await the companion reply, append
   * it, and return the full ChatSendResult so the screen can act on `.launch`.
   */
  send: (characterId: string, text: string, replyTo?: ChatReplyRef) => Promise<ChatSendResult | null>;
  /** Clear the persisted transcript + empty the local array. */
  clear: (characterId: string) => Promise<void>;
}

/**
 * Per-character send sequence (chat #9). Each send() bumps its character's
 * counter and captures the value; only the latest send may mutate the store on
 * resolve/reject, so an interrupted (superseded) turn never appends a stale
 * reply or clears `awaiting` out from under the follow-up. Module-level (not
 * reactive) — it's a guard, not rendered state.
 */
const sendSeq: Record<string, number> = {};

/** True if a rejected chatSend was our deliberate interrupt (not a real error). */
function isChatAbort(err: unknown): boolean {
  return /CHAT_ABORTED/.test(String((err as { message?: string })?.message ?? err));
}

/** Append `msg` to a character's list immutably. */
function appendMessage(
  map: Record<string, ChatMessage[]>,
  characterId: string,
  msg: ChatMessage,
): Record<string, ChatMessage[]> {
  return { ...map, [characterId]: [...(map[characterId] ?? []), msg] };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  awaiting: {},
  loaded: {},

  load: async (characterId) => {
    if (get().loaded[characterId]) return;
    // Mark loaded up front so a re-entry while the fetch is in flight doesn't
    // double-fire; on failure we reset it so a later open can retry.
    set((s) => ({ loaded: { ...s.loaded, [characterId]: true } }));
    try {
      const history = await sei.chatHistory(characterId);
      set((s) => ({ messages: { ...s.messages, [characterId]: history } }));
    } catch {
      set((s) => ({ loaded: { ...s.loaded, [characterId]: false } }));
    }
  },

  send: async (characterId, text, replyTo) => {
    // #9 — claim this character's latest-send slot. A follow-up send bumps this,
    // interrupts the in-flight LLM call (main aborts it), and takes over state.
    const token = (sendSeq[characterId] ?? 0) + 1;
    sendSeq[characterId] = token;
    const isCurrent = (): boolean => sendSeq[characterId] === token;

    const userMsg: ChatMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text,
      ts: Date.now(),
      ...(replyTo ? { replyTo } : {}),
    };
    set((s) => ({
      messages: appendMessage(s.messages, characterId, userMsg),
      awaiting: { ...s.awaiting, [characterId]: true },
    }));
    try {
      const result = await sei.chatSend({ characterId, text, replyTo });
      // A newer send superseded us mid-flight — it owns the reply + awaiting now.
      if (!isCurrent()) return result;
      set((s) => ({
        messages: appendMessage(s.messages, characterId, result.reply),
        awaiting: { ...s.awaiting, [characterId]: false },
      }));
      // #6 — main stamped last_chatted on this successful reply; refresh the
      // character so the Home grid + IconRail re-sort by last interaction.
      void useDataStore.getState().refreshCharacter(characterId);
      return result;
    } catch (err) {
      // Superseded turn: a newer send is now driving; leave its state alone.
      if (!isCurrent()) return null;
      // Deliberate interrupt (main aborted this turn): don't show the "sorry"
      // fallback; the follow-up send keeps `awaiting` true for its own reply.
      if (isChatAbort(err)) {
        set((s) => ({ awaiting: { ...s.awaiting, [characterId]: false } }));
        return null;
      }
      // Real failure — never strand the typing indicator: surface an apologetic
      // companion line and clear `awaiting` so the composer stays usable.
      const fallback: ChatMessage = {
        id: `local-err-${Date.now()}`,
        role: 'companion',
        text: "sorry, i couldn't reply just now. try again in a moment?",
        ts: Date.now(),
      };
      set((s) => ({
        messages: appendMessage(s.messages, characterId, fallback),
        awaiting: { ...s.awaiting, [characterId]: false },
      }));
      return null;
    }
  },

  clear: async (characterId) => {
    await sei.chatClear(characterId);
    set((s) => ({ messages: { ...s.messages, [characterId]: [] } }));
  },
}));
