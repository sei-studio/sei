/**
 * FleetScene — the 3D Fleet Battle sea (three.js, no React).
 *
 * Open water on a bright day (openSea.ts: the stage environment, the sea out
 * to a horizon, sky, islands). The two 10x10 grids are areas marked on the
 * water: the sea shader draws their cell lines and a lighter lagoon tint, a
 * rope of yellow and white floats rings each one with striped buoys at the
 * corners, and floating white markers carry the row letters and column
 * numbers. The player's waters are on the left with their toy fleet, the
 * companion's on the right. Ships float on the shared sea and cast shadows
 * onto it.
 *
 * Shots are pegs, the same on both boards: white for a miss (with a splash
 * when it lands), red with a little flame and smoke for a hit (with a burst).
 * A sunk ship lists and settles low in the water over a dark slick and keeps
 * smoking; the companion's sunk ships are revealed the same way, so nothing
 * that was sunk ever disappears.
 *
 * During fleet setup the right area is a wooden pier: the five ships wait in
 * its berths and are dragged (or clicked, or moved by keyboard) onto the left
 * area; a ghost shows where a held ship would go, green when it fits.
 *
 * Driven imperatively by FleetBoard3D.tsx; rendering is on demand plus the
 * stage's throttled, self-sleeping ambient tier for the water and flames.
 * Colors are 3D art-asset values (literal by design, like the chess scene).
 */

import * as THREE from 'three';
import {
  BATTLESHIP_SHIP_NAMES,
  SHIP_SIZES,
  placementCells,
  type BATTLESHIPCell,
  type BATTLESHIPPlacement,
  type BATTLESHIPShipName,
} from '@shared/battleshipIpc';
import { makeWoodTexture } from '../../chess/three/woodTexture';
import { TabletopStage, easeOut, easeOutBack, endFraming, smooth } from '../../tabletop/TabletopStage';
import { roundedRect } from '../../connect4/three/Connect4Scene';
import { HORIZON_FRAC, OpenSea, SEA_LEVEL, openSeaEnvironment } from './openSea';
import { DECK_Y, ENEMY_PALETTE, PLAYER_PALETTE, ShipLibrary } from './shipGeometry';
import { ROW_LETTERS, type GridPos } from '../fleetUtil';

export type BoardId = 'player' | 'enemy';

export interface FleetView {
  phase: 'placing' | 'battle';
  /** The player's ships (draft during placement) and whether each is sunk. */
  playerShips: Array<{ placement: BATTLESHIPPlacement; sunk: boolean }>;
  playerCells: BATTLESHIPCell[][];
  enemyCells: BATTLESHIPCell[][];
  /**
   * Enemy ships to draw: mid-game the ones the player sank (rebuilt from the
   * visible grid), at game end the whole revealed fleet (afloat ones surface).
   */
  enemyShips: Array<{ placement: BATTLESHIPPlacement; sunk: boolean }>;
  /** The companion's latest shot on the player's grid. */
  lastAiShot: GridPos | null;
}

export type FleetPick =
  | { kind: 'cell'; board: BoardId; row: number; col: number }
  | { kind: 'dock'; name: BATTLESHIPShipName }
  | null;

// ── Layout ──────────────────────────────────────────────────────────────────
const N = 10;
/** Centre of each sea area along x (player left, companion right). */
const TRAY_X = 6.35;
/** Margin around an area that its rope, buoys and markers take. */
const RIM = 1.0;
const TRAY_HALF = N / 2 + RIM;
const WATER_Y = SEA_LEVEL;
/** Rope ring around an area, and the marker line just outside it. */
const ROPE = N / 2 + 0.2;
const MARK = N / 2 + 0.68;
/** Pier deck height; harbor ships float in its berths at the waterline. */
const PIER_TOP = WATER_Y + 0.3;
/** Camera: field of view and elevation (degrees). Low enough to look out to sea, steep enough for readable grids. */
const FOV = 42;
const ELEVATION = 45;
const DOCK_LEFT = TRAY_X - 3.15;
const DOCK_ROW_Z = [-4.2, -2.1, 0, 2.1, 4.2];
const DRAFT = 0.02; // ships float this far above their waterline origin

// Art palette.
const C_FOAM = 0xeafcff;
const C_FLOAT = 0xffc83d;
const C_FLOAT_ALT = 0xfbfaf4;
const C_ROPE = 0xf1e7cf;
const C_BUOY = 0xff6f4d;
const C_MARK_INK = '#1d3557';
const C_PEG_MISS = 0xf3efe6;
const C_PEG_HIT = 0xe0453a;
const C_FLAME = 0xff7a2a;
const C_FLAME_CORE = 0xffd86b;
const C_SMOKE = 0x8a837c;
const C_RETICLE = 0xffe3a3;
const C_AIM = 0xff8a7a;
const C_SLICK = 0x0e3a4c;

/**
 * How a sunk ship lies. Most list to one side and settle low. A vertical
 * ship lies along the view, where a big roll and a deep settle leave a thin
 * sliver, so it lists less and stays higher. The submarine is nearly flush
 * with the water already, so it goes stern first with the bow lifted, which
 * reads as sinking where a roll would not.
 */
function sunkPose(p: BATTLESHIPPlacement): { roll: number; pitch: number; y: number } {
  if (p.name === 'submarine') return { roll: 0.1, pitch: -0.24, y: -0.1 };
  return p.horizontal ? { roll: 0.22, pitch: -0.07, y: -0.21 } : { roll: 0.1, pitch: -0.1, y: -0.14 };
}

interface ShipEntry {
  key: string;
  board: BoardId;
  placement: BATTLESHIPPlacement;
  outer: THREE.Group; // position + yaw
  mesh: THREE.Mesh;
  tilt: THREE.Group; // roll / pitch / sink offset
  deck: THREE.Group; // pegs and flames riding the deck
  slick: THREE.Mesh | null;
  sunk: boolean;
  sinkStart: number; // -1 = not sinking; Infinity = settled
  dropStart: number; // -1 = at rest
  phase: number;
}

interface Fx {
  start: number;
  dur: number;
  update: (t: number) => void;
  done: () => void;
}

interface Flicker {
  obj: THREE.Object3D;
  kind: 'flame' | 'smoke';
  phase: number;
  base: THREE.Vector3;
}

/** One shot marker, kept across pushes while its cell and host stay the same. */
interface PegEntry {
  value: 'miss' | 'hit' | 'sunk';
  /** The ship whose deck it rides, or null on open water. */
  host: ShipEntry | null;
  obj: THREE.Group;
  ripple: THREE.Mesh | null;
  flickers: Flicker[];
}

function hash(r: number, c: number, salt = 0): number {
  const x = Math.sin((r + 1) * 12.9898 + (c + 1) * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

export class FleetScene {
  private readonly stage: TabletopStage;
  private readonly ships: ShipLibrary;
  private readonly sea: OpenSea;

  private readonly enemyTray = new THREE.Group();
  private readonly dock = new THREE.Group();
  private readonly shipRoot = new THREE.Group();
  private readonly markerRoot = new THREE.Group();
  private readonly dockShips = new Map<BATTLESHIPShipName, THREE.Mesh>();
  private readonly ghost: THREE.Mesh;
  private readonly reticle: THREE.Group;
  private readonly aim: THREE.Group;
  private readonly lastShotRing: THREE.Mesh;

  // Shared geometries / materials for markers and effects.
  private readonly pegGeo: THREE.LatheGeometry;
  private readonly rippleGeo: THREE.RingGeometry;
  private readonly flameGeo: THREE.ConeGeometry;
  private readonly flameCoreGeo: THREE.ConeGeometry;
  private readonly puffGeo: THREE.IcosahedronGeometry;
  private readonly dropGeo: THREE.IcosahedronGeometry;
  private readonly splashGeo: THREE.RingGeometry;
  private readonly flashGeo: THREE.IcosahedronGeometry;
  private readonly slickGeos = new Map<number, THREE.ShapeGeometry>();
  private readonly matPegMiss: THREE.MeshStandardMaterial;
  private readonly matPegHit: THREE.MeshStandardMaterial;
  private readonly matRipple: THREE.MeshBasicMaterial;
  private readonly matFlame: THREE.MeshBasicMaterial;
  private readonly matFlameCore: THREE.MeshBasicMaterial;
  private readonly matSmoke: THREE.MeshStandardMaterial;
  private readonly matDrop: THREE.MeshBasicMaterial;
  private readonly matDropHot: THREE.MeshBasicMaterial;
  private readonly matSlick: THREE.MeshBasicMaterial;
  private readonly matDockShip: THREE.MeshStandardMaterial;
  private readonly matSunk: THREE.MeshStandardMaterial;

  private disposed = false;
  private shipMap = new Map<string, ShipEntry>();
  private known: Record<BoardId, BATTLESHIPCell[][] | null> = { player: null, enemy: null };
  private phase: 'placing' | 'battle' | null = null;
  private phaseStart = 0;
  private aspect = 1;
  private viewW = 1;
  private viewH = 1;
  /** endShift value the camera last showed; the tick re-frames until it lands. */
  private shiftShown = 0;
  /** 0..1: the game is over, the areas slide up to make room for the result. */
  private endShift = { from: 0, to: 0, start: -Infinity };
  private fx: Fx[] = [];
  private flickers: Flicker[] = [];
  private readonly pegs = new Map<string, PegEntry>();
  private pegDrops: Array<{ obj: THREE.Object3D; y: number; start: number; delay: number }> = [];
  private heldDock: BATTLESHIPShipName | null = null;
  private thinking: { pos: GridPos; x: number; z: number; nextAt: number } | null = null;
  private dockUnplaced = new Set<BATTLESHIPShipName>(BATTLESHIP_SHIP_NAMES);

  /** Called after the camera is re-framed (projected anchors moved). */
  onLayout: () => void = () => undefined;

  constructor(container: HTMLElement) {
    this.stage = new TabletopStage(container, {
      environment: openSeaEnvironment,
      exposure: 1.0,
      // Water, bob and flames read fine at 15 fps, and the scene redraw is the cost.
      ambientFps: 15,
      ambientSleepMs: 15_000,
    });
    this.stage.camera.fov = FOV;
    const own = this.stage.own.bind(this.stage);
    const scene = this.stage.scene;
    this.ships = new ShipLibrary();

    // ── The sea, and the two areas marked on it ──
    this.sea = new OpenSea(this.stage, [
      { x: -TRAY_X, z: 0, half: N / 2 },
      { x: TRAY_X, z: 0, half: N / 2 },
    ]);
    this.buildAreaMarks(-TRAY_X, scene);
    this.buildAreaMarks(TRAY_X, this.enemyTray);
    scene.add(this.enemyTray);

    // ── Harbor (fleet setup): a wooden pier with five berths ──
    this.buildPier();
    this.matDockShip = this.ships.material;
    for (let i = 0; i < BATTLESHIP_SHIP_NAMES.length; i++) {
      const name = BATTLESHIP_SHIP_NAMES[i];
      const size = SHIP_SIZES[name];
      const ship = new THREE.Mesh(this.ships.geometry(name, PLAYER_PALETTE), this.matDockShip);
      ship.position.set(DOCK_LEFT + size / 2, WATER_Y + DRAFT, DOCK_ROW_Z[i]);
      ship.castShadow = true;
      ship.receiveShadow = true;
      this.dock.add(ship);
      this.dockShips.set(name, ship);
    }
    scene.add(this.dock);

    // ── Markers + effects resources ──
    this.pegGeo = own(pegGeometry());
    this.pegGeo.scale(1.15, 1.15, 1.15);
    this.rippleGeo = own(new THREE.RingGeometry(0.17, 0.22, 24));
    this.flameGeo = own(new THREE.ConeGeometry(0.11, 0.32, 7));
    this.flameGeo.translate(0, 0.16, 0);
    this.flameCoreGeo = own(new THREE.ConeGeometry(0.065, 0.2, 7));
    this.flameCoreGeo.translate(0, 0.1, 0);
    this.puffGeo = own(new THREE.IcosahedronGeometry(0.12, 0));
    this.dropGeo = own(new THREE.IcosahedronGeometry(0.045, 0));
    this.splashGeo = own(new THREE.RingGeometry(0.16, 0.24, 28));
    this.flashGeo = own(new THREE.IcosahedronGeometry(0.3, 1));
    this.matPegMiss = own(new THREE.MeshStandardMaterial({ color: C_PEG_MISS, roughness: 0.35 }));
    this.matPegHit = own(
      new THREE.MeshStandardMaterial({ color: C_PEG_HIT, roughness: 0.35, emissive: new THREE.Color(C_PEG_HIT), emissiveIntensity: 0.2 }),
    );
    this.matRipple = own(new THREE.MeshBasicMaterial({ color: C_FOAM, transparent: true, opacity: 0.45, depthWrite: false }));
    this.matFlame = own(new THREE.MeshBasicMaterial({ color: C_FLAME }));
    this.matFlameCore = own(new THREE.MeshBasicMaterial({ color: C_FLAME_CORE }));
    this.matSmoke = own(new THREE.MeshStandardMaterial({ color: C_SMOKE, roughness: 1, transparent: true, opacity: 0.62, flatShading: true, depthWrite: false }));
    this.matDrop = own(new THREE.MeshBasicMaterial({ color: C_FOAM }));
    this.matDropHot = own(new THREE.MeshBasicMaterial({ color: C_FLAME_CORE }));
    // Sunk hulls: the same vertex colors, scorched darker and duller.
    this.matSunk = own(this.ships.material.clone());
    this.matSunk.color.setHex(0x8a7f76);
    this.matSunk.roughness = Math.min(1, this.matSunk.roughness + 0.2);
    this.matSlick = own(new THREE.MeshBasicMaterial({ color: C_SLICK, transparent: true, opacity: 0.4, depthWrite: false }));

    scene.add(this.shipRoot, this.markerRoot);

    // Placement ghost.
    this.ghost = new THREE.Mesh(this.ships.geometry('carrier', PLAYER_PALETTE), this.ships.ghostOk);
    this.ghost.visible = false;
    this.ghost.renderOrder = 2;
    scene.add(this.ghost);

    // Target reticle (player's cursor) and the companion's aim.
    this.reticle = this.makeReticle(C_RETICLE);
    this.aim = this.makeReticle(C_AIM);
    scene.add(this.reticle, this.aim);
    const lastGeo = own(new THREE.RingGeometry(0.36, 0.43, 32));
    const lastMat = own(new THREE.MeshBasicMaterial({ color: C_AIM, transparent: true, opacity: 0.75, depthWrite: false }));
    this.lastShotRing = new THREE.Mesh(lastGeo, lastMat);
    this.lastShotRing.rotation.x = -Math.PI / 2;
    this.lastShotRing.visible = false;
    scene.add(this.lastShotRing);

    this.stage.onResize = (aspect, w, h) => this.frameCamera(aspect, w, h);
    this.stage.tick = (now, dt) => this.tick(now, dt);
    this.stage.ambient = (now, dt) => this.ambientTick(now, dt);
    this.setPhase('battle', false);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setView(view: FleetView, animate: boolean): void {
    const anim = animate && !this.stage.reducedMotion;
    this.setPhase(view.phase, anim);
    const now = performance.now();

    // Ships: the player's (draft or live) and the revealed sunk enemy ones.
    const want = new Map<string, { board: BoardId; placement: BATTLESHIPPlacement; sunk: boolean }>();
    for (const s of view.playerShips) want.set(`player:${s.placement.name}`, { board: 'player', ...s });
    if (view.phase === 'battle') {
      for (const e of view.enemyShips) want.set(`enemy:${e.placement.name}`, { board: 'enemy', ...e });
    }
    for (const [key, ent] of [...this.shipMap]) {
      const w = want.get(key);
      if (!w || !samePlacement(w.placement, ent.placement)) {
        this.shipRoot.remove(ent.outer);
        this.shipMap.delete(key);
      }
    }
    for (const [key, w] of want) {
      let ent = this.shipMap.get(key);
      if (!ent) {
        ent = this.makeShip(key, w.board, w.placement);
        // A freshly revealed enemy ship surfaces upright, then goes down
        // (sunk) or stays afloat (the end-of-game reveal).
        if (anim && (view.phase === 'placing' || w.board === 'enemy')) ent.dropStart = now;
        if (w.sunk) ent.sinkStart = anim ? now + (w.board === 'enemy' ? 350 : 0) : Infinity;
        ent.sunk = w.sunk;
      } else if (w.sunk && !ent.sunk) {
        ent.sunk = true;
        ent.sinkStart = anim ? now + 250 : Infinity;
      } else if (!w.sunk && ent.sunk) {
        ent.sunk = false;
        ent.sinkStart = -1;
      }
      ent.mesh.material = ent.sunk ? this.matSunk : this.ships.material;
      this.updateSlick(ent);
    }

    // Shots: diff the pegs; only the new ones drop in.
    this.syncMarkers(view, anim, now);
    this.known = { player: cloneCells(view.playerCells), enemy: cloneCells(view.enemyCells) };

    if (view.lastAiShot && view.phase === 'battle') {
      const p = this.cellCenter('player', view.lastAiShot.row, view.lastAiShot.col);
      this.lastShotRing.position.set(p.x, WATER_Y + 0.012, p.z);
      this.lastShotRing.visible = true;
    } else {
      this.lastShotRing.visible = false;
    }
    this.stage.wake();
    this.stage.invalidate();
  }

  /** Harbor contents: which ships still wait there, and which one is held. */
  setDock(unplaced: BATTLESHIPShipName[], held: BATTLESHIPShipName | null): void {
    this.dockUnplaced = new Set(unplaced);
    this.heldDock = held;
    for (const [name, mesh] of this.dockShips) mesh.visible = this.dockUnplaced.has(name);
    this.stage.wake();
    this.stage.invalidate();
  }

  /** Placement ghost for a held ship (null hides it). */
  setGhost(g: { placement: BATTLESHIPPlacement; valid: boolean } | null): void {
    if (!g) {
      this.ghost.visible = false;
    } else {
      this.ghost.geometry = this.ships.geometry(g.placement.name, PLAYER_PALETTE);
      this.ghost.material = g.valid ? this.ships.ghostOk : this.ships.ghostBad;
      this.poseOnBoard(this.ghost, 'player', g.placement);
      this.ghost.position.y += 0.1;
      this.ghost.visible = true;
    }
    this.stage.invalidate();
  }

  /** The player's reticle over a cell (null hides it). */
  setTarget(board: BoardId | null, pos: GridPos | null): void {
    if (!pos || !board) {
      this.reticle.visible = false;
    } else {
      const c = this.cellCenter(board, pos.row, pos.col);
      this.reticle.position.set(c.x, WATER_Y + 0.02, c.z);
      this.reticle.visible = true;
    }
    this.stage.wake();
    this.stage.invalidate();
  }

  /** The companion is aiming: a red reticle roams the player's waters. */
  setThinking(on: boolean): void {
    if (!on) {
      this.thinking = null;
      this.aim.visible = false;
    } else if (!this.thinking) {
      const pos = { row: 4, col: 5 };
      const c = this.cellCenter('player', pos.row, pos.col);
      this.thinking = { pos, x: c.x, z: c.z, nextAt: performance.now() + 500 };
      this.aim.position.set(c.x, WATER_Y + 0.02, c.z);
      this.aim.visible = !this.stage.ambientDisabled;
    }
    this.stage.wake();
    this.stage.invalidate();
  }

  /** What is under the pointer: a board cell, a harbor ship, or nothing. */
  pick(clientX: number, clientY: number): FleetPick {
    if (this.phase === 'placing') {
      const dockHit = this.stage.pointerOnPlane(clientX, clientY, new THREE.Plane(new THREE.Vector3(0, 1, 0), -(WATER_Y + 0.15)));
      if (dockHit) {
        for (let i = 0; i < BATTLESHIP_SHIP_NAMES.length; i++) {
          const name = BATTLESHIP_SHIP_NAMES[i];
          if (!this.dockUnplaced.has(name)) continue;
          const size = SHIP_SIZES[name];
          if (
            dockHit.x >= DOCK_LEFT - 0.15 &&
            dockHit.x <= DOCK_LEFT + size + 0.15 &&
            Math.abs(dockHit.z - DOCK_ROW_Z[i]) <= 0.75
          ) {
            return { kind: 'dock', name };
          }
        }
      }
    }
    const hit = this.stage.pointerOnPlane(clientX, clientY, new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y));
    if (!hit) return null;
    for (const board of ['player', 'enemy'] as BoardId[]) {
      if (board === 'enemy' && this.phase !== 'battle') continue;
      const lx = hit.x - this.boardX(board) + N / 2;
      const lz = hit.z + N / 2;
      if (lx >= 0 && lx < N && lz >= 0 && lz < N) {
        return { kind: 'cell', board, row: Math.floor(lz), col: Math.floor(lx) };
      }
    }
    return null;
  }

  /** The player-board cell under a pointer, even when off the grid (clamped). */
  playerCellNear(clientX: number, clientY: number): GridPos | null {
    const hit = this.stage.pointerOnPlane(clientX, clientY, new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y));
    if (!hit) return null;
    const lx = hit.x - this.boardX('player') + N / 2;
    const lz = hit.z + N / 2;
    if (lx < -0.6 || lx > N + 0.6 || lz < -0.6 || lz > N + 0.6) return null;
    return {
      row: THREE.MathUtils.clamp(Math.floor(lz), 0, N - 1),
      col: THREE.MathUtils.clamp(Math.floor(lx), 0, N - 1),
    };
  }

  wake(): void {
    this.stage.wake();
  }

  /** Projected label anchors (container px). */
  anchors(): {
    player: { x: number; y: number };
    enemy: { x: number; y: number };
    dock: Array<{ name: BATTLESHIPShipName; x: number; y: number }>;
  } {
    const rim = (x: number): { x: number; y: number } => this.stage.project(new THREE.Vector3(x, WATER_Y, ROPE + 0.62));
    return {
      player: rim(-TRAY_X - 2),
      enemy: rim(TRAY_X + 2),
      dock: BATTLESHIP_SHIP_NAMES.map((name, i) => ({
        name,
        ...this.stage.project(new THREE.Vector3(DOCK_LEFT + SHIP_SIZES[name] + 0.3, WATER_Y, DOCK_ROW_Z[i])),
      })),
    };
  }

  timing(): TabletopStage['timing'] {
    return this.stage.timing;
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.fx) f.done();
    this.fx = [];
    for (const g of this.slickGeos.values()) g.dispose();
    this.ships.dispose();
    this.stage.dispose();
  }

  // ── Building blocks ────────────────────────────────────────────────────────

  private boardX(board: BoardId): number {
    return board === 'player' ? -TRAY_X : TRAY_X;
  }

  private cellCenter(board: BoardId, row: number, col: number): THREE.Vector3 {
    return new THREE.Vector3(this.boardX(board) + col - N / 2 + 0.5, WATER_Y, row - N / 2 + 0.5);
  }

  /** Place an object at a placement's centre with its yaw (length along +x). */
  private poseOnBoard(obj: THREE.Object3D, board: BoardId, p: BATTLESHIPPlacement): void {
    const cells = placementCells(p);
    const a = this.cellCenter(board, cells[0].row, cells[0].col);
    const b = this.cellCenter(board, cells[cells.length - 1].row, cells[cells.length - 1].col);
    obj.position.set((a.x + b.x) / 2, WATER_Y + DRAFT, (a.z + b.z) / 2);
    obj.rotation.set(0, p.horizontal ? 0 : -Math.PI / 2, 0);
  }

  private makeShip(key: string, board: BoardId, placement: BATTLESHIPPlacement): ShipEntry {
    const outer = new THREE.Group();
    const tilt = new THREE.Group();
    const deck = new THREE.Group();
    const palette = board === 'player' ? PLAYER_PALETTE : ENEMY_PALETTE;
    const mesh = new THREE.Mesh(this.ships.geometry(placement.name, palette), this.ships.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    tilt.add(mesh, deck);
    outer.add(tilt);
    this.poseOnBoard(outer, board, placement);
    this.shipRoot.add(outer);
    const ent: ShipEntry = {
      key,
      board,
      placement,
      outer,
      mesh,
      tilt,
      deck,
      slick: null,
      sunk: false,
      sinkStart: -1,
      dropStart: -1,
      phase: hash(placement.row, placement.col, placement.name.length) * Math.PI * 2,
    };
    this.shipMap.set(key, ent);
    return ent;
  }

  private updateSlick(ent: ShipEntry): void {
    if (ent.sunk && !ent.slick) {
      const size = SHIP_SIZES[ent.placement.name];
      let geo = this.slickGeos.get(size);
      if (!geo) {
        geo = new THREE.ShapeGeometry(roundedRect(-size / 2 - 0.05, -0.42, size + 0.1, 0.84, 0.4), 6);
        this.slickGeos.set(size, geo);
      }
      const slick = new THREE.Mesh(geo, this.matSlick);
      slick.rotation.x = -Math.PI / 2;
      slick.position.y = WATER_Y + 0.006 - (WATER_Y + DRAFT);
      ent.outer.add(slick);
      ent.slick = slick;
    } else if (!ent.sunk && ent.slick) {
      ent.outer.remove(ent.slick);
      ent.slick = null;
    }
  }

  private makeReticle(color: number): THREE.Group {
    const own = this.stage.own.bind(this.stage);
    const g = new THREE.Group();
    const tileMat = own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.26, depthWrite: false }));
    const lineMat = own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
    const tile = new THREE.Mesh(own(new THREE.PlaneGeometry(0.94, 0.94)), tileMat);
    tile.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(own(new THREE.RingGeometry(0.27, 0.34, 32)), lineMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    g.add(tile, ring);
    const tickGeo = own(new THREE.PlaneGeometry(0.16, 0.045));
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(tickGeo, lineMat);
      tick.rotation.x = -Math.PI / 2;
      const a = (i * Math.PI) / 2;
      tick.rotation.z = a;
      tick.position.set(Math.cos(a) * 0.41, 0.002, -Math.sin(a) * 0.41);
      g.add(tick);
    }
    g.visible = false;
    g.renderOrder = 3;
    return g;
  }

  private setPhase(phase: 'placing' | 'battle', animate: boolean): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.phaseStart = animate ? performance.now() : -Infinity;
    if (phase === 'placing') {
      this.known = { player: null, enemy: null };
      this.reticle.visible = false;
      this.lastShotRing.visible = false;
    } else {
      this.ghost.visible = false;
    }
    this.applyPhasePose(performance.now());
  }

  /** Pier and companion's area swap: the incoming one rises out of the water. */
  private applyPhasePose(now: number): boolean {
    const t = THREE.MathUtils.clamp((now - this.phaseStart) / 650, 0, 1);
    const e = easeOut(t);
    const showDock = this.phase === 'placing';
    this.dock.visible = showDock;
    this.enemyTray.visible = !showDock;
    const incoming = showDock ? this.dock : this.enemyTray;
    incoming.position.y = -0.8 * (1 - e);
    // The companion's area is drawn on the water too: it fades in with its floats.
    this.sea.setPatchStrength(1, showDock ? 0 : e);
    return t < 1;
  }

  // ── Markers ────────────────────────────────────────────────────────────────

  /**
   * Shot markers follow the cells. A peg whose cell, value and host ship are
   * unchanged is kept as it is (mid-drop, flames and all), so a push that
   * arrives during a drop, like the "thinking" push right after a shot, never
   * cuts its animation. Only pegs for newly shot cells drop in.
   */
  private syncMarkers(view: FleetView, anim: boolean, now: number): void {
    const shipOn = (board: BoardId, r: number, c: number): { ent: ShipEntry; seg: number } | null => {
      for (const ent of this.shipMap.values()) {
        if (ent.board !== board) continue;
        const seg = placementCells(ent.placement).findIndex((p) => p.row === r && p.col === c);
        if (seg >= 0) return { ent, seg };
      }
      return null;
    };

    const want = new Set<string>();
    let stagger = 0;
    let lit = false;
    for (const board of view.phase === 'battle' ? (['player', 'enemy'] as BoardId[]) : []) {
      const cells = board === 'player' ? view.playerCells : view.enemyCells;
      const prev = this.known[board];
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const v = cells[r]?.[c];
          if (v !== 'miss' && v !== 'hit' && v !== 'sunk') continue;
          const key = `${board}:${r}:${c}`;
          want.add(key);
          const onShip = v !== 'miss' ? shipOn(board, r, c) : null;
          const cur = this.pegs.get(key);
          if (cur && cur.value === v && cur.host === (onShip?.ent ?? null)) continue;
          if (cur) this.removePeg(key, cur);

          const was = prev?.[r]?.[c];
          const isNew = anim && prev !== null && (was === 'empty' || was === 'ship' || was === undefined);
          const peg = new THREE.Group();
          const pegMesh = new THREE.Mesh(this.pegGeo, v === 'miss' ? this.matPegMiss : this.matPegHit);
          pegMesh.castShadow = true;
          peg.add(pegMesh);
          const entry: PegEntry = { value: v, host: onShip?.ent ?? null, obj: peg, ripple: null, flickers: [] };
          let restY: number;
          if (onShip) {
            // Ride the deck: local ship frame, length along +x.
            const size = SHIP_SIZES[onShip.ent.placement.name];
            const lx = onShip.seg - (size - 1) / 2;
            const deckTop = onShip.ent.placement.name === 'carrier' ? DECK_Y + 0.04 : onShip.ent.placement.name === 'submarine' ? 0.19 : DECK_Y;
            peg.position.set(lx, deckTop, (hash(r, c, 3) - 0.5) * 0.16);
            onShip.ent.deck.add(peg);
            restY = peg.position.y;
          } else {
            const p = this.cellCenter(board, r, c);
            peg.position.set(p.x, WATER_Y, p.z);
            this.markerRoot.add(peg);
            restY = WATER_Y;
            const ripple = new THREE.Mesh(this.rippleGeo, this.matRipple);
            ripple.rotation.x = -Math.PI / 2;
            ripple.position.set(p.x, WATER_Y + 0.004, p.z);
            this.markerRoot.add(ripple);
            entry.ripple = ripple;
          }
          if (v === 'hit' || v === 'sunk') {
            this.addFire(peg, r, c, v === 'sunk', entry.flickers);
            lit = true;
          }
          this.pegs.set(key, entry);
          if (isNew) {
            const delay = stagger;
            stagger += 120;
            peg.position.y = restY + 1.6;
            this.pegDrops.push({ obj: peg, y: restY, start: now, delay });
            const world = new THREE.Vector3();
            const impact = (): void => {
              if (this.pegs.get(key) !== entry) return; // replaced before it landed
              peg.getWorldPosition(world);
              this.splash(world, v !== 'miss');
            };
            this.fx.push({ start: now + delay + 260, dur: 1, update: () => undefined, done: impact });
          }
        }
      }
    }
    for (const [key, e] of [...this.pegs]) if (!want.has(key)) this.removePeg(key, e);
    this.flickers = [...this.pegs.values()].flatMap((e) => e.flickers);
    if (lit) this.poseFlickers(performance.now(), true);
  }

  private removePeg(key: string, e: PegEntry): void {
    e.obj.removeFromParent();
    e.ripple?.removeFromParent();
    this.pegDrops = this.pegDrops.filter((d) => d.obj !== e.obj);
    this.pegs.delete(key);
  }

  /** A little flame + smoke on a hit peg; sunk ships only smoulder. */
  private addFire(peg: THREE.Group, r: number, c: number, smoulder: boolean, out: Flicker[]): void {
    const top = 0.42;
    if (!smoulder) {
      const flame = new THREE.Mesh(this.flameGeo, this.matFlame);
      flame.position.set(0, top - 0.04, 0);
      const core = new THREE.Mesh(this.flameCoreGeo, this.matFlameCore);
      core.position.set(0, top - 0.02, 0);
      peg.add(flame, core);
      out.push({ obj: flame, kind: 'flame', phase: hash(r, c, 1) * 10, base: flame.position.clone() });
      out.push({ obj: core, kind: 'flame', phase: hash(r, c, 2) * 10 + 3, base: core.position.clone() });
    }
    const puffs = smoulder ? 2 : 2;
    for (let i = 0; i < puffs; i++) {
      const puff = new THREE.Mesh(this.puffGeo, this.matSmoke);
      puff.position.set(0, top + 0.1, 0);
      peg.add(puff);
      out.push({ obj: puff, kind: 'smoke', phase: hash(r, c, 5 + i) + i * 0.5, base: puff.position.clone() });
    }
  }

  /** Splash (miss) or burst (hit) at a world point. Transient, self-cleaning. */
  private splash(at: THREE.Vector3, hot: boolean): void {
    if (this.stage.reducedMotion || this.disposed) return;
    const now = performance.now();
    const group = new THREE.Group();
    group.position.copy(at);
    this.stage.scene.add(group);
    const ringMat = new THREE.MeshBasicMaterial({ color: hot ? C_FLAME_CORE : C_FOAM, transparent: true, opacity: 0.9, depthWrite: false });
    const ring = new THREE.Mesh(this.splashGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = hot ? 0.05 : 0.01;
    group.add(ring);
    let flashMat: THREE.MeshBasicMaterial | null = null;
    let flash: THREE.Mesh | null = null;
    if (hot) {
      flashMat = new THREE.MeshBasicMaterial({ color: C_FLAME, transparent: true, opacity: 0.85, depthWrite: false });
      flash = new THREE.Mesh(this.flashGeo, flashMat);
      flash.position.y = 0.35;
      group.add(flash);
    }
    const drops: Array<{ m: THREE.Mesh; v: THREE.Vector3 }> = [];
    const n = hot ? 9 : 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 0.6 + Math.random() * 0.5;
      const m = new THREE.Mesh(this.dropGeo, hot ? this.matDropHot : this.matDrop);
      group.add(m);
      drops.push({ m, v: new THREE.Vector3(Math.cos(a) * sp, 2.6 + Math.random() * 1.2, Math.sin(a) * sp) });
    }
    this.fx.push({
      start: now,
      dur: 900,
      update: (t) => {
        const s = t * 0.9;
        ring.scale.setScalar(1 + easeOut(t) * 3.2);
        ringMat.opacity = 0.9 * (1 - t);
        if (flash && flashMat) {
          flash.scale.setScalar(0.2 + easeOut(Math.min(1, t * 3)) * 1.1);
          flashMat.opacity = 0.85 * Math.max(0, 1 - t * 2.2);
        }
        for (const d of drops) {
          d.m.position.set(d.v.x * s, Math.max(0, d.v.y * s - 4.9 * s * s), d.v.z * s);
          d.m.visible = d.m.position.y > 0 || t < 0.1;
        }
      },
      done: () => {
        this.stage.scene.remove(group);
        ringMat.dispose();
        flashMat?.dispose();
      },
    });
    this.stage.invalidate();
  }

  // ── Animation ──────────────────────────────────────────────────────────────

  /** Game over: ease the areas up so the result card clears the grids. */
  setEnded(ended: boolean): void {
    const to = ended ? 1 : 0;
    if (this.endShift.to === to) return;
    const now = performance.now();
    this.endShift = { from: this.endShiftAt(now), to, start: this.stage.reducedMotion ? -Infinity : now };
    this.stage.invalidate();
  }

  private endShiftAt(now: number): number {
    const t = THREE.MathUtils.clamp((now - this.endShift.start) / 700, 0, 1);
    return this.endShift.from + (this.endShift.to - this.endShift.from) * smooth(t);
  }

  private frameCamera(aspect: number, w: number, h: number): void {
    this.aspect = aspect;
    this.viewW = w;
    this.viewH = h;
    this.applyCamera(performance.now());
    queueMicrotask(() => this.onLayout());
  }

  /**
   * Where the areas sit in the panel with the camera at rest: height from the
   * far markers to the near rope (0 top, 1 bottom) and the widest NDC x (the
   * near corners). Measured, not assumed: at this angle perspective makes the
   * fit non-linear, and a narrow window is width-bound.
   */
  private restExtent(look: THREE.Vector3, elev: number, d: number): { top: number; bottom: number; side: number } {
    const cam = this.stage.camera;
    this.stage.placeCamera(look, elev, d);
    if (cam.view) cam.clearViewOffset();
    cam.updateMatrixWorld();
    // What actually sticks out on the open water: the letter markers on the
    // left, the corner buoys, the number markers on the far side and the
    // area label under the near rope.
    const letters = TRAY_X + MARK + 0.36;
    const buoys = TRAY_X + ROPE + 0.25;
    const buoyTop = WATER_Y + 0.55;
    let top = 1;
    let bottom = 0;
    let side = 0;
    const v = new THREE.Vector3();
    for (const [px, py, pz] of [
      [-letters, WATER_Y, -(MARK + 0.36)],
      [-buoys, buoyTop, -ROPE],
      [buoys, buoyTop, -ROPE],
      [-letters, WATER_Y, N / 2 - 0.5],
      [-buoys, buoyTop, ROPE + 0.25],
      [buoys, buoyTop, ROPE + 0.25],
      [0, WATER_Y, ROPE + 1.0],
    ] as const) {
      v.set(px, py, pz).project(cam);
      const fy = (1 - v.y) / 2;
      top = Math.min(top, fy);
      bottom = Math.max(bottom, fy);
      side = Math.max(side, Math.abs(v.x));
    }
    return { top, bottom, side };
  }

  private applyCamera(now: number): boolean {
    const cam = this.stage.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const elev = THREE.MathUtils.degToRad(ELEVATION);
    const look = new THREE.Vector3(0, 0, 0.6);
    // Both areas edge to edge, then pull back until they fit the room below
    // the sky band (the turn line sits on the sky).
    const top0 = HORIZON_FRAC + 0.035;
    const bottom0 = 0.975;
    const room = bottom0 - top0;
    let d = (TRAY_X + TRAY_HALF + 0.3) / (tanHalf * this.aspect);
    // The near corners are the widest part of the view at this angle, and
    // perspective makes the fit non-linear in d: bisect for the closest
    // distance where both the height and the width fit.
    const sideRoom = 0.97;
    const fits = (e: { top: number; bottom: number; side: number }): boolean =>
      e.bottom - e.top <= room && e.side <= sideRoom;
    let lo = d * 0.5;
    let hi = d * 4;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(this.restExtent(look, elev, mid))) hi = mid;
      else lo = mid;
    }
    d = hi;
    const ext = this.restExtent(look, elev, d);
    // Slide the picture down (a lens shift, so the camera keeps its angle)
    // to open the sky band; spare height goes mostly above the areas (more open sea).
    const span = ext.bottom - ext.top;
    const skyPx = (top0 + Math.max(0, room - span) * 0.7 - ext.top) * this.viewH;
    // Game over: pull back and slide up so row J clears the result card. The
    // sky shift hands over to the lift as the tween runs.
    const shift = this.endShiftAt(now);
    this.shiftShown = shift;
    const end = endFraming(this.viewH, ext.top, ext.bottom, shift);
    this.stage.placeCamera(look, elev, d * end.k);
    const offY = end.liftPx - skyPx * (1 - shift);
    if (Math.abs(offY) > 0.5) cam.setViewOffset(this.viewW, this.viewH, 0, offY, this.viewW, this.viewH);
    else if (cam.view) cam.clearViewOffset();
    // The horizon, haze and sky follow the framing; the haze starts past the far markers.
    this.sea.layout(this.viewH, this.viewW, -TRAY_HALF - 0.5, -TRAY_HALF - 2);
    this.stage.invalidate();
    return now - this.endShift.start < 700;
  }

  private shipPose(ent: ShipEntry, now: number, ambient: boolean): boolean {
    let moving = false;
    let y = 0;
    let roll = 0;
    let pitch = 0;
    if (ent.sinkStart !== -1) {
      const t = ent.sinkStart === Infinity ? 1 : THREE.MathUtils.clamp((now - ent.sinkStart) / 1900, 0, 1);
      if (t < 1) moving = true;
      const e = smooth(t);
      const pose = sunkPose(ent.placement);
      const side = ent.phase > Math.PI ? 1 : -1;
      roll = side * pose.roll * e;
      pitch = pose.pitch * e;
      y = pose.y * e;
    }
    if (ent.dropStart !== -1) {
      const t = THREE.MathUtils.clamp((now - ent.dropStart) / 380, 0, 1);
      if (t < 1) moving = true;
      else ent.dropStart = -1;
      y += (1 - easeOutBack(t)) * 0.7;
    }
    if (ambient && this.stage.ambientAwake(now)) {
      const k = ent.sunk ? 0.4 : 1;
      y += Math.sin(now / 900 + ent.phase) * 0.012 * k;
      roll += Math.sin(now / 1300 + ent.phase * 1.7) * 0.014 * k;
      pitch += Math.sin(now / 1100 + ent.phase * 0.7) * 0.008 * k;
    }
    ent.tilt.position.y = y;
    ent.tilt.rotation.set(roll, 0, pitch);
    return moving;
  }

  private poseFlickers(now: number, force = false): void {
    if (!force && !this.stage.ambientAwake(now)) return;
    for (const f of this.flickers) {
      if (f.kind === 'flame') {
        const s = 0.85 + 0.25 * Math.sin(now / 90 + f.phase) * Math.sin(now / 53 + f.phase * 2);
        f.obj.scale.set(1 + 0.08 * Math.sin(now / 70 + f.phase), s, 1);
      } else {
        const cyc = ((now / 2400 + f.phase) % 1 + 1) % 1;
        f.obj.position.set(f.base.x + Math.sin(cyc * 6 + f.phase) * 0.05, f.base.y + cyc * 0.75, f.base.z);
        const sc = Math.sin(cyc * Math.PI) * (0.7 + cyc * 0.9);
        f.obj.scale.setScalar(Math.max(0.001, sc));
      }
    }
  }

  private tick(now: number, _dt: number): boolean {
    let moving = this.applyPhasePose(now);
    if (this.endShiftAt(now) !== this.shiftShown) {
      this.applyCamera(now);
      moving = true;
      this.onLayout();
    }

    for (const ent of this.shipMap.values()) if (this.shipPose(ent, now, false)) moving = true;

    // Pegs plug in from above with a small bounce.
    if (this.pegDrops.length) {
      const still: typeof this.pegDrops = [];
      for (const d of this.pegDrops) {
        const t = THREE.MathUtils.clamp((now - d.start - d.delay) / 300, 0, 1);
        d.obj.position.y = d.y + (1 - easeOutBack(t)) * 1.6 * (t === 0 ? 1 : 1);
        if (t < 1) still.push(d);
        else d.obj.position.y = d.y;
      }
      this.pegDrops = still;
      if (still.length) moving = true;
    }

    // Held harbor ship floats up.
    for (const [name, mesh] of this.dockShips) {
      const i = BATTLESHIP_SHIP_NAMES.indexOf(name);
      const want = WATER_Y + DRAFT + (this.heldDock === name ? 0.28 : 0);
      const k = this.stage.reducedMotion ? 1 : 0.25;
      mesh.position.y += (want - mesh.position.y) * k;
      if (Math.abs(want - mesh.position.y) > 0.002) moving = true;
      else mesh.position.y = want;
      mesh.position.z = DOCK_ROW_Z[i];
    }

    if (this.fx.length) {
      const live: Fx[] = [];
      for (const f of this.fx) {
        const t = (now - f.start) / f.dur;
        if (t < 0) {
          live.push(f);
          continue;
        }
        if (t >= 1) {
          f.done();
          continue;
        }
        f.update(t);
        live.push(f);
      }
      this.fx = live;
      if (live.length) moving = true;
    }

    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    if (this.reticle.visible) this.reticle.scale.setScalar(this.stage.reducedMotion ? 1 : 0.96 + 0.05 * pulse);
    return moving;
  }

  /** Throttled ambient tier: water, bobbing ships, flames, smoke, the aim. */
  private ambientTick(now: number, dt: number): boolean {
    this.sea.time.value += dt / 1000;
    for (const ent of this.shipMap.values()) this.shipPose(ent, now, true);
    this.poseFlickers(now);
    const th = this.thinking;
    if (th) {
      this.stage.wake();
      if (now > th.nextAt) {
        th.pos = {
          row: THREE.MathUtils.clamp(th.pos.row + Math.round((Math.random() - 0.5) * 6), 0, N - 1),
          col: THREE.MathUtils.clamp(th.pos.col + Math.round((Math.random() - 0.5) * 6), 0, N - 1),
        };
        th.nextAt = now + 700 + Math.random() * 900;
      }
      const c = this.cellCenter('player', th.pos.row, th.pos.col);
      th.x += (c.x - th.x) * 0.2;
      th.z += (c.z - th.z) * 0.2;
      this.aim.position.set(th.x, WATER_Y + 0.02, th.z);
    }
    if (this.reticle.visible) this.reticle.scale.setScalar(0.96 + 0.05 * (0.5 + 0.5 * Math.sin(now / 260)));
    return true;
  }

  // ── Materials and textures ─────────────────────────────────────────────────

  /**
   * One area's marks on the water: a rope ring of yellow and white floats,
   * striped buoys at the corners, and white floating markers with the row
   * letters (left) and column numbers (far side).
   */
  private buildAreaMarks(x: number, parent: THREE.Object3D): void {
    const m = this.marks ?? (this.marks = this.makeMarkResources());

    const rope = new THREE.Group();
    for (const [rx, rz, len, along] of [
      [0, -ROPE, ROPE * 2, 'x'],
      [0, ROPE, ROPE * 2, 'x'],
      [-ROPE, 0, ROPE * 2, 'z'],
      [ROPE, 0, ROPE * 2, 'z'],
    ] as const) {
      const r = new THREE.Mesh(m.ropeGeo, m.ropeMat);
      r.scale.set(len, 1, 1);
      if (along === 'z') r.rotation.y = Math.PI / 2;
      r.position.set(x + rx, WATER_Y + 0.05, rz);
      rope.add(r);
    }
    parent.add(rope);

    // Floats every ~0.42 along the ring, alternating colors.
    const per = 25;
    const floats = new THREE.InstancedMesh(m.floatGeo, m.floatMat, per * 4);
    const mtx = new THREE.Matrix4();
    const col = new THREE.Color();
    let k = 0;
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < per; i++) {
        const t = -ROPE + (i / per) * ROPE * 2;
        const [fx, fz] = side === 0 ? [t, -ROPE] : side === 1 ? [ROPE, t] : side === 2 ? [-t, ROPE] : [-ROPE, -t];
        mtx.makeTranslation(x + fx, WATER_Y + 0.05, fz);
        floats.setMatrixAt(k, mtx);
        floats.setColorAt(k, col.setHex(k % 2 ? C_FLOAT_ALT : C_FLOAT));
        k++;
      }
    }
    floats.castShadow = true;
    parent.add(floats);

    // Corner buoys.
    for (const [bx, bz] of [
      [-ROPE, -ROPE],
      [ROPE, -ROPE],
      [-ROPE, ROPE],
      [ROPE, ROPE],
    ]) {
      const b = new THREE.Group();
      b.position.set(x + bx, WATER_Y, bz);
      const body = new THREE.Mesh(m.buoyGeo, m.buoyMat);
      const band = new THREE.Mesh(m.bandGeo, m.bandMat);
      body.castShadow = true;
      b.add(body, band);
      parent.add(b);
    }

    // Floating markers: white discs, letters and numbers on a shared texture.
    const discs = new THREE.InstancedMesh(m.markGeo, m.markMat, N * 2);
    for (let i = 0; i < N; i++) {
      const at = i - N / 2 + 0.5;
      discs.setMatrixAt(i, mtx.makeTranslation(x + at, WATER_Y + 0.04, -MARK));
      discs.setMatrixAt(N + i, mtx.makeTranslation(x - MARK, WATER_Y + 0.04, at));
    }
    discs.receiveShadow = true;
    parent.add(discs);
    const labels = new THREE.Mesh(m.labelGeo, m.labelMat);
    labels.rotation.x = -Math.PI / 2;
    labels.position.set(x, WATER_Y + 0.091, 0);
    parent.add(labels);
  }

  private marks: ReturnType<FleetScene['makeMarkResources']> | null = null;

  private makeMarkResources() {
    const own = this.stage.own.bind(this.stage);
    const ropeGeo = own(new THREE.BoxGeometry(1, 0.035, 0.035));
    const floatGeo = own(new THREE.SphereGeometry(0.11, 10, 6));
    floatGeo.scale(1, 0.72, 1);
    const buoyGeo = own(
      new THREE.LatheGeometry(
        [
          [0, -0.2],
          [0.2, -0.2],
          [0.22, 0.05],
          [0.17, 0.32],
          [0.07, 0.5],
          [0, 0.53],
        ].map(([a, b]) => new THREE.Vector2(a, b)),
        12,
      ),
    );
    const bandGeo = own(new THREE.CylinderGeometry(0.205, 0.215, 0.1, 12, 1, true));
    bandGeo.translate(0, 0.16, 0);
    const markGeo = own(new THREE.CylinderGeometry(0.33, 0.35, 0.1, 18));
    const labelGeo = own(new THREE.PlaneGeometry(TRAY_HALF * 2, TRAY_HALF * 2));
    const labelTex = own(this.makeMarkerTexture());
    return {
      ropeGeo,
      ropeMat: own(new THREE.MeshStandardMaterial({ color: C_ROPE, roughness: 0.9 })),
      floatGeo,
      floatMat: own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 })),
      buoyGeo,
      buoyMat: own(new THREE.MeshStandardMaterial({ color: C_BUOY, roughness: 0.5 })),
      bandGeo,
      bandMat: own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide })),
      markGeo,
      markMat: own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 })),
      labelGeo,
      labelMat: own(new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false })),
    };
  }

  /** Letters and numbers that sit on the floating markers (one texture, both areas). */
  private makeMarkerTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const size = canvas.width;
      ctx.fillStyle = C_MARK_INK;
      ctx.font = `700 ${Math.round(size * 0.05)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const toU = (v: number): number => ((v + TRAY_HALF) / (TRAY_HALF * 2)) * size;
      // Glyphs fill most of the marker disc; wide ones ("10") squeeze to fit.
      const maxW = (0.56 / (TRAY_HALF * 2)) * size;
      const put = (text: string, x: number, y: number): void => {
        const w = ctx.measureText(text).width;
        const sx = w > maxW ? maxW / w : 1;
        ctx.save();
        ctx.translate(x, y + 1);
        ctx.scale(sx, 1);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      };
      for (let i = 0; i < N; i++) {
        const at = i - N / 2 + 0.5;
        put(String(i + 1), toU(at), toU(-MARK));
        put(ROW_LETTERS[i], toU(-MARK), toU(at));
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  /** The setup harbor: a plank walkway on pilings with finger piers between five berths. */
  private buildPier(): void {
    const own = this.stage.own.bind(this.stage);
    const planks = own(
      makeWoodTexture({ base: [214, 178, 132], stripe: [196, 158, 112], streak: [168, 130, 88], seed: 53, frequency: 0.08 }),
    );
    planks.repeat.set(0.3, 0.3);
    const deckMat = own(new THREE.MeshStandardMaterial({ map: planks, roughness: 0.7 }));
    const postMat = own(new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.8 }));
    const deckT = 0.14;
    const walkX = DOCK_LEFT + 7.9;
    const walk = new THREE.Mesh(own(new THREE.BoxGeometry(1.3, deckT, ROPE * 2 + 0.4)), deckMat);
    walk.position.set(walkX, PIER_TOP - deckT / 2, 0);
    walk.castShadow = true;
    walk.receiveShadow = true;
    this.dock.add(walk);
    const fingerLen = walkX - 0.65 - (DOCK_LEFT - 0.45);
    const fingerGeo = own(new THREE.BoxGeometry(fingerLen, deckT * 0.8, 0.3));
    const fingerZ = [-5.25, -3.15, -1.05, 1.05, 3.15, 5.25];
    const posts: Array<[number, number]> = [];
    for (const z of fingerZ) {
      const f = new THREE.Mesh(fingerGeo, deckMat);
      f.position.set(DOCK_LEFT - 0.45 + fingerLen / 2, PIER_TOP - deckT * 0.45, z);
      f.castShadow = true;
      f.receiveShadow = true;
      this.dock.add(f);
      posts.push([DOCK_LEFT - 0.35, z]);
    }
    for (let z = -ROPE; z <= ROPE + 0.01; z += (ROPE * 2) / 5) posts.push([walkX + 0.55, z]);
    const postGeo = own(new THREE.CylinderGeometry(0.1, 0.11, 1.1, 8));
    const pilings = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    const mtx = new THREE.Matrix4();
    posts.forEach(([px, pz], i) => pilings.setMatrixAt(i, mtx.makeTranslation(px, PIER_TOP - 0.45, pz)));
    pilings.castShadow = true;
    this.dock.add(pilings);
  }
}

/** Peg: a short shaft with a rounded head, standing on y = 0. */
function pegGeometry(): THREE.LatheGeometry {
  const pts = [
    [0, -0.02],
    [0.07, -0.02],
    [0.07, 0.2],
    [0.1, 0.22],
    [0.12, 0.27],
    [0.11, 0.32],
    [0.07, 0.355],
    [0, 0.365],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 16);
}

function samePlacement(a: BATTLESHIPPlacement, b: BATTLESHIPPlacement): boolean {
  return a.name === b.name && a.row === b.row && a.col === b.col && a.horizontal === b.horizontal;
}

function cloneCells(cells: BATTLESHIPCell[][]): BATTLESHIPCell[][] {
  return cells.map((r) => r.slice());
}
