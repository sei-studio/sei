/**
 * Placeholder chat-aside panels for a bot-backed game that has not registered
 * its own surfaces yet (game adapters M0, 260908). The game agents replace
 * these through registerGameSurface; until then the launch panel offers the
 * shared summon flow and the dashboard shows the generic activity line.
 */
import React from 'react';
import type { GameId } from '@shared/gameIpc';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { GamePackCard } from './GamePackCard';
import { attemptSummon } from '../../lib/summonFlow';
import { botGameName } from '../../lib/gameLaunch';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import styles from './GenericGamePanels.module.css';

export interface GenericGamePanelProps {
  game: GameId;
  characterId: string;
}

export function GenericGameLaunchPanel({ game, characterId }: GenericGamePanelProps): React.ReactElement {
  const t = useT();
  const name = botGameName(game);
  const world = useDataStore((s) => s.worlds[game]);
  const open = world?.kind === 'open';
  return (
    <div className={styles.panel} data-game={game}>
      <p className={styles.title}>{name}</p>
      <p className={styles.hint}>
        {open
          ? t('Your world is open. Press Play to bring your companion in.')
          : t('Open your world in {game} first, then press Play.', { game: name })}
      </p>
      <GamePackCard game={game} />
      <Button kind="primary" size="md" onClick={() => void attemptSummon(characterId, game)}>
        {t('Play')}
      </Button>
    </div>
  );
}

export function GenericGameDashboardPanel({ game, characterId }: GenericGamePanelProps): React.ReactElement {
  const t = useT();
  const name = botGameName(game);
  const snapshot = useMcDashboardStore((s) => s.gameSnapshots[characterId] ?? null);
  const activity = snapshot?.activity ?? '';
  return (
    <div className={styles.panel} data-game={game}>
      <p className={styles.title}>{name}</p>
      <p className={styles.hint}>{activity ? sentenceCase(activity) : t('Playing')}</p>
    </div>
  );
}

function sentenceCase(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}
