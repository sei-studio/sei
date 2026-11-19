/**
 * ChatTopBar — the ONE companion top bar (260721), shared by ChatScreen and
 * VoiceCallScreen so games and calls keep an identical header: back chevron,
 * avatar, bold name + dim #tag (opens the profile page), and the top-right
 * game-controller + phone buttons.
 *
 * Context-aware behavior, identical structure:
 *   - back:  chat → home; call view → back to that chat (the call keeps
 *            running; GameSurface's chrome row / the icon-rail badge carry it).
 *   - controller: opens the games picker, including mid-call. It carried the
 *            one-time "New games added" tip (260929) until the tip moved to
 *            WorldLink (261119).
 *   - backseat: opens the screen-share source picker (260803). It is here
 *            because backseat's only other entry point is the share button in
 *            the call controls, which you cannot reach without already being on
 *            a call, so nobody who had not already found the feature ever saw
 *            it. From here, confirming a source starts the call as well (the
 *            picker arms a pending share; see ShareScreenModal). Its one-time
 *            beta tip was moved to the games button (260929). Its "(beta)"
 *            tag moved to WorldLink (261119).
 *   - SeiLink (261105, T337): her room on the desktop. Shown wherever SeiLink
 *            can run (useSeilinkStore availability). Not moved in -> the
 *            move-in flow (the sheet, or straight in); moved in -> her room
 *            editor (lib/seilink/seilinkFlow openSeilink). Lit while she lives
 *            there. The guide's SeiLink tour spotlights it (data-tutorial).
 *            Tagged "(beta)" in its label and tooltip, the way Backseat was.
 *            It carries the one-time "New" tip (261119, lib/worldlinkTipPref),
 *            which keeps out of the way of WorldLink's own tour, sheet and
 *            intro; clicking the button retires it.
 *   - phone: no call → start one. With a game surface open the call starts IN
 *            PLACE (260722, startOrOpenCall: this screen stays, GameSurface's
 *            chrome row shows the compact controls); otherwise the fullscreen
 *            call view opens (its gate handles consent/install before
 *            dialing). On the call view → back to chat (toggles the SURFACE;
 *            hanging up stays on the red button).
 */

import React, { useEffect, useMemo } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useTutorialStore } from '../lib/stores/useTutorialStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import {
  claimTipShown,
  dismissWorldlinkTip,
  shouldShowWorldlinkTip,
  useWorldlinkTipStore,
  worldlinkAlreadyKnown,
  worldlinkTipDone,
} from '../lib/worldlinkTipPref';
import { FEATURE_TIP_EVENT, type TipAction } from '@shared/seilinkIntroTelemetry';
import { sei } from '../lib/ipcClient';
import { useFirstMomentStore } from '../lib/stores/useFirstMomentStore';
import { startOrOpenCall } from '../lib/callLaunch';
import { visionBlocked, visionGateReason } from '../lib/visionGate';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { GamepadIcon, PhoneIcon, BackIcon, UserIcon, BackseatIcon, SeilinkIcon } from './icons';
import { movedInId, useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { openSeilink } from '../lib/seilink/seilinkFlow';
import { IdTag } from './IdTag';
import { useT } from '../lib/i18n';
import styles from './ChatTopBar.module.css';

/** The WorldLink tip's analytics (shape only, rebuilt in main). */
function trackTip(action: TipAction, characterId: string): void {
  try {
    sei.track(FEATURE_TIP_EVENT, { target: 'worldlink', action, character_id: characterId });
  } catch {
    /* analytics must never disrupt the header */
  }
}

export interface ChatTopBarProps {
  characterId: string;
  /** A game surface is open below the header (ChatScreen's own `gameOpen`).
   *  Only hides the one-time WorldLink tip, which would otherwise cover the game. */
  gameOpen?: boolean;
}

export function ChatTopBar({ characterId, gameOpen = false }: ChatTopBarProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setChatReturnId = useUiStore((s) => s.setChatReturnId);
  const onCallView = useUiStore((s) => s.view.kind === 'voice-call');
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const t = useT();
  const seilinkAvailable = useSeilinkStore((s) => s.availability?.enabled === true);
  const seilinkHere = useSeilinkStore((s) => movedInId(s.status) === characterId);

  // china-compat W9: backseat is an image surface, so a text-only local model
  // disables the button (never hides it) with the reason as its tooltip. Only
  // a confident 'no' locks; 'unknown' stays usable (backseatService's
  // LLM_NO_VISION gate is the authoritative backstop). The reason rides the
  // native `title` because the data-tip tooltip is one nowrap line.
  //
  // A live Minecraft summon disables it too (260907): backseat is mutually
  // exclusive with a summon (main refuses with BACKSEAT_MC_SESSION_ACTIVE),
  // so grey the button up front with the reason instead of letting the picker
  // flow fail at the end.
  const backseatBlocked = visionBlocked(useUiStore((s) => s.llmVision));
  const llmModel = useUiStore((s) => s.llmModel);
  const summonKind = useDataStore((s) => s.summons[characterId]?.kind);
  const mcSummonActive = summonKind === 'online' || summonKind === 'connecting';
  const backseatDisabled = backseatBlocked || mcSummonActive;
  const backseatReason = backseatBlocked
    ? visionGateReason(t, 'backseat', llmModel)
    : mcSummonActive
      ? t('End the Minecraft session to use Backseat')
      : null;

  // The one-time WorldLink tip (261119). Its stored flags (retired, intro
  // seen, tour finished) are re-read whenever something that can change them
  // moves: a dismissal anywhere (the store's rev), the account, the tour
  // ending, a WorldLink surface closing. Everything else is live state: see
  // worldlinkTipPref for why each of these suppresses it. The SeiLink sheet,
  // editor and intro are modals too, but live in their own store.
  const modalOpen = useUiStore((s) => s.modal !== null);
  const seilinkOpen = useSeilinkStore(
    (s) => s.flow !== null || s.intro !== null || s.liveHint !== null || s.desktopHint !== null || s.moveBusy,
  );
  const someoneMovedIn = useSeilinkStore((s) => movedInId(s.status) != null);
  const tutorialActive = useTutorialStore((s) => s.active);
  const firstMomentLive = useFirstMomentStore(
    (s) => s.status === 'armed' || s.status === 'greeting' || s.status === 'ready',
  );
  // The flag is per ACCOUNT, so a scope change has to re-read it. Switching
  // accounts does not necessarily remount this header, and inheriting the
  // previous account's dismissal would silence the notice for someone who has
  // never seen it.
  const authScope = useAuthStore((s) => (s.state.kind === 'signed_in' ? s.state.user.id : 'local'));
  const tipRev = useWorldlinkTipStore((s) => s.rev);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tipDone = useMemo(() => worldlinkTipDone(), [tipRev, authScope]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const knowsWorldlink = useMemo(() => worldlinkAlreadyKnown(), [tipRev, authScope, tutorialActive, seilinkOpen]);
  const showTip = shouldShowWorldlinkTip({
    done: tipDone,
    available: seilinkAvailable,
    alreadyKnown: knowsWorldlink || someoneMovedIn,
    onChatScreen: !onCallView,
    gameOpen,
    modalOpen,
    seilinkOpen,
    tutorialActive,
    firstMomentLive,
  });
  useEffect(() => {
    if (showTip && claimTipShown()) trackTip('shown', characterId);
  }, [showTip, characterId]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const companionName = character?.name ?? t('Companion');
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const onBack = (): void => {
    if (onCallView) navigate({ kind: 'chat', characterId });
    else navigate({ kind: 'home' });
  };

  const onProfile = (): void => {
    setChatReturnId(characterId);
    navigate({ kind: 'character', id: characterId });
  };

  const onPhone = (): void => {
    // On the call view the phone toggles the SURFACE back to chat. Otherwise
    // startOrOpenCall routes: game surface open → start the call in place
    // (no navigation); no game → open the fullscreen call view (whose gate
    // owns the install/consent step before dialing).
    if (onCallView) navigate({ kind: 'chat', characterId });
    else startOrOpenCall(characterId);
  };

  return (
    <header className={styles.header}>
      <button
        type="button"
        className={styles.backBtn}
        onClick={onBack}
        aria-label={t('Back')}
        data-tip={t('Back')}
      >
        <BackIcon size={20} />
      </button>
      <div className={styles.headerAvatar}>
        {character ? (
          <PixelPortrait
            seed={character.id + character.name}
            palette={palette}
            size={22}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <UserIcon size={14} />
        )}
      </div>
      <button
        type="button"
        className={styles.nameToggle}
        onClick={onProfile}
        aria-label={t("Open {name}'s profile", { name: companionName })}
      >
        <span className={styles.headerName}>{companionName}</span>
        {character?.public_id ? <IdTag id={character.public_id} size="sm" /> : null}
      </button>
      <div className={styles.headerActions}>
        {/* Wrapped so the card anchors to the button itself rather than to the
            actions row. */}
        <div className={styles.tipWrap}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => openModal({ kind: 'games-picker', characterId })}
            aria-label={t('Play together')}
            data-tip={t('Play together')}
            data-tip-edge="right"
            data-tutorial="games-btn"
          >
            <GamepadIcon size={18} />
          </button>

        </div>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => {
            if (!backseatDisabled) openModal({ kind: 'share-screen', characterId });
          }}
          disabled={backseatDisabled}
          aria-disabled={backseatDisabled}
          aria-label={t('Backseat')}
          title={backseatReason ?? undefined}
          data-tip={backseatReason ?? t('Backseat')}
          data-tip-edge="right"
          data-tutorial="backseat-btn"
        >
          <BackseatIcon size={18} />
        </button>
        {seilinkAvailable ? (
          // Wrapped so the tip anchors to the button itself.
          <div className={styles.tipWrap}>
            <button
              type="button"
              className={seilinkHere ? `${styles.iconBtn} ${styles.iconBtnActive}` : styles.iconBtn}
              onClick={() => {
                // Finding the button is what the tip was for: it retires before
                // the sheet or intro opens, so it can never sit over them.
                if (showTip) trackTip('opened', characterId);
                dismissWorldlinkTip();
                void openSeilink(characterId, 'button');
              }}
              aria-label={t('WorldLink (beta)')}
              aria-pressed={seilinkHere}
              data-tip={
                seilinkHere
                  ? t("WorldLink (beta): edit {name}'s room", { name: companionName })
                  : t('WorldLink (beta): put {name} on your desktop', { name: companionName })
              }
              data-tip-edge="right"
              data-tutorial="seilink-btn"
            >
              <SeilinkIcon size={18} />
            </button>
            {/* Hangs BELOW the button with the tail pointing up: the header is
                at the top of the window, so there is nowhere above it to go. */}
            {showTip ? (
              <div className={styles.tip} role="note">
                <span className={styles.tipTail} aria-hidden="true" />
                <div className={styles.tipHead}>
                  <span className={styles.tipIcon} aria-hidden="true">
                    <SeilinkIcon size={18} />
                  </span>
                  <span className={styles.tipNew}>{t('NEW')}</span>
                </div>
                <p className={styles.tipTitle}>{t('WorldLink (beta)')}</p>
                <p className={styles.tipBody}>{t('{name} can move onto your desktop and live on your wallpaper.', { name: companionName })}</p>
                <button
                  type="button"
                  className={styles.tipBtn}
                  onClick={() => {
                    trackTip('dismissed', characterId);
                    dismissWorldlinkTip();
                  }}
                >
                  {t('Got it')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className={onCallView ? `${styles.iconBtn} ${styles.iconBtnActive}` : styles.iconBtn}
          onClick={onPhone}
          aria-label={onCallView ? t('Back to chat') : t('Voice call')}
          data-tip={onCallView ? t('Back to chat') : t('Voice call')}
          data-tip-edge="right"
          data-tutorial="call-btn"
        >
          <PhoneIcon size={18} />
        </button>
      </div>
    </header>
  );
}
