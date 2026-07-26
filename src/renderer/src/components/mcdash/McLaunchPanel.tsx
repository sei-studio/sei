/**
 * McLaunchPanel — the Minecraft game-launch surface (260721).
 *
 * Mounted in the ChatScreen game aside (the chess slot, inside the shared
 * GameSurface chrome) when the Minecraft tile is picked and the bot is not
 * online yet. The whole panel is the game art under a dark scrim with three
 * elements on top: the title, a "How do I set up launch?" help link (opens
 * the Minecraft setup window), and the primary Launch button.
 *
 * Launch runs the shared summon flow (username-conflict guard, one-time
 * skin-setup nudge, fresh LAN check, host-compatibility gate). With no open
 * world detected, that flow opens the same setup window on the "Connecting
 * to world" tab WITH the searching animation, and auto-resumes the summon
 * when a world opens. While the summon is in flight the button reads
 * "connecting..." (disabled); on failure the button returns to Launch and a
 * one-line plain-English reason (ERROR_COPY) shows under it, since this
 * panel is now the only Minecraft connect control (the profile page went
 * static, 260721). Once the bot is online, ChatScreen swaps this panel for
 * the live dashboard (McDashboardPanel).
 */

import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { ERROR_COPY } from '../../lib/errors';
import { Button } from '../Button';
import styles from './McLaunchPanel.module.css';

/** Same renderer-relative art the picker tile uses (public/img). */
const MC_ART = './img/game-minecraft.webp';

export interface McLaunchPanelProps {
  characterId: string;
}

export function McLaunchPanel({ characterId }: McLaunchPanelProps): React.ReactElement {
  const summon = useDataStore((s) => s.summons[characterId]);
  const openModal = useUiStore((s) => s.openModal);
  const connecting = summon?.kind === 'connecting';
  const failReason =
    summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;

  return (
    <div
      className={styles.panel}
      style={{ backgroundImage: `url(${MC_ART})` }}
      aria-label="Minecraft"
    >
      <div className={styles.scrim} aria-hidden="true" />
      {/* 260721: no local close control; the GameSurface bottom-right "x"
          dismisses this panel. */}
      <div className={styles.content}>
        <h2 className={styles.title}>Minecraft</h2>
        <Button
          kind="accent"
          size="lg"
          disabled={connecting}
          onClick={() =>
            // 260721: shared cross-launch gate — a live chess game or screen
            // share confirms (and ends) before the summon runs.
            requestGameLaunch(characterId, { id: 'minecraft', name: 'Minecraft' }, () =>
              void attemptSummon(characterId),
            )
          }
        >
          {connecting ? 'Connecting...' : 'Launch'}
        </Button>
        {failReason ? (
          <p className={styles.failLine} role="alert">
            {failReason}
          </p>
        ) : null}
        <button
          type="button"
          className={styles.setupLink}
          onClick={() => openModal({ kind: 'mc-setup', tab: 'world', searching: false })}
        >
          How do I set up launch?
        </button>
      </div>
    </div>
  );
}
