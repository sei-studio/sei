/**
 * TabletopStage — the shared 3D "wooden table" stage for the tabletop
 * minigames (Four in a Row, Fleet Battle), in the same family as the chess
 * scene (components/chess/three/ChessScene.ts).
 *
 * It owns what every tabletop game needs and nothing game-specific:
 *   - the WebGL renderer with the chess settings (ACES tone mapping, soft
 *     PCF shadows, pixel ratio capped at 2);
 *   - the dark room, the chess lights (warm key with shadows, low hemi +
 *     cool fill: contrast over brightness) and the same procedural wood table;
 *   - a perspective camera the game frames in its onResize callback;
 *   - on-demand rendering: a frame is drawn only after invalidate(). The
 *     game's tick() reports whether something is still moving; while it is,
 *     frames keep coming at display rate, then the loop stops. There is no
 *     permanent 60fps loop (the app shares the machine with a Minecraft bot);
 *   - an optional AMBIENT tier (water, flames, a glow pulse): throttled to
 *     AMBIENT_FPS and put to sleep AMBIENT_SLEEP_MS after the last
 *     wake() (pointer movement or a state push), so a game left open while
 *     the player chats costs nothing. Hidden documents, an unfocused window
 *     (the player is in Minecraft), reduced motion and software WebGL skip
 *     it entirely.
 *     Ambient-only frames reuse the last shadow map: the shadow pass is
 *     redrawn only when something real moved or the game invalidated;
 *   - ownership tracking: geometries, materials and textures registered
 *     through own() are disposed with the stage;
 *   - pointer raycasting against arbitrary planes / objects.
 *
 * Colors here are 3D art-asset values (wood, light tints), literal by design
 * like the chess scene; UI chrome around the canvas uses design tokens.
 */

import * as THREE from 'three';
import { makeWoodTexture } from '../chess/three/woodTexture';

/** Throttled ambient animation rate (frames per second). */
export const AMBIENT_FPS = 24;
/** Ambient animation sleeps this long after the last wake(). */
export const AMBIENT_SLEEP_MS = 30_000;

/** True for software WebGL (SwiftShader, llvmpipe, Microsoft Basic Render). */
export function isSoftwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  let name = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    return false;
  }
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}

/** Same room color as the chess scene. */
export const ROOM_COLOR = 0x1a120c;

type Disposable = THREE.BufferGeometry | THREE.Material | THREE.Texture;

export interface StageTiming {
  /** Frames rendered since mount. */
  frames: number;
  /** Total CPU time spent inside tick + render (ms). */
  cpuMs: number;
  /** Worst single frame CPU time (ms). */
  worstMs: number;
}

export interface TabletopStageOptions {
  /** Shadow map edge (px). Chess uses 2048; the minigames get by on less. */
  shadowMapSize?: number;
  /** Half extent of the key light's shadow camera (world units). */
  shadowExtent?: number;
  /** Key light position. */
  keyPosition?: [number, number, number];
  /** Tone mapping exposure (chess: 1.05). */
  exposure?: number;
  /** Ambient tier rate in frames per second (default AMBIENT_FPS). */
  ambientFps?: number;
  /** Ambient tier sleeps this long after the last wake (default AMBIENT_SLEEP_MS). */
  ambientSleepMs?: number;
}

export class TabletopStage {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly reducedMotion: boolean;
  /** A software rasterizer (SwiftShader, llvmpipe): every pixel costs CPU. */
  readonly softwareGl: boolean;
  readonly key: THREE.DirectionalLight;
  readonly timing: StageTiming = { frames: 0, cpuMs: 0, worstMs: 0 };

  /** Per-frame game hook: advance animations; return true while moving. */
  tick: (now: number, dt: number) => boolean = () => false;
  /** Per-frame ambient hook (throttled); return true to keep ambient alive. */
  ambient: ((now: number, dt: number) => boolean) | null = null;
  /** Called after a container resize with the new aspect (w / h). */
  onResize: (aspect: number, width: number, height: number) => void = () => undefined;

  private readonly owned: Disposable[] = [];
  private readonly ro: ResizeObserver;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private raf = 0;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private awakeUntil = 0;
  private disposed = false;
  /** The next frame must redraw the shadow map (set by invalidate()). */
  private shadowDirty = true;
  private focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  private readonly ambientFrameMs: number;
  private readonly ambientSleepMs: number;
  private readonly onVisibility = (): void => {
    if (!document.hidden) this.resumeAmbient();
  };
  private readonly onFocus = (): void => {
    this.focused = true;
    this.resumeAmbient();
  };
  /** three.js re-creates its GPU state on restore; draw a fresh frame. */
  private readonly onContextRestored = (): void => {
    this.invalidate();
    this.resumeAmbient();
  };
  private readonly onBlur = (): void => {
    this.focused = false;
  };

  constructor(container: HTMLElement, opts: TabletopStageOptions = {}) {
    this.container = container;
    this.reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Redrawn on demand (see frame()): ambient-only frames reuse it.
    this.renderer.shadowMap.autoUpdate = false;
    this.ambientFrameMs = 1000 / (opts.ambientFps ?? AMBIENT_FPS);
    this.ambientSleepMs = opts.ambientSleepMs ?? AMBIENT_SLEEP_MS;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? 1.05;
    this.softwareGl = isSoftwareRenderer(this.renderer.getContext());
    // On a software rasterizer the cost is fill rate, so keep pixels at 1:1.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.softwareGl ? 1 : 2));
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(ROOM_COLOR);
    this.scene.fog = new THREE.Fog(ROOM_COLOR, 18, 42);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 140);

    // ── Lights: the chess rig ──
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a281c, 0.3));
    const key = new THREE.DirectionalLight(0xfff1dd, 2.1);
    const [kx, ky, kz] = opts.keyPosition ?? [5, 11, 6];
    key.position.set(kx, ky, kz);
    key.castShadow = true;
    const size = opts.shadowMapSize ?? 1024;
    key.shadow.mapSize.set(size, size);
    const ext = opts.shadowExtent ?? 7;
    key.shadow.camera.left = -ext;
    key.shadow.camera.right = ext;
    key.shadow.camera.top = ext;
    key.shadow.camera.bottom = -ext;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.scene.add(key.target);
    this.key = key;
    const fill = new THREE.DirectionalLight(0xcdd8ff, 0.2);
    fill.position.set(-6, 7, -4);
    this.scene.add(fill);

    // ── Table: same wood as the chess table ──
    const tableTex = this.own(
      makeWoodTexture({
        base: [122, 82, 46],
        stripe: [108, 73, 40],
        streak: [82, 53, 29],
        seed: 11,
        frequency: 0.09,
      }),
    );
    tableTex.repeat.set(15, 15);
    const tableMat = this.own(new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.62, metalness: 0.02 }));
    const table = new THREE.Mesh(this.own(new THREE.PlaneGeometry(200, 200)), tableMat);
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('blur', this.onBlur);
    // First layout happens after the game wires onResize (next microtask).
    queueMicrotask(() => this.resize());
  }

  /** Register a GPU resource for disposal with the stage. */
  own<T extends Disposable>(res: T): T {
    this.owned.push(res);
    return res;
  }

  /** Schedule one frame (and more while tick() reports motion). */
  invalidate(): void {
    this.shadowDirty = true;
    this.requestFrame();
  }

  /**
   * No ambient tier at all: reduced motion, or a software rasterizer, where
   * one ambient frame of a full scene costs about a CPU-second and a 15 fps
   * tier would pin every core. The scene still renders on demand.
   */
  get ambientDisabled(): boolean {
    return this.reducedMotion || this.softwareGl;
  }

  /** Keep the ambient tier running for another ambientSleepMs. */
  wake(): void {
    if (this.disposed || !this.ambient || this.ambientDisabled) return;
    const wasAsleep = performance.now() > this.awakeUntil;
    this.awakeUntil = performance.now() + this.ambientSleepMs;
    if (wasAsleep) this.scheduleAmbient(0);
  }

  /**
   * Back from a hidden document or an unfocused window. The ambient loop
   * stopped while it was away even if the awake window has not run out, so
   * wake() alone (which only restarts a sleeping loop) is not enough.
   */
  private resumeAmbient(): void {
    if (this.disposed || !this.ambient || this.ambientDisabled) return;
    this.awakeUntil = performance.now() + this.ambientSleepMs;
    if (!this.raf && !this.ambientTimer) this.scheduleAmbient(0);
  }

  /** True while the ambient tier is allowed to animate. */
  ambientAwake(now = performance.now()): boolean {
    return (
      !!this.ambient && !this.ambientDisabled && !document.hidden && this.focused && now < this.awakeUntil
    );
  }

  /** Point the shared raycaster at a client coordinate; null if unsized. */
  aim(clientX: number, clientY: number): THREE.Raycaster | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray;
  }

  /** Where the pointer ray meets a plane, or null. */
  pointerOnPlane(clientX: number, clientY: number, plane: THREE.Plane): THREE.Vector3 | null {
    const ray = this.aim(clientX, clientY);
    if (!ray) return null;
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Project a world point to container pixels. */
  project(p: THREE.Vector3): { x: number; y: number } {
    this.camera.updateMatrixWorld();
    const v = p.clone().project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  /** Aim the camera at `look` from `elevation` radians, `distance` away. */
  placeCamera(look: THREE.Vector3, elevation: number, distance: number): void {
    this.camera.position.set(
      look.x,
      look.y + Math.sin(elevation) * distance,
      look.z + Math.cos(elevation) * distance,
    );
    this.camera.lookAt(look);
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = distance + 6;
      fog.far = distance + 34;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('blur', this.onBlur);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const r of this.owned) r.dispose();
    this.owned.length = 0;
    // Detach first: the context loss below must not reach the board's
    // context-lost watcher (it would show the failure notice on unmount).
    this.renderer.domElement.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private requestFrame(): void {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private scheduleAmbient(delay: number): void {
    if (this.ambientTimer || this.disposed) return;
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      // An ambient-only frame: no shadow redraw unless something invalidated.
      if (this.ambientAwake()) this.requestFrame();
    }, delay);
  }

  private resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.onResize(w / h, w, h);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const t0 = performance.now();
    const dt = this.lastFrameAt ? Math.min(Math.max(now - this.lastFrameAt, 0), 250) : 16;
    this.lastFrameAt = now;
    const moving = this.tick(now, dt);
    let ambientAlive = false;
    if (this.ambient && this.ambientAwake(now)) ambientAlive = this.ambient(now, dt);
    // The shadow pass is about a quarter of a frame's raster work. Ambient
    // motion (water, a few mm of bob, flame flicker) needs no fresh shadows.
    this.renderer.shadowMap.needsUpdate = this.shadowDirty || moving;
    this.shadowDirty = false;
    this.renderer.render(this.scene, this.camera);
    const spent = performance.now() - t0;
    this.timing.frames++;
    this.timing.cpuMs += spent;
    if (spent > this.timing.worstMs) this.timing.worstMs = spent;
    if (moving) {
      this.requestFrame();
    } else if (ambientAlive) {
      this.scheduleAmbient(this.ambientFrameMs);
    }
    // After an idle gap the next frame starts a fresh clock (dt = 16 ms), so a
    // new animation never begins with a jump.
    if (!moving && !ambientAlive) this.lastFrameAt = 0;
  };
}

/** Smoothstep easing. */
/** Pixels the game-over result card strip takes at the bottom of a panel (chrome strip + card + gap). */
export const END_CARD_PX = 154;

/**
 * Game-over framing: the result card takes a fixed strip of pixels at the
 * bottom of the panel, so a world-space nudge clears it at one panel height
 * and not another. Given where the board sits at rest (fractions of the panel
 * height, top and bottom), returns how much to pull the camera back (`k`,
 * multiply the distance) and how far to slide the picture up (`liftPx`, for
 * camera.setViewOffset) so the board fits the room above the card. Both are
 * scaled by `amount` (0..1) for the tween.
 */
export function endFraming(
  heightPx: number,
  boardTop: number,
  boardBottom: number,
  amount: number,
): { k: number; liftPx: number } {
  const h = Math.max(1, heightPx);
  const r = Math.min(END_CARD_PX, h * 0.42) / h;
  const room = 0.94 - r;
  const span = boardBottom - boardTop;
  const kFull = Math.max(1, span / room);
  const top = 0.5 - (0.5 - boardTop) / kFull;
  const lift = Math.max(0, top - (0.04 + (room - span / kFull) / 2));
  return { k: 1 + (kFull - 1) * amount, liftPx: lift * amount * h };
}

/** Applies endFraming's lift to the camera (clears it at rest). */
export function applyLift(camera: THREE.PerspectiveCamera, w: number, h: number, liftPx: number): void {
  if (liftPx > 0.5) camera.setViewOffset(w, h, 0, liftPx, w, h);
  else if (camera.view) camera.clearViewOffset();
}

export const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Ease-out cubic. */
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
/** Ease-out back (a toy-like overshoot). */
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
