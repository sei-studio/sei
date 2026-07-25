/**
 * McDashVitals — pixel hearts (health) + drumsticks (food) rows for the
 * Minecraft dashboard (260721). Original pixel-art shapes drawn as SVG rect
 * grids with crispEdges (no Mojang textures; the style is evoked with our
 * own cells). Values are the vanilla 0-20 half-unit scales: ten icons per
 * row, each icon worth 2 points, odd values render a half icon.
 */

import React from 'react';
import styles from './McDashboardPanel.module.css';

type Cell = [number, number];

/** 9x8 pixel heart. */
const HEART_CELLS: Cell[] = [];
{
  const rows: number[][] = [
    [1, 2, 6, 7],
    [0, 1, 2, 3, 5, 6, 7, 8],
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    [1, 2, 3, 4, 5, 6, 7],
    [2, 3, 4, 5, 6],
    [3, 4, 5],
    [4],
  ];
  rows.forEach((xs, y) => xs.forEach((x) => HEART_CELLS.push([x, y])));
}

/** 9x9 pixel drumstick: meat blob top-left, bone to the bottom-right. */
const MEAT_CELLS: Cell[] = [];
const BONE_CELLS: Cell[] = [];
{
  const meatRows: number[][] = [
    [2, 3, 4],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5],
    [2, 3, 4, 5],
  ];
  meatRows.forEach((xs, y) => xs.forEach((x) => MEAT_CELLS.push([x, y])));
  const boneRows: Array<[number, number[]]> = [
    [5, [5]],
    [6, [6, 7]],
    [7, [6, 7, 8]],
    [8, [7, 8]],
  ];
  boneRows.forEach(([y, xs]) => xs.forEach((x) => BONE_CELLS.push([x, y])));
}

function cellsToRects(cells: Cell[], fill: string, clipHalf: boolean): React.ReactElement[] {
  return cells
    .filter(([x]) => !clipHalf || x <= 4)
    .map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />);
}

type IconState = 'full' | 'half' | 'empty';

function Heart({ state }: { state: IconState }): React.ReactElement {
  return (
    <svg viewBox="0 0 9 8" className={styles.vitalIcon} shapeRendering="crispEdges" aria-hidden="true">
      {cellsToRects(HEART_CELLS, '#3a3a44', false)}
      {state !== 'empty' ? cellsToRects(HEART_CELLS, '#e33b3b', state === 'half') : null}
      {state === 'full' ? <rect x={2} y={1} width={1} height={1} fill="#ff8f8f" /> : null}
    </svg>
  );
}

function Drumstick({ state }: { state: IconState }): React.ReactElement {
  return (
    <svg viewBox="0 0 9 9" className={styles.vitalIcon} shapeRendering="crispEdges" aria-hidden="true">
      {cellsToRects(MEAT_CELLS, '#3a3a44', false)}
      {cellsToRects(BONE_CELLS, '#3a3a44', false)}
      {state !== 'empty' ? (
        <>
          {cellsToRects(MEAT_CELLS, '#b1633c', state === 'half')}
          {cellsToRects(BONE_CELLS, '#ece6d8', state === 'half')}
          {state === 'full' ? <rect x={2} y={1} width={1} height={1} fill="#d98f66" /> : null}
        </>
      ) : null}
    </svg>
  );
}

function iconState(value: number, index: number): IconState {
  if (value >= (index + 1) * 2) return 'full';
  if (value === index * 2 + 1) return 'half';
  return 'empty';
}

export function HeartsRow({ health }: { health: number }): React.ReactElement {
  return (
    <div className={styles.vitalRow} role="img" aria-label={`Health ${health} of 20`}>
      {Array.from({ length: 10 }, (_, i) => (
        <Heart key={i} state={iconState(health, i)} />
      ))}
    </div>
  );
}

export function FoodRow({ food }: { food: number }): React.ReactElement {
  return (
    <div className={styles.vitalRow} role="img" aria-label={`Food ${food} of 20`}>
      {Array.from({ length: 10 }, (_, i) => (
        <Drumstick key={i} state={iconState(food, i)} />
      ))}
    </div>
  );
}
