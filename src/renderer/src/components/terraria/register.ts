/**
 * Terraria renderer registrations (261113). Imported once from App.tsx for
 * its side effects:
 *
 *   - GAME_SURFACES.terraria  -> TerrariaLaunchPanel / the generic dashboard
 *   - the setup modal body    -> TerrariaSetupBody (the four setup steps)
 *   - the summon flow         -> setup gate, then the default world gate
 *
 * Terraria is `available: false` in the shared catalog, so the picker shows
 * a coming-soon tile and nothing here is reachable from it yet.
 */
import { getGameSurface, registerGameSurface } from '../../lib/gameSurfaces';
import { registerSummonFlow, makeDefaultSummonFlow } from '../../lib/summonFlow';
import { registerGameSetupBody } from '../../lib/gameSetupBodies';
import { useUiStore } from '../../lib/stores/useUiStore';
import { TerrariaLaunchPanel } from './TerrariaLaunchPanel';
import { TerrariaSetupBody } from './TerrariaSetupBody';
import { useTerrariaStore } from './useTerrariaStore';

registerGameSurface('terraria', { LaunchPanel: TerrariaLaunchPanel, DashboardPanel: getGameSurface('terraria').DashboardPanel });
registerGameSetupBody('terraria', TerrariaSetupBody);

const worldGate = makeDefaultSummonFlow('terraria');

/**
 * A fresh setup check first (no tModLoader or no mod parks the attempt
 * behind the setup modal, whose body offers the fix), then the shared world
 * gate (summon if a world is open, else park and resume when it is).
 */
registerSummonFlow('terraria', {
  async attempt(id) {
    const s = await useTerrariaStore.getState().refresh();
    const ready = s != null && s.tmlInstalled !== false && s.modInstalled && s.modEnabled && s.linked;
    if (s && !ready) {
      const ui = useUiStore.getState();
      const view = ui.view;
      ui.setPendingSummon(id);
      ui.setPendingSummonGame('terraria');
      ui.setPendingSummonReturnToChat(view.kind === 'chat' && view.characterId === id);
      ui.openModal({ kind: 'game-setup', game: 'terraria' });
      return;
    }
    await worldGate.attempt(id);
  },
});
