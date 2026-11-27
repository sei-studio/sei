/**
 * BattleshipPanel — the Fleet Battle surface that slides into the chat screen.
 *
 * The 3D sea table (FleetBoard3D) fills the panel edge to edge in every state
 * and everything else floats over it as the chess panel's de-boxed HUD:
 *   - launch (no game yet): title, a one-line hint and one button ("Launch")
 *     over the empty trays under a scrim;
 *   - preparing: fleet setup in the scene (harbor on the right), with
 *     Rotate / Random / Start battle top-right (owned by FleetBoard3D); once
 *     the player's fleet is in, "{name} is placing ships…" until the
 *     character's own fleet (a tool call) is ready and main opens the battle;
 *   - active: turn line top-center, the borderless resign flag top-left with
 *     an inline confirm (also during setup: main allows it);
 *   - aiTurnFailed (placement or shot): "{name} couldn't move" with a
 *     borderless Try again in the turn line (BATTLESHIP:retry);
 *   - ended: the character's whole fleet is revealed (afloat ships surface,
 *     sunk ones list in the water) and the result card with Rematch rises at
 *     the bottom. Rematch starts the next game in main straight away, which
 *     alternates who fires first.
 * Closing goes through the unified GameSurface "x".
 *
 * Contract: src/shared/battleshipIpc.ts +
 * src/main/battleship/battleshipService.ts.
 */

import React, { useEffect, useState } from 'react';
import { useBattleshipStore } from '../../lib/stores/useBattleshipStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { FlagIcon } from '../icons';
import type { BATTLESHIPResult } from '@shared/battleshipIpc';
import { FleetBoard3D } from './FleetBoard3D';
import hud from '../tabletop/TabletopHud.module.css';

export interface BattleshipPanelProps {
  characterId: string;
}

type Tr = (en: string, params?: Record<string, string | number>) => string;

function resultCopy(result: BATTLESHIPResult, name: string, t: Tr): {
  title: string;
  detail: string;
  tone: 'win' | 'loss' | 'draw';
} {
  const tone = result.winner === null ? 'draw' : result.winner === 'player' ? 'win' : 'loss';
  const title = result.winner === null ? t('Draw') : result.winner === 'player' ? t('You won') : t('{name} won', { name });
  switch (result.reason) {
    case 'all-ships-sunk':
      return {
        title,
        tone,
        detail: result.winner === 'player' ? t("You sank {name}'s whole fleet.", { name }) : t('{name} sank your whole fleet.', { name }),
      };
    case 'resign':
      return { title, tone, detail: t('You resigned. {name} takes the game.', { name }) };
    default:
      return { title: t('Game closed'), tone: 'draw', detail: t('This game ended without a result.') };
  }
}

export function BattleshipPanel({ characterId }: BattleshipPanelProps): React.ReactElement {
  const t = useT();
  const game = useBattleshipStore((s) => s.games[characterId] ?? null);
  const starting = useBattleshipStore((s) => s.starting[characterId] ?? false);
  const start = useBattleshipStore((s) => s.start);
  const move = useBattleshipStore((s) => s.move);
  const placeFleet = useBattleshipStore((s) => s.placeFleet);
  const resign = useBattleshipStore((s) => s.resign);
  const rematch = useBattleshipStore((s) => s.rematch);
  const retry = useBattleshipStore((s) => s.retry);
  const hydrate = useBattleshipStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [startErr, setStartErr] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [rematching, setRematching] = useState(false);

  // Resume any game main still holds (navigation away and back, relaunch).
  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  // Reset transient panel state when switching characters.
  useEffect(() => {
    setStartErr(null);
    setConfirmResign(false);
    setRematching(false);
  }, [characterId]);

  const gameStatus = game?.status ?? null;
  useEffect(() => {
    if (gameStatus === 'ended') setConfirmResign(false);
    else setRematching(false);
  }, [gameStatus]);

  const doStart = async (): Promise<void> => {
    setStartErr(null);
    try {
      await start(characterId);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (/not available in this build/.test(msg)) {
        setStartErr(t('Fleet Battle is not available in this build yet.'));
      } else {
        setStartErr(t("The game couldn't start. Try again in a moment."));
      }
    }
  };

  const showLaunch = !game;
  const canResign = game?.status === 'active' || game?.status === 'preparing';
  const result = game?.status === 'ended' && game.result ? resultCopy(game.result, name, t) : null;

  return (
    <div className={hud.panel} aria-label={t('Fleet Battle with {name}', { name })}>
      <div className={hud.stage}>
        <div className={hud.boardFill}>
          <FleetBoard3D
            game={showLaunch ? null : game}
            companionName={name}
            onFire={(row, col) => move(characterId, row, col)}
            onPlaceFleet={(ships) => placeFleet(characterId, ships)}
            onRetry={() => void retry(characterId)}
          />
        </div>

        {showLaunch ? (
          <div className={hud.launch}>
            <div className={hud.launchScrim} />
            <div className={hud.launchContent}>
              <h3 className={hud.launchTitle}>{t('Fleet Battle')}</h3>
              <p className={hud.launchHint}>{t('Hide your fleet, then take turns firing.')}</p>
              {startErr ? (
                <p className={hud.launchError} role="alert">
                  {startErr}
                </p>
              ) : null}
              <Button
                kind="accent"
                size="md"
                disabled={starting}
                onClick={() =>
                  requestGameLaunch(characterId, { id: 'BATTLESHIP', name: t('Fleet Battle') }, () => void doStart())
                }
              >
                {starting ? t('Starting…') : t('Launch')}
              </Button>
            </div>
          </div>
        ) : game ? (
          <div className={hud.hud}>
            {canResign ? (
              <div className={hud.hudTopLeft} role="group" aria-label={t('Game controls')}>
                {confirmResign ? (
                  <span className={hud.resignConfirm}>
                    <span className={hud.resignLabel}>{t('Resign?')}</span>
                    <Button
                      kind="danger"
                      size="sm"
                      onClick={() => {
                        setConfirmResign(false);
                        void resign(characterId);
                      }}
                    >
                      {t('Yes')}
                    </Button>
                    <Button kind="quiet" size="sm" onClick={() => setConfirmResign(false)}>
                      {t('No')}
                    </Button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`${hud.ctrlBtn} ${hud.ctrlDanger}`}
                    onClick={() => setConfirmResign(true)}
                    aria-label={t('Resign')}
                    data-tip={t('Resign')}
                    data-tip-edge="left"
                  >
                    <FlagIcon size={16} />
                  </button>
                )}
              </div>
            ) : null}

            {result ? (
              <div className={`${hud.hudResult} ${hud.hudResultLow} ${hud.hudResultRow}`}>
                <div
                  className={[
                    hud.result,
                    result.tone === 'win' ? hud.resultWin : result.tone === 'loss' ? hud.resultLoss : hud.resultDraw,
                  ].join(' ')}
                  role="status"
                >
                  <div className={hud.resultTitle}>{result.title}</div>
                  <div className={hud.resultDetail}>{result.detail}</div>
                </div>
                <div className={hud.resultActions}>
                  <Button
                    kind="accent"
                    size="md"
                    disabled={rematching}
                    onClick={() => {
                      setRematching(true);
                      void rematch(characterId).finally(() => setRematching(false));
                    }}
                  >
                    {rematching ? t('Starting…') : t('Rematch')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
