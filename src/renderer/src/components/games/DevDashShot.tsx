/**
 * DevDashShot — dev-only screenshot harness for the game dashboards, NOT
 * part of the app UI (260909; same pattern as chess/DevChessShot).
 *
 * main.tsx lazy-loads this behind `import.meta.env.DEV` when the renderer
 * URL carries `?dashshot=1`, e.g.
 *
 *     http://localhost:5173/?dashshot=1            both panels stacked
 *     http://localhost:5173/?dashshot=dontstarve   one panel, full viewport
 *     http://localhost:5173/?dashshot=stardew
 *     http://localhost:5173/?dashshot=mclaunch     the Minecraft launch panel (add &ready=1 for the set-up state)
 *     http://localhost:5173/?dashshot=dstlaunch    the Don't Starve Together launch panel
 *     http://localhost:5173/?dashshot=stardewlaunch  the Stardew Valley launch panel
 *
 * It seeds useMcDashboardStore with fixture snapshots and useDataStore with
 * two named characters (window.sei is stubbed by devHarnessStubs.ts, which
 * has to run before ipcClient captures it), and renders the real DstDashboardPanel / StardewDashboardPanel, so
 * the game-styled exceptions can be checked in a plain browser tab without
 * a summon. Deliberately no real IPC.
 */
import React from 'react';
import type { DstDashboardSnapshot } from '@shared/dstIpc';
import type { StardewDashboardSnapshot } from '@shared/stardewIpc';
import type { GenericGameDashboardSnapshot } from '@shared/gameIpc';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { DstDashboardPanel } from '../dontstarve/DstDashboardPanel';
import { StardewDashboardPanel } from '../stardew/StardewDashboardPanel';
import { McLaunchPanel } from '../mcdash/McLaunchPanel';
import { DstLaunchPanel } from '../dontstarve/DstLaunchPanel';
import { StardewLaunchPanel } from '../stardew/StardewLaunchPanel';

const DST_ID = 'dashshot-dst';
const SDV_ID = 'dashshot-sdv';
const SDV_PEER_ID = 'dashshot-sdv-peer';

const DST_SNAPSHOT: DstDashboardSnapshot = {
  game: 'dontstarve',
  characterId: DST_ID,
  ts: Date.now(),
  activity: 'gathering twigs...',
  actionName: 'gather',
  x: 112.4,
  z: -38.9,
  health: 96,
  healthMax: 125,
  hunger: 41,
  hungerMax: 150,
  sanity: 188,
  sanityMax: 250,
  temperature: 24,
  held: 'axe',
  items: [
    { prefab: 'twigs', count: 14 },
    { prefab: 'cutgrass', count: 9 },
    { prefab: 'log', count: 6 },
    { prefab: 'flint', count: 3 },
    { prefab: 'rocks', count: 7 },
    { prefab: 'berries', count: 5 },
    { prefab: 'torch', count: 1 },
    { prefab: 'pickaxe', count: 1 },
    { prefab: 'carrot', count: 2 },
    { prefab: 'goldnugget', count: 1 },
  ],
  day: 7,
  season: 'autumn',
  phase: 'dusk',
  prefab: 'wickerbottom',
};

const SDV_SNAPSHOT: StardewDashboardSnapshot = {
  game: 'stardew',
  characterId: SDV_ID,
  ts: Date.now(),
  location: 'Farm',
  x: 62,
  y: 18,
  stamina: 172,
  maxStamina: 270,
  health: 100,
  maxHealth: 100,
  gold: 1250,
  held: 'Watering Can',
  items: [
    { slot: 0, name: 'Axe', count: 1, kind: 'tool' },
    { slot: 1, name: 'Hoe', count: 1, kind: 'tool' },
    { slot: 2, name: 'Watering Can', count: 1, kind: 'tool' },
    { slot: 3, name: 'Pickaxe', count: 1, kind: 'tool' },
    { slot: 4, name: 'Scythe', count: 1, kind: 'scythe' },
    { slot: 5, name: 'Parsnip Seeds', count: 12, kind: 'seed' },
    { slot: 6, name: 'Wood', count: 38, kind: 'resource' },
    { slot: 7, name: 'Stone', count: 21, kind: 'resource' },
    { slot: 8, name: 'Fiber', count: 9, kind: 'resource' },
    { slot: 12, name: 'Leek', count: 2, kind: 'forage' },
    { slot: 13, name: 'Daffodil', count: 3, kind: 'forage' },
  ],
  activity: 'watering the crops...',
  actionName: 'water',
  day: 3,
  season: 'spring',
  year: 1,
  time: 1330,
  timeText: '1:30 PM',
  weather: 'sunny',
  paused: false,
  sleeping: false,
};

function seed(): void {
  // window.sei is stubbed by devHarnessStubs.ts (main.tsx's first import).
  useMcDashboardStore.setState((s) => ({
    gameSnapshots: {
      ...s.gameSnapshots,
      [DST_ID]: DST_SNAPSHOT as unknown as GenericGameDashboardSnapshot,
      [SDV_ID]: SDV_SNAPSHOT as unknown as GenericGameDashboardSnapshot,
      // A second farmhand on the same farm, so the status row shows two windows.
      [SDV_PEER_ID]: { ...SDV_SNAPSHOT, characterId: SDV_PEER_ID, activity: 'chopping wood...', actionName: 'chop' } as unknown as GenericGameDashboardSnapshot,
    },
  }));
  useDataStore.setState((s) => ({
    summons: {
      ...s.summons,
      [SDV_ID]: { kind: 'online', characterId: SDV_ID, game: 'stardew', uptimeMs: 0, startedAtMs: Date.now() },
      [SDV_PEER_ID]: { kind: 'online', characterId: SDV_PEER_ID, game: 'stardew', uptimeMs: 0, startedAtMs: Date.now() },
    },
  }));
  useDataStore.setState((s) => ({
    characters: [
      ...s.characters,
      { id: DST_ID, name: 'Sui', portrait_image: './img/onboard/sui-stand.png' } as unknown as (typeof s.characters)[number],
      { id: SDV_ID, name: 'Marv', portrait_image: './img/onboard/sui-talk-flipped.png' } as unknown as (typeof s.characters)[number],
      { id: SDV_PEER_ID, name: 'Lyra' } as unknown as (typeof s.characters)[number],
    ],
  }));
}

// Seed once at import, never during render (React flags store writes from a render).
seed();

export function DevDashShot({ which }: { which: string }): React.ReactElement {
  const only = which === 'dontstarve' || which === 'stardew' || which === 'mclaunch' || which === 'dstlaunch' || which === 'stardewlaunch' ? which : null;
  const box: React.CSSProperties = { height: only ? '100vh' : '50vh', minHeight: 420 };
  if (only === 'mclaunch' || only === 'dstlaunch' || only === 'stardewlaunch') {
    // The launch panels sit in the chat game aside, which is at most 62% of
    // the window; the harness box matches so a window that pushes Launch
    // below the fold is caught here rather than in the app.
    const Panel = only === 'mclaunch' ? McLaunchPanel : only === 'dstlaunch' ? DstLaunchPanel : StardewLaunchPanel;
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#111', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: '62vh', minHeight: 360 }}>
          <Panel characterId={DST_ID} />
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#111' }}>
      {only !== 'stardew' ? (
        <div style={box}>
          <DstDashboardPanel characterId={DST_ID} />
        </div>
      ) : null}
      {only !== 'dontstarve' ? (
        <div style={box}>
          <StardewDashboardPanel characterId={SDV_ID} />
        </div>
      ) : null}
    </div>
  );
}
