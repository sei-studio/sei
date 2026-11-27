#!/usr/bin/env node
/**
 * Renders Fleet Battle's water backdrop: a seamless, top-down looping water
 * video (src/renderer/src/components/battleship/three/sea-loop.mp4).
 *
 * The game draws only the boards, ships and markers in WebGL, on demand, over
 * this video, so the moving water costs a hardware video decode instead of a
 * full scene render per frame (the app shares the machine with a Minecraft
 * bot).
 *
 * The water is a tileable texture scrolled in two layers at different scales
 * and angles (classic water scroll), described by a look file
 * (scripts/sea-looks/*.json). Each layer drifts by whole tiles of its own
 * lattice per loop and the brightness swell turns a whole number of times, so
 * the frame after the last is the first. A look either grades a color texture
 * or lights a normal map into color.
 *
 *   node scripts/render-sea-loop.mjs --out sea-loop.mp4 [--look FILE.json] [--size 1920x960] [--seconds 12] [--fps 24] [--crf 24]
 *   node scripts/render-sea-loop.mjs --stills DIR [--look FILE.json]   (a few PNG frames to judge the look)
 *
 * --look defaults to scripts/sea-looks/ripples.json. Needs Google Chrome
 * (headless, software GL is fine: this is offline) and ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The look: texture, layer scales, angles and drifts, and the color grade.
const lookPath = path.resolve(
  arg('look', path.join(path.dirname(fileURLToPath(import.meta.url)), 'sea-looks', 'ripples.json')),
);
const LOOK = JSON.parse(fs.readFileSync(lookPath, 'utf8'));
{
  // The texture path is relative to the look file. WebGL1 repeat needs a
  // power-of-two texture (1024x1024 is fine).
  const tex = path.resolve(path.dirname(lookPath), LOOK.texture);
  const mime = /\.jpe?g$/i.test(tex) ? 'image/jpeg' : 'image/png';
  LOOK.dataUrl = `data:${mime};base64,${fs.readFileSync(tex).toString('base64')}`;
}

const FRAG = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTheta;
uniform sampler2D uTex;
uniform float uTileA, uTileB, uRotA, uRotB, uMixB, uNormal, uPalette, uSwell, uContrast, uBump;
uniform vec2 uDirA, uDirB;
uniform vec3 uLo, uMid, uHi, uMul;
const float TAU = 6.28318530718;

vec4 layer(vec2 px, float tile, float a, vec2 dir) {
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  return texture2D(uTex, r * px / tile + dir * (uTheta / TAU));
}

vec3 ramp(float l) {
  return l < 0.5 ? mix(uLo, uMid, l * 2.0) : mix(uMid, uHi, l * 2.0 - 1.0);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 a = layer(px, uTileA, uRotA, uDirA);
  vec4 b = layer(px + 371.0, uTileB, uRotB, uDirB);
  vec3 col;
  if (uNormal > 0.5) {
    vec3 n = normalize(vec3(((a.xy * 2.0 - 1.0) * (1.0 - uMixB) + (b.xy * 2.0 - 1.0) * uMixB) * uBump, 1.0));
    vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
    float l = clamp((diff - 0.55) * uContrast + 0.5, 0.0, 1.0);
    col = ramp(l) + uHi * spec * 0.35;
  } else {
    vec3 c = mix(a.rgb, b.rgb, uMixB);
    if (uPalette > 0.5) {
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      col = ramp(clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0));
    } else {
      col = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0) * uMul;
    }
  }
  // Very low-frequency swell: broad lighter and darker bands, one or two
  // whole cycles per loop.
  vec2 p = px / uRes.y;
  float sw = sin(dot(p, vec2(2.1, 3.4)) - uTheta) * 0.6 + sin(dot(p, vec2(-3.0, 1.6)) + 2.0 * uTheta + 1.3) * 0.4;
  col *= 1.0 + uSwell * sw;
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
const look = ${JSON.stringify(LOOK)};
window.ready = new Promise((res, rej) => {
  const u = (n) => gl.getUniformLocation(prog, n);
  const img = new Image();
  img.onload = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    const deg = Math.PI / 180;
    gl.uniform1f(u('uTileA'), look.tileA); gl.uniform1f(u('uTileB'), look.tileB);
    gl.uniform1f(u('uRotA'), (look.rotA ?? 0) * deg); gl.uniform1f(u('uRotB'), (look.rotB ?? 0) * deg);
    gl.uniform2fv(u('uDirA'), look.dirA); gl.uniform2fv(u('uDirB'), look.dirB);
    gl.uniform1f(u('uMixB'), look.mixB ?? 0.5);
    gl.uniform1f(u('uNormal'), look.normal ? 1 : 0); gl.uniform1f(u('uPalette'), look.palette ? 1 : 0);
    gl.uniform1f(u('uSwell'), look.swell ?? 0); gl.uniform1f(u('uContrast'), look.contrast ?? 1);
    gl.uniform1f(u('uBump'), look.bump ?? 1);
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    gl.uniform3fv(u('uLo'), hex(look.lo ?? '#000000')); gl.uniform3fv(u('uMid'), hex(look.mid ?? '#808080'));
    gl.uniform3fv(u('uHi'), hex(look.hi ?? '#ffffff')); gl.uniform3fv(u('uMul'), look.mul ?? [1, 1, 1]);
    res();
  };
  img.onerror = () => rej(new Error('texture failed to load'));
  img.src = look.dataUrl;
});
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
  await page.evaluate(() => window.ready);
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
