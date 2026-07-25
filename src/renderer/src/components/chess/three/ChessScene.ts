/**
 * ChessScene — the 3D "wooden table" chess viewport (three.js, no React).
 *
 * Clubhouse-Games-style presentation: a fixed perspective camera looks down
 * at ~52 degrees onto a wooden table; the board (cream vs dark green squares,
 * walnut frame) sits on it with full 3D lathe-turned pieces, one soft
 * shadow-casting key light plus fills. Everything is procedural: wood comes
 * from a seeded canvas texture, pieces from pieceGeometry.ts.
 *
 * The class is a dumb view driven imperatively by ChessBoard3D.tsx:
 *   setOrientation / setPieces / setMarks / setOverlays push display state;
 *   squareAtPointer raycasts a pointer event to a board square;
 *   liftPiece / dragPiece / releasePiece implement the drag affordance.
 *
 * Rendering is on demand: a frame is scheduled only when state changes or a
 * piece lerp is in flight; there is no permanent 60fps loop (this app shares
 * the machine with a Minecraft bot).
 *
 * All colors in this file are 3D art-asset values (wood, felt, highlight
 * glows), literal by design like the piece SVGs; UI chrome around the canvas
 * uses design tokens in ChessBoard3D.module.css.
 */

import * as THREE from 'three';
import type { ChessColor } from '@shared/chessIpc';
import { FILES, RANKS, colOf, rowOf, squareAt, type Square } from '../chessUtil';
import { createPieceLibrary, type PieceColor, type PieceLibrary, type PieceType } from './pieceGeometry';
import { makeWoodTexture } from './woodTexture';

export interface SceneMarks {
  selected: string | null;
  lastMove: { from: string; to: string } | null;
  check: string | null;
  hover: string | null;
  targets: Array<{ to: string; capture: boolean }>;
}

export interface SceneArrow {
  from: string;
  to: string;
}

const EMPTY_MARKS: SceneMarks = { selected: null, lastMove: null, check: null, hover: null, targets: [] };

// ── Layout constants (1 unit = 1 square) ────────────────────────────────────
const BOARD_TOP = 0.53; // y of the square surfaces
const FRAME_TOP = 0.56; // y of the frame lip
const SLAB_HALF = 4.6; // board slab half-extent incl. frame
const LIFT = 0.55; // how high a dragged piece floats
// Flip to false to restore the old click-lift behavior (instant raise on pointer-down).
const CONTINUOUS_DRAG = true;
// Exponential-smoothing time constant for the continuous drag follower (ms).
// alpha = 1 - exp(-dt / tau): ~28% of the gap closed per 60fps frame, ~95%
// settled in 150ms. Small enough to feel glued to the cursor, big enough that
// pickup (rest -> hover height) reads as one continuous motion.
const DRAG_TAU_MS = 50;
const FOV = 40;
const CAM_ELEVATION = (52 * Math.PI) / 180;

// Mark palette (art assets).
const C_SELECT = 0xf2c14e;
const C_LASTMOVE = 0xe8c46a;
const C_CHECK = 0xd8433a;
const C_HOVER = 0xfff6e0;
const C_TARGET = 0x243528;
const C_ARROW = 0x7fb0ff;

interface PieceEntry {
  code: string; // 'wp' .. 'bk'
  group: THREE.Group;
}

interface Anim {
  group: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  dur: number;
}

export class ChessScene {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly library: PieceLibrary;
  private readonly ro: ResizeObserver;
  private readonly reducedMotion: boolean;

  private readonly pieceRoot = new THREE.Group();
  private readonly markRoot = new THREE.Group();
  private readonly overlayRoot = new THREE.Group();

  private orientation: ChessColor = 'w';
  private pieceMap = new Map<string, PieceEntry>();
  private anims: Anim[] = [];
  /**
   * target is the cursor point the piece eases toward (null until the first
   * dragPiece). grab is the world-space offset from the cursor to where the
   * piece was actually picked up, so it does not teleport under the pointer.
   */
  private dragging: {
    square: string;
    group: THREE.Group;
    target: THREE.Vector3 | null;
    grab: THREE.Vector2;
  } | null = null;
  private lastFrameAt = 0;
  private lastMarks: SceneMarks = EMPTY_MARKS;
  private lastArrows: SceneArrow[] = [];
  private lastCircles: string[] = [];
  private raf = 0;
  private disposed = false;

  // Shared resources for marks/overlays.
  private readonly tileGeo: THREE.PlaneGeometry;
  private readonly dotGeo: THREE.CircleGeometry;
  private readonly ringGeo: THREE.RingGeometry;
  private readonly hoverGeo: THREE.RingGeometry;
  private readonly checkGeo: THREE.CircleGeometry;
  private readonly circleGeo: THREE.RingGeometry;
  private readonly matSelect: THREE.MeshBasicMaterial;
  private readonly matLastMove: THREE.MeshBasicMaterial;
  private readonly matCheck: THREE.MeshBasicMaterial;
  private readonly matHover: THREE.MeshBasicMaterial;
  private readonly matTarget: THREE.MeshBasicMaterial;
  private readonly matArrow: THREE.MeshBasicMaterial;
  private arrowGeos: THREE.BufferGeometry[] = [];

  private readonly coordCanvas: HTMLCanvasElement;
  private readonly coordTexture: THREE.CanvasTexture;
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  private readonly boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP);
  /**
   * The plane a HELD piece lives on, LIFT above the board surface.
   *
   * A dragged piece is drawn at y = BOARD_TOP + LIFT but used to be positioned
   * by raycasting the BOARD plane, so its rendered position was the projection
   * of a point 0.55 units above where the cursor actually pointed. At the 52°
   * camera that is a permanent upward screen offset, and because the piece also
   * had to RISE by LIFT as the drag began, the first ~150ms of every drag read
   * as the piece shooting up past the cursor and staying above it.
   *
   * Raycasting this plane instead makes the piece origin project exactly onto
   * the pointer: 1:1 tracking by construction, at any camera angle.
   */
  private readonly dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(BOARD_TOP + LIFT));
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(container: HTMLElement) {
    this.container = container;
    this.reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a120c);
    this.scene.fog = new THREE.Fog(0x1a120c, 18, 42);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.library = createPieceLibrary();

    // ── Lights ──
    const hemi = new THREE.HemisphereLight(0xfff4e0, 0x5c4030, 0.5);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff1dd, 1.5);
    key.position.set(5, 11, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -7;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 30;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xcdd8ff, 0.35);
    fill.position.set(-6, 7, -4);
    this.scene.add(fill);

    // ── Table ──
    // 200 units square (repeat scaled to keep the grain size) so the wood
    // still fills the whole frame at the pulled-back camera framing; the fog
    // fades the far reach into the background color long before the edge.
    const tableTex = makeWoodTexture({
      base: [122, 82, 46],
      stripe: [108, 73, 40],
      streak: [82, 53, 29],
      seed: 11,
      frequency: 0.09,
    });
    // ~13 world units per tile, seamless (whole-cycle sines) with faint
    // streaks so the repetition does not read as a pattern.
    tableTex.repeat.set(15, 15);
    this.ownedTextures.push(tableTex);
    const tableMat = new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.62, metalness: 0.02 });
    this.ownedMats.push(tableMat);
    const tableGeo = new THREE.PlaneGeometry(200, 200);
    this.ownedGeos.push(tableGeo);
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    // ── Board slab + frame ──
    const frameTex = makeWoodTexture({
      base: [82, 50, 27],
      stripe: [58, 33, 17],
      streak: [40, 22, 11],
      seed: 29,
      frequency: 0.06,
    });
    frameTex.repeat.set(2, 2);
    this.ownedTextures.push(frameTex);
    const frameMat = new THREE.MeshStandardMaterial({ map: frameTex, roughness: 0.5, metalness: 0.02 });
    this.ownedMats.push(frameMat);

    const slabGeo = new THREE.BoxGeometry(SLAB_HALF * 2, 0.47, SLAB_HALF * 2);
    this.ownedGeos.push(slabGeo);
    const slab = new THREE.Mesh(slabGeo, frameMat);
    slab.position.y = 0.235;
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.scene.add(slab);

    const lipLongGeo = new THREE.BoxGeometry(SLAB_HALF * 2, FRAME_TOP - 0.47, 0.6);
    const lipShortGeo = new THREE.BoxGeometry(0.6, FRAME_TOP - 0.47, 8);
    this.ownedGeos.push(lipLongGeo, lipShortGeo);
    const lipY = (0.47 + FRAME_TOP) / 2;
    for (const [x, z, geo] of [
      [0, 4.3, lipLongGeo],
      [0, -4.3, lipLongGeo],
      [4.3, 0, lipShortGeo],
      [-4.3, 0, lipShortGeo],
    ] as Array<[number, number, THREE.BoxGeometry]>) {
      const lip = new THREE.Mesh(geo, frameMat);
      lip.position.set(x, lipY, z);
      lip.castShadow = true;
      lip.receiveShadow = true;
      this.scene.add(lip);
    }

    // ── Squares: cream vs deep green felt-ish ──
    const sqGeo = new THREE.BoxGeometry(1, 0.06, 1);
    this.ownedGeos.push(sqGeo);
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xe7d9b4, roughness: 0.55, metalness: 0.02 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a5140, roughness: 0.58, metalness: 0.02 });
    this.ownedMats.push(lightMat, darkMat);
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const dark = (file + rank) % 2 === 0; // a1 (0,0) is dark
        const sqm = new THREE.Mesh(sqGeo, dark ? darkMat : lightMat);
        sqm.position.set(file - 3.5, 0.5, -(rank - 3.5));
        sqm.receiveShadow = true;
        this.scene.add(sqm);
      }
    }

    // ── Coordinate labels on the frame lip ──
    this.coordCanvas = document.createElement('canvas');
    this.coordCanvas.width = 512;
    this.coordCanvas.height = 512;
    this.coordTexture = new THREE.CanvasTexture(this.coordCanvas);
    this.coordTexture.colorSpace = THREE.SRGBColorSpace;
    this.coordTexture.anisotropy = 8;
    this.ownedTextures.push(this.coordTexture);
    const coordMat = new THREE.MeshBasicMaterial({
      map: this.coordTexture,
      transparent: true,
      depthWrite: false,
    });
    this.ownedMats.push(coordMat);
    const coordGeo = new THREE.PlaneGeometry(SLAB_HALF * 2, SLAB_HALF * 2);
    this.ownedGeos.push(coordGeo);
    const coordPlane = new THREE.Mesh(coordGeo, coordMat);
    coordPlane.rotation.x = -Math.PI / 2;
    coordPlane.position.y = FRAME_TOP + 0.002;
    this.scene.add(coordPlane);
    this.drawCoords();

    // ── Mark + overlay resources ──
    this.tileGeo = new THREE.PlaneGeometry(1, 1);
    this.dotGeo = new THREE.CircleGeometry(0.14, 24);
    this.ringGeo = new THREE.RingGeometry(0.34, 0.44, 32);
    this.hoverGeo = new THREE.RingGeometry(0.4, 0.47, 32);
    this.checkGeo = new THREE.CircleGeometry(0.48, 32);
    this.circleGeo = new THREE.RingGeometry(0.36, 0.43, 32);
    this.ownedGeos.push(this.tileGeo, this.dotGeo, this.ringGeo, this.hoverGeo, this.checkGeo, this.circleGeo);
    const basic = (color: number, opacity: number): THREE.MeshBasicMaterial => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      this.ownedMats.push(m);
      return m;
    };
    this.matSelect = basic(C_SELECT, 0.45);
    this.matLastMove = basic(C_LASTMOVE, 0.3);
    this.matCheck = basic(C_CHECK, 0.45);
    this.matHover = basic(C_HOVER, 0.4);
    this.matTarget = basic(C_TARGET, 0.42);
    this.matArrow = basic(C_ARROW, 0.55);

    this.scene.add(this.pieceRoot, this.markRoot, this.overlayRoot);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setOrientation(o: ChessColor): void {
    if (o === this.orientation) return;
    this.orientation = o;
    this.drawCoords();
    // Snap everything into the new frame of reference.
    this.anims = [];
    for (const [sq, ent] of this.pieceMap) this.placePiece(ent, sq);
    this.applyMarks(this.lastMarks);
    this.applyOverlays(this.lastArrows, this.lastCircles);
    this.invalidate();
  }

  /** Display the given piece set; moved pieces lerp from where they stand. */
  setPieces(pieces: Array<{ square: string; code: string }>): void {
    const target = new Map<string, string>();
    for (const p of pieces) target.set(p.square, p.code);

    const freed: PieceEntry[] = [];
    for (const [sq, ent] of [...this.pieceMap]) {
      if (target.get(sq) === ent.code) {
        target.delete(sq); // unchanged
        continue;
      }
      this.pieceMap.delete(sq);
      freed.push(ent);
    }

    for (const [sq, code] of target) {
      const dest = this.squareCenter(sq);
      // Reuse a freed group of the same code (nearest first) so moves and
      // drag-drops animate instead of popping.
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < freed.length; i++) {
        if (freed[i].code !== code) continue;
        const d = freed[i].group.position.distanceToSquared(dest);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const ent = freed.splice(bestIdx, 1)[0];
        this.pieceMap.set(sq, ent);
        this.orientPiece(ent, sq);
        this.startLerp(ent.group, dest);
      } else {
        const ent: PieceEntry = { code, group: this.library.build(code[1] as PieceType, code[0] as PieceColor) };
        this.pieceRoot.add(ent.group);
        this.pieceMap.set(sq, ent);
        this.placePiece(ent, sq);
      }
    }

    for (const ent of freed) {
      if (this.dragging?.group === ent.group) this.dragging = null;
      this.pieceRoot.remove(ent.group);
    }
    this.invalidate();
  }

  setMarks(marks: SceneMarks): void {
    this.lastMarks = marks;
    this.applyMarks(marks);
    this.invalidate();
  }

  setOverlays(arrows: SceneArrow[], circles: string[]): void {
    this.lastArrows = arrows;
    this.lastCircles = circles;
    this.applyOverlays(arrows, circles);
    this.invalidate();
  }

  /**
   * The board square under a pointer event, or null off the board.
   *
   * Pieces are hit-tested FIRST. Projecting the pointer straight onto the board
   * plane answers with the square the ray passes through, which for a click on
   * a tall piece's body is the square BEHIND it: at the 52° camera a point h
   * units up the piece lands h/tan(52°) ≈ 0.78h squares further away, close to
   * a full square for a king. Grabbing a piece by its head used to select the
   * empty square behind it.
   */
  squareAtPointer(clientX: number, clientY: number): Square | null {
    if (!this.aimRay(clientX, clientY)) return null;
    const hits = this.ray.intersectObject(this.pieceRoot, true);
    for (const h of hits) {
      // Walk up to the piece group, which is what pieceMap is keyed on.
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
        if (o.parent !== this.pieceRoot) continue;
        // The piece in hand floats between the camera and everything else, so
        // it would shadow every square it passes over. Its own square comes
        // from draggedSquare() instead.
        if (this.dragging?.group === o) break;
        for (const [sq, ent] of this.pieceMap) if (ent.group === o) return sq as Square;
        break;
      }
    }
    const out = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.boardPlane, out)) return null;
    return squareAt(Math.floor(out.x + 4), Math.floor(out.z + 4), this.orientation);
  }

  /**
   * Begin a drag on `square`. The grab offset is captured here: wherever on the
   * piece the pointer went down, the piece keeps that same relative position
   * for the rest of the drag instead of snapping its centre under the cursor.
   *
   * With CONTINUOUS_DRAG the piece stays seated until dragPiece() starts
   * feeding cursor targets; the frame loop then eases it up and along in one
   * continuous motion. Legacy mode raises the piece instantly (the old
   * click-lift affordance).
   */
  liftPiece(square: string, clientX?: number, clientY?: number): void {
    const ent = this.pieceMap.get(square);
    if (!ent) return;
    this.anims = this.anims.filter((a) => a.group !== ent.group);
    const grab = new THREE.Vector2();
    if (clientX !== undefined && clientY !== undefined) {
      const hit = this.pointerToPlane(clientX, clientY, this.dragPlane);
      if (hit) {
        const c = this.squareCenter(square);
        grab.set(c.x - hit.x, c.z - hit.z);
      }
    }
    this.dragging = { square, group: ent.group, target: null, grab };
    if (!CONTINUOUS_DRAG) ent.group.position.y = BOARD_TOP + LIFT;
    this.invalidate();
  }

  /**
   * Float the dragged piece under the cursor (clamped to the board).
   *
   * Raycasts the LIFTED plane, not the board, so the piece tracks the pointer
   * 1:1 on screen — see dragPlane. The grab offset from liftPiece is added back
   * so the piece keeps the grip it was picked up with.
   */
  dragPiece(clientX: number, clientY: number): void {
    if (!this.dragging) return;
    const hit = this.pointerToPlane(clientX, clientY, this.dragPlane);
    if (!hit) return;
    const x = THREE.MathUtils.clamp(hit.x + this.dragging.grab.x, -SLAB_HALF, SLAB_HALF);
    const z = THREE.MathUtils.clamp(hit.z + this.dragging.grab.y, -SLAB_HALF, SLAB_HALF);
    if (!CONTINUOUS_DRAG || this.reducedMotion) {
      // Track the cursor directly (legacy mode, or reduced motion: no easing).
      this.dragging.group.position.set(x, BOARD_TOP + LIFT, z);
    } else if (!this.dragging.target) {
      // FIRST drag frame: place the piece outright rather than letting the
      // follower ease into it. Easing from the seated position meant every drag
      // opened with the piece swooping up and forward to catch the cursor,
      // which is what read as "faster than my pointer". Subsequent frames ease
      // normally, which is where the smoothing actually earns its keep.
      this.dragging.target = new THREE.Vector3(x, BOARD_TOP + LIFT, z);
      this.dragging.group.position.copy(this.dragging.target);
    } else {
      // Feed the follower; frame() eases the piece toward this each frame.
      this.dragging.target.set(x, BOARD_TOP + LIFT, z);
    }
    this.invalidate();
  }

  /**
   * The board square the DRAGGED piece is currently over, or null when it is
   * off the board. Distinct from squareAtPointer: the drop target has to be the
   * square under the piece, not the one under the raw cursor ray, or the ring
   * highlights a different square than the one the piece visibly covers.
   */
  draggedSquare(): Square | null {
    const d = this.dragging;
    if (!d) return null;
    const p = d.target ?? d.group.position;
    return squareAt(Math.floor(p.x + 4), Math.floor(p.z + 4), this.orientation);
  }

  /**
   * End a drag. snapBack=true settles the piece to its origin square;
   * false leaves it floating for the imminent setPieces() to lerp home.
   */
  releasePiece(snapBack: boolean): void {
    const d = this.dragging;
    this.dragging = null;
    if (!d) return;
    if (snapBack) this.startLerp(d.group, this.squareCenter(d.square));
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const g of this.arrowGeos) g.dispose();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.library.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private squareCenter(sq: string): THREE.Vector3 {
    const x = colOf(sq, this.orientation) - 3.5;
    const z = rowOf(sq, this.orientation) - 3.5;
    return new THREE.Vector3(x, BOARD_TOP, z);
  }

  private orientPiece(ent: PieceEntry, sq: string): void {
    void sq;
    // Pieces face the opponent: the bottom side (matching the orientation)
    // looks toward -z, the top side toward +z. Heads are built facing +z.
    ent.group.rotation.y = ent.code[0] === this.orientation ? Math.PI : 0;
  }

  private placePiece(ent: PieceEntry, sq: string): void {
    ent.group.position.copy(this.squareCenter(sq));
    this.orientPiece(ent, sq);
  }

  private startLerp(group: THREE.Group, to: THREE.Vector3): void {
    this.anims = this.anims.filter((a) => a.group !== group);
    if (this.reducedMotion) {
      group.position.copy(to);
      return;
    }
    const from = group.position.clone();
    const dist = from.distanceTo(to);
    if (dist < 0.001) {
      group.position.copy(to);
      return;
    }
    const dur = THREE.MathUtils.clamp(150 + dist * 45, 170, 300);
    this.anims.push({ group, from, to, start: performance.now(), dur });
    this.invalidate();
  }

  /** Where the pointer ray meets an arbitrary horizontal plane in the scene. */
  private pointerToPlane(
    clientX: number,
    clientY: number,
    plane: THREE.Plane,
  ): THREE.Vector3 | null {
    if (!this.aimRay(clientX, clientY)) return null;
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Point the shared raycaster at a client coordinate. False if unsized. */
  private aimRay(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.ray.setFromCamera(this.ndc, this.camera);
    return true;
  }

  private clearGroup(root: THREE.Group): void {
    for (const child of [...root.children]) root.remove(child);
  }

  private flatMesh(geo: THREE.BufferGeometry, mat: THREE.Material, sq: string, y: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    const c = this.squareCenter(sq);
    m.position.set(c.x, y, c.z);
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  private applyMarks(marks: SceneMarks): void {
    this.clearGroup(this.markRoot);
    if (marks.lastMove) {
      this.markRoot.add(this.flatMesh(this.tileGeo, this.matLastMove, marks.lastMove.from, BOARD_TOP + 0.004));
      this.markRoot.add(this.flatMesh(this.tileGeo, this.matLastMove, marks.lastMove.to, BOARD_TOP + 0.004));
    }
    if (marks.selected) {
      this.markRoot.add(this.flatMesh(this.tileGeo, this.matSelect, marks.selected, BOARD_TOP + 0.006));
    }
    if (marks.check) {
      this.markRoot.add(this.flatMesh(this.checkGeo, this.matCheck, marks.check, BOARD_TOP + 0.008));
    }
    if (marks.hover) {
      this.markRoot.add(this.flatMesh(this.hoverGeo, this.matHover, marks.hover, BOARD_TOP + 0.012));
    }
    for (const t of marks.targets) {
      this.markRoot.add(
        this.flatMesh(t.capture ? this.ringGeo : this.dotGeo, this.matTarget, t.to, BOARD_TOP + 0.01),
      );
    }
  }

  private applyOverlays(arrows: SceneArrow[], circles: string[]): void {
    this.clearGroup(this.overlayRoot);
    for (const g of this.arrowGeos) g.dispose();
    this.arrowGeos = [];
    for (const sq of circles) {
      this.overlayRoot.add(this.flatMesh(this.circleGeo, this.matArrow, sq, BOARD_TOP + 0.014));
    }
    for (const a of arrows) {
      if (a.from === a.to) continue;
      const from = this.squareCenter(a.from);
      const to = this.squareCenter(a.to);
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dz);
      const geo = this.arrowGeometry(len);
      this.arrowGeos.push(geo);
      const mesh = new THREE.Mesh(geo, this.matArrow);
      mesh.position.set(from.x, BOARD_TOP + 0.016, from.z);
      mesh.rotation.x = -Math.PI / 2;
      // Shape points +x; rotate about the (post-tilt) up axis toward (dx, dz).
      mesh.rotation.z = -Math.atan2(dz, dx);
      this.overlayRoot.add(mesh);
    }
  }

  /** Flat arrow shape from (0,0) toward +x with the given length. */
  private arrowGeometry(len: number): THREE.ShapeGeometry {
    const tail = 0.3; // pull the tail off the piece
    const headLen = 0.42;
    const bodyHalf = 0.1;
    const headHalf = 0.24;
    const bodyEnd = Math.max(tail + 0.05, len - headLen);
    const s = new THREE.Shape();
    s.moveTo(tail, -bodyHalf);
    s.lineTo(bodyEnd, -bodyHalf);
    s.lineTo(bodyEnd, -headHalf);
    s.lineTo(len, 0);
    s.lineTo(bodyEnd, headHalf);
    s.lineTo(bodyEnd, bodyHalf);
    s.lineTo(tail, bodyHalf);
    s.closePath();
    return new THREE.ShapeGeometry(s);
  }

  private drawCoords(): void {
    const ctx = this.coordCanvas.getContext('2d');
    if (!ctx) return;
    const size = this.coordCanvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(238, 224, 192, 0.78)';
    ctx.font = `600 ${Math.round(size * 0.032)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const toU = (x: number): number => ((x + SLAB_HALF) / (SLAB_HALF * 2)) * size;
    const toV = (z: number): number => ((z + SLAB_HALF) / (SLAB_HALF * 2)) * size;
    for (let col = 0; col < 8; col++) {
      const label = this.orientation === 'w' ? FILES[col] : FILES[7 - col];
      ctx.fillText(label, toU(col - 3.5), toV(4.3));
    }
    for (let row = 0; row < 8; row++) {
      const label = this.orientation === 'w' ? RANKS[7 - row] : RANKS[row];
      ctx.fillText(label, toU(-4.3), toV(row - 3.5));
    }
    this.coordTexture.needsUpdate = true;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Pull back until the board's near corners fit the horizontal frustum
    // (the near edge sits ~2.6 units in front of the look point along the
    // view axis, hence the offset). Margins are deliberately generous (260721):
    // the board reads smaller so the floating HUD (identity, move list,
    // bottom controls) never collides with it at typical panel sizes; the
    // vertical minimum rose 11 → 14 and the horizontal constant 13.1 → 16.6
    // for roughly a 25% wider framing.
    const d = Math.max(14, 2.6 + 16.6 / aspect);
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = d + 6;
      fog.far = d + 34;
    }
    const look = new THREE.Vector3(0, 0.3, 0.8);
    this.camera.position.set(
      0,
      look.y + Math.sin(CAM_ELEVATION) * d,
      look.z + Math.cos(CAM_ELEVATION) * d,
    );
    this.camera.lookAt(look);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private invalidate(): void {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    let animating = false;
    const done: Anim[] = [];
    for (const a of this.anims) {
      const t = Math.min(1, (now - a.start) / a.dur);
      const e = t * t * (3 - 2 * t); // smoothstep
      a.group.position.lerpVectors(a.from, a.to, e);
      if (t >= 1) done.push(a);
      else animating = true;
    }
    if (done.length) this.anims = this.anims.filter((a) => !done.includes(a));
    // Continuous-drag follower: ease the held piece toward the cursor target.
    // Frame-rate independent (alpha from dt), dt clamped so the first frame
    // after an idle gap does not jump the whole way.
    const drag = this.dragging;
    if (drag?.target) {
      const dt = Math.min(Math.max(now - this.lastFrameAt, 0), 64);
      const alpha = 1 - Math.exp(-dt / DRAG_TAU_MS);
      drag.group.position.lerp(drag.target, alpha);
      if (drag.group.position.distanceToSquared(drag.target) > 1e-6) animating = true;
      else drag.group.position.copy(drag.target);
    }
    this.lastFrameAt = now;
    this.renderer.render(this.scene, this.camera);
    if (animating) this.invalidate();
  };
}
