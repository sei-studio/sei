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
import React, { useState } from 'react';
import type { McGameMode } from '@shared/ipc';
import type { GameId } from '@shared/gameIpc';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import styles from './GameControlsWindow.module.css';

/** Hover copy for the control buttons. No em dashes: user copy. */
const CONTROL_DESCRIPTIONS: Record<string, string> = {
  pause: 'Freezes your companion in the game. They stand still and stop thinking until you unpress it.',
  reactive: 'The AI follows simple instructions. Does not act without your command. Costs less usage.',
  proactive: 'The AI plays alongside you. Can act without your command. Costs more usage.',
  disconnect: 'Your companion leaves the world. You can launch them back in whenever you want.',
};

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
  const controls = useMcDashboardStore((s) => s.controls[characterId]);
  const setPaused = useMcDashboardStore((s) => s.setPaused);
  const setMode = useMcDashboardStore((s) => s.setMode);
  const paused = controls?.paused ?? false;
  const mode: McGameMode = controls?.mode ?? 'proactive';
  const [hint, setHint] = useState<string | null>(null);
  const hintHandlers = (key: string): Record<string, () => void> => ({
    onMouseEnter: () => setHint(key),
    onMouseLeave: () => setHint(null),
    onFocus: () => setHint(key),
    onBlur: () => setHint(null),
  });
  // Same order as McDashboardPanel.disconnect: the optimistic status flip
  // lands BEFORE the launch flag so ChatScreen does not swallow it.
  const disconnect = (): void => {
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    useMcDashboardStore.getState().setLaunch(characterId, game);
    void sei.stop(characterId).catch(() => {
      /* the session is already gone; the UI is correct */
    });
  };
  return (
    <section className={styles.controls} aria-label={t('Companion controls')}>
      <div className={styles.row}>
        <Button kind={paused ? 'accent' : 'ghost'} size="sm" aria-pressed={paused} onClick={() => setPaused(characterId, !paused)} {...hintHandlers('pause')}>
          {paused ? t('Resume') : t('Pause')}
        </Button>
        <span className={styles.modeLabel}>{t('Mode')}</span>
        <Button kind={mode === 'reactive' ? 'accent' : 'ghost'} size="sm" aria-pressed={mode === 'reactive'} onClick={() => setMode(characterId, 'reactive')} {...hintHandlers('reactive')}>
          {t('Reactive')}
        </Button>
        <Button kind={mode === 'proactive' ? 'accent' : 'ghost'} size="sm" aria-pressed={mode === 'proactive'} onClick={() => setMode(characterId, 'proactive')} {...hintHandlers('proactive')}>
          {t('Proactive')}
        </Button>
        <span className={styles.spacer} />
        <Button kind="danger" size="sm" onClick={disconnect} {...hintHandlers('disconnect')}>
          {t('Disconnect')}
        </Button>
      </div>
      <div className={styles.hint} aria-live="polite">
        {hint ? t(CONTROL_DESCRIPTIONS[hint]) : ''}
      </div>
    </section>
  );
}
