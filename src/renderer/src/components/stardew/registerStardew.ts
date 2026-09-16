/**
 * Stardew Valley renderer registration (game adapters M1, 260908). Imported
 * once from App.tsx for its side effects: the launch + dashboard panels, the
 * summon flow (install gate before the world gate), the error routes for the
 * two Stardew-specific classes, the Settings group, and the setup modal body.
 */
import { registerGameSurface } from '../../lib/gameSurfaces';
import { registerSummonFlow, makeDefaultSummonFlow } from '../../lib/summonFlow';
import { BOT_ERROR_ROUTES } from '../../lib/botErrorRouting';
import { registerGameSettingsSection } from '../../lib/gameSettingsSections';
import { registerGameSetupModal } from '../GameSetupModal';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useStardewStore } from '../../lib/stores/useStardewStore';
import { StardewLaunchPanel } from './StardewLaunchPanel';
import { StardewDashboardPanel } from './StardewDashboardPanel';
import { StardewSetupModal } from './StardewSetupModal';
import { StardewSettingsSection } from './StardewSettingsSection';

const defaultFlow = makeDefaultSummonFlow('stardew');

registerGameSurface('stardew', { LaunchPanel: StardewLaunchPanel, DashboardPanel: StardewDashboardPanel });

/**
 * The Stardew pipeline: an install gate (the mod must be in the game before
 * a farm can ever answer), then the shared world gate (fresh world check,
 * summon if open, else park behind the setup modal which auto-resumes).
 */
registerSummonFlow('stardew', {
  async attempt(id) {
    const state = (await useStardewStore.getState().refresh()) ?? useStardewStore.getState().state;
    if (state && !state.ready) {
      const ui = useUiStore.getState();
      const view = ui.view;
      ui.setPendingSummon(id);
      ui.setPendingSummonGame('stardew');
      ui.setPendingSummonReturnToChat(view.kind === 'chat' && view.characterId === id);
      ui.openModal({ kind: 'game-setup', game: 'stardew' });
      return;
    }
    await defaultFlow.attempt(id);
  },
});

BOT_ERROR_ROUTES.stardew = {
  ...BOT_ERROR_ROUTES.stardew,
  STARDEW_FARMHAND_NO_MOD: (s, game) => ({ kind: 'game-error', game, characterId: s.characterId, error: s.error, message: s.message }),
  SMAPI_INSTALL_FAILED: (s, game) => ({ kind: 'game-error', game, characterId: s.characterId, error: s.error, message: s.message }),
};

registerGameSettingsSection({ game: 'stardew', title: 'Stardew Valley', Section: StardewSettingsSection });
registerGameSetupModal('stardew', StardewSetupModal);
