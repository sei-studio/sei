/**
 * ShareWaiting (261004): the call's share area while the auto-share watch
 * waits for the game's window (useBackseatStore.watch).
 *
 * Opening Roblox from its tile means "I'm about to play, watch it", so there
 * is no window to pick. Until Roblox is up, the share area is the companion
 * saying so in one line, a quiet "waiting for Roblox" with breathing dots, and
 * one small way out ("share something else") for a player who meant another
 * window. It comes back, with a "hop back in" line, whenever the game window
 * closes mid-session. If starting the share keeps failing, the watch stops
 * retrying and the card says why, with a retry.
 */

import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import { backseatGame, type BackseatGameSelection } from '../../../../shared/backseatGames';
import { useT } from '../../lib/i18n';
import { CompanionLine } from './CompanionLine';
import styles from './ShareWaiting.module.css';

export interface ShareWaitingProps {
  characterId: string;
  game: BackseatGameSelection;
  /** The game window has closed at least once this call. */
  resumed: boolean;
  /** The watch gave up after failed starts; `error` says why. */
  stalled: boolean;
  error: string | null;
}

export function ShareWaiting({
  characterId,
  game,
  resumed,
  stalled,
  error,
}: ShareWaitingProps): React.ReactElement {
  const t = useT();
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId) ?? null);
  const openModal = useUiStore((s) => s.openModal);
  const stopWatch = useBackseatStore((s) => s.stopWatch);
  const startWatch = useBackseatStore((s) => s.startWatch);
  const gameName = backseatGame(game.gameId)?.name ?? t('your game');
  const name = character?.name ?? t('Your companion');

  const line = stalled
    ? t("Hmm, I couldn't start watching.")
    : resumed
      ? t("Hop back in, I'm still here.")
      : t("Hop in, I'll be watching!");

  return (
    <div className={styles.root}>
      <CompanionLine character={character} name={name} line={line} size={96} layout="stack" />

      {stalled ? (
        <p className={styles.error} role="alert">
          {error ?? t('Could not start sharing.')}
        </p>
      ) : (
        <p className={styles.status}>
          {t('Waiting for {game}', { game: gameName })}
          <span className={styles.dots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </p>
      )}

      <div className={styles.actions}>
        {stalled ? (
          <button type="button" className={styles.link} onClick={() => startWatch(characterId, game)}>
            {t('Try again')}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            stopWatch();
            openModal({ kind: 'share-screen', characterId, game, manual: true });
          }}
        >
          {t('Share something else')}
        </button>
      </div>
    </div>
  );
}
