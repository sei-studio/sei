/**
 * Connect4Scene — the 3D Four in a Row table (three.js, no React).
 *
 * Same family as the chess table (shared TabletopStage: room, lights, wood
 * table, on-demand rendering): an upright painted-wood frame stands on walnut
 * feet in the middle of the table, 42 holes over a slot the discs fall
 * through. Each side's discs wait in short stacks on the table (player left,
 * companion right) and shrink as the game goes on.
 *
 * Driven imperatively by Connect4Board3D.tsx:
 *   setBoard       new discs drop in from above the frame and bounce to rest;
 *                  a new game lets every disc fall out through the bottom;
 *   setHover       the column glows, a ghost disc floats above it and a faint
 *                  disc marks the landing hole;
 *   setThinking    the companion's ghost disc drifts over the columns;
 *   setWin         winning discs glow and pulse inside gold rings;
 *   columnAtPointer  raycast a pointer to a column (or null).
 *
 * Colors are 3D art-asset values (literal by design, like the chess scene).
 */

import * as THREE from 'three';
import type { CONNECT4Color } from '@shared/connect4Ipc';
import { makeWoodTexture } from '../../chess/three/woodTexture';
import { TabletopStage, applyLift, easeOutBack, endFraming, smooth } from '../../tabletop/TabletopStage';
import { COLS, ROWS, discsInHand, type Board, type Cell } from '../connect4Util';

// ── Layout (1 unit = one column) ──────────────────────────────────────────
const DISC_R = 0.47;
const DISC_T = 0.2;
const HOLE_R = 0.41;
const BASE_Y = 0.36; // panel bottom above the table (the feet lift it)
const ROW0_Y = BASE_Y + 0.62; // centre of the bottom row
const PANEL_TOP = ROW0_Y + (ROWS - 1) + 0.71;
const PANEL_HALF_W = 3.75;
const PANEL_IN = 0.12; // inner face of each panel (|z|)
const PANEL_DEPTH = 0.1; // extrude depth before bevel
const BEVEL = 0.03;
const FRONT_Z = PANEL_IN + PANEL_DEPTH + 2 * BEVEL; // outer face of the front panel
const GHOST_Y = PANEL_TOP + 0.64;
/** Where the frame (feet included) sits in the panel height at rest, top and bottom. */
const FRAME_TOP = 0.18;
const FRAME_BOTTOM = 0.88;
const PILE_X = 6.0;
const PILE_Z = 1.35;
const GRAVITY = 40; // units / s^2
const BOUNCE = 0.3;

const C_RED = 0xd8473b;
const C_YELLOW = 0xf2b430;
const C_RING = 0xffd56b;
const C_GLOW = 0xfff3d6;

interface Disc {
  mesh: THREE.Mesh;
  color: CONNECT4Color;
  cell: Cell;
  /** Falling state (null at rest). */
  fall: { y: number; v: number; target: number; delay: number; bounces: number } | null;
}

interface Exit {
  mesh: THREE.Mesh;
  v: number;
  delay: number;
}

export function cellX(c: number): number {
  return c - (COLS - 1) / 2;
}

export function cellY(r: number): number {
  return ROW0_Y + (ROWS - 1 - r);
}

export class Connect4Scene {
  private readonly stage: TabletopStage;
  private readonly discGeo: THREE.LatheGeometry;
  private readonly mats: Record<CONNECT4Color, THREE.MeshStandardMaterial>;
  private readonly glowMats: Record<CONNECT4Color, THREE.MeshStandardMaterial>;
  private readonly ghostMats: Record<CONNECT4Color, THREE.MeshStandardMaterial>;
  private readonly landMats: Record<CONNECT4Color, THREE.MeshStandardMaterial>;
  private readonly piles: Record<CONNECT4Color, THREE.InstancedMesh>;
  private readonly discRoot = new THREE.Group();
  private readonly column: THREE.Mesh;
  private readonly ghost: THREE.Mesh;
  private readonly landing: THREE.Mesh;
  private readonly thinkGhost: THREE.Mesh;
  private readonly ringRoot = new THREE.Group();
  private readonly ringGeo: THREE.TorusGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly pickPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -FRONT_Z);

  private discs = new Map<string, Disc>();
  private aspect = 1;
  private viewW = 1;
  private viewH = 1;
  /** endShift value the camera last showed; the tick re-frames until it lands. */
  private shiftShown = 0;
  /** 0..1: the game is over, the frame rises so the result card clears it. */
  private endShift = { from: 0, to: 0, start: -Infinity };
  private exits: Exit[] = [];
  private playerColor: CONNECT4Color = 'r';
  private hoverCol: number | null = null;
  private hoverX = 0;
  private thinking: { color: CONNECT4Color; col: number; x: number; nextAt: number } | null = null;
  private win: { cells: Cell[]; startedAt: number } | null = null;
  private columnFade = 0; // 0..1 highlight strength (eased)
  private inHand: Record<CONNECT4Color, number> = { r: 21, y: 21 };
  /** Called after the camera is re-framed (anchors moved). */
  onLayout: () => void = () => undefined;

  constructor(container: HTMLElement) {
    this.stage = new TabletopStage(container, { shadowExtent: 9, keyPosition: [5, 12, 9] });
    const own = this.stage.own.bind(this.stage);
    const scene = this.stage.scene;

    // ── Frame: painted teal wood panels with 42 holes ──
    const paint = own(
      makeWoodTexture({ base: [58, 112, 124], stripe: [48, 98, 110], streak: [36, 80, 92], seed: 41, frequency: 0.05 }),
    );
    paint.repeat.set(0.16, 0.16);
    const panelMat = own(new THREE.MeshStandardMaterial({ map: paint, roughness: 0.46, metalness: 0.02 }));
    const walnut = own(
      makeWoodTexture({ base: [82, 50, 27], stripe: [58, 33, 17], streak: [40, 22, 11], seed: 29, frequency: 0.06 }),
    );
    walnut.repeat.set(0.5, 0.5);
    const walnutMat = own(new THREE.MeshStandardMaterial({ map: walnut, roughness: 0.5, metalness: 0.02 }));

    const shape = roundedRect(-PANEL_HALF_W, BASE_Y, PANEL_HALF_W * 2, PANEL_TOP - BASE_Y, 0.22);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hole = new THREE.Path();
        hole.absarc(cellX(c), cellY(r), HOLE_R, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }
    const panelGeo = own(
      new THREE.ExtrudeGeometry(shape, {
        depth: PANEL_DEPTH,
        bevelEnabled: true,
        bevelThickness: BEVEL,
        bevelSize: 0.035,
        bevelSegments: 2,
        curveSegments: 22,
      }),
    );
    const front = new THREE.Mesh(panelGeo, panelMat);
    front.position.z = PANEL_IN + BEVEL;
    const back = new THREE.Mesh(panelGeo, panelMat);
    back.position.z = -(PANEL_IN + BEVEL + PANEL_DEPTH);
    // Only the back panel casts: the front one would shade every disc in
    // its hole and the toy colors would read muddy.
    back.castShadow = true;
    for (const m of [front, back]) {
      m.receiveShadow = true;
      scene.add(m);
    }

    // Floor of the slot (discs rest on it) and the two side posts with feet.
    const floorGeo = own(new THREE.BoxGeometry(PANEL_HALF_W * 2, ROW0_Y - DISC_R - BASE_Y, PANEL_IN * 2));
    const floor = new THREE.Mesh(floorGeo, walnutMat);
    floor.position.set(0, (BASE_Y + ROW0_Y - DISC_R) / 2, 0);
    floor.receiveShadow = true;
    scene.add(floor);
    const postH = PANEL_TOP + 0.12;
    const postGeo = own(roundedBox(0.3, postH, 0.82, 0.06));
    const footGeo = own(roundedBox(0.42, 0.26, 2.5, 0.08));
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, walnutMat);
      post.position.set(side * (PANEL_HALF_W + 0.13), postH / 2, 0);
      post.castShadow = true;
      post.receiveShadow = true;
      scene.add(post);
      const foot = new THREE.Mesh(footGeo, walnutMat);
      foot.position.set(side * (PANEL_HALF_W + 0.13), 0.13, 0);
      foot.castShadow = true;
      foot.receiveShadow = true;
      scene.add(foot);
    }

    // ── Discs ──
    this.discGeo = own(discGeometry());
    const plastic = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial =>
      own(new THREE.MeshStandardMaterial({ color, roughness: 0.36, metalness: 0.0, ...extra }));
    this.mats = { r: plastic(C_RED), y: plastic(C_YELLOW) };
    this.glowMats = {
      r: plastic(C_RED, { emissive: new THREE.Color(0xff6a4a), emissiveIntensity: 0.5 }),
      y: plastic(C_YELLOW, { emissive: new THREE.Color(0xffc94a), emissiveIntensity: 0.5 }),
    };
    const ghost = (color: number, opacity: number, glow: number): THREE.MeshStandardMaterial =>
      plastic(color, { transparent: true, opacity, depthWrite: false, emissive: new THREE.Color(color), emissiveIntensity: glow });
    this.ghostMats = { r: ghost(C_RED, 0.78, 0.35), y: ghost(C_YELLOW, 0.78, 0.3) };
    this.landMats = { r: ghost(C_RED, 0.4, 0.25), y: ghost(C_YELLOW, 0.4, 0.2) };
    scene.add(this.discRoot);

    this.ghost = new THREE.Mesh(this.discGeo, this.ghostMats.r);
    this.ghost.rotation.x = Math.PI / 2;
    this.ghost.visible = false;
    this.landing = new THREE.Mesh(this.discGeo, this.landMats.r);
    this.landing.rotation.x = Math.PI / 2;
    this.landing.visible = false;
    this.thinkGhost = new THREE.Mesh(this.discGeo, this.ghostMats.y);
    this.thinkGhost.rotation.x = Math.PI / 2;
    this.thinkGhost.visible = false;
    scene.add(this.ghost, this.landing, this.thinkGhost);

    // Column highlight: a soft rounded strip over the front panel.
    const stripGeo = own(new THREE.ShapeGeometry(roundedRect(-0.48, BASE_Y + 0.1, 0.96, PANEL_TOP - BASE_Y - 0.2, 0.45), 12));
    const stripMat = own(
      new THREE.MeshBasicMaterial({ color: C_GLOW, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.column = new THREE.Mesh(stripGeo, stripMat);
    this.column.position.z = FRONT_Z + 0.004;
    this.column.visible = false;
    scene.add(this.column);

    // Win rings.
    this.ringGeo = own(new THREE.TorusGeometry(HOLE_R + 0.02, 0.045, 10, 40));
    this.ringMat = own(new THREE.MeshBasicMaterial({ color: C_RING, transparent: true, opacity: 0.95 }));
    scene.add(this.ringRoot);

    // ── Disc stacks on the table ──
    const mk = (color: CONNECT4Color): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(this.discGeo, this.mats[color], 21);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      scene.add(im);
      return im;
    };
    this.piles = { r: mk('r'), y: mk('y') };

    this.stage.onResize = (aspect, w, h) => this.frameCamera(aspect, w, h);
    this.stage.tick = (now, dt) => this.tick(now, dt);
    this.stage.ambient = (now) => this.ambientTick(now);
    this.layoutPiles({ r: 21, y: 21 });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Which color the player holds (their stack sits on the left). */
  setPlayerColor(color: CONNECT4Color): void {
    if (color === this.playerColor) return;
    this.playerColor = color;
    this.layoutPiles(this.inHand);
    this.stage.invalidate();
  }

  /**
   * Show `board`. Discs that are new since the last call drop in when
   * `animate` is set; `reset` (a new game) lets the old discs fall out first.
   */
  setBoard(board: Board, opts: { animate: boolean; reset?: boolean }): void {
    if (opts.reset) this.releaseAll(opts.animate);
    const seen = new Set<string>();
    let stagger = 0;
    // Bottom row first, so a multi-disc catch-up stacks in order.
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const v = board[r]?.[c] ?? null;
        if (!v) continue;
        const key = `${r},${c}`;
        seen.add(key);
        const have = this.discs.get(key);
        if (have && have.color === v) continue;
        if (have) this.removeDisc(key);
        const mesh = new THREE.Mesh(this.discGeo, this.mats[v]);
        mesh.rotation.x = Math.PI / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const target = cellY(r);
        mesh.position.set(cellX(c), target, 0);
        const disc: Disc = { mesh, color: v, cell: { r, c }, fall: null };
        if (opts.animate && !this.stage.reducedMotion) {
          mesh.position.y = GHOST_Y;
          disc.fall = { y: GHOST_Y, v: 0, target, delay: stagger, bounces: 0 };
          stagger += 140;
        }
        this.discRoot.add(mesh);
        this.discs.set(key, disc);
      }
    }
    for (const key of [...this.discs.keys()]) if (!seen.has(key)) this.removeDisc(key);
    this.layoutPiles(discsInHand(board));
    this.applyWinMaterials();
    this.stage.wake();
    this.stage.invalidate();
  }

  /** Hover affordance over `col` in `color` (null clears it). */
  setHover(col: number | null, color: CONNECT4Color | null, landing: number): void {
    const next = col !== null && color ? col : null;
    if (next !== null && color) {
      if (this.hoverCol === null) this.hoverX = cellX(next);
      this.ghost.material = this.ghostMats[color];
      this.landing.material = this.landMats[color];
      this.landing.visible = landing >= 0;
      if (landing >= 0) this.landing.position.set(cellX(next), cellY(landing), 0);
      this.column.position.x = cellX(next);
    } else {
      this.landing.visible = false;
    }
    this.hoverCol = next;
    this.stage.wake();
    this.stage.invalidate();
  }

  /** The companion is choosing: its ghost disc drifts over the columns. */
  setThinking(color: CONNECT4Color | null): void {
    if (!color) {
      this.thinking = null;
      this.thinkGhost.visible = false;
    } else if (!this.thinking || this.thinking.color !== color) {
      const col = Math.floor(COLS / 2);
      this.thinking = { color, col, x: cellX(col), nextAt: performance.now() + 700 };
      this.thinkGhost.material = this.ghostMats[color];
      this.thinkGhost.position.set(cellX(col), GHOST_Y, 0);
      this.thinkGhost.visible = !this.stage.ambientDisabled;
    }
    this.stage.wake();
    this.stage.invalidate();
  }

  /** Highlight the winning discs (empty clears). */
  setWin(cells: Cell[]): void {
    const same =
      this.win &&
      this.win.cells.length === cells.length &&
      this.win.cells.every((a, i) => a.r === cells[i].r && a.c === cells[i].c);
    if (same) return;
    for (const child of [...this.ringRoot.children]) this.ringRoot.remove(child);
    this.win = cells.length ? { cells, startedAt: performance.now() } : null;
    for (const cell of cells) {
      const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
      ring.position.set(cellX(cell.c), cellY(cell.r), FRONT_Z + 0.01);
      ring.scale.setScalar(this.stage.reducedMotion ? 1 : 0.001);
      this.ringRoot.add(ring);
    }
    this.applyWinMaterials();
    this.stage.wake();
    this.stage.invalidate();
  }

  /** The column under a pointer, or null off the frame. */
  columnAtPointer(clientX: number, clientY: number): number | null {
    const hit = this.stage.pointerOnPlane(clientX, clientY, this.pickPlane);
    if (!hit) return null;
    if (hit.y < 0 || hit.y > GHOST_Y + 1.2) return null;
    const c = Math.round(hit.x + (COLS - 1) / 2);
    if (c < 0 || c >= COLS) return null;
    return c;
  }

  /** Keep ambient animation running (pointer activity). */
  wake(): void {
    this.stage.wake();
  }

  /** Screen anchors (container px) under the two disc stacks. */
  pileAnchors(): { player: { x: number; y: number }; ai: { x: number; y: number } } {
    const left = this.stage.project(new THREE.Vector3(-PILE_X, 0, PILE_Z + 1.05));
    const right = this.stage.project(new THREE.Vector3(PILE_X, 0, PILE_Z + 1.05));
    return { player: left, ai: right };
  }

  timing(): TabletopStage['timing'] {
    return this.stage.timing;
  }

  dispose(): void {
    this.stage.dispose();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Game over: ease the frame up so the result card below clears it. */
  setEnded(ended: boolean): void {
    const to = ended ? 1 : 0;
    if (this.endShift.to === to) return;
    const now = performance.now();
    this.endShift = { from: this.endShiftAt(now), to, start: this.stage.reducedMotion ? -Infinity : now };
    this.applyCamera(now);
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

  private applyCamera(now: number): void {
    const aspect = this.aspect;
    // Fit the frame (plus the ghost disc above it) vertically and the two
    // stacks horizontally; whichever needs the farther camera wins. Extra
    // headroom keeps the turn line clear of the ghost disc.
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov / 2));
    const vertical = 4.55 / tanHalf;
    const horizontal = 7.9 / (tanHalf * aspect);
    // Game over: pull back and slide up so the frame clears the result card.
    const shift = this.endShiftAt(now);
    this.shiftShown = shift;
    const end = endFraming(this.viewH, FRAME_TOP, FRAME_BOTTOM, shift);
    const d = Math.max(vertical, horizontal) * end.k;
    const lookY = (GHOST_Y + 0.2) / 2 + 0.22;
    this.stage.placeCamera(new THREE.Vector3(0, lookY, 0.4), THREE.MathUtils.degToRad(21), d);
    applyLift(this.stage.camera, this.viewW, this.viewH, end.liftPx);
    this.stage.invalidate();
  }

  private layoutPiles(inHand: Record<CONNECT4Color, number>): void {
    this.inHand = inHand;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    for (const color of ['r', 'y'] as CONNECT4Color[]) {
      const im = this.piles[color];
      const side = color === this.playerColor ? -1 : 1;
      const n = inHand[color];
      im.count = n;
      // Three stacks of up to seven, in a little triangle.
      const spots: Array<[number, number]> = [
        [0, 0],
        [1.02, 0.25],
        [0.45, -0.85],
      ];
      for (let i = 0; i < n; i++) {
        const stack = Math.floor(i / 7);
        const level = i % 7;
        const [ox, oz] = spots[stack] ?? spots[0];
        const jitter = ((i * 37) % 7) / 7 - 0.5;
        const pos = new THREE.Vector3(
          side * PILE_X + side * ox + jitter * 0.03,
          DISC_T / 2 + level * (DISC_T + 0.005),
          PILE_Z + oz + jitter * 0.02,
        );
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), jitter);
        m.compose(pos, q, s);
        im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }

  private applyWinMaterials(): void {
    const winKeys = new Set(this.win?.cells.map((c) => `${c.r},${c.c}`) ?? []);
    for (const [key, d] of this.discs) d.mesh.material = winKeys.has(key) ? this.glowMats[d.color] : this.mats[d.color];
  }

  private removeDisc(key: string): void {
    const d = this.discs.get(key);
    if (!d) return;
    this.discRoot.remove(d.mesh);
    this.discs.delete(key);
  }

  /** New game: every disc falls out through the bottom of the frame. */
  private releaseAll(animate: boolean): void {
    let i = 0;
    for (const d of this.discs.values()) {
      if (animate && !this.stage.reducedMotion) {
        d.mesh.material = this.mats[d.color];
        this.exits.push({ mesh: d.mesh, v: 0, delay: (d.cell.c * 40 + i * 6) % 300 });
      } else {
        this.discRoot.remove(d.mesh);
      }
      i++;
    }
    this.discs.clear();
    for (const child of [...this.ringRoot.children]) this.ringRoot.remove(child);
    this.win = null;
  }

  private tick(now: number, dt: number): boolean {
    const s = dt / 1000;
    let moving = false;
    if (this.endShiftAt(now) !== this.shiftShown) {
      this.applyCamera(now);
      this.onLayout();
      moving = true;
    }

    for (const d of this.discs.values()) {
      const f = d.fall;
      if (!f) continue;
      moving = true;
      if (f.delay > 0) {
        f.delay -= dt;
        continue;
      }
      // Fixed substeps: a slow frame (low-end GPU) skips ahead instead of
      // playing the drop in slow motion, and the bounce stays the same.
      for (let left = s; left > 0 && d.fall; left -= 1 / 120) {
        const h = Math.min(left, 1 / 120);
        f.v -= GRAVITY * h;
        f.y += f.v * h;
        if (f.y <= f.target) {
          f.y = f.target;
          if (Math.abs(f.v) > 2.2 && f.bounces < 3) {
            f.v = -f.v * BOUNCE;
            f.bounces++;
          } else {
            d.fall = null;
          }
        }
      }
      d.mesh.position.y = f.y;
    }

    if (this.exits.length) {
      moving = true;
      const gone: Exit[] = [];
      for (const e of this.exits) {
        if (e.delay > 0) {
          e.delay -= dt;
          continue;
        }
        e.v -= GRAVITY * s;
        e.mesh.position.y += e.v * s;
        if (e.mesh.position.y < -1.2) gone.push(e);
      }
      for (const e of gone) this.discRoot.remove(e.mesh);
      this.exits = this.exits.filter((e) => !gone.includes(e));
    }

    // Hover: the column strip fades, the ghost eases between columns.
    const wantFade = this.hoverCol !== null ? 1 : 0;
    const k = this.stage.reducedMotion ? 1 : 1 - Math.exp(-dt / 70);
    this.columnFade += (wantFade - this.columnFade) * k;
    if (Math.abs(wantFade - this.columnFade) < 0.01) this.columnFade = wantFade;
    else moving = true;
    const strip = this.column.material as THREE.MeshBasicMaterial;
    strip.opacity = 0.16 * this.columnFade;
    this.column.visible = this.columnFade > 0.01;
    if (this.hoverCol !== null) {
      const tx = cellX(this.hoverCol);
      this.hoverX += (tx - this.hoverX) * (this.stage.reducedMotion ? 1 : 1 - Math.exp(-dt / 45));
      if (Math.abs(tx - this.hoverX) < 0.002) this.hoverX = tx;
      else moving = true;
      this.ghost.position.set(this.hoverX, GHOST_Y, 0);
      this.ghost.visible = true;
    } else {
      this.ghost.visible = false;
    }

    // Win rings pop in one after another.
    if (this.win && !this.stage.reducedMotion) {
      const t = now - this.win.startedAt;
      this.ringRoot.children.forEach((ring, i) => {
        const p = THREE.MathUtils.clamp((t - 250 - i * 110) / 380, 0, 1);
        ring.scale.setScalar(Math.max(0.001, easeOutBack(p)));
        if (p < 1) moving = true;
      });
    }
    return moving;
  }

  /** Throttled ambient tier: the thinking ghost and the win glow pulse. */
  private ambientTick(now: number): boolean {
    let alive = false;
    const th = this.thinking;
    if (th) {
      alive = true;
      this.stage.wake(); // keep drifting for as long as the companion thinks
      if (now > th.nextAt) {
        const step = Math.random() < 0.5 ? -1 : 1;
        th.col = THREE.MathUtils.clamp(th.col + step * (1 + Math.floor(Math.random() * 2)), 0, COLS - 1);
        th.nextAt = now + 650 + Math.random() * 900;
      }
      const tx = cellX(th.col);
      th.x += (tx - th.x) * 0.18;
      this.thinkGhost.position.set(th.x, GHOST_Y + Math.sin(now / 380) * 0.06, 0);
    }
    if (this.win) {
      alive = true;
      const pulse = 0.5 + 0.5 * Math.sin((now - this.win.startedAt) / 420);
      for (const m of Object.values(this.glowMats)) m.emissiveIntensity = 0.25 + 0.45 * pulse;
      this.ringMat.opacity = 0.7 + 0.3 * pulse;
      const winKeys = new Set(this.win.cells.map((c) => `${c.r},${c.c}`));
      for (const [key, d] of this.discs) {
        if (!winKeys.has(key) || d.fall) continue;
        d.mesh.scale.setScalar(1 + 0.05 * smooth(pulse));
      }
    }
    return alive;
  }
}

// ── Geometry helpers ───────────────────────────────────────────────────────

/** A checker-style disc: raised rim, recessed face, along +y (lathe axis). */
function discGeometry(): THREE.LatheGeometry {
  const h = DISC_T / 2;
  const pts = [
    [0, -h + 0.025],
    [0.29, -h + 0.025],
    [0.33, -h + 0.005],
    [0.41, -h],
    [DISC_R - 0.02, -h + 0.005],
    [DISC_R, -h + 0.035],
    [DISC_R, h - 0.035],
    [DISC_R - 0.02, h - 0.005],
    [0.41, h],
    [0.33, h - 0.005],
    [0.29, h - 0.025],
    [0, h - 0.025],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 40);
}

export function roundedRect(x: number, y: number, w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A box with softened vertical edges (extruded rounded rectangle). */
export function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const shape = roundedRect(-w / 2, -d / 2, w, d, Math.min(r * 2, w / 2, d / 2));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * r,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r * 0.6,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // Extrusion runs along +z; stand it up so height is y, centred.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -(h - 2 * r) / 2, 0);
  return geo;
}
