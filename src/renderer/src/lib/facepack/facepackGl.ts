/**
 * Face-set renderer on WebGL2 (261116, product call 261116: "head tilt jumps
 * from A to B", "idle feels like a still picture"). Draws one face-set frame
 * as a gentle warp of the pack's pictures, so the idle life is continuous
 * instead of a cut between baked poses:
 *
 *  - head: a tilt (roll) about the neck and a small lift/shift, fading out
 *    over the neck band so the shoulders stay put and long hair bends there;
 *  - turn and nod: the features inside the face ellipse slide a few pixels
 *    while its outline mostly stays (a cheap 2.5D turn);
 *  - irises: inside each eye opening the picture shifts with her gaze,
 *    fading to nothing at the lids, so the lash line stays where it is;
 *  - lids: the half and closed patches swap in over the open eye, timed by
 *    the lid curve (fast close, a short hold, a slower open);
 *  - pose and expression changes: the old and new composites crossfade with
 *    each one's features slid toward the other's (two eye centres give the
 *    offset), so a head turn between baked poses glides instead of ghosting.
 *
 * The composite (base + mouth + overlays, eyes open) is built by FacepackView
 * on a 2D canvas and uploaded only when it changes (the mouth box alone is
 * re-uploaded while she talks). A steady frame is one quad and no uploads.
 * All coordinates here are pack px; the vertex stage maps the pack rect to
 * its place on the canvas.
 */
import type { Ellipse, FaceRig } from './faceRig';

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uDest; // x, y, w, h in canvas px
uniform vec2 uCanvas;
uniform vec2 uSize;
out vec2 vP;
void main() {
  vP = aPos * uSize;
  vec2 px = uDest.xy + aPos * uDest.zw;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vP;
out vec4 outColor;
uniform vec2 uSize;
uniform sampler2D uCur;
uniform sampler2D uOld;
uniform float uMix;
uniform vec2 uMorphCur;
uniform vec2 uMorphOld;
uniform sampler2D uHalf;
uniform sampler2D uClosed;
uniform vec4 uEyeBox;
uniform float uHalfA;
uniform float uClosedA;
uniform vec4 uEyeL;
uniform vec4 uEyeR;
uniform vec4 uEyeLo;
uniform vec4 uEyeRo;
uniform vec2 uIris;
uniform vec2 uNeck;
uniform vec2 uBand;
uniform float uRoll;
uniform vec2 uHeadShift;
uniform vec4 uFace;
uniform vec2 uFaceShift;

// 261119: every texture read runs in uniform control flow and is masked after. A read
// inside a per-pixel branch (the old early return, the old lid-box if) has no defined
// derivatives at the branch edge, so a GPU may take a far mip level there: a thin light
// line along the edge of the pack rect and of the eye box.
float inBox(vec2 uv) {
  vec2 i = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return i.x * i.y;
}

vec4 tex(sampler2D t, vec2 q) {
  vec2 uv = q / uSize;
  return texture(t, clamp(uv, 0.0, 1.0)) * inBox(uv);
}

vec2 irisShift(vec2 q, vec4 e) {
  if (e.z <= 0.0) return vec2(0.0);
  vec2 f = (q - e.xy) / e.zw;
  float w = 1.0 - smoothstep(0.42, 1.0, length(f));
  return uIris * e.zw * w;
}

void main() {
  // Head: inverse rotation about the neck, weighted by the head band.
  float hw = 1.0 - smoothstep(uBand.x, uBand.y, vP.y);
  vec2 d = vP - uNeck;
  float a = -uRoll * hw;
  float c = cos(a);
  float s = sin(a);
  vec2 q = uNeck + vec2(c * d.x - s * d.y, s * d.x + c * d.y) - uHeadShift * hw;
  // Turn / nod: features slide inside the face ellipse.
  vec2 f = (q - uFace.xy) / uFace.zw;
  float r2 = dot(f, f);
  float fw = r2 < 1.0 ? (1.0 - r2) * (1.0 - r2) : 0.0;
  q -= uFaceShift * fw;

  vec2 qc = q + uMorphCur * fw;
  vec4 col = tex(uCur, qc - irisShift(qc, uEyeL) - irisShift(qc, uEyeR));
  if (uHalfA > 0.0 || uClosedA > 0.0) {
    vec2 uv = (qc - uEyeBox.xy) / (uEyeBox.zw - uEyeBox.xy);
    vec2 luv = clamp(uv, 0.0, 1.0);
    float inside = inBox(uv);
    vec4 h = texture(uHalf, luv) * (uHalfA * inside);
    col = h + col * (1.0 - h.a);
    vec4 k = texture(uClosed, luv) * (uClosedA * inside);
    col = k + col * (1.0 - k.a);
  }
  if (uMix < 1.0) {
    vec2 qo = q + uMorphOld * fw;
    vec4 old = tex(uOld, qo - irisShift(qo, uEyeLo) - irisShift(qo, uEyeRo));
    col = mix(old, col, uMix);
  }
  outColor = col;
}`;

/** One frame's parameters (pack px unless noted). Reuse one object across frames. */
export interface FaceDrawParams {
  /** Canvas px rect the pack canvas maps to. */
  dest: [number, number, number, number];
  /** 0..1 weight of the current composite (1 = no crossfade). */
  mix: number;
  morphCur: [number, number];
  morphOld: [number, number];
  /** Lid patch weights (0 = open). */
  halfA: number;
  closedA: number;
  /** Iris shift as a fraction of each eye's radii. */
  iris: [number, number];
  roll: number;
  headShift: [number, number];
  faceShift: [number, number];
}

export function newDrawParams(): FaceDrawParams {
  return {
    dest: [0, 0, 1, 1],
    mix: 1,
    morphCur: [0, 0],
    morphOld: [0, 0],
    halfA: 0,
    closedA: 0,
    iris: [0, 0],
    roll: 0,
    headShift: [0, 0],
    faceShift: [0, 0],
  };
}

/** Lid closure where the half patch shows, and where the closed one does. */
export const LID_HALF_AT = 0.2;
export const LID_CLOSED_AT = 0.72;

/**
 * Lid closure 0..1 to the two patch weights. The patches are opaque crops, so
 * a dissolve between them shows the open iris through a shut lid (a ghost,
 * seen in the first 261116 capture). They swap instead, the way a hand-drawn
 * blink cuts between open, half and shut; the lid curve sets when each frame
 * comes (at 30 fps: open, half, shut, shut, half, open).
 */
export function lidWeights(lid: number, out: { halfA: number; closedA: number }): void {
  out.halfA = lid >= LID_HALF_AT ? 1 : 0;
  out.closedA = lid >= LID_CLOSED_AT ? 1 : 0;
}

type U = WebGLUniformLocation | null;

const UNIFORMS = [
  'uDest',
  'uCanvas',
  'uSize',
  'uCur',
  'uOld',
  'uMix',
  'uMorphCur',
  'uMorphOld',
  'uHalf',
  'uClosed',
  'uEyeBox',
  'uHalfA',
  'uClosedA',
  'uEyeL',
  'uEyeR',
  'uEyeLo',
  'uEyeRo',
  'uIris',
  'uNeck',
  'uBand',
  'uRoll',
  'uHeadShift',
  'uFace',
  'uFaceShift',
] as const;

export interface EyeSet {
  eyes: [Ellipse, Ellipse] | null;
  /** Patch box of the eye patches (pack px). */
  box: [number, number, number, number] | null;
}

export class FaceGl {
  readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly buf: WebGLBuffer;
  private readonly u: Record<(typeof UNIFORMS)[number], U>;
  private cur: WebGLTexture;
  private old: WebGLTexture;
  private readonly empty: WebGLTexture;
  private readonly patches = new Map<string, WebGLTexture>();
  private half: WebGLTexture;
  private closed: WebGLTexture;
  private curEyes: EyeSet = { eyes: null, box: null };
  private oldEyes: EyeSet = { eyes: null, box: null };
  private lost = false;
  private disposed = false;

  private constructor(
    gl: WebGL2RenderingContext,
    private readonly rig: FaceRig,
  ) {
    this.gl = gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type);
      if (!s) throw new Error('shader');
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`facepack shader: ${gl.getShaderInfoLog(s) ?? ''}`);
      return s;
    };
    const prog = gl.createProgram();
    if (!prog) throw new Error('program');
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`facepack program: ${gl.getProgramInfoLog(prog) ?? ''}`);
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    if (!buf) throw new Error('buffer');
    this.buf = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<(typeof UNIFORMS)[number], U>;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.BLEND);
    this.cur = this.newTex();
    this.old = this.newTex();
    this.empty = this.newTex();
    gl.bindTexture(gl.TEXTURE_2D, this.empty);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.half = this.empty;
    this.closed = this.empty;
    gl.uniform1i(this.u.uCur, 0);
    gl.uniform1i(this.u.uOld, 1);
    gl.uniform1i(this.u.uHalf, 2);
    gl.uniform1i(this.u.uClosed, 3);
  }

  /** A renderer on `canvas`, or null when WebGL2 is not available (the caller draws in 2D). */
  static create(canvas: HTMLCanvasElement, rig: FaceRig, onLost: () => void): FaceGl | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      const r = new FaceGl(gl, rig);
      canvas.addEventListener('webglcontextlost', (ev) => {
        ev.preventDefault();
        r.lost = true;
        // Our own dispose() loses the context on purpose: not a failure.
        if (!r.disposed) onLost();
      });
      return r;
    } catch (err) {
      console.warn('[FacepackView] WebGL setup failed, drawing in 2D', err);
      return null;
    }
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  private newTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error('texture');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return t;
  }

  private upload(t: WebGLTexture, src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * 261119 (product call 261119, "a thin white box round her every time she blinks"):
   * the lid patches are decoded ImageBitmaps, and WebGL ignores
   * UNPACK_PREMULTIPLY_ALPHA_WEBGL for an ImageBitmap: whether its pixels arrive
   * premultiplied is up to the browser and the platform's decoder. Uploaded straight,
   * the shader's premultiplied "over" adds the full colour of every soft edge pixel,
   * and the patches' fully transparent border still holds a light colour (about
   * rgb 190,191,207 in the anima packs): a bright rectangle round the eye box on
   * every blink. Drawn through a 2D canvas first, the upload is premultiplied
   * everywhere (the composite and the mouth box already go through a canvas).
   */
  private premultiplied(src: TexImageSource): TexImageSource {
    if (typeof ImageBitmap === 'undefined' || !(src instanceof ImageBitmap)) return src;
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d');
    if (!g) return src;
    g.drawImage(src, 0, 0);
    return cv;
  }

  /** The current composite changed (a new expression, pose or overlay set). `crossfade` keeps the old one for the fade. */
  setComposite(src: TexImageSource, eyes: EyeSet, crossfade: boolean): void {
    if (crossfade) {
      const t = this.old;
      this.old = this.cur;
      this.cur = t;
      this.oldEyes = this.curEyes;
    }
    this.curEyes = eyes;
    this.upload(this.cur, src);
  }

  /** Replace a region of the current composite (the mouth box while she talks). */
  updateRegion(src: TexImageSource, x: number, y: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.cur);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, Math.round(x), Math.round(y), gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** The eye patches for the current pose (null: none, the face cannot blink). Textures are kept by key. */
  setLids(half: { key: string; src: TexImageSource } | null, closed: { key: string; src: TexImageSource } | null): void {
    this.half = half ? this.patch(half.key, half.src) : this.empty;
    this.closed = closed ? this.patch(closed.key, closed.src) : this.empty;
  }

  private patch(key: string, src: TexImageSource): WebGLTexture {
    const hit = this.patches.get(key);
    if (hit) {
      this.patches.delete(key);
      this.patches.set(key, hit);
      return hit;
    }
    const t = this.newTex();
    this.upload(t, this.premultiplied(src));
    this.patches.set(key, t);
    while (this.patches.size > 16) {
      const oldest = this.patches.keys().next().value as string;
      const ot = this.patches.get(oldest);
      this.patches.delete(oldest);
      if (ot && ot !== this.half && ot !== this.closed) this.gl.deleteTexture(ot);
    }
    return t;
  }

  draw(p: FaceDrawParams, canvasW: number, canvasH: number): void {
    if (this.isLost) return;
    const gl = this.gl;
    const u = this.u;
    const r = this.rig;
    gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cur);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, p.mix < 1 ? this.old : this.empty);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.half);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.closed);
    gl.uniform4f(u.uDest, p.dest[0], p.dest[1], p.dest[2], p.dest[3]);
    gl.uniform2f(u.uCanvas, canvasW, canvasH);
    gl.uniform2f(u.uSize, r.w, r.h);
    gl.uniform1f(u.uMix, p.mix);
    gl.uniform2f(u.uMorphCur, p.morphCur[0], p.morphCur[1]);
    gl.uniform2f(u.uMorphOld, p.morphOld[0], p.morphOld[1]);
    const box = this.curEyes.box;
    const lids = box && (p.halfA > 0 || p.closedA > 0);
    gl.uniform4f(u.uEyeBox, box?.[0] ?? 0, box?.[1] ?? 0, box?.[2] ?? 1, box?.[3] ?? 1);
    gl.uniform1f(u.uHalfA, lids ? p.halfA : 0);
    gl.uniform1f(u.uClosedA, lids ? p.closedA : 0);
    const eye = (loc: U, e: Ellipse | undefined): void => gl.uniform4f(loc, e?.cx ?? 0, e?.cy ?? 0, e?.rx ?? 0, e?.ry ?? 0);
    eye(u.uEyeL, this.curEyes.eyes?.[0]);
    eye(u.uEyeR, this.curEyes.eyes?.[1]);
    eye(u.uEyeLo, this.oldEyes.eyes?.[0]);
    eye(u.uEyeRo, this.oldEyes.eyes?.[1]);
    gl.uniform2f(u.uIris, p.iris[0], p.iris[1]);
    gl.uniform2f(u.uNeck, r.neckX, r.neckY);
    gl.uniform2f(u.uBand, r.bandTop, r.bandBottom);
    gl.uniform1f(u.uRoll, p.roll);
    gl.uniform2f(u.uHeadShift, p.headShift[0], p.headShift[1]);
    gl.uniform4f(u.uFace, r.face.cx, r.face.cy, r.face.rx, r.face.ry);
    gl.uniform2f(u.uFaceShift, p.faceShift[0], p.faceShift[1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    try {
      for (const t of this.patches.values()) gl.deleteTexture(t);
      gl.deleteTexture(this.cur);
      gl.deleteTexture(this.old);
      gl.deleteTexture(this.empty);
      gl.deleteBuffer(this.buf);
      gl.deleteProgram(this.prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* already gone */
    }
  }
}
