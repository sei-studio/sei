/**
 * A CommonJS `require` anchored to THIS bundle, for loading native addons and
 * CJS-only packages from the ESM main process (package.json `"type": "module"`,
 * electron-vite emits dist/main as ESM).
 *
 * 260915: the three call sites used to fall back to
 * `createRequire(process.cwd() + '/')`. That resolves node_modules relative to
 * the process's WORKING DIRECTORY, which is the project root in `npm run dev`
 * and in vitest, but `/` for a packaged app launched from Finder or Dock. So
 * every packaged build failed `require('sherpa-onnx-node')` with "Cannot find
 * module" (surfaced in a call as "[voice unavailable, local speech cannot run
 * on this install]", even with the platform package present and loadable in
 * app.asar.unpacked), and the same fallback silently lost sharp (portrait
 * compliance) and prismarine-viewer's texture root. Anchoring on
 * `import.meta.url` resolves from the bundle's own location instead:
 * app.asar/dist/main/chunks/... walks up to app.asar/node_modules, and
 * Electron's asar hooks redirect the `.node` loads into app.asar.unpacked.
 * Verified against the shipped v0.6.1 binary with ELECTRON_RUN_AS_NODE from
 * cwd `/`: cwd-anchored require fails, bundle-anchored require loads.
 */
import { createRequire } from 'node:module';

let cached: NodeJS.Require | null = null;

export function bundleRequire(): NodeJS.Require {
  if (!cached) cached = createRequire(import.meta.url);
  return cached;
}
