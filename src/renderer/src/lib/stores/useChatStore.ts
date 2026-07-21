/**
 * useChatStore — per-character in-app chat transcripts (Phase 18/19).
 *
 * Holds the message arrays the ChatScreen renders, an `awaiting` flag per
 * character that drives the typing indicator while a reply is in flight, and a
 * `loaded` flag so history is fetched at most once per character.
 *
 * The persisted transcript lives in main (chat:history / chat:send over
 * `window.sei`); this store is the renderer-side cache + optimistic-append
 * layer. `send()` appends the user message immediately (temp id), flips
 * `awaiting` on, awaits the companion reply, then appends it. Errors degrade to
 * an apologetic companion message so the UI never gets stuck "typing".
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useDataStore } from './useDataStore';
import { useUiStore } from './useUiStore';
import {
  notifyCompanionText,
  notifyPlayerText,
  isVoiceCallActive,
  requestRemoteEndCall,
  voiceCallPeers,
} from '../voice/voiceBridge';
import { CHAT_HISTORY_PAGE } from '@shared/ipc';
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
   * characterId → older transcript pages may exist on disk (infinite
   * scrollback, 260721). Inferred from page fill: a full CHAT_HISTORY_PAGE read
   * means there may be more above it, a short page means the top was reached.
   */
  hasOlder: Record<string, boolean>;
  /** characterId → an older-page fetch is in flight (re-entry guard). */
  loadingOlder: Record<string, boolean>;
  /**
   * characterId → last persisted chat line (Party redesign §2), fetched in one
   * bulk chat:previews pull for the roster. Read through
   * {@link chatPreviewFor}, which prefers the live transcript when loaded.
   */
  previews: Record<string, ChatPreview>;

  /** Fetch the persisted transcript once. No-op if already loaded. */
  load: (characterId: string) => Promise<void>;
  /**
   * Prepend the page of transcript rows above the oldest loaded one (called by
   * ChatScreen when the user scrolls to the top). No-op while a page is already
   * in flight or when the top of the history was reached.
   */
  loadOlder: (characterId: string) => Promise<void>;
  /** Bulk-fetch roster last-line previews (idempotent per call; cheap). */
  loadPreviews: () => Promise<void>;
  /**
   * Optimistically append the user message, await the companion reply, append
   * it, and return the full ChatSendResult so the screen can act on `.launch`.
   */
  send: (
    characterId: string,
    text: string,
    replyTo?: ChatReplyRef,
    /** Multi-companion voice (260706): names of other companions on the call. */
    voicePeers?: string[],
  ) => Promise<ChatSendResult | null>;
  /**
   * 260705: drop the local cache for a character so the next load() refetches.
   * Renderer-side only (no IPC) — called after Reset memory, whose memory-dir
   * wipe deletes the persisted transcript in main; without this eviction the
   * loaded-once guard would keep showing the wiped conversation from cache.
   */
  evictLocal: (characterId: string) => void;
}

/**
 * Per-character send sequence (chat #9). Each send() bumps its character's
 * counter and captures the value; only the latest send may mutate the store on
 * resolve/reject, so an interrupted (superseded) turn never appends a stale
 * reply or clears `awaiting` out from under the follow-up. Module-level (not
 * reactive) — it's a guard, not rendered state.
 */
const sendSeq: Record<string, number> = {};

/** chat:message push unsubscribe, torn down on HMR dispose (module foot). A
 * stale hot-reloaded instance kept its listener AND its own (empty) dedup
 * state, so every in-game say() was re-announced to the voice bridge once per
 * reload — Marv spoke the same line five times (260706 field report). */
let offChatMessage: (() => void) | null = null;

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
    offChatMessage = sei.onChatMessage?.(({ characterId, message }) => {
      let appended = false;
      set((s) => {
        const list = s.messages[characterId] ?? [];
        if (list.some((m) => m.id === message.id)) return {} as Partial<ChatState>;
        appended = true;
        return {
          messages: { ...s.messages, [characterId]: [...list, message] },
          awaiting: { ...s.awaiting, [characterId]: false },
        };
      });
      // Voice calls (260705): a companion line that arrived over the push (an
      // in-game bot routing say() to the call) is spoken aloud. System lines
      // ("joined your world") stay text-only.
      if (appended && message.role === 'companion') {
        notifyCompanionText(characterId, message.text);
      }
    }) ?? null;
  } catch {
    /* preload without onChatMessage — routed replies just won't stream live */
  }

  return {
  messages: {},
  awaiting: {},
  loaded: {},
  loading: {},
  hasOlder: {},
  loadingOlder: {},
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
      // Merge, don't replace: a chat:message push (e.g. the "You and X called
      // for …" call-record row written on hang-up) can land in the store DURING
      // this async read. Overwriting messages[id] with the disk snapshot used to
      // clobber it — so a just-ended call left no visible trace in the GUI.
      // Keep any already-stored rows the disk history doesn't yet include.
      set((s) => {
        const existing = s.messages[characterId] ?? [];
        const seenIds = new Set(history.map((m) => m.id));
        const extras = existing.filter((m) => !seenIds.has(m.id));
        return {
          messages: { ...s.messages, [characterId]: extras.length ? [...history, ...extras] : history },
          loading: { ...s.loading, [characterId]: false },
          // A full page means the disk may hold older rows above it.
          hasOlder: { ...s.hasOlder, [characterId]: history.length >= CHAT_HISTORY_PAGE },
        };
      });
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
          // Reveal a multi-message greeting one bubble at a time, each with its
          // OWN typing delay — same theater send() uses — instead of dumping the
          // whole greeting at once (a two-part hello must arrive as two texts,
          // one after the other). Realistic-typing OFF → fixed inter-bubble gap.
          const realism = useUiStore.getState().realisticTyping;
          const seen = new Set((get().messages[characterId] ?? []).map((m) => m.id));
          const fresh = greeting.filter((m) => !seen.has(m.id));
          for (let i = 0; i < fresh.length; i++) {
            const waitMs = realism ? typingDelayMs(fresh[i].text) : i > 0 ? REPLY_GAP_MS : 0;
            if (waitMs > 0) {
              set((s) => ({ awaiting: { ...s.awaiting, [characterId]: true } }));
              await delay(waitMs);
            }
            set((s) => ({
              messages: appendMessage(s.messages, characterId, fresh[i]),
              awaiting: { ...s.awaiting, [characterId]: i < fresh.length - 1 },
            }));
          }
          if (fresh.length === 0) set((s) => ({ awaiting: { ...s.awaiting, [characterId]: false } }));
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

  loadOlder: async (characterId) => {
    const s = get();
    if (!s.hasOlder[characterId] || s.loadingOlder[characterId]) return;
    // Cursor: the oldest loaded row. It came from a disk read (load/loadOlder),
    // so its id exists in the JSONL; optimistic local- rows only ever append.
    const oldest = (s.messages[characterId] ?? [])[0];
    if (!oldest || !sei.chatHistoryBefore) return;
    set((st) => ({ loadingOlder: { ...st.loadingOlder, [characterId]: true } }));
    try {
      const page = await sei.chatHistoryBefore(characterId, oldest.id);
      set((st) => {
        const cur = st.messages[characterId] ?? [];
        const seen = new Set(cur.map((m) => m.id));
        const fresh = page.filter((m) => !seen.has(m.id));
        return {
          messages: fresh.length
            ? { ...st.messages, [characterId]: [...fresh, ...cur] }
            : st.messages,
          // A short page means the top of the transcript was reached.
          hasOlder: { ...st.hasOlder, [characterId]: page.length >= CHAT_HISTORY_PAGE },
          loadingOlder: { ...st.loadingOlder, [characterId]: false },
        };
      });
    } catch {
      // Keep hasOlder as-is so a later scroll can retry.
      set((st) => ({ loadingOlder: { ...st.loadingOlder, [characterId]: false } }));
    }
  },

  send: async (characterId, text, replyTo, voicePeers) => {
    // #9 — claim this character's latest-send slot. A follow-up send bumps this,
    // interrupts the in-flight LLM call (main aborts it), and takes over state.
    const token = (sendSeq[characterId] ?? 0) + 1;
    sendSeq[characterId] = token;
    const isCurrent = (): boolean => sendSeq[characterId] === token;

    const inCallEarly = isVoiceCallActive(characterId);
    // A message TYPED to a companion who is on the live call still has to reach
    // the voice director: it mirrors the text to the other companions and
    // captures the reply so their reactions chain, same as a mic utterance.
    // The director's own sends pass voicePeers, so this only fires for surfaces
    // that bypass it. Must run BEFORE chatSend below — streamed reply lines
    // start arriving while the send is still in flight.
    if (inCallEarly && !(voicePeers && voicePeers.length)) notifyPlayerText(characterId, text);
    // A typed mid-call send reaches here WITHOUT voicePeers (the composer knows
    // nothing about the call); the reply must still be framed as a group turn —
    // the other companions on the call — or the model answers with solo-call
    // framing. Director sends pass their own voicePeers, which win.
    const effectivePeers =
      voicePeers && voicePeers.length ? voicePeers : inCallEarly ? voiceCallPeers(characterId) : [];
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text,
      ts: Date.now(),
      ...(replyTo ? { replyTo } : {}),
      // Mirror main's persisted flag so the optimistic bubble is hidden too.
      ...(inCallEarly ? { voice: true } : {}),
    };
    // "Realistic typing" (Appearance & feel): when ON, hold the typing indicator
    // back until the companion has "read" your message (task 2), then keep it up
    // for a length-scaled stretch before each reply bubble (task 1). When OFF,
    // the indicator shows instantly and follow-up bubbles use the fixed gap.
    // Voice calls (260705): during a call the reply is heard, not read — the
    // typing theater (reading pause, per-bubble typing delay) would just delay
    // the audio, so pacing is disabled for the call's character.
    const inCall = inCallEarly;
    const realism = !inCall && useUiStore.getState().realisticTyping;
    set((s) => ({
      messages: appendMessage(s.messages, characterId, userMsg),
      // In-call exchanges are hidden in the chat UI (ChatMessage.voice), so a
      // typing indicator would point at bubbles that never appear — keep it off.
      awaiting: { ...s.awaiting, [characterId]: !realism && !inCall },
    }));
    // Kick the reply off NOW so model generation overlaps the reading pause.
    const replyPromise = sei.chatSend({
      characterId,
      text,
      replyTo,
      ...(effectivePeers.length ? { voicePeers: effectivePeers } : {}),
    });
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
      // Voice streaming (260706): main already streamed each sentence live over
      // the chat:message push (appended + spoken by onChatMessage as it arrived),
      // so DON'T reveal or speak result.replies again — that would double every
      // line. The reveal loop below is only for the classic blocking path.
      const replies = result.streamed ? [] : result.replies;
      for (let i = 0; i < replies.length; i++) {
        const waitMs = inCall ? 0 : realism ? typingDelayMs(replies[i].text) : i > 0 ? REPLY_GAP_MS : 0;
        if (waitMs > 0) {
          set((s) => ({ awaiting: { ...s.awaiting, [characterId]: true } }));
          await delay(waitMs);
          if (!isCurrent()) return result;
        }
        set((s) => ({
          messages: appendMessage(s.messages, characterId, replies[i]),
          awaiting: { ...s.awaiting, [characterId]: !inCall && i < replies.length - 1 },
        }));
        // Voice calls (260705): speak each reply bubble as it lands. The TTS
        // queue serializes clips, so multi-bubble replies stay in order.
        notifyCompanionText(characterId, replies[i].text);
      }
      // Voice calls (260705): the companion called end_call() this turn. Its
      // goodbye replies are already queued for TTS above; the voice store ends
      // the call once they finish playing.
      if (result.endCall) requestRemoteEndCall(characterId);
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

  evictLocal: (characterId) => {
    set((s) => ({
      messages: { ...s.messages, [characterId]: [] },
      awaiting: { ...s.awaiting, [characterId]: false },
      loaded: { ...s.loaded, [characterId]: false },
      hasOlder: { ...s.hasOlder, [characterId]: false },
      loadingOlder: { ...s.loadingOlder, [characterId]: false },
    }));
  },
  };
});

// Dev-only (Vite HMR): drop the stale instance's chat:message listener before
// the re-executed module registers the fresh one. Production never runs this.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offChatMessage?.();
    offChatMessage = null;
  });
}

/**
 * Roster last-line for a character: the tail of the live transcript when any
 * messages are in memory, else the bulk-fetched preview. Skips `voice` rows
 * (in-call caption lines hidden from the chat view) and legacy event-less
 * `system` rows, so the preview never surfaces a message the opened transcript
 * does not show. System rows WITH an event ("You and X called/played for Y")
 * DO surface (260709) — a finished call or play session is the latest
 * activity, and hiding it left the card stuck on an older chat line.
 */
export function chatPreviewFor(s: ChatState, characterId: string): ChatPreview | null {
  const list = s.messages[characterId];
  if (list && list.length > 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.voice === true) continue;
      if (m.role === 'system' && m.event === undefined) continue;
      return { role: m.role, text: m.text, ts: m.ts };
    }
    return null;
  }
  // The bulk preview (main-side readLast) already skips voice rows and legacy
  // event-less system rows, so no further filter is needed here.
  return s.previews[characterId] ?? null;
}
