/**
 * ChatTopBar — the ONE companion top bar (260721), shared by ChatScreen and
 * VoiceCallScreen so games and calls keep an identical header: back chevron,
 * avatar, bold name + dim #tag (opens the profile page), and the top-right
 * game-controller + phone buttons.
 *
 * Context-aware behavior, identical structure:
 *   - back:  chat → home; call view → back to that chat (the call keeps
 *            running; GameSurface's chrome row / the icon-rail badge carry it).
 *   - controller: opens the games picker, including mid-call. It carries the
 *            one-time "New games added" tip (260929), which announces Stardew
 *            Valley and Don't Starve Together; clicking the button retires it. See
 *            lib/gamesTipPref.
 *   - backseat: opens the screen-share source picker (260803). It is here
 *            because backseat's only other entry point is the share button in
 *            the call controls, which you cannot reach without already being on
 *            a call, so nobody who had not already found the feature ever saw
 *            it. From here, confirming a source starts the call as well (the
 *            picker arms a pending share; see ShareScreenModal). Its one-time
 *            beta tip was moved to the games button (260929).
 *   - phone: no call → start one. With a game surface open the call starts IN
 *            PLACE (260722, startOrOpenCall: this screen stays, GameSurface's
 *            chrome row shows the compact controls); otherwise the fullscreen
 *            call view opens (its gate handles consent/install before
 *            dialing). On the call view → back to chat (toggles the SURFACE;
 *            hanging up stays on the red button).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useTutorialStore } from '../lib/stores/useTutorialStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { gamesTipDone, dismissGamesTip, shouldShowGamesTip } from '../lib/gamesTipPref';
import { useFirstMomentStore } from '../lib/stores/useFirstMomentStore';
import { startOrOpenCall } from '../lib/callLaunch';
import { visionBlocked, visionGateReason } from '../lib/visionGate';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { GamepadIcon, PhoneIcon, BackIcon, UserIcon, BackseatIcon } from './icons';
import { IdTag } from './IdTag';
import { useT } from '../lib/i18n';
import styles from './ChatTopBar.module.css';

/** A name that must not wrap mid-way: its spaces become non-breaking. */
function keepWhole(name: string): string {
  return name.replace(/ /g, '\u00a0');
}

export interface ChatTopBarProps {
  characterId: string;
  /** A game surface is open below the header (ChatScreen's own `gameOpen`).
   *  Only hides the one-time games tip, which would otherwise cover the game. */
  gameOpen?: boolean;
}

export function ChatTopBar({ characterId, gameOpen = false }: ChatTopBarProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setChatReturnId = useUiStore((s) => s.setChatReturnId);
  const onCallView = useUiStore((s) => s.view.kind === 'voice-call');
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const t = useT();

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

  // The one-time games tip. `done` is read once at mount (localStorage) and
  // flipped in memory by "Got it" or a click on the games button, so the card
  // leaves without a second read. Everything else it depends on is live
  // state: see gamesTipPref for why each of these suppresses it.
  const modalOpen = useUiStore((s) => s.modal !== null);
  const tutorialActive = useTutorialStore((s) => s.active);
  const firstMomentLive = useFirstMomentStore(
    (s) => s.status === 'armed' || s.status === 'greeting' || s.status === 'ready',
  );
  // The flag is per ACCOUNT, so a scope change has to re-read it. Switching
  // accounts does not necessarily remount this header, and inheriting the
  // previous account's dismissal would silence the notice for someone who has
  // never seen it.
  const authScope = useAuthStore((s) => (s.state.kind === 'signed_in' ? s.state.user.id : 'local'));
  const [tipDone, setTipDone] = useState(gamesTipDone);
  useEffect(() => {
    setTipDone(gamesTipDone());
  }, [authScope]);
  const retireTip = (): void => {
    dismissGamesTip();
    setTipDone(true);
  };
  const showTip = shouldShowGamesTip({
    done: tipDone,
    onChatScreen: !onCallView,
    gameOpen,
    modalOpen,
    tutorialActive,
    firstMomentLive,
  });

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
            onClick={() => {
              // Finding the button is what the tip was for, so it retires too.
              if (!tipDone) retireTip();
              openModal({ kind: 'games-picker', characterId });
            }}
            aria-label={t('Play together')}
            data-tip={t('Play together')}
            data-tip-edge="right"
            data-tutorial="games-btn"
          >
            <GamepadIcon size={18} />
          </button>

          {/* Hangs BELOW the button with the tail pointing up: the header is at
              the top of the window, so there is nowhere above it to go. */}
          {showTip ? (
            <div className={styles.tip} role="note">
              <span className={styles.tipTail} aria-hidden="true" />
              <div className={styles.tipHead}>
                <span className={styles.tipIcon} aria-hidden="true">
                  <GamepadIcon size={18} />
                </span>
                <span className={styles.tipNew}>{t('NEW')}</span>
              </div>
              <p className={styles.tipTitle}>{t('New games added')}</p>
              {/* The game names are kept whole (non-breaking spaces), so a
                  line never ends inside one, e.g. "Don't Starve / Together". */}
              <p className={styles.tipBody}>
                {t('{first} and {second} are here. Play them with {name}.', {
                  first: keepWhole(t('Stardew Valley')),
                  second: keepWhole(t("Don't Starve Together")),
                  name: companionName,
                })}
              </p>
              <button type="button" className={styles.tipBtn} onClick={retireTip}>
                {t('Got it')}
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => {
            if (!backseatDisabled) openModal({ kind: 'share-screen', characterId });
          }}
          disabled={backseatDisabled}
          aria-disabled={backseatDisabled}
          aria-label={t('Backseat (beta)')}
          title={backseatReason ?? undefined}
          data-tip={backseatReason ?? t('Backseat (beta)')}
          data-tip-edge="right"
          data-tutorial="backseat-btn"
        >
          <BackseatIcon size={18} />
        </button>
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
