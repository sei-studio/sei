#!/usr/bin/env node
/**
 * Renders Fleet Battle's water backdrop: a seamless, top-down looping water
 * video (src/renderer/src/components/battleship/three/sea-loop.mp4).
 *
 * The game draws only the boards, ships and markers in WebGL, on demand, over
 * this video, so the moving water costs a hardware video decode instead of a
 * full scene render per frame (the app shares the machine with a Minecraft
 * bot). The loop is seamless by construction: every moving term in the shader
 * advances by a whole number of turns over the loop, so the frame after the
 * last is the first.
 *
 *   node scripts/render-sea-loop.mjs --out sea-loop.mp4 [--size 1920x960] [--seconds 12] [--fps 24] [--crf 24]
 *   node scripts/render-sea-loop.mjs --stills DIR       (a few PNG frames to judge the look)
 *
 * Needs Google Chrome (headless, software GL is fine: this is offline) and ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [W, H] = arg('size', '1920x960').split('x').map(Number);
const SECONDS = Number(arg('seconds', '12'));
const FPS = Number(arg('fps', '24'));
const FRAMES = Math.round(SECONDS * FPS);
const stillsDir = arg('stills', null);
const out = arg('out', null);
if (!stillsDir && !out) {
  console.error('usage: --out file.mp4 | --stills DIR');
  process.exit(2);
}

const FRAG = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTheta; // 0..2pi over the loop
#define TAU 6.28318530718

// World units: one unit is about one grid cell on screen.
const float CELL = 58.0;
const vec3 DEEP = vec3(0.067, 0.494, 0.690);
const vec3 SHALLOW = vec3(0.243, 0.718, 0.839);
const vec3 LIGHT = vec3(0.886, 0.984, 1.0);
const vec3 SUN = vec3(-0.38, 0.46, 0.80);

// Swell: a few long waves, each moving a whole number of wavelengths per loop.
float wave(vec2 p, vec2 dir, float len, float n, float ph) {
  return sin(dot(p, normalize(dir)) * TAU / len - n * uTheta + ph);
}
vec2 warp(vec2 p) {
  return vec2(
    sin(p.y * 0.23 + uTheta + 1.3) + 0.5 * sin(p.y * 0.51 - p.x * 0.17 - 2.0 * uTheta),
    sin(p.x * 0.19 - uTheta + 0.4) + 0.5 * sin(p.x * 0.43 + p.y * 0.21 + uTheta + 2.1)
  );
}
float swell(vec2 p) {
  vec2 q = p + 0.85 * warp(p);
  float h = 0.0;
  h += 1.00 * wave(q, vec2(0.94, 0.34), 12.0, 1.0, 0.0);
  h += 0.55 * wave(q, vec2(0.50, 0.87), 7.5, 2.0, 1.7);
  h += 0.30 * wave(q, vec2(-0.32, 0.95), 4.7, 3.0, 4.1);
  h += 0.16 * wave(q, vec2(0.99, -0.14), 3.1, 4.0, 2.2);
  h += 0.08 * wave(q, vec2(0.21, -0.98), 2.1, 5.0, 5.3);
  return h;
}

// Caustics: the bright network where the swell focuses sunlight, drawn as
// the edges of a cell pattern whose points circle a whole number of times
// per loop.
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float cellEdge(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 h = hash22(n + g);
      vec2 o = 0.5 + 0.36 * vec2(
        sin(uTheta * (1.0 + floor(h.x * 2.0)) + TAU * h.y),
        cos(uTheta * (1.0 + floor(h.y * 2.0)) + TAU * h.x)
      );
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}
float caustic(vec2 q) {
  float a = 1.0 - smoothstep(0.0, 0.34, cellEdge(q));
  float b = 1.0 - smoothstep(0.0, 0.5, cellEdge(q * 0.83 + vec2(3.1, 7.7)));
  // Brighter where the two nets cross, and patchy across the water.
  return clamp(a * a * (0.45 + 0.75 * b), 0.0, 1.0);
}

// Short ripples that only tilt the surface (for the glints).
vec2 ripple(vec2 p) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(0.8, 0.6));
  vec2 d2 = normalize(vec2(-0.45, 0.89));
  vec2 d3 = normalize(vec2(0.97, -0.24));
  g += d1 * cos(dot(p, d1) * TAU / 1.1 - 6.0 * uTheta);
  g += d2 * cos(dot(p, d2) * TAU / 0.8 - 7.0 * uTheta + 1.3) * 0.8;
  g += d3 * cos(dot(p, d3) * TAU / 1.4 - 5.0 * uTheta + 2.6) * 0.9;
  return g;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / CELL;
  float e = 0.06;
  float h = swell(p);
  vec2 g = vec2(swell(p + vec2(e, 0.0)) - h, swell(p + vec2(0.0, e)) - h) / e;
  vec3 n = normalize(vec3(-g * 0.16, 1.0));
  vec3 sun = normalize(SUN);

  float hn = smoothstep(-1.7, 1.9, h);
  vec3 col = mix(DEEP, SHALLOW, 0.25 + 0.6 * hn);
  col *= 0.9 + 0.22 * dot(n, sun);

  // Light dancing on the water: caustics, strongest on the lighter swell.
  float c = caustic(p / 2.2 + 0.55 * warp(p * 0.6) + 0.18 * warp(p * 1.7 + 4.0));
  c *= smoothstep(0.15, 0.75, vnoise(p * 0.16 + 0.4 * warp(p * 0.3) + 11.0));
  col = mix(col, LIGHT, c * (0.12 + 0.16 * hn));

  // Sun glints: a sharp highlight where ripples on the swell face the sun.
  vec3 nr = normalize(vec3(-g * 0.16 - ripple(p) * 0.11, 1.0));
  vec3 half_ = normalize(sun + vec3(0.0, 0.0, 1.0));
  float glint = pow(max(dot(nr, half_), 0.0), 900.0);
  glint *= smoothstep(0.45, 0.8, vnoise(p * 0.8 + 0.5 * warp(p)));
  col += vec3(1.0) * glint * 0.7;

  // Faint foam on the crests, broken up by noise that rides the swell.
  vec2 fq = p * 0.9 + 0.6 * warp(p * 1.3);
  float foamN = 0.6 * vnoise(fq) + 0.4 * vnoise(fq * 2.3 + 7.0);
  float foam = smoothstep(0.80, 0.97, hn) * smoothstep(0.55, 0.85, foamN);
  col = mix(col, LIGHT, foam * 0.22);

  gl_FragColor = vec4(col, 1.0);
}
`;

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const c = document.getElementById('c');
const gl = c.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }'));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, ${JSON.stringify(FRAG)}));
gl.linkProgram(prog);
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'a');
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), ${W}, ${H});
const uTheta = gl.getUniformLocation(prog, 'uTheta');
window.frame = (theta) => { gl.uniform1f(uTheta, theta); gl.drawArrays(gl.TRIANGLES, 0, 3); return c.toDataURL('image/png'); };
</script></body></html>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const tmp = stillsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sea-loop-'));
try {
  fs.mkdirSync(tmp, { recursive: true });
  const page = await browser.newPage({ viewport: { width: Math.min(W, 4000), height: Math.min(H, 4000) } });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.setContent(PAGE);
  const indices = stillsDir ? [0, Math.round(FRAMES / 3), Math.round((2 * FRAMES) / 3)] : [...Array(FRAMES).keys()];
  const t0 = Date.now();
  for (const i of indices) {
    const url = await page.evaluate((th) => window.frame(th), (i / FRAMES) * Math.PI * 2);
    fs.writeFileSync(path.join(tmp, `f${String(i).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
    if (i % 30 === 0) console.log(`frame ${i}/${FRAMES} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (out) {
    execFileSync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'),
        '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryslow',
        '-crf', arg('crf', '24'), '-g', String(FRAMES), '-movflags', '+faststart', '-an', out,
      ],
      { stdio: 'inherit' },
    );
    console.log(`wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
  }
} finally {
  await browser.close();
  if (!stillsDir) fs.rmSync(tmp, { recursive: true, force: true });
}
