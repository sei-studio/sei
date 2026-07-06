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
import { useUiStore } from './useUiStore';
import type { ChatMessage, ChatPreview, ChatReplyRef, ChatSendResult } from '@shared/ipc';

interface ChatState {
  /** characterId → ordered message list (oldest first). */
  messages: Record<string, ChatMessage[]>;
  /** characterId → true while a reply is in flight (drives the typing dots). */
  awaiting: Record<string, boolean>;
  /** characterId → history already fetched (idempotent load guard). */
  loaded: Record<string, boolean>;
  /**
   * characterId → true while the persisted transcript is being fetched (drives
   * the wireframe skeleton). Distinct from `awaiting`: this covers ONLY the
   * history pull, not the first-meeting greeting turn (that is `awaiting`).
   */
  loading: Record<string, boolean>;
  /**
   * characterId → last persisted chat line (Party redesign §2), fetched in one
   * bulk chat:previews pull for the roster. Read through
   * {@link chatPreviewFor}, which prefers the live transcript when loaded.
   */
  previews: Record<string, ChatPreview>;

  /** Fetch the persisted transcript once. No-op if already loaded. */
  load: (characterId: string) => Promise<void>;
  /** Bulk-fetch roster last-line previews (idempotent per call; cheap). */
  loadPreviews: () => Promise<void>;
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

/**
 * 260703 hard guard surface: main's buildChatSdk throws a LOCAL_NO_API_KEY-
 * prefixed error when the profile is in local (BYOK) mode with no saved key —
 * local mode NEVER falls back to the cloud JWT, so the failure must be told to
 * the user plainly instead of hiding behind the generic "sorry" line.
 */
function isLocalNoApiKey(err: unknown): boolean {
  return /LOCAL_NO_API_KEY/.test(String((err as { message?: string })?.message ?? err));
}

/** Small pause between multi-message replies so they arrive one at a time. Used
 *  only when "Realistic typing" is OFF (otherwise the gap is length-scaled). */
const REPLY_GAP_MS = 650;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * "Realistic typing" pacing (Appearance & feel toggle,
 * UserConfig.realistic_typing, hydrated into useUiStore at boot). Two effects:
 *   - task 2: a "reading" pause before the typing indicator appears, scaled to
 *     the length of the USER's message at a fast-reader speed, and
 *   - task 1: the typing indicator then stays up before each reply bubble for a
 *     stretch proportional to that bubble's length at a fast-typist speed.
 * chars/sec ≈ wpm * 5 / 60 — ~200 wpm typing (a very fast typist), ~300 wpm
 * reading (faster than the ~240 wpm average, on purpose). Clamps keep the delays
 * snappy and bounded no matter how long the message is; the proportional range
 * covers ~5-83 chars (typing) / ~5-60 chars (reading) before hitting the cap,
 * which is where most chat bubbles live. The in-game bot mirrors these constants
 * in src/bot/brain/orchestrator.js so chat and Minecraft feel the same.
 */
const TYPING_CPS = 16.67;
const READING_CPS = 25;
function typingDelayMs(text: string): number {
  const len = text.length;
  if (!len) return 0;
  return Math.min(5000, Math.max(500, Math.round((len / TYPING_CPS) * 1000)));
}
function readingDelayMs(text: string): number {
  const len = text.length;
  if (!len) return 0;
  return Math.min(2500, Math.max(300, Math.round((len / READING_CPS) * 1000)));
}

/**
 * Safety net for a message ROUTED into a live game session (task 4): the reply
 * arrives asynchronously over the chat:message push, so we keep the typing
 * indicator up — but clear it after this long if nothing lands, so the composer
 * never gets stuck (e.g. the bot didn't produce a spoken reply that turn).
 */
const ROUTED_AWAIT_TIMEOUT_MS = 45000;

/** Append `msg` to a character's list immutably. */
function appendMessage(
  map: Record<string, ChatMessage[]>,
  characterId: string,
  msg: ChatMessage,
): Record<string, ChatMessage[]> {
  return { ...map, [characterId]: [...(map[characterId] ?? []), msg] };
}

export const useChatStore = create<ChatState>((set, get) => {
  // Subscribe once to main → renderer chat pushes: the live game bot replying to
  // a routed message (task 4), and "joined/left your world" system lines (task
  // 1). Append deduped by id and clear the typing indicator for that character.
  try {
    sei.onChatMessage?.(({ characterId, message }) => {
      set((s) => {
        const list = s.messages[characterId] ?? [];
        if (list.some((m) => m.id === message.id)) return {} as Partial<ChatState>;
        return {
          messages: { ...s.messages, [characterId]: [...list, message] },
          awaiting: { ...s.awaiting, [characterId]: false },
        };
      });
    });
  } catch {
    /* preload without onChatMessage — routed replies just won't stream live */
  }

  return {
  messages: {},
  awaiting: {},
  loaded: {},
  loading: {},
  previews: {},

  loadPreviews: async () => {
    try {
      const previews = await sei.chatPreviews?.();
      if (previews) set({ previews });
    } catch {
      /* roster falls back to transcript-derived lines only */
    }
  },

  load: async (characterId) => {
    if (get().loaded[characterId]) return;
    // Mark loaded up front so a re-entry while the fetch is in flight doesn't
    // double-fire; on failure we reset it so a later open can retry. `loading`
    // flips on synchronously alongside it — it drives the wireframe skeleton and
    // is cleared the moment the history lands (before the greeting turn, which
    // the typing indicator covers via `awaiting`).
    set((s) => ({
      loaded: { ...s.loaded, [characterId]: true },
      loading: { ...s.loading, [characterId]: true },
    }));
    try {
      const history = await sei.chatHistory(characterId);
      set((s) => ({
        messages: { ...s.messages, [characterId]: history },
        loading: { ...s.loading, [characterId]: false },
      }));
      // First-meeting greeting: on an empty transcript, tell main the chat was
      // opened. Main decides eligibility (unique companion, never chatted) and
      // returns any greeting replies to append — the renderer never decides
      // policy, so calling on every empty open is fine (main no-ops otherwise).
      // Show the typing indicator while we wait, then append via the same deduped
      // path a live push uses.
      if (history.length === 0 && sei.chatOpened) {
        set((s) => ({ awaiting: { ...s.awaiting, [characterId]: true } }));
        try {
          const greeting = await sei.chatOpened(characterId);
          set((s) => {
            const list = s.messages[characterId] ?? [];
            const seen = new Set(list.map((m) => m.id));
            const next = [...list, ...greeting.filter((m) => !seen.has(m.id))];
            return {
              messages: { ...s.messages, [characterId]: next },
              awaiting: { ...s.awaiting, [characterId]: false },
            };
          });
        } catch {
          set((s) => ({ awaiting: { ...s.awaiting, [characterId]: false } }));
        }
      }
    } catch {
      set((s) => ({
        loaded: { ...s.loaded, [characterId]: false },
        loading: { ...s.loading, [characterId]: false },
      }));
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
    // "Realistic typing" (Appearance & feel): when ON, hold the typing indicator
    // back until the companion has "read" your message (task 2), then keep it up
    // for a length-scaled stretch before each reply bubble (task 1). When OFF,
    // the indicator shows instantly and follow-up bubbles use the fixed gap.
    const realism = useUiStore.getState().realisticTyping;
    set((s) => ({
      messages: appendMessage(s.messages, characterId, userMsg),
      awaiting: { ...s.awaiting, [characterId]: !realism },
    }));
    // Kick the reply off NOW so model generation overlaps the reading pause.
    const replyPromise = sei.chatSend({ characterId, text, replyTo });
    try {
      if (realism) {
        // Task 2 — "reading" pause before the companion starts typing, scaled to
        // how long YOUR message takes to read (fast-reader speed).
        await delay(readingDelayMs(text));
        // Superseded during the pause — the follow-up owns state now. Swallow the
        // in-flight reply's (possibly aborted) rejection so it isn't unhandled.
        if (!isCurrent()) {
          void replyPromise.catch(() => {});
          return null;
        }
        set((s) => ({ awaiting: { ...s.awaiting, [characterId]: true } }));
      }
      const result = await replyPromise;
      // A newer send superseded us mid-flight — it owns the reply + awaiting now.
      if (!isCurrent()) return result;
      // Task 4 — routed into a live game session: the reply comes back async over
      // the chat:message push, so keep the typing indicator up and let the push
      // handler append + clear it. Safety-clear after a timeout if nothing lands.
      if (result.routed) {
        // Main stamped last_chatted when it routed the message; refresh the
        // character so Home presence flips off "New" without a reload.
        void useDataStore.getState().refreshCharacter(characterId);
        window.setTimeout(() => {
          if (sendSeq[characterId] === token) {
            set((s) => ({ awaiting: { ...s.awaiting, [characterId]: false } }));
          }
        }, ROUTED_AWAIT_TIMEOUT_MS);
        return result;
      }
      // Reveal a multi-message reply one bubble at a time (task 8): keep the
      // typing indicator up before each bubble, then append it, so a split reply
      // reads as sent-as-typed rather than a wall of text landing at once.
      // Realism ON → the pre-bubble wait is proportional to that bubble's length
      // (task 1, fast-typist speed); OFF → the first bubble is instant and
      // follow-ups use the fixed gap. `awaiting` stays true between chunks.
      const replies = result.replies;
      for (let i = 0; i < replies.length; i++) {
        const waitMs = realism ? typingDelayMs(replies[i].text) : i > 0 ? REPLY_GAP_MS : 0;
        if (waitMs > 0) {
          set((s) => ({ awaiting: { ...s.awaiting, [characterId]: true } }));
          await delay(waitMs);
          if (!isCurrent()) return result;
        }
        set((s) => ({
          messages: appendMessage(s.messages, characterId, replies[i]),
          awaiting: { ...s.awaiting, [characterId]: i < replies.length - 1 },
        }));
      }
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
      // 260703: the local-mode/no-key failure gets specific, actionable copy —
      // this state is deliberate (local mode never silently uses the cloud) and
      // the fix is in Settings, so "try again in a moment" would be a lie.
      const fallback: ChatMessage = {
        id: `local-err-${Date.now()}`,
        role: 'companion',
        text: isLocalNoApiKey(err)
          ? "i can't reply: you're in local mode but no API key is saved. add one in Settings, or switch to managed billing."
          : "sorry, i couldn't reply just now. try again in a moment?",
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
    set((s) => {
      const previews = { ...s.previews };
      delete previews[characterId];
      return { messages: { ...s.messages, [characterId]: [] }, previews };
    });
  },
  };
});

/**
 * Roster last-line for a character: the tail of the live transcript when any
 * messages are in memory, else the bulk-fetched preview. Skips `system` rows
 * (play events) — the roster wants the last spoken line.
 */
export function chatPreviewFor(s: ChatState, characterId: string): ChatPreview | null {
  const list = s.messages[characterId];
  if (list && list.length > 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== 'system') {
        return { role: list[i].role, text: list[i].text, ts: list[i].ts };
      }
    }
    return null;
  }
  const p = s.previews[characterId];
  return p && p.role !== 'system' ? p : null;
}
