/**
 * The water Fleet Battle is played on, seen from above: bright, calm sea
 * with a gentle swell, sunlight caustics and a few glints. The two 10x10
 * grids are areas marked on the water (a lighter lagoon tint and crisp cell
 * lines, drawn here; FleetScene adds the rope-and-float borders and the
 * floating coordinate markers).
 *
 * Cost is the point of this design (the app shares the machine with a
 * Minecraft bot). The moving water is NOT rendered by WebGL: it is a short
 * seamless loop video (sea-loop.mp4, made offline by
 * scripts/render-sea-loop.mjs) playing behind a transparent canvas, so it
 * costs a hardware video decode. The 3D scene above it stays on-demand and
 * only redraws when a board, ship or marker changes. In the scene the water
 * is three flat layers at sea level:
 *   - a depth-only occluder, so hulls and anything below the waterline
 *     disappear into the water (the video shows through);
 *   - a shadow catcher, so ships and pegs still cast soft shadows on it;
 *   - the two grid areas (lagoon tint, faint checker, cell lines).
 *
 * The video pauses on its current frame whenever nobody is watching: a hidden
 * document, an unfocused window (the player is in Minecraft) and reduced
 * motion (which never starts it). Software-GL machines get it too: decoding a
 * video is cheap there, unlike a per-frame scene render.
 *
 * Colors are 3D art-asset values (literal by design, like the chess scene).
 */

import * as THREE from 'three';
import { makeKeyLight, type StageEnvironment, type TabletopStage } from '../../tabletop/TabletopStage';
import seaLoopUrl from './sea-loop.mp4';

export const SEA_LEVEL = 0.33;
/** Mean color of the water video (the page shows it until the first frame). */
export const SEA_COLOR = 0x2b9fcb;
const C_LAGOON = 0x8fe6ee;
const C_LINE = 0xf4fdff;
const C_SHADOW = 0x05324a;

/** Sun and sky fill. The water itself is the video behind the canvas. */
export const openSeaEnvironment: StageEnvironment = (stage) => {
  const scene = stage.scene;
  scene.background = null;
  scene.fog = null;
  stage.renderer.setClearColor(SEA_COLOR, 0);
  scene.add(new THREE.HemisphereLight(0xdff3ff, 0x2f86a8, 1.25));
  const key = makeKeyLight({
    color: 0xfff1d6,
    intensity: 2.7,
    position: [6, 18, 7],
    mapSize: 2048,
    extent: 14,
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
  private readonly stage: TabletopStage;
  private readonly patches: Array<{ mesh: THREE.Mesh; strength: { value: number } }> = [];
  private readonly video: HTMLVideoElement;
  private disposed = false;
  private readonly onVisibility = (): void => this.updatePlayback();
  private readonly onFocus = (): void => {
    this.focused = true;
    this.updatePlayback();
  };
  private readonly onBlur = (): void => {
    this.focused = false;
    this.updatePlayback();
  };
  private focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

  constructor(stage: TabletopStage, patches: SeaPatch[]) {
    this.stage = stage;
    const own = stage.own.bind(stage);
    const scene = stage.scene;

    // ── The water surface: occluder, then shadows on it ──
    const plane = own(new THREE.PlaneGeometry(120, 80));
    plane.rotateX(-Math.PI / 2);
    const occluder = new THREE.Mesh(plane, own(new THREE.MeshBasicMaterial({ colorWrite: false })));
    occluder.position.y = SEA_LEVEL;
    occluder.renderOrder = -10;
    scene.add(occluder);
    const catcher = new THREE.Mesh(
      plane,
      own(new THREE.ShadowMaterial({ color: C_SHADOW, opacity: 0.32, depthWrite: false })),
    );
    catcher.position.y = SEA_LEVEL + 0.002;
    catcher.receiveShadow = true;
    scene.add(catcher);

    // ── The grid areas ──
    for (const p of patches) {
      const strength = { value: 1 };
      const geo = own(new THREE.PlaneGeometry(p.half * 2 + 0.2, p.half * 2 + 0.2));
      geo.rotateX(-Math.PI / 2);
      const mat = own(
        new THREE.ShaderMaterial({
          uniforms: {
            uHalf: { value: p.half },
            uStrength: strength,
            uLagoon: { value: new THREE.Color(C_LAGOON) },
            uLine: { value: new THREE.Color(C_LINE) },
          },
          vertexShader: PATCH_VERTEX,
          fragmentShader: PATCH_FRAGMENT,
          transparent: true,
          depthWrite: false,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, SEA_LEVEL + 0.003, p.z);
      mesh.renderOrder = -5;
      scene.add(mesh);
      this.patches.push({ mesh, strength });
    }

    // ── The moving water: a looping video behind the transparent canvas ──
    const v = document.createElement('video');
    v.src = seaLoopUrl;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    Object.assign(v.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      pointerEvents: 'none',
    });
    this.video = v;
    const canvas = stage.renderer.domElement;
    canvas.style.position = 'relative';
    stage.container.insertBefore(v, canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('blur', this.onBlur);
    this.updatePlayback();
  }

  /** 0..1 how strongly each area is marked (the harbor hides the companion's). */
  setPatchStrength(i: number, v: number): void {
    const p = this.patches[i];
    p.strength.value = v;
    p.mesh.visible = v > 0.001;
  }

  /** Whether the water is moving right now (for tests and probes). */
  get playing(): boolean {
    return !this.video.paused;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('blur', this.onBlur);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }

  /** Play while someone can see it; otherwise hold the current frame. */
  private updatePlayback(): void {
    if (this.disposed) return;
    const watch = !document.hidden && this.focused && !this.stage.reducedMotion;
    if (watch && this.video.paused) {
      // Autoplay of a muted video is allowed; a rejection (a test DOM without
      // media) just leaves the still frame.
      void this.video.play().catch(() => undefined);
    } else if (!watch && !this.video.paused) {
      this.video.pause();
    }
  }
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const PATCH_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// A grid area on the water: lighter lagoon tint, a faint checker and crisp
// cell lines, faded in by uStrength (0 = plain sea).
const PATCH_FRAGMENT = /* glsl */ `
uniform float uHalf;
uniform float uStrength;
uniform vec3 uLagoon;
uniform vec3 uLine;
varying vec2 vLocal;
void main() {
  vec2 g = vLocal + uHalf;
  vec2 e = min(g, 2.0 * uHalf - g);
  float inside = smoothstep(-0.04, 0.04, min(e.x, e.y)) * uStrength;
  if (inside <= 0.0) discard;
  float chk = mod(floor(g.x) + floor(g.y), 2.0);
  vec2 f = abs(fract(g) - 0.5);
  vec2 fw = fwidth(g);
  vec2 l = smoothstep(0.5 - fw * 1.7, 0.5 - fw * 0.35, f);
  float line = max(l.x, l.y);
  // Tint alpha calms the moving water inside the area so the grid reads clean.
  vec3 col = mix(uLagoon, uLagoon * 0.93, chk);
  float a = 0.38 + chk * 0.03;
  col = mix(col, uLine, line);
  a = mix(a, 0.72, line);
  gl_FragColor = vec4(col, a * inside);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
