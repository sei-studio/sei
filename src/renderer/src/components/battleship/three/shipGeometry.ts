/**
 * shipGeometry — low-poly toy ships for the Fleet Battle table.
 *
 * Original toy designs (no real-world or licensed models): a chunky hull with
 * a pointed bow, a red underside below the waterline and a few blocky deck
 * pieces per class. Every ship is ONE merged, vertex-colored geometry, so a
 * whole fleet costs one draw call per ship and one shared material.
 *
 * Local frame: length along +x (bow at +x), centred on the origin, the
 * waterline at y = 0, beam along z. Lengths fit `size` cells of 1 unit.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BATTLESHIPShipName } from '@shared/battleshipIpc';
import { SHIP_SIZES } from '@shared/battleshipIpc';

export interface ShipPalette {
  hull: number;
  bottom: number;
  stripe: number;
  deck: number;
  structure: number;
  gun: number;
  funnel: number;
  accent: number;
}

/** The player's fleet: pale blue-grey toy plastic, red underside. */
export const PLAYER_PALETTE: ShipPalette = {
  hull: 0xa9b6c4,
  bottom: 0xc4473a,
  stripe: 0x30353d,
  deck: 0x7c8794,
  structure: 0xe6eaee,
  gun: 0x8994a1,
  funnel: 0x3b4149,
  accent: 0xf2b430,
};

/** The companion's fleet (only ever seen sunk): darker gunmetal. */
export const ENEMY_PALETTE: ShipPalette = {
  hull: 0x6a7079,
  bottom: 0x8a3c31,
  stripe: 0x2a2d33,
  deck: 0x4c525a,
  structure: 0x949ba4,
  gun: 0x5a6069,
  funnel: 0x2a2d33,
  accent: 0xd8473b,
};

/** Hull height above the waterline (deck level), for pegs on deck. */
export const DECK_Y = 0.16;
const KEEL_Y = -0.13;

function paint(geo: THREE.BufferGeometry, color: number | ((y: number, ny: number) => number)): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const hex = typeof color === 'number' ? color : color(pos.getY(i), nrm.getY(i));
    c.setHex(hex);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Uniform attribute set for merging.
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}

function cyl(r: number, h: number, x: number, y: number, z: number, color: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r * 1.04, h, seg);
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}

/** A twin-barrel gun turret facing +x (dir 1) or -x (dir -1). */
function turret(x: number, y: number, dir: 1 | -1, p: ShipPalette, scale = 1): THREE.BufferGeometry[] {
  const r = 0.15 * scale;
  const parts = [cyl(r, 0.09 * scale, x, y, 0, p.gun, 12)];
  const barrel = 0.3 * scale;
  for (const z of [-0.045 * scale, 0.045 * scale]) {
    parts.push(box(barrel, 0.035 * scale, 0.035 * scale, x + dir * (r * 0.6 + barrel / 2), y + 0.03 * scale, z, p.gun));
  }
  return parts;
}

/** Pointed-bow hull, two-tone by height (red below the waterline). */
function hull(len: number, beam: number, p: ShipPalette, deckTop = DECK_Y): THREE.BufferGeometry {
  const half = len / 2;
  const b = beam / 2;
  const bow = Math.min(0.7, len * 0.28);
  const s = new THREE.Shape();
  s.moveTo(-half, -b * 0.82);
  s.lineTo(half - bow, -b);
  s.quadraticCurveTo(half - bow * 0.2, -b * 0.7, half, 0);
  s.quadraticCurveTo(half - bow * 0.2, b * 0.7, half - bow, b);
  s.lineTo(-half, b * 0.82);
  s.quadraticCurveTo(-half - 0.1, 0, -half, -b * 0.82);
  const bevel = 0.03;
  const depth = deckTop - KEEL_Y - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: 0.025,
    bevelSegments: 1,
    curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, KEEL_Y + bevel, 0);
  return paint(g, (y, ny) => {
    if (ny > 0.9 && y > deckTop - 0.02) return p.deck;
    if (y < -0.035) return p.bottom;
    if (y < -0.005) return p.stripe;
    return p.hull;
  });
}

function build(name: BATTLESHIPShipName, p: ShipPalette): THREE.BufferGeometry {
  const len = SHIP_SIZES[name] - 0.16;
  const d = DECK_Y;
  const parts: THREE.BufferGeometry[] = [];
  switch (name) {
    case 'carrier': {
      parts.push(hull(len, 0.66, p, d - 0.02));
      // Overhanging flight deck with a centre stripe and an island.
      parts.push(box(len * 0.96, 0.06, 0.84, -0.05, d - 0.02, 0, p.deck));
      parts.push(box(len * 0.8, 0.008, 0.035, -0.1, d + 0.04, 0, p.structure));
      parts.push(box(0.16, 0.008, 0.035, len * 0.33, d + 0.04, 0, p.accent));
      parts.push(box(0.62, 0.3, 0.17, 0.45, d + 0.04, 0.31, p.structure));
      parts.push(box(0.3, 0.12, 0.13, 0.45, d + 0.34, 0.31, p.hull));
      parts.push(cyl(0.02, 0.28, 0.6, d + 0.4, 0.31, p.gun, 6));
      break;
    }
    case 'battleship': {
      parts.push(hull(len, 0.66, p));
      parts.push(box(1.15, 0.2, 0.42, -0.1, d, 0, p.structure));
      parts.push(box(0.5, 0.2, 0.32, 0.15, d + 0.2, 0, p.structure));
      parts.push(box(0.22, 0.1, 0.36, 0.25, d + 0.4, 0, p.hull));
      parts.push(cyl(0.11, 0.32, -0.42, d + 0.2, 0, p.funnel));
      parts.push(cyl(0.02, 0.36, 0.2, d + 0.5, 0, p.gun, 6));
      parts.push(...turret(1.05, d, 1, p));
      parts.push(...turret(0.68, d + 0.06, 1, p, 0.85));
      parts.push(...turret(-1.15, d, -1, p));
      break;
    }
    case 'cruiser': {
      parts.push(hull(len, 0.58, p));
      parts.push(box(0.85, 0.18, 0.36, -0.05, d, 0, p.structure));
      parts.push(box(0.36, 0.17, 0.28, 0.12, d + 0.18, 0, p.structure));
      parts.push(cyl(0.09, 0.26, -0.3, d + 0.18, 0, p.funnel));
      parts.push(cyl(0.018, 0.3, 0.15, d + 0.35, 0, p.gun, 6));
      parts.push(...turret(0.78, d, 1, p, 0.85));
      parts.push(...turret(-0.85, d, -1, p, 0.85));
      break;
    }
    case 'submarine': {
      const body = new THREE.CapsuleGeometry(0.19, len - 0.38, 6, 12);
      body.rotateZ(Math.PI / 2);
      body.scale(1, 0.85, 1);
      body.translate(0, 0.02, 0);
      parts.push(paint(body, (y) => (y < -0.06 ? p.bottom : y < -0.035 ? p.stripe : p.hull)));
      parts.push(box(0.5, 0.26, 0.15, 0.2, 0.12, 0, p.structure));
      parts.push(box(0.22, 0.02, 0.36, 0.25, 0.3, 0, p.hull));
      parts.push(cyl(0.02, 0.22, 0.32, 0.36, 0, p.gun, 6));
      // Tail fins.
      parts.push(box(0.16, 0.02, 0.42, -len / 2 + 0.18, 0.02, 0, p.hull));
      break;
    }
    case 'destroyer':
    default: {
      parts.push(hull(len, 0.5, p));
      parts.push(box(0.52, 0.18, 0.3, -0.05, d, 0, p.structure));
      parts.push(box(0.24, 0.13, 0.24, 0.05, d + 0.18, 0, p.structure));
      parts.push(cyl(0.075, 0.22, -0.32, d + 0.1, 0, p.funnel));
      parts.push(...turret(0.55, d, 1, p, 0.75));
      break;
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error(`ship geometry merge failed: ${name}`);
  merged.computeBoundingSphere();
  return merged;
}

/** Builds and caches one geometry per class and palette; dispose() frees them. */
export class ShipLibrary {
  private cache = new Map<string, THREE.BufferGeometry>();
  readonly material: THREE.MeshStandardMaterial;
  /** Translucent material for placement ghosts (tinted per validity). */
  readonly ghostOk: THREE.MeshStandardMaterial;
  readonly ghostBad: THREE.MeshStandardMaterial;

  constructor() {
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.04 });
    this.ghostOk = new THREE.MeshStandardMaterial({
      color: 0x9ff0c0,
      emissive: new THREE.Color(0x3fbf7a),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.ghostBad = new THREE.MeshStandardMaterial({
      color: 0xff9a8a,
      emissive: new THREE.Color(0xd8473b),
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
  }

  geometry(name: BATTLESHIPShipName, palette: ShipPalette): THREE.BufferGeometry {
    const key = `${name}:${palette.hull}`;
    let g = this.cache.get(key);
    if (!g) {
      g = build(name, palette);
      this.cache.set(key, g);
    }
    return g;
  }

  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
    this.material.dispose();
    this.ghostOk.dispose();
    this.ghostBad.dispose();
  }
}
