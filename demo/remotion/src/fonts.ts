import { continueRender, delayRender, staticFile } from 'remotion';

// @font-face via JS so every URL goes through staticFile() — a bare CSS
// url('/fonts/...') is not guaranteed to resolve in the render server.
const FACES: Array<[family: string, file: string, weight: number]> = [
  ['Oswald', 'fonts/oswald-500.woff2', 500],
  ['Oswald', 'fonts/oswald-600.woff2', 600],
  ['Rajdhani', 'fonts/rajdhani-400.woff2', 400],
  ['Rajdhani', 'fonts/rajdhani-500.woff2', 500],
  ['Rajdhani', 'fonts/rajdhani-600.woff2', 600],
  ['JetBrains Mono', 'fonts/jetbrains-mono-400.woff2', 400],
];

let loaded = false;

export const ensureFonts = (): void => {
  if (loaded || typeof document === 'undefined') return;
  loaded = true;
  const handle = delayRender('fonts');
  const promises = FACES.map(([family, file, weight]) => {
    const face = new FontFace(family, `url(${staticFile(file)}) format('woff2')`, {
      weight: String(weight),
    });
    (document.fonts as unknown as { add: (f: FontFace) => void }).add(face);
    return face.load();
  });
  Promise.all(promises)
    .catch(() => undefined)
    .then(() => continueRender(handle));
};
