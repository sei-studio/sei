/**
 * Live2D Cubism Core loader (260804).
 *
 * The Core (`live2dcubismcore.min.js`) is Live2D's proprietary, closed-source
 * runtime: it may be redistributed inside the app (its license explicitly
 * permits that) but must never sit in the repo. `scripts/fetch-live2d-core.mjs`
 * downloads it from the official SDK zip into `src/renderer/public/live2d/`
 * (gitignored) on predev/predist — the mac-audio-tap pattern.
 *
 * It is a classic script that attaches `Live2DCubismCore` to `window`, so it
 * is injected as a <script> tag (bundler import order cannot be trusted to
 * keep a global-attaching side effect ahead of the plugin). Callers MUST
 * await this before importing 'pixi-live2d-display-lipsyncpatch/cubism4'.
 */

let corePromise: Promise<void> | null = null;

export function loadCubismCore(): Promise<void> {
  const w = window as unknown as { Live2DCubismCore?: unknown };
  if (w.Live2DCubismCore) return Promise.resolve();
  corePromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    // Relative to the renderer origin: the dev server serves public/ at the
    // root, and the packaged build copies it next to index.html (base './').
    script.src = new URL('live2d/live2dcubismcore.min.js', document.baseURI).toString();
    script.onload = () => resolve();
    script.onerror = () => {
      corePromise = null; // allow a retry after e.g. a first-run fetch
      script.remove();
      reject(new Error('Live2D core failed to load (run scripts/fetch-live2d-core.mjs)'));
    };
    document.head.appendChild(script);
  });
  return corePromise;
}
