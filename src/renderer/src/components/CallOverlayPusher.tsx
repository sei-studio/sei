/**
 * AvatarOverlayPusher (260706 as CallOverlayPusher; 260804 avatar rework) —
 * bridges app state to the always-on-top avatar overlay window. Renders
 * nothing; it watches the avatar mode + activity surfaces + call state and
 * pushes the overlay's desired state to main (voice:overlay-set), which
 * spawns/positions/tears down the overlay window and forwards the state to it.
 *
 * Lives in the MAIN window (mounted in the App shell), where the character
 * roster is available to resolve each participant's name + portrait. Reading
 * the roster via getState() inside the effect keeps it OFF the dependency
 * list, so a routine character-status update does not re-push.
 *
 * 260804: the player's own tile is GONE — the overlay is the companion's
 * presence on the desktop, not a mirror. Which companions show is
 * computeAvatarIds (pure, tested): 'activity' = call members + live game/
 * share/summon characters; 'always' falls back to the open chat.
 */
import { useEffect } from 'react';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChessStore } from '../lib/stores/useChessStore';
import { useDrawStore } from '../lib/stores/useDrawStore';
import { useBackseatStore } from '../lib/stores/useBackseatStore';
import { useAvatarStore } from '../lib/stores/useAvatarStore';
import { computeAvatarIds } from '../lib/avatar/overlayParticipants';
import { classifyEmotion } from '../lib/avatar/emotion';
import { setAvatarLevelTapEnabled } from '../lib/voice/avatarLevelTap';
import { sei } from '../lib/ipcClient';
import { t } from '../lib/i18n';

export function CallOverlayPusher(): null {
  const mode = useUiStore((s) => s.avatarMode);
  const avatarPrefs = useUiStore((s) => s.avatarPrefsByCharacter);
  const view = useUiStore((s) => s.view);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const lastSpoken = useVoiceStore((s) => s.lastSpoken);
  const lastSpokenId = useVoiceStore((s) => s.lastSpokenId);
  const chessGames = useChessStore((s) => s.games);
  const drawGames = useDrawStore((s) => s.games);
  const backseatActive = useBackseatStore((s) => s.active);
  const summons = useDataStore((s) => s.summons);
  const manifests = useAvatarStore((s) => s.manifests);
  const ensureManifest = useAvatarStore((s) => s.ensure);

  // Activity surfaces beyond the call itself — same definitions as
  // activeGameFor/avatarActivityBadge, inlined over subscribed slices so a
  // game starting/ending re-pushes.
  const activityIds = [
    ...Object.keys(chessGames).filter((id) => {
      const g = chessGames[id];
      return g != null && g.status !== 'ended';
    }),
    ...Object.keys(drawGames).filter((id) => {
      const g = drawGames[id];
      return g != null && g.phase !== 'gallery' && g.phase !== 'setup';
    }),
    ...Object.keys(backseatActive).filter((id) => backseatActive[id]),
    ...Object.keys(summons).filter((id) => {
      const k = summons[id]?.kind;
      return k === 'online' || k === 'connecting';
    }),
  ];

  const callActive = callStatus === 'live' || callStatus === 'connecting';
  const ids = computeAvatarIds({
    mode,
    callParticipants: callActive ? participants : [],
    activityIds,
    openChatId: view.kind === 'chat' ? view.characterId : null,
  });
  const idsKey = ids.join(',');

  // Live2D presence is read from the manifest cache; ask for any id we have
  // never asked about (fire-and-forget; the answer re-renders and re-pushes).
  useEffect(() => {
    for (const id of ids) ensureManifest(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, ensureManifest]);

  // Arm the TTS level tap only while a shown participant is Live2D — the tap
  // has a real cost on the no-pitch audio path (see avatarLevelTap).
  useEffect(() => {
    setAvatarLevelTapEnabled(mode !== 'off' && ids.some((id) => !!manifests[id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, idsKey, manifests]);

  useEffect(() => {
    const chars = useDataStore.getState().characters;
    void sei
      .voiceOverlaySet?.({
        enabled: mode !== 'off',
        participants: ids.map((id) => {
          const c = chars.find((x) => x.id === id);
          const prefs = avatarPrefs[id];
          const speaking = speakingId === id;
          return {
            id,
            name: c?.name ?? t('Companion'),
            portrait: c?.portrait_image ?? null,
            speaking,
            frame: prefs?.frame ?? 'circle',
            alwaysBright: prefs?.always_bright === true,
            live2d: !!manifests[id],
            // Only the audibly-speaking companion wears an emotion, classified
            // from the line it is saying (lastSpoken is set at first audible
            // sample alongside speakingId).
            emotion: speaking && lastSpokenId === id ? classifyEmotion(lastSpoken) : null,
          };
        }),
      })
      .catch(() => {
        /* overlay is best-effort; a failed push never affects the app */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, mode, speakingId, lastSpoken, lastSpokenId, avatarPrefs, manifests]);

  return null;
}
