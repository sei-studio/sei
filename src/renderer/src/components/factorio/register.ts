/**
 * Factorio renderer registrations (261113). Imported once from App.tsx for
 * its side effects:
 *
 *   - GAME_SURFACES.factorio  -> FactorioLaunchPanel / the generic dashboard
 *   - the setup modal body    -> FactorioSetupBody (the four setup steps)
 *   - the summon flow         -> setup gate, then the default world gate
 *
 * Factorio is `available: false` in the shared catalog, so the picker shows
 * a coming-soon tile and nothing here is reachable from it yet.
 */
import { getGameSurface, registerGameSurface } from '../../lib/gameSurfaces';
import { registerSummonFlow, makeDefaultSummonFlow } from '../../lib/summonFlow';
import { registerGameSetupBody } from '../../lib/gameSetupBodies';
import { useUiStore } from '../../lib/stores/useUiStore';
import { FactorioLaunchPanel } from './FactorioLaunchPanel';
import { FactorioSetupBody } from './FactorioSetupBody';
import { useFactorioStore } from './useFactorioStore';

// The dashboard stays the generic activity line (GAME_SURFACES' default for
// a game without its own panel); only the launch surface is Factorio's.
registerGameSurface('factorio', { LaunchPanel: FactorioLaunchPanel, DashboardPanel: getGameSurface('factorio').DashboardPanel });
registerGameSetupBody('factorio', FactorioSetupBody);

const worldGate = makeDefaultSummonFlow('factorio');

/**
 * A fresh setup check first (no supported game or no mod parks the attempt
 * behind the setup modal, whose body offers the fix), then the shared world
 * gate (summon if the mod answers, else park and resume when it does).
 */
registerSummonFlow('factorio', {
  async attempt(id) {
    const s = await useFactorioStore.getState().refresh();
    const ready = s?.kind === 'found' && s.install.supported !== false && s.modInstalled && s.modEnabled;
    if (s && !ready) {
      const ui = useUiStore.getState();
      const view = ui.view;
      ui.setPendingSummon(id);
      ui.setPendingSummonGame('factorio');
      ui.setPendingSummonReturnToChat(view.kind === 'chat' && view.characterId === id);
      ui.openModal({ kind: 'game-setup', game: 'factorio' });
      return;
    }
    await worldGate.attempt(id);
  },
});
