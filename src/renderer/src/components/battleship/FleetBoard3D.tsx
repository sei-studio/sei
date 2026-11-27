/**
 * FleetBoard3D — the interactive Fleet Battle viewport over
 * three/FleetScene.ts (two sea trays on the chess table).
 *
 * Pure view over the snapshot main pushes (useBattleshipStore), plus the
 * renderer-local fleet draft while the player sets up:
 *   - setup ('preparing', player fleet not in yet): drag a ship from the
 *     harbor onto your waters, drag a placed ship to move it, click it to
 *     rotate, drag it off the board to send it back. Click-then-click works
 *     too (pick up in the harbor, click a cell), right click rotates the held
 *     ship. Rotate / Random / Start battle sit top-right.
 *   - waiting ('preparing', playerFleetPlaced): the character places its own
 *     fleet with a tool call; both trays show and the turn line reads
 *     "{name} is placing ships…" until aiFleet is ready and main opens the
 *     battle.
 *   - battle: aim with the pointer at the companion's waters and click to
 *     fire; the turn line, the shot callouts ("Hit", "{name} sank your
 *     cruiser") and the companion's roaming aim while it thinks. Shots are
 *     attributed by history[].by.
 *   - aiTurnFailed (placement or shot): "{name} couldn't move" with a
 *     borderless Try again in the turn line.
 *
 * Keyboard (the viewport is focusable):
 *   setup:  1-5 pick a ship, arrows move it, R rotates, Enter places it (or
 *           picks up the ship under the cursor), Esc puts it back.
 *   battle: arrows aim, Enter or Space fires.
 *
 * With `game` null it renders the empty trays only (launch backdrop).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import {
  BATTLESHIP_COLS,
  BATTLESHIP_ROWS,
  BATTLESHIP_SHIP_NAMES,
  placementFits,
  randomFleetPlacement,
  type BATTLESHIPCell,
  type BATTLESHIPGameState,
  type BATTLESHIPPlacement,
  type BATTLESHIPShipName,
} from '@shared/battleshipIpc';
import { FleetScene, type FleetView } from './three/FleetScene';
import {
  canFireAt,
  clampedPlacementAt,
  coordName,
  enemyShips,
  lastShotBy,
  placementCellsOf,
  placementOfShip,
  rotated,
  segmentOf,
  shipAt,
  without,
  type GridPos,
} from './fleetUtil';
import { watchWebglContext } from '../tabletop/SceneGuard';
import hud from '../tabletop/TabletopHud.module.css';
import { useWindowWatched } from '../tabletop/useWindowWatched';

export interface FleetBoard3DProps {
  game: BATTLESHIPGameState | null;
  companionName: string;
  /** Fire at the companion's waters; resolves with main's verdict. */
  onFire?: (row: number, col: number) => Promise<boolean> | void;
  /** Confirm the fleet and start the battle; resolves false on failure. */
  onPlaceFleet?: (ships: BATTLESHIPPlacement[]) => Promise<boolean>;
  /** Run the character's failed turn (placement or shot) again. */
  onRetry?: () => void;
  /** The WebGL context was lost (true) or came back (false). */
  onSceneLost?: (lost: boolean) => void;
}

interface Held {
  name: BATTLESHIPShipName;
  horizontal: boolean;
  grab: number;
  /** Where it was on the board before it was picked up (null = harbor). */
  origin: BATTLESHIPPlacement | null;
  /** Click-to-pick: the ship stays held after the pointer goes up. */
  sticky: boolean;
}

interface Callout {
  id: number;
  text: string;
  tone: 'hit' | 'miss' | 'sunk';
}

const EMPTY_CELLS: BATTLESHIPCell[][] = Array.from({ length: BATTLESHIP_ROWS }, () =>
  Array<BATTLESHIPCell>(BATTLESHIP_COLS).fill('empty'),
);

const clampPos = (p: GridPos): GridPos => ({
  row: Math.min(BATTLESHIP_ROWS - 1, Math.max(0, p.row)),
  col: Math.min(BATTLESHIP_COLS - 1, Math.max(0, p.col)),
});

const samePos = (a: GridPos | null, b: GridPos | null): boolean =>
  a === b || (!!a && !!b && a.row === b.row && a.col === b.col);

export function FleetBoard3D({
  game,
  companionName,
  onFire,
  onPlaceFleet,
  onRetry,
  onSceneLost,
}: FleetBoard3DProps): React.ReactElement {
  const t = useT();
  const watched = useWindowWatched();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FleetScene | null>(null);
  const [anchors, setAnchors] = useState<ReturnType<FleetScene['anchors']> | null>(null);

  /** The player is still drawing their fleet (setup UI on). */
  const placing = game?.status === 'preparing' && !game.playerFleetPlaced;
  /** The player's fleet is in; the character is still placing its own. */
  const waiting = game?.status === 'preparing' && game.playerFleetPlaced;
  const active = game?.status === 'active';
  const aiFailed = !!game && game.status !== 'ended' && !!game.aiTurnFailed;

  // ── Setup draft ───────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<BATTLESHIPPlacement[]>([]);
  const [held, setHeld] = useState<Held | null>(null);
  const [cursor, setCursor] = useState<GridPos | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupErr, setSetupErr] = useState(false);
  const [selected, setSelected] = useState<BATTLESHIPShipName | null>(null);
  const drag = useRef<{ pointerId: number; start: GridPos | null; moved: boolean } | null>(null);

  const gameId = game?.gameId ?? null;
  const status = game?.status ?? null;
  useEffect(() => {
    setDraft([]);
    setHeld(null);
    setCursor(null);
    setSelected(null);
    setBusy(false);
    setSetupErr(false);
    drag.current = null;
  }, [gameId, status, game?.playerFleetPlaced]);

  const heldPlacement = useMemo(() => {
    if (!held || !cursor) return null;
    return clampedPlacementAt(held.name, cursor, held.horizontal, held.grab);
  }, [held, cursor]);
  const heldValid = useMemo(
    () => !!heldPlacement && placementFits(heldPlacement, placementCellsOf(draft)),
    [heldPlacement, draft],
  );
  const placedNames = useMemo(() => new Set(draft.map((p) => p.name)), [draft]);
  const unplaced = BATTLESHIP_SHIP_NAMES.filter((n) => !placedNames.has(n));
  const fleetReady = draft.length === BATTLESHIP_SHIP_NAMES.length && !held;

  // ── Battle state ──────────────────────────────────────────────────────────
  const [pending, setPending] = useState<{ pos: GridPos; shots: number } | null>(null);
  const shots = game?.history.length ?? 0;
  useEffect(() => {
    setPending(null);
  }, [shots, gameId]);

  const canFire = !!game && active && game.turn === 'player' && !game.aiThinking && !pending;
  const enemyFleet = useMemo(() => (game ? enemyShips(game) : []), [game]);

  // ── Shot callouts ─────────────────────────────────────────────────────────
  const [callout, setCallout] = useState<Callout | null>(null);
  const seen = useRef<BATTLESHIPGameState | null>(null);
  useEffect(() => {
    if (!game) return;
    const prev = seen.current;
    seen.current = game;
    if (!prev || prev.gameId !== game.gameId || game.history.length <= prev.history.length) return;
    const rec = game.history[game.history.length - 1];
    const byPlayer = rec.by === 'player';
    const ship = rec.sunkShip ? t(rec.sunkShip) : '';
    const text = byPlayer
      ? rec.sunkShip
        ? t('You sank their {ship}', { ship })
        : rec.hit
          ? t('Hit')
          : t('Miss')
      : rec.sunkShip
        ? t('{name} sank your {ship}', { name: companionName, ship })
        : rec.hit
          ? t('{name} hit your fleet', { name: companionName })
          : t('{name} missed', { name: companionName });
    setCallout({ id: Date.now(), text, tone: rec.sunkShip ? 'sunk' : rec.hit ? 'hit' : 'miss' });
  }, [game, companionName, t]);
  useEffect(() => {
    if (!callout) return;
    const timer = window.setTimeout(() => setCallout(null), 1800);
    return () => window.clearTimeout(timer);
  }, [callout]);

  // ── Scene lifecycle ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const s = new FleetScene(el);
    s.onLayout = () => setAnchors(s.anchors());
    setScene(s);
    (el as unknown as { __tabletopTiming?: () => unknown }).__tabletopTiming = () => s.timing();
    return () => {
      s.dispose();
      setScene(null);
    };
  }, []);

  const lostRef = useRef(onSceneLost);
  lostRef.current = onSceneLost;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return watchWebglContext(el, (lost) => lostRef.current?.(lost));
  }, []);

  const view: FleetView = useMemo(() => {
    if (!game) {
      return { phase: 'battle', playerShips: [], playerCells: EMPTY_CELLS, enemyCells: EMPTY_CELLS, enemyShips: [], lastAiShot: null };
    }
    if (game.status === 'preparing' && !game.playerFleetPlaced) {
      return {
        phase: 'placing',
        playerShips: draft.map((placement) => ({ placement, sunk: false })),
        playerCells: EMPTY_CELLS,
        enemyCells: EMPTY_CELLS,
        enemyShips: [],
        lastAiShot: null,
      };
    }
    return {
      phase: 'battle',
      playerShips: game.playerGrid.ships.map((s) => ({ placement: placementOfShip(s), sunk: s.sunk })),
      playerCells: game.playerGrid.cells,
      enemyCells: game.aiVisibleGrid.cells,
      enemyShips: enemyFleet,
      lastAiShot: game.status === 'active' ? lastShotBy(game, 'ai') : null,
    };
  }, [game, draft, enemyFleet]);

  // First paint is not animated (resume); every later change is.
  const painted = useRef<string | null>(null);
  useEffect(() => {
    if (!scene) return;
    const key = game?.gameId ?? '';
    scene.setView(view, painted.current === key);
    painted.current = key;
  }, [scene, view, game?.gameId]);

  useEffect(() => {
    if (!scene) return;
    const showInDock = unplaced.filter((n) => !(held?.name === n && heldPlacement));
    scene.setDock(showInDock, held && !heldPlacement ? held.name : null);
    scene.setGhost(heldPlacement ? { placement: heldPlacement, valid: heldValid } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, unplaced.join(','), held, heldPlacement, heldValid]);

  // Reticle: the player's aim (battle) or the keyboard cursor (setup).
  useEffect(() => {
    if (!scene) return;
    if (active && pending) scene.setTarget('enemy', pending.pos);
    else if (active && canFire && cursor && game && canFireAt(game, cursor)) scene.setTarget('enemy', cursor);
    else if (placing && keyboard && cursor && !held) scene.setTarget('player', cursor);
    else scene.setTarget(null, null);
  }, [scene, active, placing, canFire, cursor, pending, keyboard, held, game]);

  useEffect(() => {
    scene?.setEnded(status === 'ended');
  }, [scene, status]);

  useEffect(() => {
    scene?.setThinking(!!game && active && game.aiThinking && !aiFailed);
  }, [scene, active, game?.aiThinking, aiFailed, game]);

  // ── Setup intents ─────────────────────────────────────────────────────────
  /** `base`: the draft as it stands after a drop in the same handler (state lags a render). */
  function pickUp(name: BATTLESHIPShipName, grab: number, sticky: boolean, base = draft): void {
    const origin = base.find((p) => p.name === name) ?? null;
    if (origin) setDraft(without(base, name));
    setHeld({ name, horizontal: origin ? origin.horizontal : true, grab, origin, sticky });
    setSelected(name);
  }

  /** Put the held ship down (or back); returns the draft it leaves. */
  function dropHeld(at: BATTLESHIPPlacement | null): BATTLESHIPPlacement[] {
    if (!held) return draft;
    let next = draft;
    if (at && placementFits(at, placementCellsOf(draft))) {
      next = [...without(draft, held.name), at];
    } else if (at && held.origin) {
      // Did not fit: it goes back where it was.
      next = [...without(draft, held.name), held.origin];
    }
    if (next !== draft) setDraft(next);
    setHeld(null);
    return next;
  }

  function returnToDock(): void {
    if (!held) return;
    setHeld(null);
  }

  function rotateHeldOrSelected(): void {
    if (held) {
      setHeld({ ...held, horizontal: !held.horizontal });
      return;
    }
    const target = cursor && keyboard ? shipAt(draft, cursor) : null;
    const p = target ?? draft.find((d) => d.name === selected) ?? null;
    if (!p) return;
    const next = rotated(draft, p, cursor && target ? segmentOf(p, cursor) : 0);
    if (next) setDraft([...without(draft, p.name), next]);
  }

  async function confirmFleet(ships: BATTLESHIPPlacement[]): Promise<void> {
    if (!onPlaceFleet || busy) return;
    setBusy(true);
    setSetupErr(false);
    const ok = await onPlaceFleet(ships);
    setBusy(false);
    if (!ok) setSetupErr(true);
  }

  // ── Pointer ───────────────────────────────────────────────────────────────
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!scene || !game) return;
    scene.wake();
    if (keyboard) setKeyboard(false);
    if (placing) {
      if (!held) {
        if (cursor) setCursor(null);
        return;
      }
      const c = scene.playerCellNear(e.clientX, e.clientY);
      if (drag.current && !samePos(c, drag.current.start)) drag.current.moved = true;
      if (!samePos(c, cursor)) setCursor(c);
      return;
    }
    const p = scene.pick(e.clientX, e.clientY);
    const c = p?.kind === 'cell' && p.board === 'enemy' ? { row: p.row, col: p.col } : null;
    if (!samePos(c, cursor)) setCursor(c);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (!scene || !game) return;
    if (placing) {
      if (busy) return;
      if (e.button === 2) {
        if (held) setHeld({ ...held, horizontal: !held.horizontal });
        return;
      }
      if (e.button !== 0) return;
      const p = scene.pick(e.clientX, e.clientY);
      if (held) {
        // Second click of click-to-place.
        if (p?.kind === 'dock' || (!p && !cursor)) returnToDock();
        else dropHeld(heldPlacement);
        return;
      }
      if (p?.kind === 'dock') {
        pickUp(p.name, 0, false);
        drag.current = { pointerId: e.pointerId, start: null, moved: false };
        setCursor(null);
      } else if (p?.kind === 'cell' && p.board === 'player') {
        const pos = { row: p.row, col: p.col };
        const ship = shipAt(draft, pos);
        if (!ship) return;
        pickUp(ship.name, segmentOf(ship, pos), false);
        drag.current = { pointerId: e.pointerId, start: pos, moved: false };
        setCursor(pos);
      } else {
        return;
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0 || !canFire) return;
    const p = scene.pick(e.clientX, e.clientY);
    if (p?.kind === 'cell' && p.board === 'enemy') fire({ row: p.row, col: p.col });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || !held) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d.moved) {
      if (held.origin) {
        // A click on a placed ship rotates it in place.
        const next = rotated([...draft, held.origin], held.origin, held.grab);
        setDraft([...draft, next ?? held.origin]);
        setHeld(null);
      } else {
        setHeld({ ...held, sticky: true });
      }
      return;
    }
    if (!cursor) returnToDock();
    else dropHeld(heldPlacement);
  }

  function fire(pos: GridPos): void {
    if (!game || !canFire || !canFireAt(game, pos)) return;
    setPending({ pos, shots: game.history.length });
    void Promise.resolve(onFire?.(pos.row, pos.col)).then((ok) => {
      if (ok === false) setPending(null);
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!game) return;
    const k = e.key;
    const arrows: Record<string, GridPos> = {
      ArrowUp: { row: -1, col: 0 },
      ArrowDown: { row: 1, col: 0 },
      ArrowLeft: { row: 0, col: -1 },
      ArrowRight: { row: 0, col: 1 },
    };
    if (placing) {
      if (busy) return;
      const idx = Number(k) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < BATTLESHIP_SHIP_NAMES.length) {
        e.preventDefault();
        // Switching ships puts the held one back first; pick up from that
        // draft, not the stale render's (which would send it to the harbor).
        const base = held ? dropHeld(held.origin) : draft;
        const name = BATTLESHIP_SHIP_NAMES[idx];
        const origin = base.find((p) => p.name === name);
        pickUp(name, 0, true, base);
        setCursor(origin ? { row: origin.row, col: origin.col } : (cursor ?? { row: 4, col: 3 }));
        setKeyboard(true);
        return;
      }
      if (arrows[k]) {
        e.preventDefault();
        const cur = cursor ?? { row: 4, col: 4 };
        setCursor(clampPos({ row: cur.row + arrows[k].row, col: cur.col + arrows[k].col }));
        setKeyboard(true);
        return;
      }
      if (k === 'r' || k === 'R') {
        e.preventDefault();
        rotateHeldOrSelected();
        return;
      }
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        setKeyboard(true);
        if (held) {
          dropHeld(heldPlacement);
          return;
        }
        const cur = cursor ?? { row: 4, col: 4 };
        const ship = shipAt(draft, cur);
        if (ship) pickUp(ship.name, segmentOf(ship, cur), true);
        else if (unplaced.length) pickUp(unplaced[0], 0, true);
        if (!cursor) setCursor(cur);
        return;
      }
      if (k === 'Escape' || k === 'Delete' || k === 'Backspace') {
        if (!held) return;
        e.preventDefault();
        e.stopPropagation();
        if (k === 'Escape' && held.origin) dropHeld(held.origin);
        else returnToDock();
      }
      return;
    }
    if (!active) return;
    if (arrows[k]) {
      e.preventDefault();
      const cur = cursor ?? { row: 4, col: 4 };
      setCursor(clampPos({ row: cur.row + arrows[k].row, col: cur.col + arrows[k].col }));
      setKeyboard(true);
    } else if ((k === 'Enter' || k === ' ') && cursor) {
      e.preventDefault();
      fire(cursor);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const aiPlacing = waiting && !aiFailed;
  const turnLabel = !game
    ? ''
    : aiFailed
      ? t("{name} couldn't move", { name: companionName })
      : waiting
        ? t('{name} is placing ships…', { name: companionName })
        : placing
          ? fleetReady
            ? t('Fleet ready')
            : t('Place your ships')
          : game.aiThinking
            ? t('{name} is thinking…', { name: companionName })
            : game.turn === 'player'
              ? t('Your turn')
              : t("{name}'s turn", { name: companionName });

  let liveHint = '';
  if (keyboard && cursor) {
    const coord = coordName(cursor);
    if (placing && held) {
      liveHint = heldValid ? t('{ship} at {coord}', { ship: t(held.name), coord }) : t("{ship} doesn't fit at {coord}", { ship: t(held.name), coord });
    } else if (active && game) {
      liveHint = canFireAt(game, cursor) ? t('Target {coord}', { coord }) : t('Already fired at {coord}', { coord });
    } else {
      liveHint = coord;
    }
  }

  const ariaLabel = !game
    ? undefined
    : placing
      ? t('Fleet setup. Keys 1 to 5 pick a ship, arrows move it, R rotates, Enter places it.')
      : t('Fleet Battle board. Arrow keys aim at the enemy waters, Enter fires.');

  const showTurn = !!game && (placing || waiting || active);
  const shimmer = (active && !!game?.aiThinking && !aiFailed) || aiPlacing;
  const pointerCursor = (placing && (held || drag.current)) || (active && canFire && cursor);

  return (
    <div
      ref={containerRef}
      className={pointerCursor ? `${hud.viewport} ${hud.pointer}` : hud.viewport}
      onPointerMove={game ? onPointerMove : undefined}
      onPointerDown={game ? onPointerDown : undefined}
      onPointerUp={game ? onPointerUp : undefined}
      onPointerCancel={game ? onPointerUp : undefined}
      onPointerLeave={() => {
        if (!keyboard && !held && active) setCursor(null);
      }}
      onContextMenu={(e) => {
        if (placing) e.preventDefault();
      }}
      onKeyDown={game ? onKeyDown : undefined}
      tabIndex={game ? 0 : -1}
      role={game ? 'application' : 'presentation'}
      aria-label={ariaLabel}
    >
      {showTurn ? (
        <div className={hud.topCenter}>
          {aiFailed ? (
            <div className={hud.turnRow}>
              <div className={hud.turnChip} role="status">
                {turnLabel}
              </div>
              {onRetry ? (
                <button
                  type="button"
                  className={`${hud.sceneBtn} ${hud.retryBtn}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                >
                  {t('Try again')}
                </button>
              ) : null}
            </div>
          ) : (
            <div
              className={
                shimmer ? `${hud.turnChip} ${hud.thinking}${watched ? '' : ` ${hud.unwatched}`}` : hud.turnChip
              }
              aria-live="polite"
            >
              {turnLabel}
            </div>
          )}
          {placing ? (
            setupErr ? (
              <div className={hud.subTag} role="alert">
                {t("The game couldn't start. Try again in a moment.")}
              </div>
            ) : (
              <div className={hud.subTag}>{t('Drag ships onto your waters. Click one to turn it.')}</div>
            )
          ) : null}
          {callout ? (
            <div
              key={callout.id}
              className={[hud.callout, callout.tone === 'hit' ? hud.calloutHit : callout.tone === 'sunk' ? hud.calloutSunk : ''].join(' ')}
              role="status"
            >
              {callout.text}
            </div>
          ) : null}
        </div>
      ) : null}

      {placing ? (
        <div
          className={hud.hudTopRight}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button type="button" className={hud.sceneBtn} disabled={busy || (!held && draft.length === 0)} onClick={rotateHeldOrSelected}>
            {t('Rotate')}
          </button>
          <button
            type="button"
            className={hud.sceneBtn}
            disabled={busy}
            onClick={() => {
              setHeld(null);
              setDraft(randomFleetPlacement());
            }}
          >
            {t('Random')}
          </button>
          <Button kind="accent" size="sm" disabled={busy || !fleetReady} onClick={() => void confirmFleet(draft)}>
            {t('Start battle')}
          </Button>
        </div>
      ) : null}

      {game && anchors ? (
        <>
          <div className={`${hud.sceneLabel} ${hud.sceneLabelArea}`} style={{ left: anchors.player.x, top: anchors.player.y }}>
            {t('Your fleet')}
          </div>
          {placing ? (
            anchors.dock
              .filter((d) => unplaced.includes(d.name) && !(held?.name === d.name && heldPlacement))
              .map((d) => (
                <div key={d.name} className={`${hud.sceneLabel} ${hud.sceneLabelStart}`} style={{ left: d.x, top: d.y }}>
                  {t(d.name)}
                </div>
              ))
          ) : (
            <div className={`${hud.sceneLabel} ${hud.sceneLabelArea}`} style={{ left: anchors.enemy.x, top: anchors.enemy.y }}>
              {t("{name}'s waters", { name: companionName })}
            </div>
          )}
        </>
      ) : null}

      <div className={hud.srOnly} aria-live="polite">
        {liveHint}
      </div>
    </div>
  );
}
