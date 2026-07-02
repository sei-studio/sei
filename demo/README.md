# Sei UI demo recorder

Controlled, high-resolution product demos of the Sei desktop UI with a
**synthetic, smoothly-eased cursor** — scripted, not screen-recorded, so output
is deterministic and re-renders identically after any UI change. The app's own
CSS effects and animations are preserved (hover lifts, page slides, the summon
glint, the live skinview3d spin).

## How it works

The renderer (`src/renderer`) is served **standalone via Vite** (no Electron),
with a **mocked `window.sei` bridge** (`inject.js`) backing every screen with
in-memory fixtures. Then:

- **Faithful animations** — capture is a real-time **CDP screencast**
  (`Page.startScreencast`), so the app's actual CSS transitions/animations and
  the WebGL skin spin are recorded as they really play. Each frame keeps its
  real swap timestamp; ffmpeg encodes with that timing so playback is true speed.
- **High res (2×)** — the screencast captures at the CSS-viewport size (it
  ignores `deviceScaleFactor`), so the viewport is made 2× (2360×1520) and
  `#root` is scaled 2×. Because the `#root` transform becomes the containing
  block, the app's `position:fixed` modals/toasts scale correctly too. Output is
  **2360×1520** (2× the app's intended 1180×760 window).
- **Smooth 60fps** — the cursor is animated by an in-page `requestAnimationFrame`
  tween (no per-step node round-trips), and capture runs on the **hardware GPU**
  via new-headless Chromium (`headless:false` + `--headless=new` + Metal), which
  lifts SwiftShader's raster cap so the screencast gets ~60fps. Real Playwright
  mouse input fires under the visible cursor so genuine `:hover`, clicks, and the
  skinview3d drag-rotate happen.
- **No keychain / no Minecraft** — LOCAL mode, `hasApiKey` mocked true; "Summon"
  plays a scripted `Connecting… → Online` via `window.__demo.online()`.
- **Real default assets** — fixtures are the actual Sui / Lyra / Marv default
  characters (`resources/default-characters/*.json`); their portraits load from
  `src/renderer/public/img/` and their bundled skins from `resources/skins/`.

## Captured flow

1. Companions page (Sui / Lyra / Marv) → 2. hover Marv (reveals the centred
Summon button + card lift) → 3. click into Marv **below centre** (centre is the
Summon button, so a lower click opens instead of summoning) → 4. Summon
(Connecting → Online) → 5. Skin tab → 6. rotate the 3D skin 360° → 7. back to
Companions.

## Run

```bash
npm i -D playwright && npx playwright install chromium   # one-time
node demo/record.mjs            # 2360×1520, 60 fps -> demo/out/sei-demo.mp4
FPS=30 node demo/record.mjs     # encode at 30 fps
```

If a machine has no usable GPU, swap the launch args in `record.mjs` for the
commented SwiftShader fallback (capture still works, just a lower source fps).

## Customizing

- **Flow / timing** — the numbered steps in `record.mjs` (`glide`, `sleep`,
  `click`, the rotation sweep). Cursor motion is the `window.__tween` engine.
- **Cursor look** — the `#__democursor` style block + SVG in `record.mjs`.
- **Characters / greeting / launch stats** — `buildFixtures()` + `config` in
  `record.mjs`; the generic bridge lives in `inject.js`.

## Upgrade path

For agency-grade polish (zoom-to-element, captions, branded window chrome,
transitions), feed these high-res frames into a Remotion composition and add the
motion-design layer there.
