/**
 * GamePackCard (260908, game-adapters M0b) — the "Download Minecraft support
 * (about 120 MB)" card a game's launch surface shows before its first launch.
 *
 * One card per game, driven entirely by useGamePackStore's mirror of main's
 * pack state (src/main/games/packs.ts):
 *   missing      -> the offer: size, one-time, a Download button
 *   downloading  -> a PercentBar with received / total MB
 *   error        -> the ERROR_COPY line for GAME_PACK_DOWNLOAD_FAILED + Retry
 *   ready        -> renders NOTHING (the surface's own launch UI takes over)
 *
 * The size before the manifest has been fetched is the descriptor's hint
 * (GAME_PACKS[game].sizeHintBytes); once a download is running the real
 * total from the manifest replaces it. Not wired into ChatScreen or
 * McLaunchPanel here; the merge that lands the multi-game launch panel
 * mounts it there.
 */
import React, { useEffect } from 'react';
import type { GameId } from '@shared/gamePacks';
import { GAME_PACKS, packProgressPct, packSizeMb } from '@shared/gamePacks';
import { useT } from '../../lib/i18n';
import { ERROR_COPY } from '../../lib/errors';
import { useGamePackStore } from '../../lib/stores/useGamePackStore';
import { Button } from '../Button';
import { PercentBar } from '../PercentBar';
import styles from './GamePackCard.module.css';

export interface GamePackCardProps {
  game: GameId;
  className?: string;
}

export function GamePackCard({ game, className }: GamePackCardProps): React.ReactElement | null {
  const t = useT();
  const state = useGamePackStore((s) => s.packs[game]);
  const refresh = useGamePackStore((s) => s.refresh);
  const ensure = useGamePackStore((s) => s.ensure);
  const desc = GAME_PACKS[game];

  // A card mounted before App.tsx's init() has pulled anything asks once.
  useEffect(() => {
    if (state === undefined) void refresh(game);
  }, [state, refresh, game]);

  if (state === undefined || state.kind === 'ready') return null;

  const cls = [styles.card, className ?? ''].filter(Boolean).join(' ');

  if (state.kind === 'downloading') {
    const total = state.total > 0 ? state.total : desc.sizeHintBytes;
    const pct = packProgressPct(state.received, total);
    return (
      <section className={cls} aria-live="polite" data-state="downloading">
        <h3 className={styles.title}>{t('Downloading {name} support…', { name: desc.name })}</h3>
        <PercentBar
          value={pct}
          size="md"
          hideLabel
          label={t('{name} support download, {pct} percent', { name: desc.name, pct })}
        />
        <p className={styles.meta}>
          {t('{received} of {total} MB', {
            received: Math.min(packSizeMb(state.received), packSizeMb(total)),
            total: packSizeMb(total),
          })}
        </p>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className={cls} role="alert" data-state="error">
        <h3 className={styles.title}>{t("Couldn't download {name} support", { name: desc.name })}</h3>
        <p className={styles.body}>{t(ERROR_COPY.GAME_PACK_DOWNLOAD_FAILED)}</p>
        <div className={styles.actions}>
          <Button kind="primary" size="md" onClick={() => void ensure(game)}>
            {t('Retry')}
          </Button>
        </div>
      </section>
    );
  }

  const mb = packSizeMb(desc.sizeHintBytes);
  return (
    <section className={cls} data-state="missing">
      <h3 className={styles.title}>{t('Download {name} support (about {mb} MB)', { name: desc.name, mb })}</h3>
      <p className={styles.body}>
        {t(
          'Playing {name} together needs a one-time download. It is stored on this device and only downloads again after an update that needs a newer version.',
          { name: desc.name },
        )}
      </p>
      <div className={styles.actions}>
        <Button kind="primary" size="md" onClick={() => void ensure(game)}>
          {t('Download ({mb} MB)', { mb })}
        </Button>
      </div>
    </section>
  );
}
