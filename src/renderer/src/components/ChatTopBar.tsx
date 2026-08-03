/**
 * ChatTopBar — the ONE companion top bar (260721), shared by ChatScreen and
 * VoiceCallScreen so games and calls keep an identical header: back chevron,
 * avatar, bold name + dim #tag (opens the profile page), and the top-right
 * game-controller + phone buttons.
 *
 * Context-aware behavior, identical structure:
 *   - back:  chat → home; call view → back to that chat (the call keeps
 *            running; GameSurface's chrome row / the icon-rail badge carry it).
 *   - controller: opens the games picker, including mid-call.
 *   - backseat: opens the screen-share source picker (260803). It is here
 *            because backseat's only other entry point is the share button in
 *            the call controls, which you cannot reach without already being on
 *            a call, so nobody who had not already found the feature ever saw
 *            it. From here, confirming a source starts the call as well (the
 *            picker arms a pending share; see ShareScreenModal).
 *   - phone: no call → start one. With a game surface open the call starts IN
 *            PLACE (260722, startOrOpenCall: this screen stays, GameSurface's
 *            chrome row shows the compact controls); otherwise the fullscreen
 *            call view opens (its gate handles consent/install before
 *            dialing). On the call view → back to chat (toggles the SURFACE;
 *            hanging up stays on the red button).
 */

import React, { useMemo } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { startOrOpenCall } from '../lib/callLaunch';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { GamepadIcon, PhoneIcon, BackIcon, UserIcon, BackseatIcon } from './icons';
import { IdTag } from './IdTag';
import styles from './ChatTopBar.module.css';

export interface ChatTopBarProps {
  characterId: string;
}

export function ChatTopBar({ characterId }: ChatTopBarProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setChatReturnId = useUiStore((s) => s.setChatReturnId);
  const onCallView = useUiStore((s) => s.view.kind === 'voice-call');
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const companionName = character?.name ?? 'Companion';
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
        aria-label="Back"
        data-tip="Back"
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
        aria-label={`Open ${companionName}'s profile`}
      >
        <span className={styles.headerName}>{companionName}</span>
        {character?.public_id ? <IdTag id={character.public_id} size="sm" /> : null}
      </button>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => openModal({ kind: 'games-picker', characterId })}
          aria-label="Play together"
          data-tip="Play together"
          data-tip-edge="right"
          data-tutorial="games-btn"
        >
          <GamepadIcon size={18} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => openModal({ kind: 'share-screen', characterId })}
          aria-label="Backseat (beta)"
          data-tip="Backseat (beta)"
          data-tip-edge="right"
          data-tutorial="backseat-btn"
        >
          <BackseatIcon size={18} />
        </button>
        <button
          type="button"
          className={onCallView ? `${styles.iconBtn} ${styles.iconBtnActive}` : styles.iconBtn}
          onClick={onPhone}
          aria-label={onCallView ? 'Back to chat' : 'Voice call'}
          data-tip={onCallView ? 'Back to chat' : 'Voice call'}
          data-tip-edge="right"
          data-tutorial="call-btn"
        >
          <PhoneIcon size={18} />
        </button>
      </div>
    </header>
  );
}
