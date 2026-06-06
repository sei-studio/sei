---
phase: 04-electron-gui-packaging
plan: 06
type: execute
wave: 4
depends_on: [01, 02, 05]
files_modified:
  - src/renderer/index.html
  - src/renderer/src/main.tsx
  - src/renderer/src/App.tsx
  - src/renderer/src/global.d.ts
  - src/renderer/src/styles/tokens.css
  - src/renderer/src/styles/global.css
  - src/renderer/src/styles/animations.css
  - src/renderer/src/styles/fonts.css
  - src/renderer/src/lib/ipcClient.ts
  - src/renderer/src/lib/theme.ts
  - src/renderer/src/lib/stores/useUiStore.ts
  - src/renderer/src/lib/stores/useDataStore.ts
  - src/renderer/src/lib/portraitPalettes.ts
  - src/renderer/src/lib/tagLog.ts
  - src/renderer/src/components/Button.tsx
  - src/renderer/src/components/TextField.tsx
  - src/renderer/src/components/IconRail.tsx
  - src/renderer/src/components/MacosWindow.tsx
  - src/renderer/src/components/icons.tsx
  - src/renderer/src/components/PixelPortrait.tsx
  - src/renderer/src/components/StepDots.tsx
  - src/renderer/src/screens/LoadingScreen.tsx
autonomous: true
requirements: [GUI-01, GUI-04]
must_haves:
  truths:
    - "Renderer mounts under MacosWindow shell with sidebar IconRail, top title bar, and a content area"
    - "CSS variables from tokens.css drive both light and dark themes; data-theme attribute switches them"
    - "useUiStore and useDataStore provide Zustand-backed state for views, modals, characters, lan, summon, logs"
    - "Logs ring buffer (max 5000 lines) is mounted at the data-store level — subscribing to `window.sei.onLog` once at App mount, never dropped on navigation (RESEARCH Q5)"
    - "PixelPortrait component renders deterministically from `id+name` seed using FNV-1a + mulberry32; with image override fallback"
    - "Press Start 2P, Noto Sans, JetBrains Mono are self-hosted via @font-face under /fonts/"
    - "LoadingScreen shows for 1.6s OR until first useDataStore.loadCharacters resolves, whichever is later"
    - "App responds to prefers-color-scheme on first run; theme_mode in config persists user choice"
  artifacts:
    - path: src/renderer/index.html
      provides: "Vite entrypoint loading main.tsx and tokens.css"
    - path: src/renderer/src/App.tsx
      provides: "Root component: theme provider, store subscriptions to onLog/onStatus/onLan, route switch among LoadingScreen → OnboardingScreen → HomeScreen → AddCharacterScreen → CharacterPage → SettingsScreen → ComingSoonScreen"
      exports: ["App"]
    - path: src/renderer/src/lib/ipcClient.ts
      provides: "Typed wrapper around window.sei (delegates straight through; exists for testability and one-spot signature reference)"
      exports: ["sei"]
    - path: src/renderer/src/lib/stores/useUiStore.ts
      provides: "Zustand store: currentView, navigation stack, modal state, theme override"
      exports: ["useUiStore"]
    - path: src/renderer/src/lib/stores/useDataStore.ts
      provides: "Zustand store: characters, lan, summon, logs (ring buffer max 5000)"
      exports: ["useDataStore"]
    - path: src/renderer/src/lib/theme.ts
      provides: "applyTheme(mode), subscribeSystemTheme(cb)"
      exports: ["applyTheme", "subscribeSystemTheme"]
    - path: src/renderer/src/lib/tagLog.ts
      provides: "tagLog(line) → {color, line} regex classifier"
      exports: ["tagLog"]
    - path: src/renderer/src/lib/portraitPalettes.ts
      provides: "PALETTES_LIGHT, PALETTES_DARK arrays; pickPalette(seed, theme)"
      exports: ["PALETTES_LIGHT", "PALETTES_DARK", "pickPalette"]
    - path: src/renderer/src/components/Button.tsx
      provides: "Button primitive (kind: primary|accent|ghost|quiet, size: sm|md|lg)"
      exports: ["Button"]
    - path: src/renderer/src/components/TextField.tsx
      provides: "Borderless underline input (single + multiline, monospace mode, password mode)"
      exports: ["TextField"]
    - path: src/renderer/src/components/IconRail.tsx
      provides: "72px sidebar with Home / MCBlock / Plus / spacer / Theme / Settings buttons"
      exports: ["IconRail"]
    - path: src/renderer/src/components/MacosWindow.tsx
      provides: "1180x760 chrome wrapper with title bar (no fake traffic lights — native chrome only)"
      exports: ["MacosWindow"]
    - path: src/renderer/src/components/PixelPortrait.tsx
      provides: "12x12 deterministic procedural sprite + image-override fallback"
      exports: ["PixelPortrait"]
    - path: src/renderer/src/components/StepDots.tsx
      provides: "Active 22x6 + inactive 6x6 progress dots"
      exports: ["StepDots"]
    - path: src/renderer/src/components/icons.tsx
      provides: "BackIcon, ArrowIcon, PlusIcon, SparkleIcon, HomeIcon, SettingsIcon, SunIcon, MoonIcon, MCBlock"
      exports: ["BackIcon", "ArrowIcon", "PlusIcon", "SparkleIcon", "HomeIcon", "SettingsIcon", "SunIcon", "MoonIcon", "MCBlock"]
    - path: src/renderer/src/screens/LoadingScreen.tsx
      provides: "Boot loading screen — recolored mask-image logo + 3 blinking dots"
      exports: ["LoadingScreen"]
  key_links:
    - from: src/renderer/src/App.tsx
      to: src/renderer/src/lib/stores/useDataStore.ts
      via: "subscribe to window.sei.onLog/onStatus/onLan at mount, push into store"
      pattern: "window\\.sei\\.onLog"
    - from: src/renderer/src/App.tsx
      to: src/renderer/src/components/MacosWindow.tsx
      via: "shell wrapper rendered around all screens except LoadingScreen"
      pattern: "MacosWindow"
    - from: src/renderer/src/lib/theme.ts
      to: document.documentElement
      via: "data-theme attribute"
      pattern: "documentElement\\.setAttribute"
---

<changes_made>
**Revision pass (Warning 5):** Task 3 PixelPortrait determinism is now backed by a literal pixel-value assertion in `<verify>` and `<acceptance_criteria>` so the next checker pass can prove the algorithm is wired correctly (not just that the magic constants appear in the source). The acceptance criterion fixes test seed `'sui Sui'` with theme `'light'`, asserts that the eye pixel at `(4,3)` reads as `#0E0E0E`, and that the sky-row pixel at `(0,5)` matches `palette[1]` from the deterministically-selected palette. A small inline test harness (created during verify) renders the canvas headlessly and reads `getImageData` to confirm.
</changes_made>

<objective>
Stand up the renderer's foundation: HTML entrypoint, root App component, the four CSS files (tokens / global / animations / fonts), the lib layer (ipc client, theme, stores, log tagger, palettes), the primitive components (Button, TextField, IconRail, MacosWindow, PixelPortrait, StepDots, icons), and the LoadingScreen. Subscribes to `window.sei.onLog` / `onStatus` / `onLan` ONCE at App mount, populating the store-level ring buffer.

Purpose: Plans 07 / 08 / 09 build screen flows on top of these primitives. Without the shell, store, theme, and base components, screens have nothing to compose. This plan IS the renderer's "skeleton."

Output: ~22 files. Largest renderer plan. Most components are direct ports from `.planning/phases/04-electron-gui-packaging/design/project/{ui.jsx,screens.jsx,app.jsx}` — visual fidelity is the contract; UI-SPEC dictates behavior on conflict.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@.planning/phases/04-electron-gui-packaging/04-PATTERNS.md
@.planning/phases/04-electron-gui-packaging/04-UI-SPEC.md
@src/shared/ipc.ts
@src/shared/characterSchema.ts
@.planning/phases/04-electron-gui-packaging/design/project/index.html
@.planning/phases/04-electron-gui-packaging/design/project/ui.jsx
@.planning/phases/04-electron-gui-packaging/design/project/screens.jsx
@.planning/phases/04-electron-gui-packaging/design/project/app.jsx
@.planning/phases/04-electron-gui-packaging/design/project/macos-window.jsx

<interfaces>
From RendererApi (src/shared/ipc.ts):
- listCharacters / getCharacter / saveCharacter / deleteCharacter
- getConfig / saveConfig / saveApiKey / hasApiKey
- summon / stop
- onStatus / onLog / onLan returning Unsubscribe

UI-SPEC visual contracts (lock points):
- Color tokens table (§Color, lines ~146–215 of UI-SPEC.md)
- Spacing scale (xs=4 sm=8 md=12 md+=16 lg=24 xl=32 2xl=40 3xl=56)
- Sans token scale (4 sizes / 2 weights only) + sans component overrides table
- Pixel font usage table; Mono usage table
- Animation tokens table
- Button kind × size matrix
- TextField borderless underline 1.5px
- IconRail 72px wide; rail-button hit area 56x56
- MacosWindow 1180x760 + 38px title bar
- StepDots 22x6 active / 6x6 inactive
- PixelPortrait 12x12 algorithm verbatim (FNV-1a + mulberry32 + fixed eye pixels)
- LoadingScreen 1.6s wallclock floor OR app:ready event whichever is later

Mockup files (`.planning/phases/04-electron-gui-packaging/design/project/`) are the visual source of truth for components — port their inline-style patterns into CSS-modules-or-inline-style as the executor judges fit; UI-SPEC §Defaults locks **CSS Modules**.

Tag prefix vocabulary (from src/bot/brain/log.js producer):
- `[chat<-]` `[chat->]` `[haiku?]` `[haiku!]` `[heal]` `[act!]`
Renderer log tagger consumes these.
</interfaces>

<key_locked_decisions>
- D-03: Vite + React + TS for renderer.
- D-05: No CDN deps. Fonts self-hosted under `src/renderer/public/fonts/` (renderer's public dir).
- D-08: Logos at `src/renderer/public/img/sei-logo.svg`, etc. (already moved in plan 01).
- D-14: Procedural pixel portraits deterministic from `id + name`, FNV-1a + mulberry32 + 12x12 mirrored grid + fixed eye pixels.
- D-15: contextIsolation: true; renderer NEVER imports mineflayer or anything from `src/bot/`.
- D-28: All edges sharp — `border-radius: 0` everywhere.
- D-29: Color tokens from UI-SPEC §Color verbatim.
- D-30: Typography — Noto Sans body, Press Start 2P pixel (sparingly), JetBrains Mono mono.
- D-31: Inputs borderless 1.5px underline.
- D-32: macOS traffic lights are NATIVE — never render the mockup's JSX TrafficLights component.
- D-33: theme_mode persisted; first-run respects prefers-color-scheme.
- D-34: Sidebar rail items: Home, MCBlock, +, spacer, Theme, Settings. NO "Sei" wordmark in rail.
- D-35: LoadingScreen recolors via `mask-image: url(/img/sei-logo-small.svg)`.
- D-53: Logs panel buffer cap 5000 lines in renderer.
- UI-SPEC §Defaults: Zustand state (no Redux), CSS Modules, hand-rolled log virtualization, self-hosted fonts.
- RESEARCH §Resolved Q5: Logs ring buffer mounted at the data-store level (App.tsx subscribes once); never drop lines on navigation.
- UI-SPEC line 425: `react-virtuoso` is NOT used; LogsPanel uses hand-rolled IntersectionObserver windowing (plan 08).
- prefers-reduced-motion: respect across all animations (UI-SPEC §Animation Tokens).
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Index HTML, fonts download, all four CSS files (tokens/global/animations/fonts), main.tsx, global.d.ts</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/index.html (entire file — port verbatim minus inline styles)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Color" (lines ~146–215) — full token tables (light + dark + reserved-for list)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Animation Tokens" (lines ~221–243)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Spacing Scale" (lines ~37–76)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Typography" (lines ~80–143)
    - src/shared/ipc.ts (RendererApi for global.d.ts declaration)
    - electron.vite.config.ts (verify alias `@` and `@shared` paths from plan 01)
  </read_first>
  <behavior>
    - `src/renderer/index.html` is a minimal Vite entry: `<!doctype html>`, `<title>Sei</title>`, `<link rel="stylesheet" href="/src/styles/tokens.css">` etc., `<div id="root"></div>`, `<script type="module" src="/src/main.tsx"></script>`. Body has the wallpaper texture via `body::before` (defined in global.css). NO inline `<style>` block (D-05 + UI-SPEC line 31 — split into separate CSS files).
    - `src/renderer/src/main.tsx` mounts `<App />` into `#root` via `ReactDOM.createRoot`.
    - `src/renderer/src/global.d.ts` declares `Window.sei: RendererApi`.
    - Four CSS files produced verbatim from UI-SPEC tables:
      - `tokens.css`: `:root { --window: #FDFEFF; --accent: #F4C2AA; ... }` light tokens + `:root[data-theme="dark"] { ... }` dark tokens + shadow tokens. **Verbatim** from UI-SPEC §Color.
      - `global.css`: body, scrollbars, wallpaper texture (from `index.html` `<style>` body — port). All-edges-sharp affirmed via `* { box-sizing: border-box; }` and component-level `border-radius: 0`. Fonts referenced via `font-family: var(--sans), var(--pixel), var(--mono)`.
      - `animations.css`: `@keyframes seiPulse`, `seiDot`, `fade`, `fade-up` exactly as UI-SPEC §Animation Tokens. Plus `@media (prefers-reduced-motion: reduce) { ... }` block neutralizing pulse/dot animations.
      - `fonts.css`: `@font-face` for Noto Sans 400, Noto Sans 600, Press Start 2P 400, JetBrains Mono 400, JetBrains Mono 500. Each `src: url('/fonts/<file>.woff2') format('woff2')` (renderer/public/fonts/ — files MUST be downloaded as part of this task).
    - Font files (`.woff2`) must be downloaded from Google Fonts to `src/renderer/public/fonts/` (D-05 — no CDN). Use the standard Google Fonts woff2 hosting URLs as the source.
  </behavior>
  <action>
**Step 1.** Download font files. Create `src/renderer/public/fonts/` and place these woff2 files (names exactly as listed):

- `noto-sans-400.woff2` (Noto Sans regular)
- `noto-sans-600.woff2` (Noto Sans semibold)
- `press-start-2p-400.woff2` (Press Start 2P regular)
- `jetbrains-mono-400.woff2` (JetBrains Mono regular)
- `jetbrains-mono-500.woff2` (JetBrains Mono medium)

Acceptable acquisition methods (executor's choice — most direct first):
- `curl` from Google Fonts CSS API → extract woff2 URLs → `curl` each woff2 file. Example:
  ```
  curl -A "Mozilla/5.0" "https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&family=JetBrains+Mono:wght@400;500&family=Press+Start+2P&display=swap" \
    | grep -o "https://[^)]*\\.woff2" | sort -u | head
  ```
- Manual download from Google Fonts website
- npm packages like `@fontsource/noto-sans` and copying their `files/*.woff2`

If network access is unavailable, create empty placeholder files with the correct names — fonts will fail to load and fall back to system fonts at runtime, which is degraded but not blocking. Document the missing files in the SUMMARY so plan 11 can verify on the clean-VM build.

**Step 2.** Create `src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sei</title>
    <link rel="stylesheet" href="/src/styles/fonts.css" />
    <link rel="stylesheet" href="/src/styles/tokens.css" />
    <link rel="stylesheet" href="/src/styles/animations.css" />
    <link rel="stylesheet" href="/src/styles/global.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 3.** Create `src/renderer/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

**Step 4.** Create `src/renderer/src/global.d.ts`:

```ts
import type { RendererApi } from '@shared/ipc';

declare global {
  interface Window { sei: RendererApi; }
}

export {};
```

**Step 5.** Create `src/renderer/src/styles/tokens.css` from UI-SPEC §Color verbatim. Structure:

```css
:root {
  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-md-plus: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 40px;
  --space-3xl: 56px;

  /* Light theme tokens (default) */
  --window: #FDFEFF;
  --accent: #F4C2AA;
  --accent-strong: #E5A382;
  --accent-soft: rgba(244, 194, 170, 0.30);
  --accent-text: #2A1B12;
  --desktop: #F2F1EE;
  --surface: #F6F5F2;
  --surface-2: #FFFFFF;
  --rail: #F6F5F2;
  --rail-active: #ECEAE3;
  --text: #1A1D24;
  --text-2: #4A4D55;
  --muted: #8A8D95;
  --green: #5E8E47;
  --red: #C4523A;
  --warn: #C2A13A;
  --border: rgba(26, 29, 36, 0.08);
  --border-strong: rgba(26, 29, 36, 0.16);

  /* Shadows */
  --shadow-window: 0 0 0 1px rgba(0,0,0,.10), 0 24px 60px rgba(0,0,0,.16), 0 4px 16px rgba(0,0,0,.06);
  --shadow-card: 0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.05);
  --shadow-pop: 0 12px 32px rgba(0,0,0,.10);

  /* Easing */
  --ease-pop: cubic-bezier(.2, .7, .2, 1);

  /* Typography stacks */
  --sans: 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --pixel: 'Press Start 2P', monospace;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

:root[data-theme="dark"] {
  --window: #191C21;
  --accent: #7AA9ED;
  --accent-strong: #94BBF2;
  --accent-soft: rgba(122, 169, 237, 0.16);
  --accent-text: #0F1218;
  --desktop: #14161B;
  --surface: #1F232A;
  --surface-2: #252932;
  --rail: #15181D;
  --rail-active: #252932;
  --text: #E8EBF0;
  --text-2: #B4B9C2;
  --muted: #6E7480;
  --green: #7DB868;
  --red: #E07259;
  --warn: #E0BE5C;
  --border: rgba(255, 255, 255, 0.07);
  --border-strong: rgba(255, 255, 255, 0.14);

  --shadow-window: 0 0 0 1px rgba(0,0,0,.5), 0 24px 60px rgba(0,0,0,.55), 0 4px 16px rgba(0,0,0,.35);
  --shadow-card: 0 1px 2px rgba(0,0,0,.25), 0 4px 12px rgba(0,0,0,.30);
  --shadow-pop: 0 12px 32px rgba(0,0,0,.45);
}
```

**Step 6.** Create `src/renderer/src/styles/global.css`:

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; padding: 0; }

body {
  font-family: var(--sans);
  background: var(--desktop);
  color: var(--text);
  transition: background 240ms ease, color 240ms ease;
  position: relative;
  overflow: hidden;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(1200px 700px at 20% 10%, rgba(244,194,170,0.18), transparent 60%),
    radial-gradient(1000px 800px at 90% 90%, rgba(122,169,237,0.08), transparent 60%);
}

:root[data-theme="dark"] body::before {
  background:
    radial-gradient(1200px 700px at 20% 10%, rgba(122,169,237,0.10), transparent 60%),
    radial-gradient(1000px 800px at 90% 90%, rgba(244,194,170,0.05), transparent 60%);
}

#root { position: relative; z-index: 1; }

/* All edges sharp (D-28) */
button, input, textarea, select { border-radius: 0; }

/* Custom scrollbar — subtle */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-strong); }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

button { font-family: inherit; cursor: pointer; }
input, textarea { font-family: inherit; }
```

**Step 7.** Create `src/renderer/src/styles/animations.css`:

```css
@keyframes seiPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.85; transform: scale(1.02); }
}

@keyframes seiDot {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-3px); }
}

@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  /* UI-SPEC §Accessibility — reduce motion */
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

**Step 8.** Create `src/renderer/src/styles/fonts.css`:

```css
@font-face {
  font-family: 'Noto Sans';
  src: url('/fonts/noto-sans-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Noto Sans';
  src: url('/fonts/noto-sans-600.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Press Start 2P';
  src: url('/fonts/press-start-2p-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('/fonts/jetbrains-mono-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('/fonts/jetbrains-mono-500.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/index.html && test -f src/renderer/src/main.tsx && test -f src/renderer/src/global.d.ts && test -f src/renderer/src/styles/tokens.css && test -f src/renderer/src/styles/global.css && test -f src/renderer/src/styles/animations.css && test -f src/renderer/src/styles/fonts.css && test -d src/renderer/public/fonts && grep -q "FDFEFF" src/renderer/src/styles/tokens.css && grep -q "F4C2AA" src/renderer/src/styles/tokens.css && grep -q "data-theme=\"dark\"" src/renderer/src/styles/tokens.css && grep -q "7AA9ED" src/renderer/src/styles/tokens.css && grep -q "@keyframes seiPulse" src/renderer/src/styles/animations.css && grep -q "@keyframes seiDot" src/renderer/src/styles/animations.css && grep -q "@keyframes fade-up" src/renderer/src/styles/animations.css && grep -q "prefers-reduced-motion" src/renderer/src/styles/animations.css && grep -q "@font-face" src/renderer/src/styles/fonts.css && grep -q "noto-sans-400.woff2" src/renderer/src/styles/fonts.css && grep -q "press-start-2p-400.woff2" src/renderer/src/styles/fonts.css && grep -q "jetbrains-mono-400.woff2" src/renderer/src/styles/fonts.css && grep -q "ReactDOM.createRoot" src/renderer/src/main.tsx && grep -q "Window { sei: RendererApi" src/renderer/src/global.d.ts && ! grep -q "<style>" src/renderer/index.html'</automated>
  </verify>
  <acceptance_criteria>
    - All four CSS files exist under `src/renderer/src/styles/`
    - `tokens.css` contains light hex `#FDFEFF` (window) and `#F4C2AA` (accent) AND dark hex `#191C21` and `#7AA9ED`
    - `tokens.css` has `:root[data-theme="dark"]` selector
    - `animations.css` defines all four keyframe animations: `seiPulse`, `seiDot`, `fade`, `fade-up`
    - `animations.css` contains `@media (prefers-reduced-motion: reduce)` block
    - `fonts.css` declares 5 `@font-face` entries (verified by `grep -c "@font-face" >= 5`)
    - `fonts.css` references `/fonts/noto-sans-400.woff2`, `/fonts/press-start-2p-400.woff2`, `/fonts/jetbrains-mono-400.woff2`
    - `src/renderer/public/fonts/` directory exists (files may be empty placeholders if network was unavailable; Plan SUMMARY notes this)
    - `index.html` has NO `<style>` block (D-05 split rule)
    - `index.html` references `/src/main.tsx`
    - `main.tsx` calls `ReactDOM.createRoot`
    - `global.d.ts` declares `Window { sei: RendererApi }`
  </acceptance_criteria>
  <done>HTML entry, CSS foundation, fonts in place. Renderer can boot a blank window styled with the design tokens.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: lib/ — ipcClient, theme, stores (Zustand), tagLog, portraitPalettes</name>
  <read_first>
    - src/shared/ipc.ts (RendererApi, BotStatus, LanState, LogEntry, LogBatch types)
    - src/shared/characterSchema.ts (Character, UserConfig types)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/renderer/src/lib/stores/useDataStore.ts" (lines ~601–620)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/renderer/src/lib/tagLog.ts" (lines ~544–567)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §6" (lines ~849–875) — bounded ring buffer + Zustand
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Resolved Q5" — store-level subscription
    - .planning/phases/04-electron-gui-packaging/design/project/app.jsx (PALETTES_LIGHT / PALETTES_DARK constants — port)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"PixelPortrait determinism" + §"Logs panel" tag-color list
  </read_first>
  <behavior>
    - `lib/ipcClient.ts`: re-exports `window.sei` as `sei` for testability and one-spot signature reference. Trivial in v1.
    - `lib/theme.ts`: `applyTheme(mode: 'system'|'light'|'dark')` sets `data-theme` attribute on `<html>` (resolves 'system' to actual mode via `matchMedia`); `subscribeSystemTheme(cb)` listens to `prefers-color-scheme` change events.
    - `lib/stores/useUiStore.ts`: Zustand store with `currentView`, `navigation` stack (push/pop), `modal` (LAN modal / delete-confirm), `themeMode`, `pendingSummonId`, navigation/modal actions.
    - `lib/stores/useDataStore.ts`: Zustand store with `characters: Character[]`, `lan: LanState`, `summon: BotStatus`, `logs: LogEntry[]` (max 5000, ring buffer), `dropped: number` accumulator, `loadCharacters()`, `appendLogBatch(batch)`, `setLan(state)`, `setStatus(status)`, `addCharacter(c)`, `removeCharacter(id)`, `updateCharacter(c)`. Plus `subscribeIpc()` factory: returns a teardown fn; calls `window.sei.onLog`, `onStatus`, `onLan` and pushes into store.
    - `lib/tagLog.ts`: pure function `tagLog(line: string): { color: string }` — regex first-match per UI-SPEC §Logs panel.
    - `lib/portraitPalettes.ts`: `PALETTES_LIGHT` and `PALETTES_DARK` (8–10 6-color arrays each), `pickPalette(seed: string, theme: 'light'|'dark'): string[]` — hashes seed with FNV-1a, indexes into the appropriate array.
  </behavior>
  <action>
**Step 1.** `src/renderer/src/lib/ipcClient.ts`:

```ts
import type { RendererApi } from '@shared/ipc';
export const sei: RendererApi = window.sei;
```

**Step 2.** `src/renderer/src/lib/theme.ts`:

```ts
export type ThemeMode = 'system' | 'light' | 'dark';

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute('data-theme', resolved);
}

export function subscribeSystemTheme(cb: (resolved: 'light'|'dark') => void): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches ? 'dark' : 'light');
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
```

**Step 3.** `src/renderer/src/lib/portraitPalettes.ts`:

Open `.planning/phases/04-electron-gui-packaging/design/project/app.jsx` and locate the `PALETTES_LIGHT` and `PALETTES_DARK` constants. Port them verbatim. Each palette is a 6-color array. There should be 8–10 palettes per theme.

```ts
// Source: .planning/phases/04-electron-gui-packaging/design/project/app.jsx
// 6-color palettes per theme; index 0 = sky/background, indexes 1-5 = sprite tiers.
// Port verbatim — palette ORDER and COLOR VALUES must match the mockup so PixelPortrait
// renders identically in production as in the prototype.

export const PALETTES_LIGHT: string[][] = [
  // ... (paste the array of arrays from app.jsx; keep at least 8 palettes)
];

export const PALETTES_DARK: string[][] = [
  // ... (paste the array of arrays from app.jsx)
];

function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pickPalette(seed: string, theme: 'light' | 'dark'): string[] {
  const list = theme === 'dark' ? PALETTES_DARK : PALETTES_LIGHT;
  const idx = fnv1a(seed) % list.length;
  return list[idx];
}
```

**Step 4.** `src/renderer/src/lib/tagLog.ts`:

```ts
/**
 * Pure regex log-line color tagger.
 * Source: UI-SPEC §Logs panel + PATTERNS §src/renderer/src/lib/tagLog.ts.
 *
 * Matches the [HH:MM:SS.mmm] timestamp prefix that src/bot/brain/log.js emits.
 */

export interface TaggedLine {
  color: string;
  line: string;
}

const TS = String.raw`\[\d{2}:\d{2}:\d{2}\.\d{3}\]`;

const RULES: Array<{ re: RegExp; color: string }> = [
  { re: new RegExp(`^${TS}\\s+\\[chat->\\]`), color: 'var(--accent)' },
  { re: new RegExp(`^${TS}\\s+\\[haiku!\\]`), color: 'var(--text)' },
  { re: new RegExp(`^${TS}\\s+\\[haiku\\?\\]`), color: 'var(--text-2)' },
  { re: /\[error\]|^ERROR\b|^Error:/i, color: 'var(--red)' },
  { re: /\[warn\]|^WARN\b/i, color: 'var(--warn)' },
];

export function tagLog(line: string): TaggedLine {
  for (const rule of RULES) {
    if (rule.re.test(line)) return { color: rule.color, line };
  }
  return { color: 'var(--text-2)', line };
}
```

**Step 5.** `src/renderer/src/lib/stores/useDataStore.ts`:

```ts
import { create } from 'zustand';
import type { Character } from '@shared/characterSchema';
import type { BotStatus, LanState, LogEntry, LogBatch } from '@shared/ipc';
import { sei } from '../ipcClient';

const MAX_LOG_LINES = 5000;

interface DataState {
  characters: Character[];
  lan: LanState;
  summon: BotStatus;
  logs: LogEntry[];
  dropped: number;
  loadCharacters: () => Promise<void>;
  refreshCharacter: (id: string) => Promise<void>;
  addCharacter: (c: Character) => void;
  updateCharacter: (c: Character) => void;
  removeCharacter: (id: string) => void;
  setLan: (state: LanState) => void;
  setStatus: (status: BotStatus) => void;
  appendLogBatch: (batch: LogBatch) => void;
  clearLogs: () => void;
}

export const useDataStore = create<DataState>((set) => ({
  characters: [],
  lan: { kind: 'not_connected' },
  summon: { kind: 'idle' },
  logs: [],
  dropped: 0,

  loadCharacters: async () => {
    const list = await sei.listCharacters();
    set({ characters: list });
  },
  refreshCharacter: async (id) => {
    const c = await sei.getCharacter(id);
    if (!c) {
      set((s) => ({ characters: s.characters.filter((x) => x.id !== id) }));
      return;
    }
    set((s) => ({
      characters: s.characters.some((x) => x.id === id)
        ? s.characters.map((x) => (x.id === id ? c : x))
        : [...s.characters, c],
    }));
  },
  addCharacter: (c) => set((s) => ({ characters: [...s.characters, c] })),
  updateCharacter: (c) => set((s) => ({ characters: s.characters.map((x) => (x.id === c.id ? c : x)) })),
  removeCharacter: (id) => set((s) => ({ characters: s.characters.filter((x) => x.id !== id) })),
  setLan: (state) => set({ lan: state }),
  setStatus: (status) => set({ summon: status }),
  appendLogBatch: (batch) => set((s) => {
    const next = s.logs.concat(batch.entries);
    const trimmed = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    return {
      logs: trimmed,
      dropped: s.dropped + (batch.dropped ?? 0),
    };
  }),
  clearLogs: () => set({ logs: [], dropped: 0 }),
}));

/**
 * Wire push subscriptions from preload into the data store.
 * Called once at App.tsx mount; returns a teardown function.
 *
 * Per RESEARCH §Resolved Q5: subscriptions live at the STORE level, not
 * inside individual screen components. Navigation cannot drop log lines.
 */
export function subscribeIpc(): () => void {
  const offLan = sei.onLan((state) => useDataStore.getState().setLan(state));
  const offStatus = sei.onStatus((status) => useDataStore.getState().setStatus(status));
  const offLog = sei.onLog((batch) => useDataStore.getState().appendLogBatch(batch));
  return () => {
    offLan();
    offStatus();
    offLog();
  };
}
```

**Step 6.** `src/renderer/src/lib/stores/useUiStore.ts`:

```ts
import { create } from 'zustand';
import type { ThemeMode } from '../theme';

export type View =
  | { kind: 'loading' }
  | { kind: 'onboarding'; isReonboard: boolean }
  | { kind: 'home' }
  | { kind: 'add-character' }
  | { kind: 'character'; id: string }
  | { kind: 'settings' }
  | { kind: 'coming-soon' };

export type Modal =
  | null
  | { kind: 'lan'; mode: 'info' | 'searching' }
  | { kind: 'delete-confirm'; characterId: string };

interface UiState {
  view: View;
  modal: Modal;
  themeMode: ThemeMode;
  pendingSummonId: string | null;
  navigate: (view: View) => void;
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setPendingSummon: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { kind: 'loading' },
  modal: null,
  themeMode: 'system',
  pendingSummonId: null,
  navigate: (view) => set({ view, modal: null }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setPendingSummon: (id) => set({ pendingSummonId: id }),
}));
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/lib/ipcClient.ts && test -f src/renderer/src/lib/theme.ts && test -f src/renderer/src/lib/tagLog.ts && test -f src/renderer/src/lib/portraitPalettes.ts && test -f src/renderer/src/lib/stores/useUiStore.ts && test -f src/renderer/src/lib/stores/useDataStore.ts && grep -q "export const sei" src/renderer/src/lib/ipcClient.ts && grep -q "export function applyTheme" src/renderer/src/lib/theme.ts && grep -q "export function subscribeSystemTheme" src/renderer/src/lib/theme.ts && grep -q "documentElement.setAttribute" src/renderer/src/lib/theme.ts && grep -q "MAX_LOG_LINES = 5000" src/renderer/src/lib/stores/useDataStore.ts && grep -q "appendLogBatch" src/renderer/src/lib/stores/useDataStore.ts && grep -q "export function subscribeIpc" src/renderer/src/lib/stores/useDataStore.ts && grep -q "sei.onLog" src/renderer/src/lib/stores/useDataStore.ts && grep -q "sei.onStatus" src/renderer/src/lib/stores/useDataStore.ts && grep -q "sei.onLan" src/renderer/src/lib/stores/useDataStore.ts && grep -q "useUiStore" src/renderer/src/lib/stores/useUiStore.ts && grep -q "PALETTES_LIGHT" src/renderer/src/lib/portraitPalettes.ts && grep -q "PALETTES_DARK" src/renderer/src/lib/portraitPalettes.ts && grep -q "export function pickPalette" src/renderer/src/lib/portraitPalettes.ts && grep -q "fnv1a" src/renderer/src/lib/portraitPalettes.ts && grep -q "export function tagLog" src/renderer/src/lib/tagLog.ts && grep -q "var(--accent)" src/renderer/src/lib/tagLog.ts && grep -q "var(--red)" src/renderer/src/lib/tagLog.ts && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "src/renderer.*lib/.*error TS" | grep -v "TS2307.*\\..*\\..*woff2\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - All 6 files exist under `src/renderer/src/lib/`
    - `useDataStore.ts` defines `MAX_LOG_LINES = 5000`
    - `useDataStore.ts` exports `subscribeIpc()` which calls all three: `sei.onLog`, `sei.onStatus`, `sei.onLan`
    - `useDataStore.ts` `appendLogBatch` uses `slice(-MAX_LOG_LINES)` for ring-buffer trim
    - `useUiStore.ts` exports `useUiStore` Zustand store with `view`, `modal`, `themeMode`, `pendingSummonId`, navigation actions
    - `theme.ts` calls `document.documentElement.setAttribute('data-theme', ...)`
    - `theme.ts` exports `applyTheme` and `subscribeSystemTheme`
    - `portraitPalettes.ts` exports `PALETTES_LIGHT`, `PALETTES_DARK`, `pickPalette`
    - `portraitPalettes.ts` defines `fnv1a` hash function
    - `tagLog.ts` includes `var(--accent)` for chat-> and `var(--red)` for error class — verified by grep
    - `npx tsc --noEmit -p tsconfig.web.json` reports 0 errors for files under `src/renderer/src/lib/` (errors about woff2 modules or empty inputs tolerated)
  </acceptance_criteria>
  <done>State + theme + tagger + palette modules ready. Components in Task 3 + screens in Plans 07/08 consume from these.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: Components (Button, TextField, IconRail, MacosWindow, PixelPortrait, StepDots, icons), App.tsx, LoadingScreen</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/ui.jsx (entire — Button, TextField, IconRail/Sidebar, RailButton, AppWindow, PixelPortrait, all icon SVGs; port verbatim into TS+CSS-Modules)
    - .planning/phases/04-electron-gui-packaging/design/project/macos-window.jsx (window chrome reference — but DO NOT render JSX TrafficLights; per UI-SPEC line 336 + D-32)
    - .planning/phases/04-electron-gui-packaging/design/project/app.jsx (App composition reference + palette constants)
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (LoadingScreen + StepDots specifics)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Component Inventory" (Button matrix, TextField, IconRail, MacosWindow, PixelPortrait, StepDots — full visual contract)
    - .planning/phases/04-electron-gui-packaging/04-PATTERNS.md §"src/renderer/src/components/MacosWindow.tsx" + §"src/renderer/src/components/PixelPortrait.tsx"
  </read_first>
  <behavior>
    - `Button.tsx`: Variants × sizes per UI-SPEC matrix. Primary (text bg + window text), Accent (--accent + --accent-text), Ghost (transparent + --text), Quiet (transparent + --text-2). Sizes sm/md/lg dimensions per UI-SPEC.
    - `TextField.tsx`: Borderless 1.5px bottom underline. Single-line + multiline. Monospace mode. Password mode. autoFocus, onEnter handler.
    - `IconRail.tsx`: 72px wide. Buttons: Home, MCBlock, +, spacer, Theme toggle, Settings. Active button: 3px left bar in --accent at top:8 bottom:8. NO Sei wordmark.
    - `MacosWindow.tsx`: 1180x760 wrapper. Title bar 38px draggable (`-webkit-app-region: drag` on the title bar; `no-drag` on inner buttons). NO fake traffic lights. On macOS adds 80px left padding to title bar so the centered title doesn't collide with the OS-drawn lights.
    - `PixelPortrait.tsx`: Implements the FNV-1a + mulberry32 algorithm verbatim per UI-SPEC §PixelPortrait determinism (lines ~344–361). 12x12 grid; left half generated, mirrored to right; eyes at (4,3) and (4,8) forced to `#0E0E0E`; top 2 rows = sky linear gradient palette[0]→palette[1]; rows 7–11 body 75% fill from palette indices 2..(palLen-1); rows 2–6 head 82% fill. Renders via Canvas or SVG (Canvas simpler; size param controls the canvas pixel size, scaled with `image-rendering: pixelated`). Image override fallback: if `portraitImage` prop is non-null and `<img>` loads, render that instead.
    - **WARNING-5 determinism contract:** the algorithm MUST be extractable as a pure function `generatePixelGrid(seed, palette): string[][]` that returns a 12x12 array of `#RRGGBB` strings. The component then paints this grid to canvas. Extracting the pure function makes the determinism assertion testable without jsdom canvas mocking (see acceptance_criteria for the seed `'sui Sui'`/theme `'light'` pixel assertions).
    - `StepDots.tsx`: Active dot 22x6 in --accent; past dot 6x6 in --text-2; future dot 6x6 in --border-strong. Width transition 240ms ease.
    - `icons.tsx`: BackIcon, ArrowIcon, PlusIcon, SparkleIcon (four-point sparkle with smaller secondary sparkle), HomeIcon, SettingsIcon (gear), SunIcon, MoonIcon, MCBlock (generic green-top / brown-side pixel block — NOT Minecraft branded per CONTEXT specifics).
    - `LoadingScreen.tsx`: Full-window background --window. Recolored Sei mark via `mask-image: url('/img/sei-logo-small.svg')` tinted with `background-color: var(--accent)` at 220px wide. seiPulse 1.6s. Three blinking dots staggered 160ms (seiDot animation).
    - `App.tsx`: On mount: applyTheme based on stored `theme_mode` (or 'system' first run), subscribe to system theme changes, call `subscribeIpc()` once, call `useDataStore.getState().loadCharacters()`. Determine first view based on `await sei.hasApiKey()` — if no key, navigate to onboarding step 0; if has key, navigate to home. Use `useUiStore` to manage view; initial `view = {kind: 'loading'}` for at least 1.6s. Renders `LoadingScreen` while view.kind === 'loading'; once ready, renders `MacosWindow > IconRail + content area > <CurrentScreen />`. The CurrentScreen switch covers home/onboarding/character/add-character/settings/coming-soon (concrete screens come from plans 07–08; for THIS plan, render `<div>TODO: {view.kind}</div>` placeholders for any screen not yet implemented). Hooks into `useUiStore` for view + modal; modals render at top of MacosWindow (or document.body via portal — your call).
  </behavior>
  <action>
This task is the largest in the phase. The executor should:

1. **Open the four mockup files** (`design/project/ui.jsx`, `screens.jsx`, `app.jsx`, `macos-window.jsx`) and READ them fully ONCE. Each component below corresponds to a JSX function in those files. The mockup uses inline styles; we port to CSS Modules (`Button.module.css` adjacent to `Button.tsx`, etc.) — UI-SPEC Defaults locks CSS Modules.

2. **Port each component as a 1:1 visual port**, with these adaptations:
   - JSX → `.tsx` with `interface Props` from UI-SPEC type signatures.
   - Inline styles → CSS Modules. Pull every CSS variable reference (`var(--accent)` etc.) as-is.
   - Mockup SVGs → `icons.tsx` named exports.

3. **MacosWindow specifics:** DO NOT render the mockup's `<TrafficLights />` JSX — UI-SPEC line 336 + D-32 mandate native chrome only. Title bar uses `-webkit-app-region: drag` (CSS) so the user can drag the window. Buttons inside need `-webkit-app-region: no-drag` to remain clickable. macOS adds 80px left padding to title bar.

4. **PixelPortrait verbatim algorithm.** The constants `2246822507` and `3266489909` ARE NOT arbitrary (UI-SPEC line 351–352, line 588–592 — same input must produce same sprite as the prototype's mockup). Render via `<canvas>` 12x12 then scaled to `size` prop with `image-rendering: pixelated`. Reference `pickPalette` from `lib/portraitPalettes.ts`.

5. **App.tsx orchestration:**

```tsx
import React, { useEffect, useState } from 'react';
import { sei } from './lib/ipcClient';
import { applyTheme, subscribeSystemTheme, type ThemeMode } from './lib/theme';
import { useUiStore } from './lib/stores/useUiStore';
import { useDataStore, subscribeIpc } from './lib/stores/useDataStore';
import { MacosWindow } from './components/MacosWindow';
import { IconRail } from './components/IconRail';
import { LoadingScreen } from './screens/LoadingScreen';

const LOADING_FLOOR_MS = 1600;

export function App(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const navigate = useUiStore((s) => s.navigate);
  const [bootStartedAt] = useState(() => Date.now());

  // Apply theme + subscribe to system changes
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return;
    return subscribeSystemTheme(() => applyTheme('system'));
  }, [themeMode]);

  // One-time IPC subscription; never torn down except on full app exit.
  // Per RESEARCH §Resolved Q5 — store-level subscription prevents log loss on navigation.
  useEffect(() => {
    const teardown = subscribeIpc();
    return teardown;
  }, []);

  // Initial bootstrap
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Load persisted config + theme
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        setThemeMode(cfg.theme_mode as ThemeMode);
        applyTheme(cfg.theme_mode as ThemeMode);
      } catch {
        // Defaults already applied
      }

      // Load character list
      try { await useDataStore.getState().loadCharacters(); } catch {}

      // Decide first view
      const hasKey = await sei.hasApiKey().catch(() => false);
      if (cancelled) return;

      // Loading screen wallclock floor
      const elapsed = Date.now() - bootStartedAt;
      const remaining = Math.max(0, LOADING_FLOOR_MS - elapsed);
      window.setTimeout(() => {
        if (cancelled) return;
        if (!hasKey) {
          navigate({ kind: 'onboarding', isReonboard: false });
        } else {
          navigate({ kind: 'home' });
        }
      }, remaining);
    })();
    return () => { cancelled = true; };
  }, [bootStartedAt, navigate, setThemeMode]);

  if (view.kind === 'loading') return <LoadingScreen />;

  return (
    <MacosWindow subtitle={subtitleForView(view)}>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <IconRail />
        <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {/* Plans 07–08 fill these in. For this plan, placeholders are fine. */}
          {view.kind === 'onboarding' && <OnboardingPlaceholder />}
          {view.kind === 'home' && <HomePlaceholder />}
          {view.kind === 'add-character' && <AddCharacterPlaceholder />}
          {view.kind === 'character' && <CharacterPagePlaceholder id={view.id} />}
          {view.kind === 'settings' && <SettingsPlaceholder />}
          {view.kind === 'coming-soon' && <ComingSoonPlaceholder />}
        </main>
      </div>
    </MacosWindow>
  );
}

function subtitleForView(view: ReturnType<typeof useUiStore.getState>['view']): string {
  switch (view.kind) {
    case 'onboarding': return 'Onboarding';
    case 'home': return 'Characters';
    case 'add-character': return 'New character';
    case 'character': return ' ';      // CharacterPage shows the character name elsewhere; keep subtitle minimal
    case 'settings': return 'Settings';
    case 'coming-soon': return 'Other games';
    default: return '';
  }
}

const Placeholder = ({ label }: { label: string }) => (
  <div style={{ padding: 40 }}>{label} — implemented in plan 07–08</div>
);
const OnboardingPlaceholder = () => <Placeholder label="Onboarding" />;
const HomePlaceholder = () => <Placeholder label="Home" />;
const AddCharacterPlaceholder = () => <Placeholder label="AddCharacter" />;
const CharacterPagePlaceholder = ({ id }: { id: string }) => <Placeholder label={`Character ${id}`} />;
const SettingsPlaceholder = () => <Placeholder label="Settings" />;
const ComingSoonPlaceholder = () => <Placeholder label="ComingSoon" />;
```

6. **LoadingScreen.tsx:**

```tsx
export function LoadingScreen(): React.ReactElement {
  return (
    <div className={styles.root}>
      <div className={styles.mark} aria-label="Sei" />
      <div className={styles.dots}>
        <span style={{ animationDelay: '0ms' }} />
        <span style={{ animationDelay: '160ms' }} />
        <span style={{ animationDelay: '320ms' }} />
      </div>
    </div>
  );
}
```

With `LoadingScreen.module.css`:

```css
.root {
  position: fixed; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 24px;
  background: var(--window);
}
.mark {
  width: 220px; height: 36px;
  background-color: var(--accent);
  -webkit-mask-image: url('/img/sei-logo-small.svg');
  mask-image: url('/img/sei-logo-small.svg');
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
  animation: seiPulse 1600ms ease-in-out infinite;
}
.dots {
  display: flex; gap: 6px;
}
.dots span {
  width: 6px; height: 6px;
  background: var(--accent);
  display: block;
  animation: seiDot 1100ms ease-in-out infinite;
}
```

7. For each component (Button, TextField, IconRail, MacosWindow, PixelPortrait, StepDots, icons), ensure:
   - File exports the component as a named export (no default exports).
   - Adjacent `<Component>.module.css` for styles. (`icons.tsx` has no companion CSS — pure SVGs.)
   - Props interface matches UI-SPEC Component Inventory contract exactly.
   - prefers-reduced-motion respected (handled globally via `animations.css` rule that zeroes durations).

Implementation depth note: This task can take ~30% context. Optimize by porting components in dependency order (icons first, then Button/TextField, then IconRail/MacosWindow which use icons, then StepDots/PixelPortrait, then App + LoadingScreen). Resist over-styling — match mockup colors/dimensions exactly; avoid creative additions.
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/components/Button.tsx && test -f src/renderer/src/components/TextField.tsx && test -f src/renderer/src/components/IconRail.tsx && test -f src/renderer/src/components/MacosWindow.tsx && test -f src/renderer/src/components/PixelPortrait.tsx && test -f src/renderer/src/components/StepDots.tsx && test -f src/renderer/src/components/icons.tsx && test -f src/renderer/src/screens/LoadingScreen.tsx && test -f src/renderer/src/App.tsx && grep -q "export function Button" src/renderer/src/components/Button.tsx && grep -q "export function TextField" src/renderer/src/components/TextField.tsx && grep -q "export function IconRail" src/renderer/src/components/IconRail.tsx && grep -q "export function MacosWindow" src/renderer/src/components/MacosWindow.tsx && grep -q "export function PixelPortrait" src/renderer/src/components/PixelPortrait.tsx && grep -q "export function StepDots" src/renderer/src/components/StepDots.tsx && grep -q "export function App" src/renderer/src/App.tsx && grep -q "export function LoadingScreen" src/renderer/src/screens/LoadingScreen.tsx && grep -q "subscribeIpc" src/renderer/src/App.tsx && grep -q "applyTheme" src/renderer/src/App.tsx && grep -q "sei.hasApiKey" src/renderer/src/App.tsx && grep -q "sei.getConfig" src/renderer/src/App.tsx && grep -q "LOADING_FLOOR_MS = 1600" src/renderer/src/App.tsx && grep -q "2246822507" src/renderer/src/components/PixelPortrait.tsx && grep -q "3266489909" src/renderer/src/components/PixelPortrait.tsx && grep -q "0E0E0E\\|#0e0e0e" src/renderer/src/components/PixelPortrait.tsx && grep -q "BackIcon\\|export.*BackIcon" src/renderer/src/components/icons.tsx && grep -q "SparkleIcon" src/renderer/src/components/icons.tsx && grep -q "MCBlock" src/renderer/src/components/icons.tsx && grep -q "HomeIcon" src/renderer/src/components/icons.tsx && grep -q "SunIcon" src/renderer/src/components/icons.tsx && grep -q "MoonIcon" src/renderer/src/components/icons.tsx && ! grep -q "TrafficLights" src/renderer/src/components/MacosWindow.tsx && grep -q "mask-image" src/renderer/src/screens/LoadingScreen.module.css && grep -q "border-radius: 0\\|border-radius:0" src/renderer/src/components/Button.module.css && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(components|screens|App)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS2307.*woff2\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - All 7 component files + 1 screen file + App.tsx exist
    - Each component file exports the named function (verified by `grep -q "export function <Name>"`)
    - `MacosWindow.tsx` does NOT contain `TrafficLights` (D-32 — verified by grep returning 0)
    - `PixelPortrait.tsx` contains the magic constants `2246822507` AND `3266489909` (UI-SPEC determinism contract)
    - `PixelPortrait.tsx` contains the eye color `0E0E0E` (or `0e0e0e`)
    - **WARNING-5 fix (determinism contract):** for the canonical seed `'sui Sui'` rendered against theme `'light'`, the resulting 12x12 canvas MUST satisfy:
      - pixel `(4,3)` is `#0E0E0E` (the left-eye fixed pixel)
      - pixel `(7,3)` is `#0E0E0E` (the right-eye fixed pixel — column 7 = `12 - 1 - 4` = mirror of column 4)
      - pixel `(0,5)` matches `palette[1]` from `pickPalette('sui Sui', 'light')` (the sky-gradient lower band)
      The executor MUST add a small jsdom/canvas-mock or headless-Chromium test that renders `<PixelPortrait seed="sui Sui" size={12} ... />` and reads `ctx.getImageData(...)` to assert these three pixels. The test runs as part of Task 3's verify command. If running headless canvas in jsdom is impractical, the executor extracts the pixel-generation function (the part before `ctx.fillRect`) into a pure helper and unit-tests THAT helper instead — the helper must return a 12x12 array of hex strings.
    - `icons.tsx` exports at minimum: BackIcon, ArrowIcon, PlusIcon, SparkleIcon, HomeIcon, SettingsIcon, SunIcon, MoonIcon, MCBlock (verified by grep matching each)
    - `App.tsx` calls `subscribeIpc()`, `applyTheme(...)`, `sei.hasApiKey()`, `sei.getConfig()`
    - `App.tsx` has `LOADING_FLOOR_MS = 1600` constant (UI-SPEC §Animation Tokens)
    - `LoadingScreen.module.css` uses `mask-image` for the recolored logo
    - `Button.module.css` contains `border-radius: 0` (D-28 sharp corners)
    - `npx tsc --noEmit -p tsconfig.web.json` reports 0 errors for new files (errors about `*.module.css` modules are tolerated — Vite's CSS modules type plugin handles them at build time, not tsc)
  </acceptance_criteria>
  <done>Renderer skeleton complete. `npm run dev` boots an Electron window showing LoadingScreen → "Onboarding placeholder" or "Home placeholder" depending on whether an API key is saved. Plans 07–08 replace placeholders with real screens.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| renderer→main IPC | All IPC happens through `window.sei` typed bridge; renderer cannot import Node APIs |
| renderer DOM | User input contained; no `dangerouslySetInnerHTML` permitted |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-27 | Tampering | malicious bot stdout containing HTML/script | mitigate | LogsPanel renders lines as plain text (React's default escaping); no innerHTML; tagLog only sets a CSS color, never a class with side effects |
| T-04-28 | Information Disclosure | renderer Console / DevTools logs | accept | DevTools is dev-only; production builds disable it via electron-builder default |
| T-04-29 | Spoofing | renderer impersonates main via crafted IPC payload | mitigate | Plan 05's ipc.ts validates every payload with Zod; this plan only consumes through preload (no direct IPC from renderer) |
| T-04-30 | Tampering | XSS in onboarding text fields | mitigate | TextField uses React controlled inputs; values flow through Zod validation in main on save; renderer renders plain text only |
</threat_model>

<verification>
- `npm run dev` boots an Electron window
- Window shows LoadingScreen for ≥1.6s
- After loading: navigates to Onboarding placeholder (no API key) OR Home placeholder
- Pressing Cmd-Shift-I (dev only) opens DevTools; no errors in console (font load failures permitted if WOFF2s couldn't be downloaded)
- Theme: clicking the IconRail theme button toggles `data-theme` between light and dark
- LAN pill / data flow: visible in Home placeholder once plans 07/08 land — for this plan, the store updates correctly (verified by setting a manual `useDataStore.getState().setLan(...)` in DevTools)
- `npx tsc --noEmit -p tsconfig.web.json` passes with 0 errors for renderer files (CSS module resolution errors tolerated)
</verification>

<success_criteria>
- Plans 07/08 import primitives (Button, TextField, IconRail, MacosWindow, PixelPortrait, StepDots, icons) from `src/renderer/src/components/` and the lib helpers and only need to author screen-specific layout.
- Plan 11 verifies that on a clean-VM build, fonts/icons/images all load (relative paths resolve correctly under packaged Electron).
- Logs panel (plan 08) consumes from `useDataStore.getState().logs` directly — no need to subscribe again.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-06-SUMMARY.md` documenting:
- Whether the WOFF2 font files were successfully downloaded; if not, list the placeholders for plan 11 to verify
- Final list of icon names exported from `icons.tsx` (so plan 07/08 know what's available)
- Confirmation that subscribeIpc subscribes only ONCE in App's mount effect
- Note for plan 09 (errors): the LAN-unavailable / KEYCHAIN_FALLBACK toast surface is not yet wired — plan 09 adds it to App.tsx as a top-of-window banner or toast
- Note for plan 07 executor: navigate from `useUiStore` and read `useDataStore.getState().lan` for LAN-aware behavior
</output>
