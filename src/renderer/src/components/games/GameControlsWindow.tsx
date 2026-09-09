/**
 * GameControlsWindow + GameStatusStrip — the runtime controls every
 * bot-backed game dashboard shares (game adapters M2, 260908): the status
 * line ("Gathering twigs...", "Paused"), the play/pause toggle, the
 * reactive/proactive mode pair, and Disconnect. Same store actions and IPC
 * as McDashboardPanel's controls window (useMcDashboardStore.setPaused /
 * setMode -> supervisor.setGamePaused / setGameMode, which are game-agnostic);
 * McDashboardPanel keeps its own vanilla-inventory styling on purpose (a
 * documented exception to the tokens), so this is the token-styled version
 * for the other games rather than a copy of that one.
 */
import React from 'react';
import type { GameId } from '@shared/gameIpc';
import { GAME_CATALOG } from '@shared/games';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useGameControls, GAME_CONTROL_DESCRIPTIONS } from './useGameControls';
import styles from './GameControlsWindow.module.css';

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface GameStatusStripProps {
  characterId: string;
  /** The lowercase activity line the bot ships ("gathering twigs..."). */
  activity: string | null | undefined;
}

export function GameStatusStrip({ characterId, activity }: GameStatusStripProps): React.ReactElement {
  const t = useT();
  const paused = useMcDashboardStore((s) => s.controls[characterId]?.paused ?? false);
  return (
    <section className={styles.strip} aria-label={t('Status')}>
      <span className={styles.stripTitle}>{t('Status')}</span>
      <span className={styles.stripText} aria-live="polite">
        {paused ? t('Paused') : sentenceCase(activity || 'idling')}
      </span>
    </section>
  );
}

export interface GameControlsWindowProps {
  characterId: string;
  /** Which launch panel to fall back to after Disconnect. */
  game: GameId;
}

export function GameControlsWindow({ characterId, game }: GameControlsWindowProps): React.ReactElement {
  const t = useT();
  const c = useGameControls(characterId, game);
  const gameName = GAME_CATALOG.find((g) => g.id === game)?.name ?? game;
  return (
    <section className={styles.controls} aria-label={t('Companion controls')}>
      <div className={styles.row}>
        <Button kind={c.paused ? 'accent' : 'ghost'} size="sm" aria-pressed={c.paused} onClick={() => c.setPaused(!c.paused)} {...c.hintHandlers('pause')}>
          {c.paused ? t('Resume') : t('Pause')}
        </Button>
        <span className={styles.modeLabel}>{t('Mode')}</span>
        <Button kind={c.mode === 'reactive' ? 'accent' : 'ghost'} size="sm" aria-pressed={c.mode === 'reactive'} onClick={() => c.setMode('reactive')} {...c.hintHandlers('reactive')}>
          {t('Reactive')}
        </Button>
        <Button kind={c.mode === 'proactive' ? 'accent' : 'ghost'} size="sm" aria-pressed={c.mode === 'proactive'} onClick={() => c.setMode('proactive')} {...c.hintHandlers('proactive')}>
          {t('Proactive')}
        </Button>
        <span className={styles.spacer} />
        <Button kind="danger" size="sm" onClick={c.disconnect} {...c.hintHandlers('disconnect')}>
          {t('Disconnect')}
        </Button>
      </div>
      <div className={styles.hint} aria-live="polite">
        {c.hint ? t(GAME_CONTROL_DESCRIPTIONS[c.hint], { game: gameName }) : ''}
      </div>
    </section>
  );
}
