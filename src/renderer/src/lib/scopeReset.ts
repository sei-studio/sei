/**
 * Renderer caches that belong to ONE account (260926).
 *
 * Main re-points every per-profile store on app:scope-changed (sign-in,
 * sign-out, account switch), but the renderer keeps what it already read in
 * memory. The bundled defaults (Sui, Lyra, ...) have the same UUID in every
 * profile, so a cache keyed by character id showed the next account the
 * previous account's data: most seriously the chat transcript, straight from
 * useChatStore without a disk read. App.tsx calls this FIRST in its
 * scope-changed handler, before it reloads config and characters.
 *
 * Cleared here: chat transcripts + previews + in-flight reveals, imported
 * avatar manifests, unsent feedback drafts, and the dev console's bot log
 * (bot lines quote the conversation), and the recently-deleted id set. Stores that already re-seed on scope or
 * auth change (characters, library state, credits, cloud ids) are not
 * repeated here.
 */
import { useChatStore } from './stores/useChatStore';
import { useAvatarStore } from './stores/useAvatarStore';
import { useDataStore } from './stores/useDataStore';
import { clearAllFeedbackDrafts } from './feedbackDraft';

export function resetAccountScopedState(): void {
  useChatStore.getState().resetForScope();
  useAvatarStore.getState().reset();
  useDataStore.getState().clearLogs();
  // Ids the previous account deleted: they hide cloud placeholders by id, and
  // a default deleted by one account must not vanish for the next.
  useDataStore.setState({ recentlyDeletedIds: new Set<string>() });
  clearAllFeedbackDrafts();
}
