/**
 * FirstMomentCard — the next-step tiles under the companion's first greeting
 * (260926). See lib/firstMoment.ts for when it exists at all and
 * lib/stores/useFirstMomentStore.ts for its lifecycle.
 *
 * Sits at the end of the chat message list, indented to the message column so
 * it reads as part of the companion's turn. Every button reuses an existing
 * path, so there is nothing first-moment specific past the click:
 *   - chess / Minecraft go through the same cross-launch gate + openGame the
 *     "Play together" tiles use (chess slides its board into the chat's game
 *     area; Minecraft opens its launch panel, which owns setup and summon);
 *   - the call is the top bar's phone button (startOrOpenCall).
 * "Not now" just retires the card. Any click is final for the session.
 */
import React, { useEffect } from 'react';
import { useFirstMomentStore } from '../lib/stores/useFirstMomentStore';
import { firstMomentButtons, type FirstMomentAction } from '../lib/firstMoment';
import { openGame, requestGameLaunch } from '../lib/gameLaunch';
import { startOrOpenCall } from '../lib/callLaunch';
import { PhoneIcon } from './icons';
import { useT } from '../lib/i18n';
import styles from './FirstMomentCard.module.css';

/** Same renderer-relative art as the picker tiles (lib/games.ts). */
const ART: Record<'chess' | 'minecraft', string> = {
  chess: './img/chess-launch.png',
  minecraft: './img/game-minecraft.webp',
};

export function runFirstMomentAction(characterId: string, action: FirstMomentAction): void {
  useFirstMomentStore.getState().act(action);
  if (action === 'chess' || action === 'minecraft') {
    const name = action === 'chess' ? 'Chess' : 'Minecraft';
    requestGameLaunch(characterId, { id: action, name }, () => openGame(characterId, action));
  } else if (action === 'call') {
    startOrOpenCall(characterId);
  }
}

export interface FirstMomentCardProps {
  characterId: string;
}

export function FirstMomentCard({ characterId }: FirstMomentCardProps): React.ReactElement | null {
  const t = useT();
  // Only while the moment is live for THIS companion: 'ready' means the
  // greeting finished revealing; any click moves it on to 'done'.
  const plan = useFirstMomentStore((s) =>
    s.characterId === characterId && s.status === 'ready' ? s.plan : null,
  );
  const markShown = useFirstMomentStore((s) => s.markShown);

  useEffect(() => {
    if (plan) markShown();
  }, [plan, markShown]);

  if (!plan) return null;

  const label = (a: Exclude<FirstMomentAction, 'dismiss'>): string =>
    a === 'chess' ? t('Play chess now') : a === 'minecraft' ? t('Summon me in Minecraft') : t('Call me');

  return (
    <div className={styles.root} data-first-moment>
      <div className={styles.tiles}>
        {firstMomentButtons(plan).map((a) => {
          const primary = a === plan.primary;
          if (a === 'call') {
            return (
              <button
                key={a}
                type="button"
                data-action={a}
                className={`${styles.tile} ${styles.callTile}`}
                onClick={() => runFirstMomentAction(characterId, a)}
              >
                <span className={styles.callIcon}>
                  <PhoneIcon size={22} />
                </span>
                <span className={styles.label}>{label(a)}</span>
              </button>
            );
          }
          return (
            <button
              key={a}
              type="button"
              data-action={a}
              data-primary={primary ? 'true' : undefined}
              className={`${styles.tile} ${styles.artTile} ${primary ? styles.primary : ''}`}
              style={{ backgroundImage: `url(${ART[a]})` }}
              onClick={() => runFirstMomentAction(characterId, a)}
            >
              <span className={styles.label}>{label(a)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-action="dismiss"
        className={styles.dismiss}
        onClick={() => runFirstMomentAction(characterId, 'dismiss')}
      >
        {t('Not now')}
      </button>
    </div>
  );
}
