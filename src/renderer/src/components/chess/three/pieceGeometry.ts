/**
 * pieceGeometry — procedural 3D chess pieces (turned/lathe silhouettes).
 *
 * Every piece is built from primitives at runtime, no model files:
 *   - pawn/rook/bishop/queen/king are LatheGeometry profiles (a classic
 *     "turned wood" Staunton-ish silhouette);
 *   - the rook gets four merlon boxes on the rim (crenellations);
 *   - the knight is a lathe base plus an extruded horse-head silhouette;
 *   - the bishop gets a slanted trim plate suggesting the mitre cut;
 *   - the queen gets coronet balls, the king a cross finial.
 *
 * Piece colors are 3D art-asset values (cream vs walnut), literal by design,
 * same precedent as the 2D piece SVGs in pieces.tsx.
 */

import * as THREE from 'three';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PieceColor = 'w' | 'b';

type Pt = [number, number]; // [radius, y]

const deg = (d: number): number => (d * Math.PI) / 180;

/** Sample a circular arc into lathe profile points (round heads / domes). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([Math.max(0, cx + r * Math.cos(a)), cy + r * Math.sin(a)]);
  }
  return out;
}

function lathe(points: Pt[], segments = 40): THREE.LatheGeometry {
  const geo = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
  geo.computeVertexNormals();
  return geo;
}

// ── Lathe profiles (radius, height), base at y=0 ─────────────────────────────

const PAWN: Pt[] = [
  [0.3, 0],
  [0.3, 0.05],
  [0.27, 0.09],
  [0.19, 0.13],
  [0.135, 0.22],
  [0.105, 0.34],
  [0.095, 0.42],
  [0.16, 0.46],
  [0.16, 0.49],
  [0.09, 0.52],
  ...arc(0, 0.64, 0.15, deg(-55), deg(90), 10),
];

const ROOK: Pt[] = [
  [0.32, 0],
  [0.32, 0.06],
  [0.29, 0.1],
  [0.22, 0.15],
  [0.185, 0.25],
  [0.17, 0.45],
  [0.185, 0.55],
  [0.25, 0.6],
  [0.26, 0.63],
  [0.26, 0.78],
  [0.2, 0.78],
  [0.2, 0.7],
  [0.13, 0.7],
  [0.13, 0.72],
  [0, 0.72],
];

const KNIGHT_BASE: Pt[] = [
  [0.32, 0],
  [0.32, 0.06],
  [0.28, 0.1],
  [0.22, 0.15],
  [0.19, 0.2],
  [0.21, 0.26],
  [0.23, 0.3],
  [0, 0.3],
];

const BISHOP: Pt[] = [
  [0.3, 0],
  [0.3, 0.055],
  [0.27, 0.095],
  [0.2, 0.14],
  [0.14, 0.24],
  [0.105, 0.4],
  [0.095, 0.52],
  [0.17, 0.57],
  [0.17, 0.6],
  [0.1, 0.63],
  ...arc(0, 0.76, 0.155, deg(-70), deg(55), 8),
  [0.06, 0.93],
  [0, 1.0],
];

const QUEEN: Pt[] = [
  [0.34, 0],
  [0.34, 0.06],
  [0.3, 0.11],
  [0.23, 0.16],
  [0.16, 0.28],
  [0.12, 0.46],
  [0.105, 0.62],
  [0.175, 0.68],
  [0.175, 0.71],
  [0.105, 0.74],
  [0.19, 0.92],
  [0.22, 0.99],
  [0.145, 1.0],
  [0.1, 1.02],
  ...arc(0, 1.06, 0.09, deg(-30), deg(90), 8),
];

const KING: Pt[] = [
  [0.35, 0],
  [0.35, 0.06],
  [0.31, 0.11],
  [0.24, 0.17],
  [0.17, 0.3],
  [0.125, 0.5],
  [0.11, 0.68],
  [0.18, 0.74],
  [0.18, 0.77],
  [0.11, 0.8],
  [0.2, 0.99],
  [0.22, 1.06],
  [0.14, 1.08],
  [0.09, 1.1],
  ...arc(0, 1.13, 0.085, deg(-20), deg(90), 8),
];

/** Extruded horse-head silhouette for the knight (faces +x pre-rotation). */
function knightHeadGeometry(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.18, 0.22);
  s.lineTo(-0.21, 0.48);
  s.quadraticCurveTo(-0.19, 0.62, -0.13, 0.7);
  s.lineTo(-0.08, 0.8); // back of the ear
  s.lineTo(-0.02, 0.93); // ear tip
  s.lineTo(0.04, 0.79); // ear front
  s.quadraticCurveTo(0.12, 0.75, 0.17, 0.68); // forehead
  s.quadraticCurveTo(0.25, 0.58, 0.28, 0.48); // nose bridge
  s.lineTo(0.26, 0.4); // muzzle tip
  s.quadraticCurveTo(0.18, 0.36, 0.12, 0.37); // mouth
  s.lineTo(0.09, 0.28); // jaw
  s.quadraticCurveTo(0.05, 0.23, 0.02, 0.21); // chest
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.13,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.03,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geo.translate(0, 0, -0.065 - 0.035); // center the extrusion on z=0
  return geo;
}

export interface PieceLibrary {
  /** New group for a piece; geometry and materials are shared library-wide. */
  build(type: PieceType, color: PieceColor): THREE.Group;
  /** Approximate piece height (for camera/label placement if needed). */
  heightOf(type: PieceType): number;
  dispose(): void;
}

const HEIGHTS: Record<PieceType, number> = {
  p: 0.79,
  r: 0.92,
  n: 1.1,
  b: 1.05,
  q: 1.21,
  k: 1.38,
};

export function createPieceLibrary(): PieceLibrary {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  const mat = (color: number, roughness: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 });
    materials.push(m);
    return m;
  };

  // Light cream vs dark walnut, with a darker trim shade for the mitre cut.
  const body: Record<PieceColor, THREE.MeshStandardMaterial> = {
    w: mat(0xe9dfc6, 0.3),
    b: mat(0x46281a, 0.38),
  };
  const trim: Record<PieceColor, THREE.MeshStandardMaterial> = {
    w: mat(0xb5a273, 0.45),
    b: mat(0x241109, 0.5),
  };

  const bodies: Record<PieceType, THREE.BufferGeometry> = {
    p: track(lathe(PAWN)),
    r: track(lathe(ROOK)),
    n: track(lathe(KNIGHT_BASE)),
    b: track(lathe(BISHOP)),
    q: track(lathe(QUEEN)),
    k: track(lathe(KING)),
  };

  const merlon = track(new THREE.BoxGeometry(0.1, 0.15, 0.07));
  const knightHead = track(knightHeadGeometry());
  const bishopBall = track(new THREE.SphereGeometry(0.048, 16, 12));
  const bishopSlit = track(new THREE.BoxGeometry(0.19, 0.02, 0.13));
  const coronetBall = track(new THREE.SphereGeometry(0.034, 12, 10));
  const queenTopBall = track(new THREE.SphereGeometry(0.042, 14, 12));
  const crossV = track(new THREE.BoxGeometry(0.05, 0.21, 0.05));
  const crossH = track(new THREE.BoxGeometry(0.155, 0.05, 0.05));

  function mesh(geo: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
    const out = new THREE.Mesh(geo, m);
    out.castShadow = true;
    out.receiveShadow = false;
    return out;
  }

  function build(type: PieceType, color: PieceColor): THREE.Group {
    const g = new THREE.Group();
    const bm = body[color];
    g.add(mesh(bodies[type], bm));

    if (type === 'r') {
      // Crenellations: four merlons around the rim.
      for (let i = 0; i < 4; i++) {
        const a = deg(45) + (i * Math.PI) / 2;
        const m = mesh(merlon, bm);
        m.position.set(Math.sin(a) * 0.225, 0.83, Math.cos(a) * 0.225);
        m.rotation.y = a;
        g.add(m);
      }
    } else if (type === 'n') {
      const head = mesh(knightHead, bm);
      head.position.y = 0.06;
      // Shape faces +x; turn it to face +z (the scene orients per side).
      head.rotation.y = -Math.PI / 2;
      g.add(head);
    } else if (type === 'b') {
      const ball = mesh(bishopBall, bm);
      ball.position.y = 1.01;
      g.add(ball);
      // Mitre cut: a slanted darker plate across the head's front.
      const slit = mesh(bishopSlit, trim[color]);
      slit.position.set(0, 0.8, 0.1);
      slit.rotation.x = deg(-38);
      g.add(slit);
    } else if (type === 'q') {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const b = mesh(coronetBall, bm);
        b.position.set(Math.sin(a) * 0.195, 1.0, Math.cos(a) * 0.195);
        g.add(b);
      }
      const top = mesh(queenTopBall, bm);
      top.position.y = 1.17;
      g.add(top);
    } else if (type === 'k') {
      const v = mesh(crossV, bm);
      v.position.y = 1.3;
      g.add(v);
      const h = mesh(crossH, bm);
      h.position.y = 1.31;
      g.add(h);
    }
    return g;
  }

  return {
    build,
    heightOf: (type) => HEIGHTS[type],
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
