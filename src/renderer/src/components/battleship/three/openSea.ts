/**
 * The open sea Fleet Battle is played on: bright, stylized daytime water out
 * to a horizon, a painted sky with drifting toy clouds, a couple of islands
 * and rocks. The two 10x10 grids are areas marked on the water itself (the
 * sea shader draws their grid lines and a lighter lagoon tint; FleetScene adds
 * the rope-and-float borders and the floating coordinate markers).
 *
 * Built as Fleet Battle's TabletopStage environment (openSeaEnvironment: the
 * sun, sky fill, haze) plus the OpenSea object for everything that follows
 * the camera:
 *   - the horizon is a fake one, which is what keeps the camera steep enough
 *     for readable grids. The sea is a plane that ends at the distance where
 *     a screen ray a set fraction below the top meets the water; fog fades it
 *     to the haze color by that edge, and a sky quad covers the screen above
 *     that line. layout() recomputes all of it when the framing changes, so
 *     the horizon sits in the same place at every panel size;
 *   - cost: the sky is one quad covering only the sky band (no full-frame
 *     background pass), the sea is one plane and one material, the islands
 *     are a handful of low-poly meshes. Nothing here runs per frame except
 *     the shared time uniform, which the ambient tier advances.
 *
 * Colors are 3D art-asset values (literal by design, like the chess scene).
 */

import * as THREE from 'three';
import { makeKeyLight, type StageEnvironment, type TabletopStage } from '../../tabletop/TabletopStage';

export const SEA_LEVEL = 0.33;
/** The haze the sea fades into at the horizon (also the clear color). */
const C_HAZE = 0xa6dcec;
const C_DEEP = 0x1679b4;
const C_SHALLOW = 0x35b4d8;
const C_FOAM = 0xf2fdff;
const C_LAGOON = 0x7fe0e6;
const C_LINE = 0xf4fdff;
const C_SKY_TOP = 0x4aaef2;
const C_SKY_LOW = 0xbfe6fb;

/** Where the horizon sits, as a fraction of the panel height from the top. */
export const HORIZON_FRAC = 0.13;

/** Sun, sky fill and haze. The sea and sky meshes come from OpenSea. */
export const openSeaEnvironment: StageEnvironment = (stage) => {
  const scene = stage.scene;
  scene.background = null;
  stage.renderer.setClearColor(C_HAZE, 1);
  scene.fog = new THREE.Fog(C_HAZE, 40, 90);
  scene.add(new THREE.HemisphereLight(0xdff3ff, 0x2f86a8, 1.25));
  const key = makeKeyLight({
    color: 0xfff1d6,
    intensity: 2.7,
    position: [7, 16, 10],
    mapSize: 2048,
    extent: 13,
    radius: 3,
    shadowIntensity: 0.62,
  });
  scene.add(key, key.target);
  return { key };
};

export interface SeaPatch {
  x: number;
  z: number;
  half: number;
}

export class OpenSea {
  readonly time = { value: 0 };
  private readonly stage: TabletopStage;
  private readonly sea: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms: { uHorizon: { value: number }; uSize: { value: THREE.Vector2 }; uTime: { value: number } };
  private readonly patchUniforms: { value: THREE.Vector4 }[];
  /** Things that ride the horizon (islands), with their offset from it. */
  /** Horizon props: `fx` is the signed fraction of the half view width they sit at. */
  private readonly far: Array<{ obj: THREE.Object3D; fx: number; dz: number }> = [];
  /** z of the sea's far edge (the horizon) after the last layout. */
  horizonZ = -40;

  constructor(stage: TabletopStage, patches: SeaPatch[]) {
    this.stage = stage;
    const own = stage.own.bind(stage);
    const scene = stage.scene;
    stage.camera.far = 600;

    // ── Sea ──
    const seaGeo = own(new THREE.PlaneGeometry(1, 1, 1, 1));
    seaGeo.rotateX(-Math.PI / 2);
    this.patchUniforms = patches.map((p) => ({ value: new THREE.Vector4(p.x, p.z, p.half, 1) }));
    this.sea = new THREE.Mesh(seaGeo, this.makeSeaMaterial());
    this.sea.position.y = SEA_LEVEL;
    this.sea.receiveShadow = true;
    this.sea.frustumCulled = false;
    scene.add(this.sea);

    // ── Sky: one quad over the band above the horizon ──
    this.skyUniforms = { uHorizon: { value: 0.7 }, uSize: { value: new THREE.Vector2(1, 1) }, uTime: this.time };
    const skyMat = own(
      new THREE.ShaderMaterial({
        uniforms: {
          ...this.skyUniforms,
          uTop: { value: new THREE.Color(C_SKY_TOP) },
          uLow: { value: new THREE.Color(C_SKY_LOW) },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1)), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;
    scene.add(this.sky);

    this.buildIslands();
  }

  /** 0..1 how strongly each patch's grid is marked (the harbor hides one). */
  setPatchStrength(i: number, v: number): void {
    this.patchUniforms[i].value.w = v;
  }

  /**
   * Fit the sea, haze and sky to the current camera: the horizon lands
   * HORIZON_FRAC below the top of the panel, but never closer than `minFar`
   * (just beyond the grids), and the haze starts after `clearZ`.
   */
  layout(viewH: number, viewW: number, clearZ: number, minFar: number): void {
    const cam = this.stage.camera;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const ray = new THREE.Vector3(0, 1 - 2 * HORIZON_FRAC, 0.5).unproject(cam).sub(cam.position).normalize();
    let zFar = -260;
    if (ray.y < -1e-4) zFar = cam.position.z + ray.z * ((SEA_LEVEL - cam.position.y) / ray.y);
    zFar = THREE.MathUtils.clamp(zFar, -260, minFar);
    this.horizonZ = zFar;

    const zNear = cam.position.z + 40;
    this.sea.scale.set(900, 1, zNear - zFar);
    this.sea.position.set(cam.position.x, SEA_LEVEL, (zNear + zFar) / 2);

    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    const depth = (z: number): number => new THREE.Vector3(0, SEA_LEVEL, z).sub(cam.position).dot(forward);
    const fog = this.stage.scene.fog as THREE.Fog;
    const far = depth(zFar);
    fog.far = far;
    fog.near = Math.min(far - 2, Math.max(depth(clearZ) + 1.5, far * 0.55));

    const h = new THREE.Vector3(cam.position.x, SEA_LEVEL, zFar).project(cam).y;
    this.skyUniforms.uHorizon.value = THREE.MathUtils.clamp(h, -1, 1);
    this.skyUniforms.uSize.value.set(viewW, Math.max(1, ((1 - h) / 2) * viewH));
    // Props keep their place in the picture whatever the panel's shape.
    const tanW = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect;
    for (const f of this.far) {
      const z = zFar + f.dz;
      f.obj.position.set(cam.position.x + f.fx * depth(z) * tanW, 0, z);
    }
  }

  // ── Building ───────────────────────────────────────────────────────────────

  private makeSeaMaterial(): THREE.MeshStandardMaterial {
    const mat = this.stage.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0 }));
    const uniforms: Record<string, { value: unknown }> = {
      uTime: this.time,
      uDeep: { value: new THREE.Color(C_DEEP) },
      uShallow: { value: new THREE.Color(C_SHALLOW) },
      uFoam: { value: new THREE.Color(C_FOAM) },
      uLagoon: { value: new THREE.Color(C_LAGOON) },
      uLine: { value: new THREE.Color(C_LINE) },
      uPatchA: this.patchUniforms[0],
      uPatchB: this.patchUniforms[1],
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSea;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSea = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SEA_FRAGMENT_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${SEA_FRAGMENT_COLOR}`);
    };
    mat.customProgramCacheKey = () => 'fleet-open-sea-v2';
    return mat;
  }

  /** A sandy island with a palm on the horizon at each side, and a few rocks. */
  private buildIslands(): void {
    const own = this.stage.own.bind(this.stage);
    const scene = this.stage.scene;
    const flat = (color: number): THREE.MeshStandardMaterial =>
      own(new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }));
    const sand = flat(0xf3dfae);
    const grass = flat(0x7ccb64);
    const trunk = flat(0xa9774a);
    const leaf = flat(0x3fae5c);
    const rock = flat(0x9eabb3);
    const foam = own(new THREE.MeshBasicMaterial({ color: C_FOAM, transparent: true, opacity: 0.7, depthWrite: false }));

    const sandGeo = own(new THREE.CylinderGeometry(2.4, 3.0, 0.7, 12));
    const hillGeo = own(new THREE.IcosahedronGeometry(1.9, 1));
    hillGeo.scale(1.15, 0.55, 1);
    const trunkGeo = own(new THREE.CylinderGeometry(0.09, 0.14, 2.0, 6));
    trunkGeo.translate(0, 1, 0);
    const leafGeo = own(new THREE.ConeGeometry(0.42, 1.5, 4));
    leafGeo.rotateZ(Math.PI / 2);
    leafGeo.scale(1, 0.25, 1);
    leafGeo.translate(0.75, 0, 0);
    const foamGeo = own(new THREE.RingGeometry(3.0, 3.5, 24));
    foamGeo.rotateX(-Math.PI / 2);
    const rockGeo = own(new THREE.DodecahedronGeometry(0.7, 0));

    const island = (fx: number, dz: number, s: number, palms: number): void => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(sandGeo, sand);
      base.position.y = SEA_LEVEL + 0.05;
      const hill = new THREE.Mesh(hillGeo, grass);
      hill.position.set(-0.3, SEA_LEVEL + 0.4, 0.2);
      const ring = new THREE.Mesh(foamGeo, foam);
      ring.position.y = SEA_LEVEL + 0.01;
      g.add(base, hill, ring);
      for (let i = 0; i < palms; i++) {
        const palm = new THREE.Group();
        palm.position.set(0.9 - i * 1.3, SEA_LEVEL + 0.45, -0.3 + i * 0.5);
        palm.rotation.z = 0.18 - i * 0.3;
        palm.add(new THREE.Mesh(trunkGeo, trunk));
        for (let k = 0; k < 5; k++) {
          const l = new THREE.Mesh(leafGeo, leaf);
          l.position.y = 2.0;
          l.rotation.set(0, (k / 5) * Math.PI * 2 + i, -0.35);
          palm.add(l);
        }
        g.add(palm);
      }
      g.scale.setScalar(s);
      scene.add(g);
      this.far.push({ obj: g, fx, dz });
    };
    island(-0.8, 3.2, 0.8, 2);
    island(0.84, 2.7, 0.65, 1);

    const rocks = (fx: number, dz: number, s: number): void => {
      const g = new THREE.Group();
      for (const [rx, rz, rs, ry] of [
        [0, 0, 1, 0.3],
        [0.9, 0.4, 0.6, 1.2],
        [-0.7, 0.5, 0.45, 2.1],
      ] as const) {
        const m = new THREE.Mesh(rockGeo, rock);
        m.position.set(rx, SEA_LEVEL + 0.1 * rs, rz);
        m.scale.set(rs, rs * 0.7, rs);
        m.rotation.y = ry;
        g.add(m);
      }
      const ring = new THREE.Mesh(foamGeo, foam);
      ring.scale.setScalar(0.45);
      ring.position.y = SEA_LEVEL + 0.01;
      g.add(ring);
      g.scale.setScalar(s);
      scene.add(g);
      this.far.push({ obj: g, fx, dz });
    };
    rocks(-0.97, 2.5, 0.7);
    rocks(0.5, 1.2, 0.5);
  }
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const SEA_FRAGMENT_PARS = /* glsl */ `
varying vec2 vSea;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uLagoon;
uniform vec3 uLine;
uniform vec4 uPatchA;
uniform vec4 uPatchB;

// A grid area on the water: lighter lagoon tint, a faint checker and crisp
// cell lines, faded in by P.w (0 = plain sea).
float patchMask(vec4 P, vec2 p) {
  vec2 g = p - P.xy + P.z;
  vec2 e = min(g, 2.0 * P.z - g);
  return smoothstep(-0.04, 0.04, min(e.x, e.y)) * P.w;
}

vec3 seaPatch(vec3 col, vec4 P, vec2 p) {
  if (P.w <= 0.001) return col;
  vec2 g = p - P.xy + P.z;
  float inside = patchMask(P, p);
  if (inside <= 0.0) return col;
  vec3 c = mix(col, uLagoon, 0.32);
  float chk = mod(floor(g.x) + floor(g.y), 2.0);
  c *= 1.0 - chk * 0.045;
  vec2 f = abs(fract(g) - 0.5);
  vec2 fw = fwidth(g);
  vec2 l = smoothstep(0.5 - fw * 1.7, 0.5 - fw * 0.35, f);
  c = mix(c, uLine, max(l.x, l.y) * 0.62);
  return mix(col, c, inside);
}
`;

const SEA_FRAGMENT_COLOR = /* glsl */ `
{
  vec2 p = vSea;
  float t = uTime;
  float w1 = sin(p.x * 0.42 + t * 0.55 + sin(p.y * 0.31 + t * 0.3) * 1.5);
  float w2 = sin(p.y * 0.55 - t * 0.45 + sin(p.x * 0.27 - t * 0.22) * 1.3);
  float w = 0.5 + 0.25 * (w1 + w2);
  vec3 col = mix(uDeep, uShallow, 0.3 + 0.5 * w);
  // Toy foam: thin bright crests that roll with the swell.
  float crest = sin(p.x * 0.38 + p.y * 1.05 + t * 0.85 + w1 * 0.5);
  float fw = fwidth(crest);
  // (Calm inside the areas so the grid reads clean.)
  float calm = (1.0 - patchMask(uPatchA, p)) * (1.0 - patchMask(uPatchB, p));
  col = mix(col, uFoam, smoothstep(0.988 - fw, 0.997, crest) * (0.2 + 0.2 * w2) * calm);
  col = seaPatch(col, uPatchA, p);
  col = seaPatch(col, uPatchB, p);
  diffuseColor.rgb = col;
}
`;

const SKY_VERTEX = /* glsl */ `
uniform float uHorizon;
varying vec2 vSky;
void main() {
  float y = mix(uHorizon, 1.0, position.y + 0.5);
  vSky = vec2(position.x + 0.5, position.y + 0.5);
  gl_Position = vec4(position.x * 2.0, y, 0.0, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uLow;
uniform vec2 uSize;
uniform float uTime;
varying vec2 vSky;

// One toy cloud: a few overlapping puffs over a flat base, in pixels.
float cloud(vec2 q, vec2 c, float s) {
  float d = 0.0;
  d = max(d, 1.0 - length((q - c - vec2(0.0, 4.0) * s) / (vec2(22.0, 13.0) * s)));
  d = max(d, 1.0 - length((q - c - vec2(-17.0, 0.0) * s) / (vec2(15.0, 10.0) * s)));
  d = max(d, 1.0 - length((q - c - vec2(18.0, -1.0) * s) / (vec2(17.0, 10.0) * s)));
  d *= step(c.y - 7.0 * s, q.y);
  return smoothstep(0.0, 0.08, d);
}

void main() {
  vec2 q = vSky * uSize;
  vec3 col = mix(uLow, uTop, smoothstep(0.0, 1.0, vSky.y));
  float span = uSize.x + 240.0;
  float drift = uTime * 4.0;
  float c = 0.0;
  c = max(c, cloud(q, vec2(mod(0.18 * uSize.x + drift, span) - 120.0, uSize.y * 0.42), 1.0));
  c = max(c, cloud(q, vec2(mod(0.55 * uSize.x + drift * 0.8, span) - 120.0, uSize.y * 0.62), 0.8));
  c = max(c, cloud(q, vec2(mod(0.86 * uSize.x + drift * 1.1, span) - 120.0, uSize.y * 0.36), 1.15));
  vec3 cloudCol = mix(vec3(0.86, 0.92, 0.98), vec3(1.0), smoothstep(0.3, 0.75, fract(q.y / max(uSize.y, 1.0)) ));
  col = mix(col, cloudCol, c * 0.95);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
