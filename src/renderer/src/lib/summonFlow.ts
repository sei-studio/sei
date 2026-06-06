/**
 * Shared summon-attempt flow.
 *
 * Both CharacterPage (deploy bar) and CharactersScreen (grid card) trigger a
 * summon, and both must run the same two gates in the same order:
 *
 *   1. First-summon skin-setup nudge — the FIRST time a user who has never
 *      completed skin setup tries to summon any character, show a one-time
 *      "run skin setup" prompt. This fires BEFORE the LAN "not connected"
 *      instruction (a user with no open world should be told about skins
 *      first). Gated by WizardState.hasRunOnce (have they ever set up) AND a
 *      profile-scoped wizard:prompt-shown flag (have we already nudged them),
 *      so it appears at most once per account. Skin setup is needed in BOTH
 *      cloud and local mode, so this is not gated on ai_backend_kind.
 *
 *   2. LAN gate — if connected, summon immediately; otherwise stash the
 *      pending id and open the LAN "open your world" modal, which auto-resumes
 *      the summon when LAN flips to connected (LanModal, D-56).
 *
 * Centralised here (rather than duplicated per screen) so the gate order and
 * the show-once bookkeeping live in one place. `proceedSummon` is exported so
 * the skin-setup prompt's "skip for now" button can resume the normal flow.
 */

import { sei } from './ipcClient';
import { useUiStore } from './stores/useUiStore';
import { useDataStore } from './stores/useDataStore';

/**
 * Run the LAN gate and summon. Always navigates to the character page on the
 * connected path — harmless when the caller is already on that page
 * (CharacterPage) and matches the CharactersScreen card behavior.
 */
export function proceedSummon(id: string): void {
  const ui = useUiStore.getState();
  const lan = useDataStore.getState().lan;
  if (lan.kind === 'connected') {
    void sei.summon(id).catch(() => {
      // Errors surface via onStatus → BotStatus.error; the model row owns display.
    });
    ui.navigate({ kind: 'character', id });
    return;
  }
  ui.setPendingSummon(id);
  ui.openModal({ kind: 'lan', mode: 'searching' });
}

/**
 * Entry point for a summon attempt. Shows the one-time skin-setup nudge if
 * warranted; otherwise falls straight through to {@link proceedSummon}. Never
 * blocks the summon on the nudge — any IPC failure degrades to the normal flow.
 */
export async function attemptSummon(id: string): Promise<void> {
  try {
    const { shown } = await sei.wizardPromptShown('get');
    if (!shown) {
      const wiz = await sei.getWizardState();
      if (!wiz.hasRunOnce) {
        // First summon for a user who has never set up skins — nudge once,
        // then never auto-show again (they can re-run setup from Settings).
        await sei.wizardPromptShown('set');
        useUiStore.getState().openModal({ kind: 'skin-setup-prompt', characterId: id });
        return;
      }
    }
  } catch {
    // Best-effort — never let the nudge bookkeeping block a summon.
  }
  proceedSummon(id);
}
