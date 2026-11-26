/**
 * BATTLESHIPPanel: the Fleet Battle surface that slides into the
 * chat screen.
 *
 * States:
 *   - launch screen (no game yet, or Rematch clicked after a finished game):
 *     "Fleet Battle" title, one primary button ("Launch").
 *   - status 'preparing': the player places their own five ships on the left
 *     grid (pick a ship, rotate, tap a cell; tap a placed ship to take it
 *     back), can roll a random fleet, then confirms. The character places
 *     its own fleet at the same time (aiFleet); the battle opens once both
 *     are ready, so a quick player waits for it.
 *   - Try again shows whenever the character's turn could not be finished
 *     (aiTurnFailed), during placement or the battle.
 *   - status 'active' / 'ended': two 10x10 grids (player ships visible, AI
 *     shots hidden) plus turn label and resign control. Result + Rematch
 *     when the game ends; Rematch starts the next game in main, which
 *     alternates who fires first.
 *
 * Contract: src/shared/battleshipIpc.ts +
 * src/main/battleship/battleshipService.ts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useBattleshipStore } from '../../lib/stores/useBattleshipStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import {
  BATTLESHIP_SHIP_NAMES,
  SHIP_SIZES,
  fleetCells,
  placementCells,
  placementFits,
  randomFleetPlacement,
} from '@shared/battleshipIpc';
import type {
  BATTLESHIPGameState,
  BATTLESHIPPlacement,
  BATTLESHIPShipName,
} from '@shared/battleshipIpc';
import styles from './BattleshipPanel.module.css';

export interface BattleshipPanelProps {
  characterId: string;
}

function cellLabel(r: number, c: number): string {
  return `Empty cell, row ${r + 1}, column ${c + 1}`;
}

const SHIP_LABEL: Record<BATTLESHIPShipName, string> = {
  carrier: 'carrier',
  battleship: 'battleship',
  cruiser: 'cruiser',
  submarine: 'submarine',
  destroyer: 'destroyer',
};

const COORD_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const COORD_COLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

export function BattleshipPanel({ characterId }: BattleshipPanelProps): React.ReactElement {
  const t = useT();
  const game = useBattleshipStore((s) => s.games[characterId] ?? null);
  const starting = useBattleshipStore((s) => s.starting[characterId] ?? false);
  const start = useBattleshipStore((s) => s.start);
  const move = useBattleshipStore((s) => s.move);
  const placeFleet = useBattleshipStore((s) => s.placeFleet);
  const resign = useBattleshipStore((s) => s.resign);
  const rematch = useBattleshipStore((s) => s.rematch);
  const retryTurn = useBattleshipStore((s) => s.retry);
  const end = useBattleshipStore((s) => s.end);
  const hydrate = useBattleshipStore((s) => s.hydrate);

  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const name = character?.name ?? t('Companion');

  const [startErr, setStartErr] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);

  // Placement draft (renderer-local until "Start battle" confirms it).
  const [draft, setDraft] = useState<BATTLESHIPPlacement[]>([]);
  const [horizontal, setHorizontal] = useState(true);
  const [selected, setSelected] = useState<BATTLESHIPShipName | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    void hydrate(characterId);
  }, [characterId, hydrate]);

  useEffect(() => {
    setStartErr(null);
    setConfirmResign(false);
  }, [characterId]);

  const gameStatus = game?.status ?? null;
  const gameId = game?.gameId ?? null;
  useEffect(() => {
    setDraft([]);
    setSelected(null);
    setPlacing(false);
  }, [gameId, gameStatus]);

  const draftCells = useMemo(() => fleetCells(draft), [draft]);
  const placedNames = useMemo(() => new Set(draft.map((p) => p.name)), [draft]);

  const activeShip: BATTLESHIPShipName | null = useMemo(() => {
    if (selected && !placedNames.has(selected)) return selected;
    return BATTLESHIP_SHIP_NAMES.find((n) => !placedNames.has(n)) ?? null;
  }, [selected, placedNames]);

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

  const onPlayerCellClick = (row: number, col: number): void => {
    if (!game || game.status !== 'preparing') return;
    const occupied = draft.find((p) =>
      placementCells(p).some((c) => c.row === row && c.col === col),
    );
    if (occupied) {
      setDraft((prev) => prev.filter((p) => p.name !== occupied.name));
      setSelected(occupied.name);
      return;
    }
    if (!activeShip) return;
    const candidate: BATTLESHIPPlacement = {
      name: activeShip,
      row,
      col,
      horizontal,
    };
    if (!placementFits(candidate, draftCells)) return;
    setDraft((prev) => [...prev, candidate]);
    setSelected(null);
  };

  const onChipClick = (ship: BATTLESHIPShipName): void => {
    if (!game || game.status !== 'preparing') return;
    if (placedNames.has(ship)) {
      setDraft((prev) => prev.filter((p) => p.name !== ship));
      setSelected(ship);
      return;
    }
    setSelected(ship);
  };

  const doPlaceFleet = async (ships: BATTLESHIPPlacement[] | null): Promise<void> => {
    setStartErr(null);
    setPlacing(true);
    const ok = await placeFleet(characterId, ships);
    setPlacing(false);
    if (!ok) setStartErr(t("The game couldn't start. Try again in a moment."));
  };

  const onEnemyCellClick = (row: number, col: number): void => {
    if (!game || game.status !== 'active') return;
    if (game.turn !== 'player') return;
    const cell = game.aiVisibleGrid.cells?.[row]?.[col];
    if (cell === 'hit' || cell === 'miss' || cell === 'sunk') return;
    void move(characterId, row, col);
  };

  const showLaunch = !game;

  const isPlayerTurn = game ? game.turn === 'player' : false;
  /** The player is still drawing their fleet (placement UI on). */
  const placingFleet = game?.status === 'preparing' && !game.playerFleetPlaced;
  /** The player's fleet is in; the character is still placing its own. */
  const waitingForAiFleet = game?.status === 'preparing' && game.playerFleetPlaced;
  const aiFailed = !!game && game.status !== 'ended' && !!game.aiTurnFailed;
  const fleetReady = draft.length === BATTLESHIP_SHIP_NAMES.length;

  return (
    <div className={styles.panel} aria-label={t('Fleet Battle with {name}', { name })}>
      {showLaunch ? (
        <div className={styles.launch}>
          <h3 className={styles.launchTitle}>{t('Fleet Battle')}</h3>
          {startErr ? (
            <p className={styles.launchError} role="alert">{startErr}</p>
          ) : null}
          <Button
            kind="accent"
            size="md"
            disabled={starting}
            onClick={() =>
              requestGameLaunch(characterId, { id: 'BATTLESHIP', name: t('Fleet Battle') }, () =>
                void doStart(),
              )
            }
          >
            {starting ? t('Starting…') : t('Launch')}
          </Button>
        </div>
      ) : game ? (
        <div className={styles.stage}>
          {placingFleet ? (
            <div className={styles.fleetBar}>
              <span className={styles.fleetHint}>{t('Place your ships')}</span>
              <div className={styles.fleetList}>
                {BATTLESHIP_SHIP_NAMES.map((ship) => {
                  const placed = placedNames.has(ship);
                  const active = !placed && activeShip === ship;
                  return (
                    <button
                      key={ship}
                      type="button"
                      className={[
                        styles.fleetChip,
                        placed ? styles.fleetChipPlaced : '',
                        active ? styles.fleetChipActive : '',
                      ].join(' ')}
                      onClick={() => onChipClick(ship)}
                      aria-pressed={placed}
                    >
                      {t(SHIP_LABEL[ship])}
                      <span className={styles.fleetSize}>{SHIP_SIZES[ship]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className={styles.grids}>
            <div className={styles.gridWrap}>
              <div className={styles.gridTitle}>{t('Your ships')}</div>
              <div className={styles.gridWithCoords}>
                <div className={styles.coordCell} />
                {COORD_COLS.map((num) => (
                  <div key={num} className={styles.coordCell}>{num}</div>
                ))}
                {game.playerGrid.cells.map((row, r) => (
                  <React.Fragment key={r}>
                    <div className={styles.coordCell}>{COORD_ROWS[r]}</div>
                    {row.map((cell, c) => {
                      const drafted = placingFleet
                        ? draftCells.some((p) => p.row === r && p.col === c)
                        : false;
                      const showShip = placingFleet ? drafted : cell === 'ship';
                      return (
                        <button
                          key={`p-${r}-${c}`}
                          type="button"
                          className={[
                            styles.cell,
                            showShip ? styles.ship : '',
                            // A sunk cell has no style of its own yet: show it as a hit.
                            cell === 'hit' || cell === 'sunk' ? styles.hit : '',
                            cell === 'miss' ? styles.miss : '',
                          ].join(' ')}
                          disabled={!placingFleet}
                          onClick={placingFleet ? () => onPlayerCellClick(r, c) : undefined}
                          aria-label={cellLabel(r, c)}
                        />
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div className={styles.gridWrap}>
              <div className={styles.gridTitle}>{t('Enemy grid')}</div>
              <div className={styles.gridWithCoords}>
                <div className={styles.coordCell} />
                {COORD_COLS.map((num) => (
                  <div key={num} className={styles.coordCell}>{num}</div>
                ))}
                {game.aiVisibleGrid.cells.map((row, r) => (
                  <React.Fragment key={r}>
                    <div className={styles.coordCell}>{COORD_ROWS[r]}</div>
                    {row.map((cell, c) => {
                      const disabled =
                        game.status !== 'active' ||
                        game.turn !== 'player' ||
                        cell === 'hit' ||
                        cell === 'miss' ||
                        cell === 'sunk';
                      return (
                        <button
                          key={`a-${r}-${c}`}
                          type="button"
                          className={[
                            styles.cell,
                            disabled ? styles.disabled : '',
                            cell === 'hit' || cell === 'sunk' ? styles.hit : '',
                            cell === 'miss' ? styles.miss : '',
                          ].join(' ')}
                          disabled={disabled}
                          onClick={() => onEnemyCellClick(r, c)}
                          aria-label={cellLabel(r, c)}
                        />
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.hud}>
            <div className={styles.turnLabel}>
              {game.status === 'ended'
                ? null
                : aiFailed
                  ? t("{name} couldn't move", { name })
                  : placingFleet
                    ? activeShip
                      ? t('Placing {ship}', { ship: t(SHIP_LABEL[activeShip]) })
                      : t('Fleet ready')
                    : waitingForAiFleet
                      ? t('Waiting for {name} to place ships', { name })
                      : isPlayerTurn
                        ? t('Your turn')
                        : t("{name}'s turn", { name })}
            </div>

            <div className={styles.controls}>
              {aiFailed ? (
                <Button kind="accent" size="sm" onClick={() => void retryTurn(characterId)}>
                  {t('Try again')}
                </Button>
              ) : null}
              {game.status === 'ended' ? null : placingFleet ? (
                <>
                  <Button kind="quiet" size="sm" onClick={() => setHorizontal((h) => !h)}>
                    {t('Rotate')}
                  </Button>
                  <Button
                    kind="quiet"
                    size="sm"
                    disabled={placing}
                    onClick={() => {
                      setDraft(randomFleetPlacement());
                      setSelected(null);
                    }}
                  >
                    {t('Random')}
                  </Button>
                  <Button
                    kind="accent"
                    size="sm"
                    disabled={placing || !fleetReady}
                    onClick={() => void doPlaceFleet(draft)}
                  >
                    {t('Start battle')}
                  </Button>
                </>
              ) : confirmResign ? (
                <span className={styles.resignConfirm}>
                  <span className={styles.resignLabel}>{t('Resign?')}</span>
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
                  className={`${styles.ctrlBtn} ${styles.ctrlDanger}`}
                  onClick={() => setConfirmResign(true)}
                  aria-label={t('Resign')}
                  data-tip={t('Resign')}
                >
                  {t('Resign')}
                </button>
              )}
            </div>
          </div>

          {placingFleet && startErr ? (
            <p className={styles.launchError} role="alert">{startErr}</p>
          ) : null}

          {game.status === 'ended' && game.result ? (
            <div className={styles.resultWrap}>
              <div className={styles.resultTitle}>
                {game.result.winner === null
                  ? t('Draw')
                  : game.result.winner === 'player'
                    ? t('You won')
                    : t('{name} won', { name })}
              </div>
              <div className={styles.resultDetail}>
                {game.result.reason === 'all-ships-sunk'
                  ? t('All ships sunk.')
                  : game.result.reason === 'resign'
                    ? t('You resigned. {name} takes the game.', { name })
                    : t('This game ended without a result.')}
              </div>
              <div className={styles.resultActions}>
                <Button kind="accent" size="md" onClick={() => void rematch(characterId)}>
                  {t('Rematch')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
