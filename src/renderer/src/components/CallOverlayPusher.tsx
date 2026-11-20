/**
 * AvatarOverlayPusher (260706 as CallOverlayPusher; 260804 avatar rework;
 * 261120 WorldLink pin) — bridges app state to the always-on-top avatar
 * overlay window. Renders nothing; it pushes the overlay's desired state to
 * main (voice:overlay-set), which spawns/positions/tears down the overlay
 * window and forwards the state to it.
 *
 * Lives in the MAIN window (mounted in the App shell), where the character
 * roster is available to resolve the name + portrait. Reading the roster via
 * getState() inside the effect keeps it OFF the dependency list, so a routine
 * character-status update does not re-push.
 *
 * 261120: who shows is floatingAvatarIds (shared/seilinkPin.ts, pure,
 * tested): only the WorldLink companion while she is pinned on top, and
 * never while the app draws her in her room itself (her room editor, the
 * WorldLink intro). Calls, games, shares and summons add nobody; a call
 * with her still drives her mouth, emotion, mute, interrupt and captions
 * here. She is drawn the way her room draws her (`figure`: the room's
 * avatar choice, RoomAvatar in the overlay).
 */
import { useEffect, useState } from 'react';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useBackseatStore } from '../lib/stores/useBackseatStore';
import { useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { classifyEmotion } from '../lib/avatar/emotion';
import { setAvatarLevelTapEnabled } from '../lib/voice/avatarLevelTap';
import { sei } from '../lib/ipcClient';
import { t, useLangStore } from '../lib/i18n';
import { floatingAvatarIds } from '@shared/seilinkPin';
import { roomAvatarUse, type RoomAvatarUse } from './seilink/RoomAvatar';

export function CallOverlayPusher(): null {
  const available = useSeilinkStore((s) => s.availability?.enabled === true);
  const hostState = useSeilinkStore((s) => s.status.state);
  const hostCharacterId = useSeilinkStore((s) => s.status.characterId);
  const hostPinned = useSeilinkStore((s) => s.status.pinned === true);
  // The app drawing her in her room itself: the room editor (also the
  // first-link flow on the desktop) and the intro.
  const editorId = useSeilinkStore((s) => (s.flow?.kind === 'editor' ? s.flow.characterId : null));
  const introId = useSeilinkStore((s) => s.intro?.characterId ?? null);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const lastSpoken = useVoiceStore((s) => s.lastSpoken);
  const lastSpokenId = useVoiceStore((s) => s.lastSpokenId);
  const callMuted = useUiStore((s) => s.callMuted);
  const lang = useLangStore((s) => s.lang);
  const backseatActive = useBackseatStore((s) => s.active);

  const ids = floatingAvatarIds({
    available,
    status: { state: hostState, characterId: hostCharacterId, pinned: hostPinned },
    inRoomViews: [editorId, introId].filter((x): x is string => !!x),
  });
  const id = ids[0] ?? null;

  // Her figure follows her room's avatar choice (imported model or the Sei
  // avatar). The Sei avatar until the room answers (what her room shows with
  // no saved choice); a room edit re-reads it.
  const [figure, setFigure] = useState<{ id: string; use: RoomAvatarUse } | null>(null);
  useEffect(() => {
    if (!id) return;
    let dead = false;
    const load = (): void => {
      void sei
        .seilinkRoomGet?.(id)
        .then((r) => {
          if (!dead && r) setFigure({ id, use: roomAvatarUse(r.state.avatar) });
        })
        .catch(() => {
          /* the default stands */
        });
    };
    load();
    const off = sei.onSeilinkRoomChanged?.((changed) => {
      if (changed === id) load();
    });
    return () => {
      dead = true;
      off?.();
    };
  }, [id]);
  const use: RoomAvatarUse = figure && figure.id === id ? figure.use : 'sei';

  // Arm the TTS level tap only while she floats: the tap has a real cost on
  // the no-pitch audio path (see avatarLevelTap).
  useEffect(() => {
    setAvatarLevelTapEnabled(id !== null);
  }, [id]);

  // The overlay's mute button relays through main; the mic's single source of
  // truth stays HERE (useUiStore.callMuted, which dictation subscribes to).
  useEffect(() => {
    const off = sei.onAvatarMuteRequest?.(() => {
      const ui = useUiStore.getState();
      ui.setCallMuted(!ui.callMuted);
    });
    return () => off?.();
  }, []);

  // 261030: the overlay's interrupt button, relayed the same way. During a
  // share the player is in their game and the overlay is the only call
  // control on screen, so this is the interrupt that is actually reachable.
  useEffect(() => {
    const off = sei.onAvatarInterruptRequest?.(() => useVoiceStore.getState().interrupt());
    return () => off?.();
  }, []);

  const callActive = callStatus === 'live' || callStatus === 'connecting';
  // Her call controls show only when SHE is on the call (or sharing): a call
  // with someone else is not hers to mute from her overlay.
  const herCall = !!id && ((callActive && participants.includes(id)) || backseatActive[id] === true);

  useEffect(() => {
    const chars = useDataStore.getState().characters;
    void sei
      .voiceOverlaySet?.({
        enabled: id !== null,
        // Call-surface extras (260806): gate the overlay's mute + captions
        // buttons and feed the caption box.
        onCall: herCall,
        muted: callMuted,
        lang,
        lastSpoken: herCall && lastSpokenId === id ? lastSpoken || null : null,
        lastSpokenId: herCall ? lastSpokenId : null,
        participants: id
          ? [id].map((pid) => {
              const c = chars.find((x) => x.id === pid);
              const speaking = speakingId === pid;
              return {
                id: pid,
                name: c?.name ?? t('Companion'),
                portrait: c?.portrait_image ?? null,
                speaking,
                figure: use,
                // Only while she is audibly speaking does she wear an emotion,
                // classified from the line she is saying.
                emotion: speaking && lastSpokenId === pid ? classifyEmotion(lastSpoken) : null,
              };
            })
          : [],
      })
      .catch(() => {
        /* overlay is best-effort; a failed push never affects the app */
      });
  }, [id, use, herCall, speakingId, lastSpoken, lastSpokenId, callMuted, lang]);

  return null;
}
