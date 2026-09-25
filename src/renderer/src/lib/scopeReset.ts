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
 * avatar manifests, unsent feedback drafts, the dev console's bot log (bot
 * lines quote the conversation), the recently-deleted id set, and a pending
 * guided first moment. Stores that already re-seed on scope or
 * auth change (characters, library state, credits, cloud ids) are not
 * repeated here.
 *
 * Live surfaces (260926): endLiveSurfaces() drops the renderer's half of every
 * per-account session (the voice call, screen capture, the chess and Draw!
 * mirrors) and leaves any screen that belongs to one. Main ends the sessions
 * themselves, writes their rows into the outgoing account, and then pushes
 * app:scope-ending, which runs this at once; resetAccountScopedState runs it
 * again as the safety net (it is idempotent).
 */
import { useChatStore } from './stores/useChatStore';
import { useAvatarStore } from './stores/useAvatarStore';
import { useDataStore } from './stores/useDataStore';
import { useFirstMomentStore } from './stores/useFirstMomentStore';
import { clearAllFeedbackDrafts } from './feedbackDraft';
import { useVoiceStore } from './stores/useVoiceStore';
import { useBackseatStore } from './stores/useBackseatStore';
import { useChessStore } from './stores/useChessStore';
import { useDrawStore } from './stores/useDrawStore';
import { useUiStore, type View } from './stores/useUiStore';

/** Screens that show one character's live or private surface. */
const ACCOUNT_SURFACE_VIEWS: ReadonlySet<View['kind']> = new Set<View['kind']>([
  'chat',
  'voice-call',
  'draw',
  'character',
  'unique-reveal',
]);

/**
 * End the renderer's half of every live per-account surface (260926) and
 * return to Home from any screen that belongs to one. Never calls main to
 * end anything: main already did, before it told us.
 */
export function endLiveSurfaces(): void {
  // Capture first, the call second: the same order as the hang-up button.
  try { useBackseatStore.getState().resetForScope(); } catch { /* keep going */ }
  try {
    const voice = useVoiceStore.getState();
    // endCall is the single call teardown (mic, TTS queue, timers, overlay).
    // Its hang-up reports reach main after main closed these calls itself,
    // and main drops them (voice/callState consumeClosedByMain).
    if (voice.participants.length > 0 || voice.status !== 'idle') voice.endCall();
  } catch { /* keep going */ }
  try { useChessStore.getState().resetForScope(); } catch { /* keep going */ }
  try { useDrawStore.getState().resetForScope(); } catch { /* keep going */ }
  try {
    const ui = useUiStore.getState();
    ui.setGameFullscreen(false);
    // navigate() also closes any open modal. Elsewhere, only a modal about
    // one of the old account's characters (games picker, share-screen, ...)
    // goes; an auth or terms modal the sign-in itself raised stays.
    if (ACCOUNT_SURFACE_VIEWS.has(ui.view.kind)) ui.navigate({ kind: 'home' });
    else if (ui.modal && 'characterId' in ui.modal) ui.closeModal();
  } catch { /* keep going */ }
}

export function resetAccountScopedState(): void {
  endLiveSurfaces();
  useChatStore.getState().resetForScope();
  useAvatarStore.getState().reset();
  useDataStore.getState().clearLogs();
  // Ids the previous account deleted: they hide cloud placeholders by id, and
  // a default deleted by one account must not vanish for the next.
  useDataStore.setState({ recentlyDeletedIds: new Set<string>() });
  clearAllFeedbackDrafts();
  // A pending guided first moment belongs to the account that armed it.
  useFirstMomentStore.getState().reset();
}
