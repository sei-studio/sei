#!/usr/bin/env node
/**
 * Fetch the Live2D Cubism Core (260804).
 *
 * `live2dcubismcore.min.js` is Live2D's PROPRIETARY runtime: its license
 * explicitly permits redistributing it inside an application, but it must not
 * be committed to the repo (same posture as AIRI's unplugin-live2d-sdk). This
 * script downloads the official SDK-for-Web zip and extracts just the Core
 * into src/renderer/public/live2d/ (gitignored), where the renderer's
 * loadCubismCore() expects it. Hooked on predev/predist next to the mac
 * audio tap.
 *
 * Offline behavior: if the file already exists we do nothing; if the download
 * fails we WARN and exit 0 — dev must not break offline, Live2D avatars just
 * won't render until the next online run.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_URL = 'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.3.zip';
const CORE_ENTRY_SUFFIX = 'Core/live2dcubismcore.min.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'src', 'renderer', 'public', 'live2d', 'live2dcubismcore.min.js');

try {
  await access(target);
  process.exit(0); // already fetched
} catch {
  /* fetch below */
}

try {
  console.log('[live2d-core] downloading Cubism SDK for Web...');
  const res = await fetch(SDK_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zipBytes = Buffer.from(await res.arrayBuffer());

  // Minimal zip extraction via jszip (already a dependency of the app).
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(zipBytes);
  const entry = Object.values(zip.files).find(
    (f) => !f.dir && f.name.endsWith(CORE_ENTRY_SUFFIX),
  );
  if (!entry) throw new Error('core file not found in SDK zip');
  const core = await entry.async('nodebuffer');

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, core);
  console.log(`[live2d-core] wrote ${path.relative(root, target)} (${core.byteLength} bytes)`);
} catch (err) {
  console.warn(
    `[live2d-core] WARN: could not fetch the Cubism Core (${err?.message ?? err}). ` +
      'Live2D avatars will not render in this build; re-run npm run fetch:live2d online.',
  );
  process.exit(0);
}
