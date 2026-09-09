/**
 * McDashControls (extracted from McDashboardPanel, game adapters M1 260908):
 * the status strip and the controls window (pause, reactive/proactive mode,
 * disconnect) in the vanilla-inventory style, so a second game's dashboard
 * reuses the exact same windows instead of copying them. Markup, class
 * names and copy are the ones McDashboardPanel shipped with; only the game
 * name in the proactive description is a prop.
 */
import React, { useState } from 'react';
import type { McGameMode } from '@shared/ipc';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../lib/stores/useUiStore';
import { companionActivityText } from '../games/useGameCompanions';
import type { GameCompanion } from '../games/useGameCompanions';
import styles from './McDashboardPanel.module.css';

/** "gathering oak logs..." → "Gathering oak logs...". */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Hover copy for the control buttons (260725). No em dashes: user copy. */
function controlDescriptions(gameName: string): Record<string, string> {
  return {
    pause: 'Freezes your companion in the game. They stand still and stop thinking until you unpress it.',
    reactive: 'The AI follows simple instructions. Does not act without your command. Costs less usage.',
    proactive: gameName === 'Minecraft'
      ? 'The AI plays Minecraft alongside you. Can act without your command. Costs more usage.'
      : 'The AI plays {game} alongside you. Can act without your command. Costs more usage.',
    disconnect: 'Your companion leaves the world. You can launch them back in whenever you want.',
  };
}

export interface McDashStatusStripProps {
  /** The bot's lowercase activity line; sentence-cased for display. */
  activity: string;
  paused: boolean;
  /** This companion's name, shown as the window title once there is more than one. */
  name?: string;
  /**
   * The OTHER companions in the same game (useGameCompanions): one more
   * status window each, laid out across the same row, clickable to open
   * that companion's chat (and so its dashboard).
   */
  companions?: GameCompanion[];
}

/**
 * The status row: what the AI is doing right now, and, when several
 * companions share the world (260909), one window per companion across the
 * width that used to be one strip.
 */
export function McDashStatusStrip({ activity, paused, name, companions = [] }: McDashStatusStripProps): React.ReactElement {
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  const many = companions.length > 0;
  return (
    <div className={styles.statusRow}>
      <section className={`${styles.dialog} ${styles.statusDialog}`} aria-label={t('Status')}>
        <span className={styles.statusTitle}>{many && name ? name : t('Status')}</span>
        <span className={styles.statusText} aria-live="polite">
          {paused ? t('Paused') : sentenceCase(activity || 'idling')}
        </span>
      </section>
      {companions.map((c) => {
        const label = c.name ?? t('Companion');
        return (
          <button
            key={c.id}
            type="button"
            className={`${styles.dialog} ${styles.statusDialog} ${styles.statusPeer}`}
            aria-label={t("Open {name}'s chat", { name: label })}
            title={t("Open {name}'s chat", { name: label })}
            onClick={() => navigate({ kind: 'chat', characterId: c.id })}
          >
            <span className={styles.statusTitle}>{label}</span>
            <span className={styles.statusText}>{companionActivityText(c, t('Paused'))}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface McDashControlsProps {
  paused: boolean;
  mode: McGameMode;
  onPause: (paused: boolean) => void;
  onMode: (mode: McGameMode) => void;
  onDisconnect: () => void;
  /** Proper game name for the proactive description ("Minecraft", "Stardew Valley"). */
  gameName: string;
}

/**
 * The controls window: the pause toggle (pressed-in bevel while paused, like
 * a vanilla toggle) over the two runtime play modes under a "Mode" subtitle,
 * the hovered button's description, and Disconnect.
 */
export function McDashControls({ paused, mode, onPause, onMode, onDisconnect, gameName }: McDashControlsProps): React.ReactElement {
  const t = useT();
  const [controlHint, setControlHint] = useState<string | null>(null);
  const descriptions = controlDescriptions(gameName);
  const hintHandlers = (key: string): Record<string, () => void> => ({
    onMouseEnter: () => setControlHint(key),
    onMouseLeave: () => setControlHint(null),
    onFocus: () => setControlHint(key),
    onBlur: () => setControlHint(null),
  });
  return (
    <section className={`${styles.dialog} ${styles.controlsDialog}`} aria-label={t('Companion controls')}>
      <button
        type="button"
        className={paused ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
        aria-pressed={paused}
        onClick={() => onPause(!paused)}
        {...hintHandlers('pause')}
      >
        {t('Pause')}
      </button>
      <div className={styles.invTitle}>{t('Mode')}</div>
      <button
        type="button"
        className={mode === 'reactive' ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
        aria-pressed={mode === 'reactive'}
        onClick={() => onMode('reactive')}
        {...hintHandlers('reactive')}
      >
        {t('Reactive')}
      </button>
      <button
        type="button"
        className={mode === 'proactive' ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
        aria-pressed={mode === 'proactive'}
        onClick={() => onMode('proactive')}
        {...hintHandlers('proactive')}
      >
        {t('Proactive')}
      </button>
      <div className={styles.controlsHint} aria-live="polite">
        {controlHint ? t(descriptions[controlHint], { game: gameName }) : ''}
      </div>
      <button type="button" className={`${styles.mcButton} ${styles.disconnectBtn}`} onClick={onDisconnect} {...hintHandlers('disconnect')}>
        {t('Disconnect')}
      </button>
    </section>
  );
}
