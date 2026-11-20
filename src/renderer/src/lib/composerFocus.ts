/**
 * Focus her chat composer once her chat is up (product call (261116)): a
 * double click on her on the desktop brings Sei to the front on her chat,
 * ready to type. App.tsx asks before it navigates; ChatScreen takes the ask
 * when it shows that character's chat (now, or when it mounts). An ask is
 * good for FOCUS_ASK_MS, so a stale one never steals focus later.
 */
export const FOCUS_ASK_MS = 5_000;

let pending: { characterId: string; at: number } | null = null;
const listeners = new Set<() => void>();

export function requestComposerFocus(characterId: string, now = Date.now()): void {
  pending = { characterId, at: now };
  listeners.forEach((l) => l());
}

/** True (and the ask is used up) when there is a fresh ask for this character. */
export function takeComposerFocus(characterId: string, now = Date.now()): boolean {
  if (!pending || pending.characterId !== characterId) return false;
  const fresh = now - pending.at <= FOCUS_ASK_MS;
  pending = null;
  return fresh;
}

export function onComposerFocusRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
