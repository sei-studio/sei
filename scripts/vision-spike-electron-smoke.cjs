// scripts/vision-spike-electron-smoke.cjs
//
// Phase 15-01 de-risk: prove gl + canvas dlopen and render INSIDE an Electron process
// (the real Electron 42 ABI target — NOT system Node, where they're ABI-mismatched).
//
// This is the automatable half of the Task 3 packaged-build checkpoint: it answers the
// Pitfall-1 question "do the native modules load under Electron 42?" without needing a live
// Minecraft world. It loads node-canvas-webgl (-> gl, canvas), builds a three.js WebGLRenderer,
// renders a synthetic colored scene, and encodes a JPEG — exactly the native surface renderPov
// exercises. A live-world render (chunks -> JPEG via renderPov) is the human's part of the
// checkpoint.
//
// Run headless:  ELECTRON_RUN_AS_NODE unset; e.g.
//   xvfb-run -a ./node_modules/.bin/electron scripts/vision-spike-electron-smoke.cjs   (linux)
//   ./node_modules/.bin/electron scripts/vision-spike-electron-smoke.cjs               (macOS)

const { app } = require('electron');

function fail(msg, err) {
  console.error(`VISION_SPIKE_FAIL: ${msg}${err ? ` — ${(err && err.stack) || err}` : ''}`);
  if (app) app.exit(1); else process.exit(1);
}

async function run() {
  let THREE, createCanvas;
  try {
    THREE = require('three');
    globalThis.THREE = THREE;
    globalThis.Worker = require('worker_threads').Worker;
  } catch (e) { return fail('require three / worker_threads', e); }

  try {
    ({ createCanvas } = require('node-canvas-webgl/lib')); // -> native gl + canvas dlopen
  } catch (e) { return fail('require node-canvas-webgl (gl/canvas dlopen)', e); }

  let buffer;
  try {
    const W = 256, H = 256;
    const canvas = createCanvas(W, H);
    const renderer = new THREE.WebGLRenderer({ canvas });
    renderer.setSize(W, H);

    // Synthetic scene: a lit colored cube on a sky background — enough to prove the GL
    // pipeline draws non-background pixels and canvas encodes them.
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    const camera = new THREE.PerspectiveCamera(75, W / H, 0.1, 1000);
    camera.position.z = 3;
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0xff5533 }),
    );
    cube.rotation.set(0.6, 0.8, 0);
    scene.add(cube);

    renderer.render(scene, camera);
    buffer = canvas.toBuffer('image/jpeg', { quality: 0.4 });
  } catch (e) { return fail('three WebGLRenderer render + canvas.toBuffer', e); }

  if (!buffer || buffer.length === 0) return fail('toBuffer produced 0 bytes');

  console.log(`VISION_SPIKE_OK: rendered ${buffer.length} bytes JPEG under Electron ${process.versions.electron}`);
  app.exit(0);
}

app.whenReady().then(run).catch((e) => fail('app.whenReady', e));
