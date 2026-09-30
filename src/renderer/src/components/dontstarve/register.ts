/**
 * Don't Starve Together renderer registrations (game adapters M2, 260908).
 * Imported once from App.tsx for its side effects:
 *
 *   - GAME_SURFACES.dontstarve  -> DstLaunchPanel / DstDashboardPanel
 *   - the setup modal body      -> DstSetupBody (install / launch steps)
 *   - the summon flow           -> install gate, then the default world gate
 *   - the Settings group        -> DstSettingsSection
 */
import { registerGameSurface } from '../../lib/gameSurfaces';
import { registerSummonFlow, makeDefaultSummonFlow } from '../../lib/summonFlow';
import { registerGameSetupBody } from '../../lib/gameSetupBodies';
import { registerGameSettingsSection } from '../../lib/gameSettingsSections';
import { useUiStore } from '../../lib/stores/useUiStore';
import { DstLaunchPanel } from './DstLaunchPanel';
import { DstDashboardPanel } from './DstDashboardPanel';
import { DstSetupBody } from './DstSetupBody';
import { DstSettingsSection } from './DstSettingsSection';
import { useDstStore } from './useDstStore';

registerGameSurface('dontstarve', { LaunchPanel: DstLaunchPanel, DashboardPanel: DstDashboardPanel });
registerGameSetupBody('dontstarve', DstSetupBody);
registerGameSettingsSection({ game: 'dontstarve', title: "Don't Starve Together", Section: DstSettingsSection });

const worldGate = makeDefaultSummonFlow('dontstarve');

/**
 * The DST pipeline: a fresh install check first (no game or no helper parks
 * the attempt behind the setup modal, whose body offers the fix), then the
 * shared world gate (summon if a hosted world is heartbeating, else park and
 * auto-resume when it appears).
 */
registerSummonFlow('dontstarve', {
  async attempt(id) {
    const state = await useDstStore.getState().refreshInstall();
    const helperReady = state?.kind === 'found' && state.modInstalled;
    if (state && !helperReady) {
      const ui = useUiStore.getState();
      const view = ui.view;
      ui.setPendingSummon(id);
      ui.setPendingSummonGame('dontstarve');
      ui.setPendingSummonReturnToChat(view.kind === 'chat' && view.characterId === id);
      ui.openModal({ kind: 'game-setup', game: 'dontstarve' });
      return;
    }
    await worldGate.attempt(id);
  },
});
