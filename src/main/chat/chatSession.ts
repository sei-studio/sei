/**
 * chatSession — analytics session boundaries for plain text chat (260801).
 *
 * Text chat was the one companion surface with NO instrumentation at all. Every
 * other surface emits `<surface>_started` / `<surface>_ended` with `duration_ms`
 * and a `character_id` (see CLAUDE.md, "Instrumenting a game or timed surface"),
 * so the dashboard's playtime and its per-character attribution both excluded
 * texting entirely. A user who signed up, texted a companion for an hour and
 * never opened a call or a minigame was indistinguishable from one who bounced
 * after onboarding.
 *
 * WHY AN IDLE TIMEOUT AND NOT SCREEN MOUNT/UNMOUNT. Two reasons. A mounted
 * ChatScreen left open in the background is not playtime, and counting it would
 * inflate the one number the dashboard sums across every surface. And the chat
 * screen HOSTS the other surfaces: measuring mounted time would double-count
 * every chess game, Draw! round and voice call against the chat clock. Here a
 * session is a run of actual messages, so `duration_ms` is time spent talking.
 *
 * The overlap is excluded structurally rather than by subtraction:
 * `noteChatMessage` is called from ONE place — the point in the `chat:send`
 * handler past which chess and Draw! have both declined to handle the message
 * and no voice call is live. A line typed into a live game or spoken on a call
 * is already counted by that surface's own event and never reaches here.
 *
 * `duration_ms` spans first message to LAST message, never including the idle
 * tail that closes the session, so a conversation is never credited with the
 * timeout. A one-message session therefore reports 0 ms, which is honest:
 * `messages` carries what actually happened.
 *
 * Shape only, never content — no message text, no persona, no reply.
 */

/** Quiet gap that ends a session. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface LiveSession {
  characterId: string;
  startedAt: number;
  lastAt: number;
  messages: number;
  timer: NodeJS.Timeout;
}

// One session per character: two companions texted in the same stretch are two
// sessions, the same way two summons are two bot sessions.
const sessions = new Map<string, LiveSession>();

/**
 * Record one player message to `characterId` on the plain-chat path. Opens a
 * session on the first message and refreshes the idle timer on every one.
 * Never throws — analytics must not be able to break a chat send.
 */
export function noteChatMessage(characterId: string): void {
  try {
    const now = Date.now();
    const live = sessions.get(characterId);
    if (live) {
      clearTimeout(live.timer);
      live.lastAt = now;
      live.messages += 1;
      live.timer = setTimeout(() => void endChatSession(characterId, 'idle'), IDLE_TIMEOUT_MS);
      // A pending timer must never hold the app open at quit.
      live.timer.unref?.();
      return;
    }
    const timer = setTimeout(() => void endChatSession(characterId, 'idle'), IDLE_TIMEOUT_MS);
    timer.unref?.();
    sessions.set(characterId, { characterId, startedAt: now, lastAt: now, messages: 1, timer });
    void (async () => {
      try {
        const { capture } = await import('../analytics');
        capture('chat_session_started', { character_id: characterId });
      } catch { /* best-effort */ }
    })();
  } catch { /* best-effort */ }
}

/**
 * Close one character's session and emit `chat_session_ended`. Idempotent — a
 * quit racing the idle timer emits exactly one event.
 */
export async function endChatSession(characterId: string, reason: 'idle' | 'quit'): Promise<void> {
  const live = sessions.get(characterId);
  if (!live) return;
  clearTimeout(live.timer);
  sessions.delete(characterId);
  try {
    const { capture } = await import('../analytics');
    capture('chat_session_ended', {
      character_id: characterId,
      duration_ms: live.lastAt - live.startedAt,
      messages: live.messages,
      reason,
    });
  } catch { /* best-effort */ }
}

/**
 * Close every open session. Called from the app's quit path so a conversation
 * still inside its idle window is not lost — without this, quitting mid-chat
 * (the normal way a chat ends) would drop the session entirely.
 */
export async function endAllChatSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => endChatSession(id, 'quit')));
}
