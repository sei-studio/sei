/**
 * FleetScene — the 3D Fleet Battle table (three.js, no React).
 *
 * Two walnut sea trays sit side by side on the chess table (shared
 * TabletopStage): the player's waters on the left with their toy fleet, the
 * companion's waters on the right. The water is one stylized animated surface
 * per tray (a patched MeshStandardMaterial: rolling color bands, soft crests,
 * crisp grid lines drawn in the shader), so the grid stays readable while it
 * moves, and ships still cast shadows onto it.
 *
 * Shots are pegs, the same on both boards: white for a miss (with a splash
 * when it lands), red with a little flame and smoke for a hit (with a burst).
 * A sunk ship lists and settles low in the water over a dark slick and keeps
 * smoking; the companion's sunk ships are revealed the same way, so nothing
 * that was sunk ever disappears.
 *
 * During fleet setup the right tray is a wooden harbor: the five ships wait
 * in slots and are dragged (or clicked, or moved by keyboard) onto the left
 * tray; a ghost shows where a held ship would go, green when it fits.
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
import { TabletopStage, applyLift, easeOut, easeOutBack, endFraming, smooth } from '../../tabletop/TabletopStage';
import { roundedRect } from '../../connect4/three/Connect4Scene';
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
const TRAY_X = 6.35;
const RIM = 0.78;
const TRAY_HALF = N / 2 + RIM;
const BASE_TOP = 0.24;
const RIM_TOP = 0.44;
const WATER_Y = 0.33;
const DOCK_TOP = 0.3;
const DOCK_HALF_X = 3.6;
const DOCK_HALF_Z = 5.6;
const DOCK_LEFT = TRAY_X - 3.15;
const DOCK_ROW_Z = [-4.2, -2.1, 0, 2.1, 4.2];
const DRAFT = 0.02; // ships float this far above their waterline origin

// Art palette.
const C_DEEP = 0x1c5a73;
const C_SHALLOW = 0x3f9db2;
const C_LINE = 0xe4f6f8;
const C_FOAM = 0xeafcff;
const C_PEG_MISS = 0xf3efe6;
const C_PEG_HIT = 0xe0453a;
const C_FLAME = 0xff7a2a;
const C_FLAME_CORE = 0xffd86b;
const C_SMOKE = 0x8a837c;
const C_RETICLE = 0xffe3a3;
const C_AIM = 0xff8a7a;
const C_SLICK = 0x0b2531;

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

function hash(r: number, c: number, salt = 0): number {
  const x = Math.sin((r + 1) * 12.9898 + (c + 1) * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

export class FleetScene {
  private readonly stage: TabletopStage;
  private readonly ships: ShipLibrary;
  private readonly waterTime = { value: 0 };

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
  /** 0..1: the game is over, the trays slide up to make room for the result. */
  private endShift = { from: 0, to: 0, start: -Infinity };
  private fx: Fx[] = [];
  private flickers: Flicker[] = [];
  private pegDrops: Array<{ obj: THREE.Object3D; y: number; start: number; delay: number }> = [];
  private heldDock: BATTLESHIPShipName | null = null;
  private thinking: { pos: GridPos; x: number; z: number; nextAt: number } | null = null;
  private dockUnplaced = new Set<BATTLESHIPShipName>(BATTLESHIP_SHIP_NAMES);

  /** Called after the camera is re-framed (projected anchors moved). */
  onLayout: () => void = () => undefined;

  constructor(container: HTMLElement) {
    this.stage = new TabletopStage(container, {
      shadowMapSize: 2048,
      // Water, bob and flames read fine at 15 fps, and the scene redraw is the cost.
      ambientFps: 15,
      ambientSleepMs: 15_000,
      shadowExtent: 13,
      keyPosition: [6, 14, 9],
    });
    const own = this.stage.own.bind(this.stage);
    const scene = this.stage.scene;
    this.ships = new ShipLibrary();

    // ── Trays ──
    const walnut = own(
      makeWoodTexture({ base: [82, 50, 27], stripe: [58, 33, 17], streak: [40, 22, 11], seed: 29, frequency: 0.06 }),
    );
    walnut.repeat.set(0.12, 0.12);
    const walnutMat = own(new THREE.MeshStandardMaterial({ map: walnut, roughness: 0.5, metalness: 0.02 }));
    const baseGeo = own(new THREE.BoxGeometry(TRAY_HALF * 2, BASE_TOP, TRAY_HALF * 2));
    const rimShape = roundedRect(-TRAY_HALF, -TRAY_HALF, TRAY_HALF * 2, TRAY_HALF * 2, 0.35);
    const hole = new THREE.Path();
    hole.moveTo(-N / 2, -N / 2);
    hole.lineTo(N / 2, -N / 2);
    hole.lineTo(N / 2, N / 2);
    hole.lineTo(-N / 2, N / 2);
    hole.lineTo(-N / 2, -N / 2);
    rimShape.holes.push(hole);
    const rimGeo = own(
      new THREE.ExtrudeGeometry(rimShape, {
        depth: RIM_TOP - BASE_TOP - 0.06,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.03,
        bevelSegments: 2,
        curveSegments: 8,
      }),
    );
    rimGeo.rotateX(-Math.PI / 2);
    rimGeo.translate(0, BASE_TOP + 0.03, 0);
    const waterGeo = own(new THREE.PlaneGeometry(N, N, 1, 1));
    const coordTex = own(this.makeCoordTexture());
    const coordMat = own(new THREE.MeshBasicMaterial({ map: coordTex, transparent: true, depthWrite: false }));
    const coordGeo = own(new THREE.PlaneGeometry(TRAY_HALF * 2, TRAY_HALF * 2));

    const makeTray = (x: number, parent: THREE.Object3D): void => {
      const base = new THREE.Mesh(baseGeo, walnutMat);
      base.position.set(x, BASE_TOP / 2, 0);
      base.receiveShadow = true;
      base.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, walnutMat);
      rim.position.x = x;
      rim.castShadow = true;
      rim.receiveShadow = true;
      const water = new THREE.Mesh(waterGeo, this.makeWaterMaterial());
      water.rotation.x = -Math.PI / 2;
      water.position.set(x, WATER_Y, 0);
      water.receiveShadow = true;
      const coords = new THREE.Mesh(coordGeo, coordMat);
      coords.rotation.x = -Math.PI / 2;
      coords.position.set(x, RIM_TOP + 0.004, 0);
      parent.add(base, rim, water, coords);
    };
    makeTray(-TRAY_X, scene);
    makeTray(TRAY_X, this.enemyTray);
    scene.add(this.enemyTray);

    // ── Harbor (fleet setup): a light wood board with five slots ──
    const maple = own(
      makeWoodTexture({ base: [168, 122, 76], stripe: [146, 104, 62], streak: [118, 82, 46], seed: 53, frequency: 0.08 }),
    );
    maple.repeat.set(0.16, 0.16);
    const mapleMat = own(new THREE.MeshStandardMaterial({ map: maple, roughness: 0.55, metalness: 0.02 }));
    const dockShape = roundedRect(-DOCK_HALF_X, -DOCK_HALF_Z, DOCK_HALF_X * 2, DOCK_HALF_Z * 2, 0.35);
    const dockGeo = own(
      new THREE.ExtrudeGeometry(dockShape, {
        depth: DOCK_TOP - 0.06,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.03,
        bevelSegments: 2,
        curveSegments: 8,
      }),
    );
    dockGeo.rotateX(-Math.PI / 2);
    dockGeo.translate(0, 0.03, 0);
    const dockBoard = new THREE.Mesh(dockGeo, mapleMat);
    dockBoard.position.x = TRAY_X;
    dockBoard.castShadow = true;
    dockBoard.receiveShadow = true;
    this.dock.add(dockBoard);
    // Each slot: a pale routed lip around a dark recess, a little larger than
    // the ship so it still reads with the ship sitting in it.
    const slotMat = own(new THREE.MeshStandardMaterial({ color: 0x4a2c17, roughness: 0.85 }));
    const lipMat = own(new THREE.MeshStandardMaterial({ color: 0xe2c193, roughness: 0.6 }));
    this.matDockShip = this.ships.material;
    for (let i = 0; i < BATTLESHIP_SHIP_NAMES.length; i++) {
      const name = BATTLESHIP_SHIP_NAMES[i];
      const size = SHIP_SIZES[name];
      const lipGeo = own(new THREE.ShapeGeometry(roundedRect(-0.24, -0.6, size + 0.48, 1.2, 0.42), 6));
      const lip = new THREE.Mesh(lipGeo, lipMat);
      lip.rotation.x = -Math.PI / 2;
      lip.position.set(DOCK_LEFT, DOCK_TOP + 0.002, DOCK_ROW_Z[i]);
      lip.receiveShadow = true;
      this.dock.add(lip);
      const slotGeo = own(new THREE.ShapeGeometry(roundedRect(-0.16, -0.52, size + 0.32, 1.04, 0.36), 6));
      const slot = new THREE.Mesh(slotGeo, slotMat);
      slot.rotation.x = -Math.PI / 2;
      slot.position.set(DOCK_LEFT, DOCK_TOP + 0.004, DOCK_ROW_Z[i]);
      slot.receiveShadow = true;
      this.dock.add(slot);
      const ship = new THREE.Mesh(this.ships.geometry(name, PLAYER_PALETTE), this.matDockShip);
      ship.position.set(DOCK_LEFT + size / 2, DOCK_TOP + 0.13, DOCK_ROW_Z[i]);
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

    // Shots: rebuild pegs, animate the ones that are new since last time.
    this.rebuildMarkers(view, anim, now);
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
      const dockHit = this.stage.pointerOnPlane(clientX, clientY, new THREE.Plane(new THREE.Vector3(0, 1, 0), -(DOCK_TOP + 0.15)));
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
    const rim = (x: number): { x: number; y: number } => this.stage.project(new THREE.Vector3(x, RIM_TOP, N / 2 + RIM / 2));
    return {
      player: rim(-TRAY_X - 2),
      enemy: rim(TRAY_X + 2),
      dock: BATTLESHIP_SHIP_NAMES.map((name, i) => ({
        name,
        ...this.stage.project(new THREE.Vector3(DOCK_LEFT + SHIP_SIZES[name] + 0.3, DOCK_TOP, DOCK_ROW_Z[i])),
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

  /** Harbor and enemy tray swap: the incoming one rises from the table. */
  private applyPhasePose(now: number): boolean {
    const t = THREE.MathUtils.clamp((now - this.phaseStart) / 650, 0, 1);
    const e = easeOut(t);
    const showDock = this.phase === 'placing';
    this.dock.visible = showDock;
    this.enemyTray.visible = !showDock;
    const incoming = showDock ? this.dock : this.enemyTray;
    incoming.position.y = -0.8 * (1 - e);
    return t < 1;
  }

  // ── Markers ────────────────────────────────────────────────────────────────

  private rebuildMarkers(view: FleetView, anim: boolean, now: number): void {
    for (const child of [...this.markerRoot.children]) this.markerRoot.remove(child);
    for (const ent of this.shipMap.values()) for (const child of [...ent.deck.children]) ent.deck.remove(child);
    this.flickers = [];
    this.pegDrops = this.pegDrops.filter(() => false);
    if (view.phase !== 'battle') return;

    const shipOn = (board: BoardId, r: number, c: number): { ent: ShipEntry; seg: number } | null => {
      for (const ent of this.shipMap.values()) {
        if (ent.board !== board) continue;
        const seg = placementCells(ent.placement).findIndex((p) => p.row === r && p.col === c);
        if (seg >= 0) return { ent, seg };
      }
      return null;
    };

    let stagger = 0;
    for (const board of ['player', 'enemy'] as BoardId[]) {
      const cells = board === 'player' ? view.playerCells : view.enemyCells;
      const prev = this.known[board];
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const v = cells[r]?.[c];
          if (v !== 'miss' && v !== 'hit' && v !== 'sunk') continue;
          const was = prev?.[r]?.[c];
          const isNew = anim && prev !== null && (was === 'empty' || was === 'ship' || was === undefined);
          const onShip = v !== 'miss' ? shipOn(board, r, c) : null;
          const peg = new THREE.Group();
          const pegMesh = new THREE.Mesh(this.pegGeo, v === 'miss' ? this.matPegMiss : this.matPegHit);
          pegMesh.castShadow = true;
          peg.add(pegMesh);
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
          }
          if (v === 'hit' || v === 'sunk') this.addFire(peg, r, c, v === 'sunk');
          if (isNew) {
            const delay = stagger;
            stagger += 120;
            peg.position.y = restY + 1.6;
            this.pegDrops.push({ obj: peg, y: restY, start: now, delay });
            const world = new THREE.Vector3();
            const impact = (): void => {
              peg.getWorldPosition(world);
              if (v === 'miss') this.splash(world, false);
              else this.splash(world, true);
            };
            this.fx.push({ start: now + delay + 260, dur: 1, update: () => undefined, done: impact });
          }
        }
      }
    }
  }

  /** A little flame + smoke on a hit peg; sunk ships only smoulder. */
  private addFire(peg: THREE.Group, r: number, c: number, smoulder: boolean): void {
    const top = 0.42;
    if (!smoulder) {
      const flame = new THREE.Mesh(this.flameGeo, this.matFlame);
      flame.position.set(0, top - 0.04, 0);
      const core = new THREE.Mesh(this.flameCoreGeo, this.matFlameCore);
      core.position.set(0, top - 0.02, 0);
      peg.add(flame, core);
      this.flickers.push({ obj: flame, kind: 'flame', phase: hash(r, c, 1) * 10, base: flame.position.clone() });
      this.flickers.push({ obj: core, kind: 'flame', phase: hash(r, c, 2) * 10 + 3, base: core.position.clone() });
    }
    const puffs = smoulder ? 2 : 2;
    for (let i = 0; i < puffs; i++) {
      const puff = new THREE.Mesh(this.puffGeo, this.matSmoke);
      puff.position.set(0, top + 0.1, 0);
      peg.add(puff);
      this.flickers.push({ obj: puff, kind: 'smoke', phase: hash(r, c, 5 + i) + i * 0.5, base: puff.position.clone() });
    }
    this.poseFlickers(performance.now(), true);
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

  /** Game over: ease the trays up so the result card clears the grids. */
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
   * Where the trays sit in the panel height (0 top, 1 bottom) with the camera
   * at rest: the far rims (column numbers) to the near outer edges. Measured,
   * not assumed, because a narrow window is width-bound and the trays then
   * fill more of the height than in a wide one.
   */
  private restExtent(look: THREE.Vector3, elev: number, d: number): { top: number; bottom: number } {
    const cam = this.stage.camera;
    this.stage.placeCamera(look, elev, d);
    if (cam.view) cam.clearViewOffset();
    cam.updateMatrixWorld();
    const x = TRAY_X + TRAY_HALF;
    let top = 1;
    let bottom = 0;
    const v = new THREE.Vector3();
    for (const [px, py, pz] of [
      [-x, RIM_TOP, -TRAY_HALF],
      [x, RIM_TOP, -TRAY_HALF],
      [-x, 0, TRAY_HALF],
      [x, 0, TRAY_HALF],
    ] as const) {
      const fy = (1 - v.set(px, py, pz).project(cam).y) / 2;
      top = Math.min(top, fy);
      bottom = Math.max(bottom, fy);
    }
    return { top, bottom };
  }

  private applyCamera(now: number): boolean {
    const aspect = this.aspect;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov / 2));
    const elev = THREE.MathUtils.degToRad(57);
    // Horizontal: both trays edge to edge; vertical: the tray depth plus room
    // for the turn line and the board labels above the far rims.
    const horizontal = (TRAY_X + TRAY_HALF + 0.3) / (tanHalf * aspect);
    const vertical = 6.1 / tanHalf;
    // Game over: pull back and slide up so row J clears the result card.
    const shift = this.endShiftAt(now);
    this.shiftShown = shift;
    const look = new THREE.Vector3(0, 0, 0.75);
    const rest = Math.max(horizontal, vertical);
    const ext = shift > 0 ? this.restExtent(look, elev, rest) : { top: 0, bottom: 1 };
    const end = endFraming(this.viewH, ext.top, ext.bottom, shift);
    const d = rest * end.k;
    this.stage.placeCamera(look, elev, d);
    applyLift(this.stage.camera, this.viewW, this.viewH, end.liftPx);
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
      const want = DOCK_TOP + 0.13 + (this.heldDock === name ? 0.28 : 0);
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
    this.waterTime.value += dt / 1000;
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

  /** Stylized water: color bands, soft crests and shader-drawn grid lines. */
  private makeWaterMaterial(): THREE.MeshStandardMaterial {
    const mat = this.stage.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.0 }));
    const uniforms = {
      uTime: this.waterTime,
      uDeep: { value: new THREE.Color(C_DEEP) },
      uShallow: { value: new THREE.Color(C_SHALLOW) },
      uLine: { value: new THREE.Color(C_LINE) },
      uFoam: { value: new THREE.Color(C_FOAM) },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGridUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGridUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec2 vGridUv;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uLine;
uniform vec3 uFoam;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  vec2 g = vGridUv * 10.0;
  float t = uTime;
  float w1 = sin(g.x * 0.9 + t * 0.55 + sin(g.y * 0.6 + t * 0.3) * 1.4);
  float w2 = sin(g.y * 1.15 - t * 0.45 + sin(g.x * 0.7 - t * 0.25) * 1.2);
  float w = 0.5 + 0.25 * (w1 + w2);
  vec3 col = mix(uDeep, uShallow, 0.25 + 0.55 * w);
  float band = sin(g.x * 1.1 + g.y * 2.3 + t * 0.9 + w1 * 1.3);
  col = mix(col, uFoam, smoothstep(0.96, 1.0, band) * 0.1 * (0.5 + 0.5 * w2));
  float chk = mod(floor(g.x) + floor(g.y), 2.0);
  col *= 1.0 - chk * 0.045;
  vec2 f = abs(fract(g) - 0.5);
  vec2 fw = fwidth(g);
  vec2 l = smoothstep(0.5 - fw * 1.6, 0.5 - fw * 0.3, f);
  float line = max(l.x, l.y);
  col = mix(col, uLine, line * 0.5);
  vec2 e = min(vGridUv, 1.0 - vGridUv) * 10.0;
  col *= mix(0.72, 1.0, smoothstep(0.0, 0.7, min(e.x, e.y)));
  diffuseColor.rgb = col;
}`,
        );
    };
    mat.customProgramCacheKey = () => 'fleet-water-v2';
    return mat;
  }

  /** Row letters on the left rim, column numbers on the far rim. */
  private makeCoordTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const size = canvas.width;
      ctx.fillStyle = 'rgba(238, 224, 192, 0.82)';
      ctx.font = `600 ${Math.round(size * 0.034)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const toU = (x: number): number => ((x + TRAY_HALF) / (TRAY_HALF * 2)) * size;
      const rimMid = N / 2 + RIM / 2;
      for (let i = 0; i < N; i++) {
        const at = i - N / 2 + 0.5;
        ctx.fillText(String(i + 1), toU(at), toU(-rimMid));
        ctx.fillText(ROW_LETTERS[i], toU(-rimMid), toU(at));
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
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
