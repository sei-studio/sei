/**
 * Slay the Spire 2 renderer registrations (261115). Imported once from
 * App.tsx for its side effects:
 *
 *   - GAME_SURFACES.sts2   -> Sts2LaunchPanel / the generic dashboard
 *   - the setup modal body -> Sts2SetupBody (the four setup steps)
 *   - the summon flow      -> setup gate, then the default world gate
 *
 * Slay the Spire 2 is `available: false` in the shared catalog, so the
 * picker shows a coming-soon tile and nothing here is reachable from it yet.
 */
import { getGameSurface, registerGameSurface } from '../../lib/gameSurfaces';
import { registerSummonFlow, makeDefaultSummonFlow } from '../../lib/summonFlow';
import { registerGameSetupBody } from '../../lib/gameSetupBodies';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { Sts2LaunchPanel } from './Sts2LaunchPanel';
import { Sts2SetupBody } from './Sts2SetupBody';
import { useSts2Store } from './useSts2Store';

// The dashboard stays the generic activity line; only the launch surface is the game's.
registerGameSurface('sts2', { LaunchPanel: Sts2LaunchPanel, DashboardPanel: getGameSurface('sts2').DashboardPanel });
registerGameSetupBody('sts2', Sts2SetupBody);

const worldGate = makeDefaultSummonFlow('sts2');

/**
 * A fresh setup check first (no game, no current mod, or the mod not yet
 * turned on parks the attempt behind the setup modal, whose body offers the
 * fix), then the shared world gate (summon when a Sei co-op lobby is open,
 * else park and resume when it opens).
 */
registerSummonFlow('sts2', {
  async attempt(id) {
    const s = await useSts2Store.getState().refresh();
    const world = useDataStore.getState().worlds.sts2;
    const ready = (s?.kind === 'found' && s.modInstalled && s.modCurrent && s.modLoaded) || world?.kind === 'open';
    if (s && !ready) {
      const ui = useUiStore.getState();
      const view = ui.view;
      ui.setPendingSummon(id);
      ui.setPendingSummonGame('sts2');
      ui.setPendingSummonReturnToChat(view.kind === 'chat' && view.characterId === id);
      ui.openModal({ kind: 'game-setup', game: 'sts2' });
      return;
    }
    await worldGate.attempt(id);
  },
});
