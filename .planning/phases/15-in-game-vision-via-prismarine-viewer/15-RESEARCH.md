# Phase 15: In-Game Vision via prismarine-viewer - Research

**Researched:** 2026-06-04
**Domain:** Headless 3D rendering under Electron utilityProcess + multi-provider VLM image-content wiring + custom Minecraft line-of-sight + proxy rate-limit gating
**Confidence:** MEDIUM-HIGH (codebase seams VERIFIED; prismarine-viewer headless-under-Electron path is the one genuine LOW-confidence risk that the planner must validate against a PACKAGED build)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Two render paths. (a) **Explicit `visualize`** — an LLM-callable closed-registry action the bot can invoke at any time. (b) **Idle auto-render** — fires on the existing P3 idle tick (~60s) when enabled. v1.0 idle = every idle tick (no scene-change gating).
- **D-02:** **Skip near-duplicate frames** before sending an idle frame — compare to last-sent frame via a cheap frame/position hash; skip if effectively unchanged.
- **D-03:** **Aggressive compression** — downscale and lower quality well below the 512×512 ceiling. Target ≈256px + low JPEG quality (Claude's discretion). Model only needs general shapes/layout.
- **D-04:** A dedicated **prismarine/vision config** block exposes: **render frequency**, **auto-render on/off**, **image quality**. Default auto-render = **OFF**.
- **D-05:** Auto-render surfaced as **one additional toggle line in the Settings screen** (NOT CharacterPage), gated behind a **confirm popup**. Single global toggle scopes to active character (single-bot-at-a-time). Writes through to D-04 config.
- **D-06:** Confirm popup says plainly auto-look **uses more playtime** — **no token counts, no numeric estimates** (PROXY-05).
- **D-07:** When auto-render ON, the **Playtime/Credits "~Xh playtime" figure shrinks** (apply a vision multiplier to the playtime estimate).
- **D-08:** **Explicit `visualize` is ungated by owner-proximity.** The 16-block + LOS gate (VIS-04/VIS-05) governs **idle auto-render only**. Explicit renders whatever the bot sees now; still degrades gracefully (VIS-08).
- **D-09:** **Per-hour cap applies to explicit renders only** (~10/hour, configurable). Idle renders already bounded by idle-tick cadence.
- **D-10:** **VLM gating (VIS-03)** keys off the existing per-provider `capabilities.vision` descriptor from Phase 14. Non-VLM provider → `visualize` hidden from registry AND idle toggle disabled/inert.
- **D-11:** BYO-key and local-VLM users get **vision allowed, uncapped, no playtime warning** — same capability gating (D-10) + same compression (D-03), but no proxy per-hour cap and no playtime-shrink. Idle toggle still available.

### Claude's Discretion
- **Render visibility in the GUI:** show a small **thumbnail in the chat log** of what the bot saw (transparency/trust). Net-new renderer work (chat log has no image-block UI today). May fall back to feed-silently-to-model if too heavy — but default is to show it.
- Exact compression target (resolution + JPEG quality), the dedupe hash algorithm (perceptual hash vs position+yaw/pitch quantization), the LOS helper's exact block/fluid/entity handling (VIS-05), the degradation copy wording ("I can't see clearly right now"), and the explicit-render cap default number — all Claude's discretion within the decisions above.

### Deferred Ideas (OUT OF SCOPE)
- **Scene-change-gated idle cadence** (render only on meaningful view change). v1.0 = every-idle-tick + dedupe.
- **Per-character (not global) vision settings.** Global Settings toggle sufficient while single-bot holds.
- **Modded-texture extraction into the viewer atlas** — explicitly **Phase 16**.
- **Frame-fidelity tuning** (FOV, render entities/other players, hand/HUD) — left to render-path research; not a v1.0 user decision.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VIS-01 | Bot-POV `prismarine-viewer` headless render → PNG from eye position + look direction | §"Render Path (VIS-01)" — `prismarine-viewer/viewer` subpath: `Viewer`+`WorldView` against a three.js `WebGLRenderer` backed by `node-canvas-webgl`; `viewer.setFirstPersonCamera(pos, yaw, pitch)`; single frame via `canvas.toBuffer()` (no ffmpeg/MP4). Runs in the bot **utilityProcess** (VERIFIED: bot is `utilityProcess.fork`). |
| VIS-02 | `visualize` Zod action → fresh render → image content block in next turn | §"Image-Content Seam (VIS-02)" — `messageMappers.js` has NO image path today (VERIFIED). Recommended: tool_result stays text; image attaches as a **fresh user turn** in a provider-neutral `{type:'image'}` internal block; mappers translate per provider. |
| VIS-03 | Gated by `capabilities.vision`; non-VLM → `visualize` hidden + idle disabled | §"Capability Gating (VIS-03/D-10)" — `provider.capabilities.vision` already exists per Phase 14 (VERIFIED). Conditional registration is net-new at `createDefaultRegistry`/adapter seam. |
| VIS-04 | VLM + within 16 blocks of owner + clear LOS → auto-attach render every idle tick (default OFF; opt-in + cost warning) | §"Idle Auto-Render Hook (VIS-04)" + §"Config & UI". P3 idle tick exists (`sei:idle`, VERIFIED). 16-block + LOS gate governs idle only (D-08). |
| VIS-05 | Custom LOS helper (not raw `bot.world.raycast`) — non-full blocks, fluids, entity bounding boxes | §"Custom Line-of-Sight (VIS-05)" — raw raycast iterates `block.shapes` only, never fluids or entities (VERIFIED in `prismarine-world/src/world.js`). Algorithm sketched. |
| VIS-06 | Downscale to max 512×512 before send | §"Compression (D-03/VIS-06)" — D-03 goes smaller (~256px low-quality JPEG). |
| VIS-07 | Per-hour cap enforced by the proxy (cloud users) | §"Proxy Per-Hour Cap (VIS-07/D-09)" — slots into `checkAndIncrementBucket` with a new `vision_hourly` bucket kind + 3600s window (VERIFIED pattern in `personaDailyGate.ts`). |
| VIS-08 | Graceful degradation when chunks aren't loaded ("I can't see clearly right now") | §"Graceful Degradation (VIS-08)" — render-empty/throw → string result, no image attached. |
</phase_requirements>

## Summary

This phase is two-thirds plumbing through existing, well-understood seams (closed registry, P3 idle tick, proxy bucket gate, provider-capability descriptor — all VERIFIED in the codebase) and one-third genuine native-rendering risk that the planner must de-risk early against a **packaged** build, not just `electron-vite dev`.

The render path is clearer than the discussion feared. `prismarine-viewer` exposes a `prismarine-viewer/viewer` subpath with two clean classes — `Viewer` (wraps a three.js `WebGLRenderer`) and `WorldView` (subscribes to a mineflayer bot's loaded chunks). The mainline `headless` export streams JPEG frames to **ffmpeg → MP4**, which Sei does **not** want (Sei needs one PNG, no ffmpeg dependency, no infinite frame loop). The recommended approach skips the `headless` export entirely and drives `Viewer`+`WorldView` directly: build a `WebGLRenderer` on a `node-canvas-webgl` canvas, `worldView.listenToBot(bot)` + `worldView.init(pos)`, `viewer.setFirstPersonCamera(bot.entity.position.offset(0, bot.entity.eyeHeight, 0), bot.entity.yaw, bot.entity.pitch)`, `await viewer.waitForChunksToRender()`, `viewer.update()`, then grab `canvas.toBuffer('image/png')` for one frame. **The native risk is `node-canvas-webgl` → `gl` (headless-gl) + `canvas`, which must be `@electron/rebuild`-ed against Electron 42's ABI and load in the utilityProcess from `app.asar.unpacked`.** headless-gl prebuilds target node-abi, not electron-abi, so a from-source rebuild against Electron headers is required. This is the named "Native ABI mismatch" pitfall and is the single highest-risk task — plan it first, gate it on a `checkpoint:human-verify` against a packaged build on a clean machine.

VIS-02 is the second-riskiest wiring and the research resolved its cleanest shape: `orchestrator.js` has no image-content path and `messageMappers.js` only translates `text`/`tool_use`/`tool_result`. Anthropic alone allows an image *inside* a `tool_result.content` array; OpenAI-compat, Ollama, and Gemini all **forbid** images in tool/function-result messages — images must ride a separate `role:'user'` turn. Therefore the provider-agnostic design is: `visualize` returns a short **text** tool_result ("rendered — view attached"), and the orchestrator appends a **fresh user turn** carrying a provider-neutral internal `{type:'image', source:{media_type, data}}` block that the four mappers each translate to their native shape. This keeps the seam single-sourced in `messageMappers.js` and avoids Anthropic-only behavior leaking into the orchestrator.

**Primary recommendation:** Drive `prismarine-viewer/viewer` directly (NOT the `headless` MP4 export) for a single `canvas.toBuffer()` PNG in the bot utilityProcess; rebuild `node-canvas-webgl`/`gl`/`canvas` against Electron 42 and verify in a packaged build FIRST; wire VIS-02 as a fresh provider-neutral image **user turn** (not a tool_result image) translated in `messageMappers.js`; gate everything on the existing `capabilities.vision` flag; add a `vision_hourly` proxy bucket alongside `persona_daily`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Headless POV render (VIS-01) | Bot utilityProcess | — | mineflayer `bot` + native GL live in utilityProcess only (three-process invariant; VERIFIED `utilityProcess.fork` in `botSupervisor.ts`). The renderer process must NOT do this — it has no `bot`. |
| `visualize` action registration + gating (VIS-02/03) | Bot utilityProcess (brain + adapter) | — | Closed registry + provider capabilities both live in `src/bot/`. |
| Image content-block translation (VIS-02) | Bot utilityProcess (`brain/llm/messageMappers.js`) | — | Provider wire-format translation is already centralized here. |
| Custom LOS helper (VIS-05) | Bot utilityProcess (adapter/minecraft) | — | Needs live `bot.world` + `bot.entities`; mineflayer-specific → adapter layer, not brain. |
| Frame dedupe + compression (D-02/D-03) | Bot utilityProcess | — | Operates on the raw render buffer before it crosses to the LLM call. |
| Per-hour vision cap (VIS-07) | Proxy (Fly.io) | Bot (signals request) | Cap must be server-authoritative (D-09: explicit renders are LLM-driven and unbounded). |
| Vision config block (D-04) | Bot config (`src/bot/config.js`) | Renderer (Settings toggle writes through) | Config is source of truth (D-05); Settings is a thin write-through. |
| Settings toggle + confirm popup (D-05/D-06) | Renderer (`SettingsScreen.tsx`) | Main (IPC persist) | UI tier; mirrors the existing backend-switch confirm-modal pattern. |
| Playtime shrink (D-07) | Renderer (`playtimeEstimate.ts`) | — | Pure client-side multiplier; no main-process release needed. |
| Chat-log thumbnail (discretion) | Renderer | Bot (emits image to chat-log IPC) | Net-new renderer image-block UI. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `prismarine-viewer` | 1.33.0 (pub 2025-02-09) | Bot-POV world render (`Viewer`+`WorldView`) | The PrismarineJS-official renderer; the locked vision decision is built on it. `[ASSUMED]` (see audit). |
| `node-canvas-webgl` | 0.3.0 (pub 2023-08-11) | Headless `<canvas>` + WebGL context for three.js in Node | The exact module `prismarine-viewer`'s headless example imports. Pulls `canvas`+`gl`. `[ASSUMED]` |
| `gl` (headless-gl) | 8.1.6 (latest) — but pinned `^6.0.0` by node-canvas-webgl@0.3.0 | Native WebGL implementation (ANGLE-backed) | The actual GPU-less GL context. **Native; ABI-critical.** `[ASSUMED]` |
| `canvas` (node-canvas) | 3.2.3 (latest) — pinned `^2.6.0` by node-canvas-webgl@0.3.0 | 2D canvas + image encode (`toBuffer`) | Native; produces the PNG/JPEG buffer. `[ASSUMED]` |

### Already present (transitive — DO NOT re-add)
| Library | Version | Note |
|---------|---------|------|
| `three` | 0.156.1 (via skinview3d) AND 0.128.0 (pinned by prismarine-viewer) | VERIFIED both present in separate subtrees — **no conflict**; prismarine-viewer resolves its own pinned 0.128.0. Do not attempt to dedupe. |
| `prismarine-block` | 1.23.0 | VERIFIED present (mineflayer transitive). Exposes `block.shapes` + `block.boundingBox` for LOS. |
| `prismarine-world` | (mineflayer transitive) | VERIFIED. Owns `bot.world.raycast` (the one VIS-05 must NOT use). |
| `prismarine-entity` | 2.6.0 | VERIFIED. Entity `.height`/`.width` for LOS bounding boxes. |
| `vec3` | 0.1.10 | VERIFIED. LOS ray math. |
| `minecraft-data` | (present) | VERIFIED. Block metadata. |

### Supporting (compression — pick ONE, Claude's discretion D-03)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `canvas` (already in tree via node-canvas-webgl) | 3.2.3 | `canvas.toBuffer('image/jpeg', {quality})` + draw-to-smaller-canvas downscale | **Recommended** — zero new native dep; node-canvas already does encode + resize. |
| `sharp` | 0.34.x | High-quality resize + JPEG encode | Only if `canvas` downscale quality is insufficient. Adds a second heavy native dep (libvips) → more ABI surface. Prefer to AVOID. `[ASSUMED]` |
| `jpeg-js` | 0.4.x | Pure-JS JPEG encode | Fallback if a native encode path is unavailable; slower, pure-JS (no ABI risk). `[ASSUMED]` |

**Strong recommendation:** do all downscale + JPEG encoding with the **`canvas`** that `node-canvas-webgl` already pulls in. Draw the GL canvas onto a smaller 2D canvas (~256px) and `toBuffer('image/jpeg', {quality: 0.4})`. This adds **zero** new native modules beyond the render stack and keeps the ABI surface minimal.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `prismarine-viewer/viewer` direct frame | `prismarine-viewer` `headless` export | `headless` spawns ffmpeg, streams JPEG frames to an MP4, loops `frames` times. Wrong shape for one-shot PNG; adds an ffmpeg system dependency Sei doesn't ship. **Reject.** |
| `node-canvas-webgl` (gl-backed) | Render in a hidden Electron `BrowserWindow` (real Chromium WebGL) | Avoids headless-gl native build entirely — Chromium already has WebGL. BUT violates the three-process invariant (render would live in main/renderer, not the bot utilityProcess that owns `bot`), and requires shuttling chunk data across processes. **Reject for v1.0**; note as a fallback if the headless-gl rebuild proves intractable. |
| `gl` (headless-gl) | `@kmamal/gl` / other GL bindings | Not what prismarine-viewer depends on; would require a custom viewer fork. **Reject.** |

**Installation (subject to per-package `checkpoint:human-verify` — see audit):**
```bash
npm install prismarine-viewer node-canvas-webgl
# gl + canvas come transitively via node-canvas-webgl; three/prismarine-block/world/entity/vec3 already present
npm run postinstall   # electron-builder install-app-deps → rebuilds native (gl, canvas) against Electron 42
```

**Version verification (run before locking the stack):**
```bash
npm view prismarine-viewer version        # confirmed 1.33.0 @ 2025-02-09
npm view node-canvas-webgl version        # confirmed 0.3.0 @ 2023-08-11
npm view gl version ; npm view canvas version
```

## Package Legitimacy Audit

> slopcheck was **NOT available** at research time (`pip install slopcheck` failed in this environment). Per protocol, **every package below is tagged `[ASSUMED]`** and the planner **MUST gate each `npm install` behind a `checkpoint:human-verify` task** before it runs. Registry existence (verified via `npm view`) does not by itself confer VERIFIED status.

| Package | Registry | Age / Last Pub | Source Repo | slopcheck | Disposition |
|---------|----------|----------------|-------------|-----------|-------------|
| `prismarine-viewer` | npm | pub 2025-02-09 (v1.33.0); mature project | github.com/PrismarineJS/prismarine-viewer | unavailable | **Approved, ASSUMED** — gate install behind checkpoint. PrismarineJS-official; aligns with locked decision. |
| `node-canvas-webgl` | npm | pub 2023-08-11 (v0.3.0); **stale, low-maintenance** | github (third-party, not PrismarineJS) | unavailable | **Approved with WARNING, ASSUMED** — it is the exact module prismarine-viewer's own headless example imports, but it is a small third-party package last touched 2023. Pins old `canvas@^2.6.0`/`gl@^6.0.0`. Verify the pinned native versions actually `@electron/rebuild` against Electron 42 in the de-risk task. |
| `gl` (headless-gl) | npm | v8.1.6 latest (pub 2026-04-10); pinned `^6.0.0` transitively | github.com/stackgl/headless-gl | unavailable | **Approved, ASSUMED** — native, ABI-critical. Pin/override may be needed to get a version that builds on Node 22 / Electron 42. |
| `canvas` (node-canvas) | npm | v3.2.3 latest (pub 2026-03-31); pinned `^2.6.0` transitively | github.com/Automattic/node-canvas | unavailable | **Approved, ASSUMED** — native, widely used. |
| `sharp` (only if needed) | npm | active | github.com/lovell/sharp | unavailable | **Avoid unless `canvas` encode insufficient, ASSUMED** — adds libvips native dep. |
| `jpeg-js` (fallback) | npm | active, pure-JS | github.com/jpeg-js/jpeg-js | unavailable | **Fallback only, ASSUMED** — no ABI risk. |

**Packages removed due to slopcheck [SLOP] verdict:** none (slopcheck unavailable).
**Packages flagged as suspicious [SUS]:** `node-canvas-webgl` is flagged here as **stale/low-maintenance** (not slopcheck-derived) — the planner should add a `checkpoint:human-verify` that confirms it builds against Electron 42 before committing to it.

**Postinstall-script check:** `electron-builder install-app-deps` (Sei's existing postinstall) is what rebuilds native modules; `gl` and `canvas` run node-gyp builds at install — expected and legitimate, but they are the failure surface on a clean machine.

## Architecture Patterns

### System Architecture Diagram

```
                          ┌─────────────────────────────────────────────────────────┐
                          │             BOT utilityProcess (src/bot/)                  │
                          │                                                            │
  P3 idle tick ──sei:idle─┤► fsm.js ──► brain/index.js ──► orchestrator.handleDispatch │
  (~60s, VIS-04)          │                                      │                     │
                          │                                      ▼                     │
  LLM tool_use            │              ┌──────────────────────────────────────┐     │
  "visualize" ───────────►├─────────────►│ adapter.executeAction('visualize')    │     │
  (VIS-02, gated VIS-03)  │              └──────────────────┬───────────────────┘     │
                          │                                 │                          │
                          │   idle path only (D-08):        ▼                          │
                          │   16-block + LOS gate ──►  [losClear?] ──no──► (skip)       │
                          │   (VIS-04/VIS-05)               │ yes                       │
                          │                                 ▼                          │
                          │     ┌─────────── renderPov(bot) (VIS-01) ──────────────┐   │
                          │     │ node-canvas-webgl canvas → three WebGLRenderer    │   │
                          │     │ Viewer(renderer) + WorldView(bot.world,vd,pos)    │   │
                          │     │ setFirstPersonCamera(eyePos, yaw, pitch)          │   │
                          │     │ waitForChunksToRender(); update(); render()       │   │
                          │     │ chunks loaded? ──no──► throw → "can't see" (VIS-08)│   │
                          │     └───────────────────────┬───────────────────────────┘   │
                          │                             ▼                              │
                          │   downscale ~256px + JPEG q~0.4 (D-03/VIS-06) ──► buffer   │
                          │                             │                              │
                          │   idle path: dedupe vs last frame (D-02) ──same──►(skip)   │
                          │                             ▼ new                          │
                          │   append FRESH user turn: {type:'image',source:{...}}      │
                          │   (VIS-02 — NOT a tool_result image)                       │
                          │                             ▼                              │
                          │   messageMappers.js per-provider translate ──► provider.call│
                          └───────────────┬──────────────────────────────┬────────────┘
                                          │ (cloud-proxy mode)            │ (BYOK/local)
                                          ▼                               ▼
              ┌───────────────────────────────────────┐      direct → Anthropic/OpenAI/
              │  Fly.io PROXY  (VIS-07/D-09)           │      Gemini/Ollama (no cap, D-11)
              │  POST /v1/messages                     │
              │  …→ visionHourlyGate (vision_hourly,   │
              │       3600s, ~10/hr, explicit only)    │
              │  …→ rateLimitGate → forward            │
              └───────────────────────────────────────┘

   ┌── Renderer (src/renderer) ──────────────────────────────────────────────────┐
   │ SettingsScreen: auto-render toggle line ──► VisionAutoRenderConfirmModal      │
   │   (D-05/D-06 "uses more playtime", no numbers) ──► IPC ──► config (D-04)      │
   │ CreditsScreen/UsageBar: playtimeEstimate × vision multiplier when ON (D-07)   │
   │ chat log: optional thumbnail of bot.image (discretion)                        │
   └──────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/bot/adapter/minecraft/
├── observers/
│   └── lineOfSight.js     # NEW — custom LOS (VIS-05): blocks+fluids+entities
├── behaviors/
│   └── visualize.js       # NEW — renderPov() + downscale + dedupe (VIS-01/06, D-02/03)
├── render/
│   └── povRenderer.js     # NEW — prismarine-viewer/viewer wiring + node-canvas-webgl
└── registry.js            # EDIT — conditional 'visualize' registration (VIS-02/03)

src/bot/brain/llm/
└── messageMappers.js      # EDIT — add {type:'image'} block → per-provider translation (VIS-02)

src/bot/brain/
└── orchestrator.js        # EDIT — append fresh image user-turn after visualize settles (VIS-02)

src/bot/
└── config.js              # EDIT — vision config block (D-04)

proxy/src/rateLimit/
└── visionHourlyGate.ts    # NEW — mirrors personaDailyGate.ts (VIS-07/D-09)

src/renderer/src/
├── screens/SettingsScreen.tsx              # EDIT — toggle line (D-05)
├── components/VisionAutoRenderConfirmModal.tsx  # NEW — confirm popup (D-06)
└── lib/playtimeEstimate.ts                 # EDIT — vision multiplier (D-07)
```

### Pattern 1: Direct single-frame headless render (VIS-01)
**What:** Drive `Viewer`+`WorldView` directly; capture one PNG via `canvas.toBuffer()`. Skip the `headless`/ffmpeg/MP4 machinery.
**When to use:** Always for Sei — we want one still, not a video stream.
**Example (shape — planner must verify exact `viewer` subpath import against the installed package):**
```javascript
// Source: prismarine-viewer/viewer/README.md (Viewer + WorldView public API)
//         + examples/headless.js (node-canvas-webgl + setFirstPersonCamera)
// [CITED: github.com/PrismarineJS/prismarine-viewer viewer/README.md]
const { createCanvas } = require('node-canvas-webgl')   // headless WebGL canvas
const THREE = require('three')
const { Viewer, WorldView } = require('prismarine-viewer/viewer')

async function renderPov(bot, { width = 256, height = 256, viewDistance = 4 } = {}) {
  const canvas = createCanvas(width, height)
  const renderer = new THREE.WebGLRenderer({ canvas })
  const viewer = new Viewer(renderer)
  viewer.setVersion(bot.version)                          // VIS-08: guard — bot.version must exist

  const center = bot.entity.position
  const worldView = new WorldView(bot.world, viewDistance, center)
  viewer.listen(worldView)
  await worldView.init(center)                            // emits loaded chunks
  worldView.listenToBot(bot)

  // VIS-08: if no chunks render (not loaded), waitForChunksToRender resolves with
  // an empty scene → caller detects black/empty frame and returns the degrade string.
  await viewer.waitForChunksToRender()

  const eye = center.offset(0, bot.entity.eyeHeight, 0)   // VERIFIED bot.entity.eyeHeight exists
  viewer.setFirstPersonCamera(eye, bot.entity.yaw, bot.entity.pitch)
  viewer.update()
  renderer.render(viewer.scene, viewer.camera)            // exact draw call: verify against installed API

  // node-canvas encode — downscale by rendering at small size + JPEG (D-03/VIS-06)
  const buf = canvas.toBuffer('image/jpeg', { quality: 0.4 })  // verify node-canvas-webgl exposes toBuffer
  // teardown: dispose renderer + remove worldView listeners to avoid GL context leak
  worldView.removeListenersFromBot?.(bot)
  renderer.dispose?.()
  return buf
}
```
**Wall-clock timeout (CLAUDE.md invariant):** wrap `renderPov` in a `Promise.race` against a timer (e.g. 5s) — `waitForChunksToRender` can hang if chunks never arrive. **Every external call has a timeout — no exceptions.**

### Pattern 2: Provider-neutral image attachment (VIS-02)
**What:** Add a fourth internal block type `{type:'image', source:{media_type, data}}` and translate it in each mapper. Attach it as a **fresh user turn** after `visualize` settles — NOT inside the tool_result.
**When to use:** Always — only Anthropic accepts tool_result images; OpenAI/Gemini/Ollama require a user-turn image. A fresh user turn is the one shape all four accept.
**Per-provider translation (the seam to add in `messageMappers.js`):**
```javascript
// Anthropic (native — anthropicClient passes blocks through verbatim):
//   { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:<b64> } }
// OpenAI-compat + Ollama (anthropicToOpenAIMessages — user message content array):
//   { type:'image_url', image_url:{ url:`data:${media_type};base64,${data}` } }
// Gemini (anthropicToGeminiContents — user parts):
//   { inline_data:{ mime_type:media_type, data:<b64> } }   // alias inlineData also accepted
```
[VERIFIED: platform.claude.com vision docs — image allowed in tool_result.content for Anthropic] but [CITED: OpenAI community — images only allowed in `user` role, never `tool` role]; Gemini matches (image must be a user `inline_data` part, not a `functionResponse`). The fresh-user-turn shape is therefore the lowest-common-denominator and keeps the orchestrator provider-agnostic.

### Pattern 3: Conditional `visualize` registration (VIS-03/D-10)
**What:** Register `visualize` only when `provider.capabilities.vision === true`.
**Where:** The adapter's `createDefaultRegistry()` is unconditional today (VERIFIED). The provider/capabilities live in the brain (`createLlmProvider(config).capabilities.vision`). The cleanest seam: pass a `visionEnabled` boolean from the orchestrator (which already holds the provider) into the adapter at construction, OR have the orchestrator filter `visualize` out of `combinedToolsFor()` when `!anthropic.capabilities?.vision`. **Recommendation:** filter at the tool-list level in `orchestrator.combinedToolsFor()` AND skip registration in the adapter — belt-and-suspenders so a non-VLM provider never sees the tool even if registration leaks.
```javascript
// orchestrator.js combinedToolsFor() — drop visualize when provider lacks vision
const visionOk = !!anthropic.capabilities?.vision
const movementTools = buildAnthropicTools(subRegistry, descMap)
  .filter(t => visionOk || t.name !== 'visualize')
```

### Anti-Patterns to Avoid
- **Rendering in the renderer/main process.** The `bot` lives in the utilityProcess; rendering anywhere else means shuttling chunk data across the process boundary. Render in the bot utilityProcess. (CLAUDE.md three-process invariant.)
- **Using the `headless` MP4 export for a single still.** Spawns ffmpeg, loops frames. Wrong tool.
- **Putting the rendered image inside the `tool_result` content for cross-provider use.** Only Anthropic accepts it; OpenAI/Gemini/Ollama silently drop or 400. Use a fresh user turn.
- **`bot.world.raycast` for the LOS gate.** Misses non-full blocks edge cases (it only tests `block.shapes`, which slabs/signs/fences DO have but fluids do NOT), and never tests entity bounding boxes. (Pitfall 10 — see VIS-05.)
- **Generating code from the LLM.** `visualize` is a Zod-typed closed-registry action; never widen this. (Closed-registry invariant.)
- **Editing a renderer `.tsx`/`.ts` without deleting the stale shadow `.js`.** Every modal has a `.js` next to it (VERIFIED in the component listing). Vite serves the stale `.js`. Delete the artifact (outside `src/bot`) + restart dev. (Project pitfall.)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| World-to-image rendering | A custom three.js Minecraft renderer (block models, textures, lighting) | `prismarine-viewer/viewer` `Viewer`+`WorldView` | Block-model + biome + texture-atlas rendering is thousands of lines and the whole reason the locked decision picked prismarine-viewer. |
| Headless WebGL context | Custom WebGL/GL bindings | `node-canvas-webgl` (→ `gl`) | ANGLE-backed conformant WebGL; reinventing this is a multi-month native project. |
| Image downscale + JPEG encode | Manual pixel resampling | `canvas.toBuffer('image/jpeg',{quality})` (already in tree via node-canvas-webgl) | node-canvas already does high-quality resize + encode; zero new dep. |
| Per-hour rate limiting | A bespoke in-memory hourly counter on the bot | Proxy `check_and_increment_bucket` RPC + new `vision_hourly` bucket | Server-authoritative (D-09 — bot is untrusted); atomic Postgres upsert already exists. |
| Block bounding boxes | Hardcoded slab/stair/fence dimensions | `prismarine-block` `block.shapes` / `block.boundingBox` | Per-version, per-state shapes already shipped in minecraft-data. |
| Entity bounding boxes | Hardcoded mob sizes | `prismarine-entity` `entity.height`/`entity.width` | Already populated by mineflayer. |

**Key insight:** Almost everything except the LOS helper and the image-content wiring is already in node_modules. The work is **integration + native-build de-risking**, not greenfield construction.

## Runtime State Inventory

> Phase 15 is **greenfield feature work, not a rename/refactor/migration.** No stored string keys, OS registrations, or data migrations are introduced. Inventory categories:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no new DB keys or collection names. Vision config (D-04) is new config fields, not a migration of existing rows. | None |
| Live service config | One new proxy bucket kind `vision_hourly` — but it uses the EXISTING `check_and_increment_bucket` RPC + `usage_buckets` table (no new migration if the RPC is kind-agnostic; VERIFY the RPC's `p_bucket_kind` is an open text param, which `personaDailyGate` evidence suggests). | Possibly a 1-line `BucketKind` type addition in `buckets.ts` (code), no SQL migration. |
| OS-registered state | None. | None |
| Secrets/env vars | None — no new secrets. Vision proxy gate reuses the existing JWT auth chain. | None |
| Build artifacts | New native modules (`gl`, `canvas`) require `electron-builder install-app-deps` to rebuild against Electron 42; they land in `app.asar.unpacked` (existing `asarUnpack: node_modules/**/*` already covers them — VERIFIED in electron-builder.yml). | Run postinstall; verify packaged build loads them. |

**Nothing found in OS-registered state, secrets, or stored-data migration — verified by inspection of config.js, buckets.ts, and electron-builder.yml.**

## Common Pitfalls

### Pitfall 1: headless-gl / canvas native ABI mismatch under Electron utilityProcess (HIGHEST RISK)
**What goes wrong:** `gl` prebuilds target node-abi, not electron-abi. Even when `npm install` succeeds against system Node, the module fails to load inside the Electron utilityProcess (`Module did not self-register` / `getUniformLocation of null` / segfault) — and dev may work while the **packaged** build fails because the rebuild didn't run for the packaged ABI or the binary wasn't unpacked.
**Why it happens:** Electron 42 ships Node ~22 but a different ABI (Chromium BoringSSL, electron module version ~135). Native modules MUST be rebuilt against Electron headers (`@electron/rebuild` / `electron-builder install-app-deps`), and must load from `app.asar.unpacked` (Node can't `dlopen` a `.node` inside the asar). [CITED: electronjs.org/docs using-native-node-modules; github.com/electron/rebuild]
**How to avoid:** (1) Make the FIRST task a spike: install, `npm run postinstall`, render one frame in the utilityProcess in `electron-vite dev`. (2) Make the SECOND task a `dist` + run-on-clean-machine `checkpoint:human-verify` BEFORE building any feature on top. (3) Confirm `gl`/`canvas` land in `node_modules` under `app.asar.unpacked` (existing `asarUnpack: node_modules/**/*` covers it — VERIFIED). (4) Keep the BrowserWindow-WebGL fallback (Alternatives table) documented in case headless-gl can't be made to build.
**Warning signs:** Works in `dev`, crashes in `dist`. `headless-gl` issue #128's `getUniformLocation of null` is the canonical "no GL context" failure.

### Pitfall 2: Vision-token cost blowout (named Roadmap Pitfall 8)
**What goes wrong:** Each image ≈ `width*height/750` tokens — a 256×256 frame ≈ ~87 tokens, but a 512×512 ≈ ~350, and an un-downscaled 1568px frame ≈ 1568 tokens (10–100× a text turn). An idle bot rendering every 60s for an hour = 60 renders; an LLM looping `visualize` is unbounded. [VERIFIED: platform.claude.com vision — `width*height/750` token formula]
**Why it happens:** No dedupe + no cap + no aggressive downscale.
**How to avoid:** D-03 (downscale to ~256px ≈ ~87 tokens/frame), D-02 (skip near-duplicate idle frames), D-09 (proxy per-hour cap on explicit renders), default-OFF idle (D-04). All four are required, not optional.
**Warning signs:** A parked bot's credit balance dropping during idle; explicit-render count spiking.

### Pitfall 3: `bot.world.raycast` used for the LOS gate (named Roadmap Pitfall 10)
**What goes wrong:** Raw raycast (VERIFIED in `prismarine-world/src/world.js:60`) iterates blocks and intersects `block.shapes`. **Fluids** (water/lava) have *empty* collision shapes → raycast passes straight through them as if air (so the bot "sees" the owner through a lake). It never considers **entities** at all (the owner could be behind a horse/another mob and raycast wouldn't know). For non-full *blocks* (slabs, fences, panes) raycast is actually CORRECT (they have real shapes) — the documented failure is specifically fluids + entities + the desire to treat partial occlusion deliberately.
**Why it happens:** raycast is a block-collision tool, not a visibility tool.
**How to avoid:** Custom LOS helper (VIS-05 below) that (a) steps the ray block-by-block checking `block.shapes` for solid occluders, (b) treats fluid blocks (`block.name` in water/lava/`_water`/`_lava` or `block.getProperties().level != null` / non-empty `block.shapes.length===0 && isFluid`) as occluders if you want "can't see through water" semantics, (c) tests intervening entity AABBs via `prismarine-entity` `entity.height`/`entity.width`.
**Warning signs:** Bot auto-renders when the owner is underwater or behind a wall it should be blocked by.

### Pitfall 4: Image attached as a tool_result image breaks non-Anthropic providers
**What goes wrong:** Putting `{type:'image'}` in a `tool_result.content` array works for Anthropic but OpenAI/Ollama emit it on a `role:'tool'` message (forbidden — image only allowed on `user`), and Gemini puts it in a `functionResponse` (forbidden). Result: 400 or silently-dropped image. [CITED: OpenAI community "only user messages can include images"]
**How to avoid:** tool_result stays text; image rides a **fresh user turn** (Pattern 2).
**Warning signs:** Vision works on Anthropic, 400s or "I can't see the image" on OpenAI/Gemini.

### Pitfall 5: GL context / WorldView listener leak across repeated renders
**What goes wrong:** Each `visualize` builds a `WebGLRenderer` + `WorldView` that subscribes to bot events. Without teardown, contexts and listeners accumulate → memory growth and eventual GL context-limit crash (headless-gl caps live contexts).
**How to avoid:** Either reuse a single long-lived `Viewer`/`renderer`/`WorldView` (re-`updatePosition` + re-`setFirstPersonCamera` per render — preferred for an idle-loop hot path) OR dispose renderer + remove bot listeners after every render. Reuse is better for the every-60s idle cadence.
**Warning signs:** RSS climbing each idle tick; "too many active WebGL contexts" after N renders.

### Pitfall 6: Stale `.js` shadows the renderer `.tsx` edits (project pitfall)
**What goes wrong:** `SettingsScreen.tsx`, `playtimeEstimate.ts`, and every modal have a sibling compiled `.js`. Vite serves the stale `.js`, silently ignoring your edits.
**How to avoid:** After editing any renderer source, delete the sibling `.js` (NEVER under `src/bot`) and restart dev.

## Code Examples

### Custom LOS helper (VIS-05) — algorithm sketch
```javascript
// Source: derived from prismarine-world raycast + prismarine-block shapes + prismarine-entity AABB
// [VERIFIED: prismarine-world/src/world.js:60 raycast iterates block.shapes only]
// [VERIFIED: prismarine-block exposes block.shapes + block.boundingBox]
// [VERIFIED: prismarine-entity exposes entity.height + entity.width]
const { Vec3 } = require('vec3')

const FLUID_NAMES = new Set(['water', 'lava', 'flowing_water', 'flowing_lava'])

function hasClearLineOfSight(bot, targetEntity, { stepsPerBlock = 4 } = {}) {
  const from = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
  const to   = targetEntity.position.offset(0, (targetEntity.height ?? 1.8) * 0.85, 0) // aim near head
  const dir  = to.minus(from)
  const dist = dir.norm()
  if (dist > 16) return false                          // VIS-04 16-block gate
  const unit = dir.scaled(1 / dist)
  const steps = Math.ceil(dist * stepsPerBlock)

  for (let i = 1; i < steps; i++) {
    const p = from.plus(unit.scaled(dist * (i / steps)))
    const block = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    if (!block) return false                            // unloaded chunk → treat as no LOS (VIS-08-adjacent)
    // (a) fluid occlusion — fluids have empty collision shapes, so raycast misses them
    if (FLUID_NAMES.has(block.name)) return false
    // (b) solid / partial block occlusion via real shapes (slabs/fences/panes have shapes)
    if (block.shapes && block.shapes.length > 0 && pointInAnyShape(p, block)) return false
  }
  // (c) entity occlusion — any OTHER entity whose AABB the ray crosses blocks sight
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || e === bot.entity || e === targetEntity || !e.position) continue
    if (segmentIntersectsEntityAABB(from, to, e)) return false
  }
  return true
}
// pointInAnyShape: test p (relative to block origin) against each [x0,y0,z0,x1,y1,z1] in block.shapes
// segmentIntersectsEntityAABB: slab-method ray/AABB using e.position±e.width/2 and e.height
```
Note: whether to treat fluids as opaque is a v1.0 product call — for an "auto-look at owner" gate, treating water/lava as blocking (don't auto-render when owner is underwater) is the safe, cheap reading and matches user expectation.

### Proxy per-hour vision gate (VIS-07/D-09)
```typescript
// Source: mirrors proxy/src/rateLimit/personaDailyGate.ts [VERIFIED pattern]
// New BucketKind 'vision_hourly' added to buckets.ts BucketKind union.
import type { MiddlewareHandler } from 'hono';
import { checkAndIncrementBucket } from './buckets.js';
import { sendError } from '../middleware/sentinel.js';

export const VISION_HOURLY_LIMIT = 10n;          // D-09 ~10/hr, configurable
const VISION_WINDOW_SECONDS = 3600;

export const visionHourlyGate: MiddlewareHandler<{ Variables: { userId: string } }> =
  async (c, next) => {
    const userId = c.get('userId');
    const r = await checkAndIncrementBucket(
      userId, 'vision_hourly', 1n, VISION_HOURLY_LIMIT, VISION_WINDOW_SECONDS);
    if (!r.allowed) {
      c.header('Retry-After', String(r.retry_after_seconds));
      return sendError(c, { code: 'rate_limited', kind: r.kind, retry_after_seconds: r.retry_after_seconds });
    }
    await next();
  };
```
**How the bot signals "this is an explicit vision request":** the cleanest route is a dedicated proxy path the bot hits only for explicit `visualize`-triggered LLM calls — e.g. `POST /vision/v1/messages` wired `originLockGate → ipRateLimitGate → verifyJwt → visionHourlyGate → rateLimitGate → forward`, OR a header (`x-sei-vision: 1`) inspected by a gate mounted on `/v1/messages`. A dedicated path is preferred (matches the existing `/free/v1/messages` + `personaDailyGate` precedent — VERIFIED in `app.ts:79`). **Open question:** the bot's `anthropicClient` is constructed with one `baseURL`; routing only the explicit-vision turn to a different path requires either a per-call path override or a second client. The planner must design this (see Open Questions). Idle renders MUST NOT hit this gate (D-09).

### Vision config block (D-04)
```javascript
// src/bot/config.js — extend ConfigSchema [VERIFIED schema shape]
vision: z.object({
  auto_render: z.boolean().default(false),              // D-04 default OFF / VIS-04
  render_interval_ms: z.number().int().min(1000).default(60_000), // "render frequency"
  image_quality: z.number().min(0.1).max(1).default(0.4),         // "image quality" D-03
  resolution_px: z.number().int().min(64).max(512).default(256),  // D-03 ~256, VIS-06 ≤512 cap
  explicit_cap_per_hour: z.number().int().min(1).default(10),     // D-09 (bot-side hint; proxy authoritative)
}).default({}),
```

### Playtime shrink (D-07)
```typescript
// src/renderer/src/lib/playtimeEstimate.ts — apply a vision multiplier to tokensPerMin
// when auto_render is ON, the effective burn rate rises → "~Xh" shrinks.
// DEFAULT_TOKENS_PER_MIN is the single knob (VERIFIED). Pass a multiplied rate:
//   const rate = autoRenderOn ? DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER : DEFAULT_TOKENS_PER_MIN
// VISION_MULTIPLIER (Claude's discretion): derive from frames/min × tokens/frame.
//   ~256px frame ≈ 87 tokens; 1 frame/min idle ≈ +87 tok/min on a ~6800 base ≈ ~1.3% — too small to see.
//   The multiplier should reflect REALISTIC heavier usage (explicit calls + larger frames); pick a
//   user-honest value (e.g. 1.3–1.5×) rather than the idle-only floor. Validate against real usage.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OS screen capture / Fabric companion mod for vision | Bot-POV via prismarine-viewer headless | Locked decision (Roadmap) | No macOS Screen-Recording permission, no privacy leak. |
| `headless` MP4 stream via ffmpeg | Direct `Viewer`+`WorldView` single `canvas.toBuffer()` | This research | No ffmpeg dep; one still, not a video. |
| Image inside tool_result (Anthropic-only habit) | Fresh provider-neutral user-turn image | This research | Works across all 4 Phase-14 providers. |

**Deprecated/outdated:**
- `node-canvas-webgl@0.3.0` is **stale (2023)** and pins old `canvas`/`gl`. It still works but is the maintenance-risk dependency — flagged for human verification.
- prismarine-viewer pins `three@0.128.0` (2021-era). Fine in its own subtree; do not try to upgrade it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `prismarine-viewer/viewer` subpath exports `Viewer`+`WorldView` consumable in Node with a `node-canvas-webgl` `WebGLRenderer` for a SINGLE frame (not just the express/web path). | Render Path / Pattern 1 | If the subpath isn't cleanly importable headless, may need the `headless` export (with ffmpeg) or a viewer fork. De-risk spike resolves this. |
| A2 | `gl` + `canvas` (via node-canvas-webgl) `@electron/rebuild` successfully against Electron 42 ABI and load in the utilityProcess from `app.asar.unpacked`. | Pitfall 1 | If they can't build, fall back to BrowserWindow-WebGL render (violates three-process purity) or descope idle/explicit render. **This is the make-or-break risk.** |
| A3 | The proxy `check_and_increment_bucket` RPC accepts an arbitrary `p_bucket_kind` text value (so `vision_hourly` needs no SQL migration, only a `BucketKind` type addition). | Runtime State / VIS-07 | If the RPC enumerates kinds, a small migration is needed. Cheap to verify by reading the migration SQL. |
| A4 | `node-canvas-webgl`'s canvas exposes `toBuffer('image/jpeg',{quality})` (node-canvas API) for downscale/encode without adding `sharp`. | Compression | If not, add `jpeg-js` (pure-JS, no ABI) or draw onto a separate `canvas` instance. |
| A5 | The bot can route ONLY explicit-vision LLM turns to a vision-gated proxy path while idle/normal turns use the standard path. | VIS-07 / Open Q1 | If hard to separate, the cap may need a header on `/v1/messages` + conditional gate, or accept idle renders also count. Design decision for the planner. |
| A6 | Treating fluids as LOS occluders matches product intent for the idle auto-render gate. | VIS-05 / Pitfall 3 | If users want "see through water," invert; low risk, easily tuned. |
| A7 | `image ≈ w*h/750 tokens` applies to the Haiku-class model Sei uses for the playtime multiplier math. | Pitfall 2 / D-07 | Formula is Anthropic-documented for current models; OpenAI/Gemini differ. Multiplier is an estimate anyway (PROXY-05 forbids exact numbers in UI). |

## Open Questions

1. **How does the bot route ONLY the explicit-`visualize` turn through the proxy's vision-hourly gate (D-09)?** **[RESOLVED — plan 15-06 Tasks 2-3]**
   - **Resolution:** per-call `path` override on the Anthropic SDK. `anthropicClient.call` (15-06 Task 2) gains an optional `path` param forwarded to `sdk.messages.create(req, { ..., path })` (RequestOptions.path is a documented per-request override; the cloud `baseURL` is the proxy ORIGIN with no path component, so `path:'/vision/v1/messages'` routes that single request through 15-02's vision gate). The orchestrator (15-06 Task 3) sets a one-shot flag on the EXPLICIT-`visualize` branch only and, in `callPersonality`, passes `path: VISION_MESSAGES_PATH` for exactly that next turn — gated on `config.anthropic.cloudMode` (cloud-proxy only; BYOK/local are uncapped per D-11) and never set on the idle path (15-07 keeps `/v1/messages`, D-09). Chosen over an `x-sei-vision` header or a second client (least new surface; matches the existing single-client + setAuthToken/setBackend design). The proxy chain stays `originLockGate -> ipRateLimitGate -> verifyJwt -> visionHourlyGate -> rateLimitGate -> forward` (15-02). Forge-resistance: the cap is server-authoritative behind verifyJwt — hitting /vision can only CONSUME the user's own cap, never bypass it (15-06 threat T-15-06-04).

2. **Reuse a single long-lived `Viewer` vs build-per-render?**
   - What we know: idle cadence is ~60s; building a GL context per render risks context-limit leaks (Pitfall 5).
   - Recommendation: long-lived `Viewer`+`renderer`+`WorldView`, `updatePosition`+`setFirstPersonCamera` per frame. Validate context stability over many renders in the de-risk spike.

3. **Does the proxy's `usage_buckets` / `check_and_increment_bucket` need a migration for `vision_hourly`?** (A3) **[RESOLVED — plan 15-02 Task 1]**
   - **Resolution:** YES — a migration IS required (overturns the original "likely no migration" guess). The RPC accepts `p_bucket_kind` as free text, BUT the `rate_buckets` TABLE has a CHECK constraint (`rate_buckets_bucket_kind_check`) that ENUMERATES allowed kinds and blocks any new kind at insert time. 15-02 Task 1 ships `supabase/migrations/20260604000000_vision_hourly_bucket.sql` (drop-then-add the CHECK to include `'vision_hourly'`, mirroring `20260527000000_persona_free_bucket.sql`), extends the `BucketKind` TS union, and runs a [BLOCKING] `supabase db push` before verification (without it the gate passes tsc/tests but rejects a real insert at runtime).

4. **Chat-log thumbnail (discretion): how heavy is net-new renderer image-block UI?**
   - Recommendation: ship the silent-to-model path first (image → LLM only), add the thumbnail as a follow-up task if cheap. CONTEXT says default is to show it, but it's explicitly downgradeable.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Electron | utilityProcess host | ✓ | 42.0.0 | — |
| `@electron/rebuild` | native rebuild (gl, canvas) | ✓ | 4.0.4 (devDep) | — |
| `three` | prismarine-viewer render | ✓ | 0.128.0 (pv subtree) + 0.156.1 (skinview3d) | — |
| `prismarine-block` / `-world` / `-entity` / `vec3` | LOS + render | ✓ | 1.23.0 / present / 2.6.0 / 0.1.10 | — |
| `minecraft-data` | block metadata | ✓ | present | — |
| `prismarine-viewer` | render (VIS-01) | ✗ | — (install 1.33.0) | none — required |
| `node-canvas-webgl` (+ `gl`, `canvas`) | headless WebGL (VIS-01) | ✗ | — (install) | BrowserWindow-WebGL render (last resort, breaks three-process purity) |
| C/C++ toolchain (node-gyp) | building gl/canvas | likely (Xcode CLT on macOS) | — | required for from-source rebuild |
| ffmpeg | ONLY the `headless` MP4 export | not needed | — | N/A — we avoid the headless export |

**Missing dependencies with no fallback:**
- `prismarine-viewer` + `node-canvas-webgl`/`gl`/`canvas` — must install and rebuild; the render feature cannot exist without them. The ONLY fallback (BrowserWindow-WebGL) compromises the three-process invariant and is a last resort.

**Missing dependencies with fallback:**
- Image encode: `canvas.toBuffer` preferred → `jpeg-js` (pure-JS, no ABI) fallback.

## Project Constraints (from CLAUDE.md)

- **Three-process Electron — render MUST run in the utilityProcess.** mineflayer (and therefore the render, which needs `bot.world`) lives in the bot utilityProcess only. NEVER render in main/renderer. (VERIFIED: `botSupervisor.ts` `utilityProcess.fork`.)
- **Closed action registry — `visualize` is a Zod-typed action, never generated code.** Register it like the existing 12-action set; do not widen the registry to execute arbitrary code.
- **Every external call has a wall-clock timeout — no exceptions.** Wrap `renderPov` (esp. `waitForChunksToRender`) and any proxy/Anthropic call in a `Promise.race` timeout. Pathfinder-style silent hangs are the named failure mode.
- **Native ABI mismatch is a named project pitfall.** `@electron/rebuild` in postinstall; **test PACKAGED builds on clean machines, not just dev.** Directly governs the gl/canvas de-risk (Pitfall 1).
- **macOS screen recording is irrelevant here** — bot-POV render avoids OS capture entirely (that's the point of the locked decision).
- **Stale `.js` shadows `.tsx`/`.ts` in the renderer** — delete artifacts (outside `src/bot`) + restart dev after renderer edits.
- **UI work snaps to the "Summoning Terminal" design system** (`.planning/UI-DESIGN-SYSTEM.md`) — the Settings toggle line + confirm modal reuse `Button`, the existing modal pattern (clone `SwitchBackendConfirmModal`/`SignOutConfirmModal`), and tokens from `tokens.css`; never literal hex/px.

## Security Domain

> `security_enforcement` is not set in config.json → treated as **enabled**. Phase 15 is mostly local render + existing-auth proxy reuse, so the surface is small but non-zero.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (reuses existing JWT chain) | Existing `verifyJwt` on the proxy; vision gate runs after it. |
| V3 Session Management | no | Unchanged. |
| V4 Access Control | **yes** | The per-hour vision cap is an access-control/abuse boundary (D-09); MUST be server-authoritative (proxy bucket), never trusted from the bot. Idle renders must not bypass the explicit cap accounting. |
| V5 Input Validation | **yes** | `visualize` args validated by Zod (closed registry, VERIFIED `registry.execute` parses schema). Image data the bot sends to the LLM is bot-generated, not user-supplied — low injection risk, but cap base64 size before send (request-size limits). |
| V6 Cryptography | no | No new crypto. |

### Known Threat Patterns for {Electron utilityProcess + native GL + multi-provider LLM}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Native module loads untrusted `.node` / supply-chain (gl/canvas/node-canvas-webgl) | Tampering / Elevation | Pin versions; install behind `checkpoint:human-verify` (slopcheck unavailable); rebuild from known source; the stale `node-canvas-webgl` is the watch item. |
| LLM loops `visualize` to exhaust credits | Denial of Service | Proxy `vision_hourly` cap (VIS-07/D-09); idle bounded by cadence + dedupe (D-02). |
| GL context / listener leak crashes the bot | Denial of Service | Reuse a single Viewer or tear down per render (Pitfall 5); wall-clock render timeout. |
| Prompt-injection in chat tricks bot into spamming renders | DoS | Same `vision_hourly` cap; explicit renders are the capped path by design. |
| Oversized base64 image inflates the request | DoS / cost | Downscale to ~256px + JPEG q~0.4 (D-03) caps payload at low KB; far under the 10 MB / 32 MB API limits. |

## Sources

### Primary (HIGH confidence — VERIFIED against codebase or official source)
- `src/bot/brain/orchestrator.js`, `brain/llm/{index,messageMappers,anthropicProvider,openaiCompatProvider,geminiProvider,ollamaProvider,anthropicClient}.js` — image-content seam, provider capabilities, tool_result construction (read directly).
- `src/bot/registry.js`, `src/bot/adapter/minecraft/{index,registry}.js` — closed-registry + conditional-registration seam.
- `src/bot/brain/fsm.js`, `src/bot/brain/index.js` — P3 idle tick + `sei:idle` enqueue.
- `src/bot/config.js` — ConfigSchema shape for the vision block.
- `proxy/src/rateLimit/{personaDailyGate,gate,ipRateLimitGate,buckets}.ts`, `proxy/src/app.ts` — proxy gate framework + route wiring.
- `src/main/botSupervisor.ts`, `electron-builder.yml`, `package.json` — utilityProcess fork, asarUnpack, Electron 42 / @electron/rebuild 4.0.4.
- `node_modules/prismarine-world/src/world.js:60`, `prismarine-block/index.js`, `prismarine-entity/index.js` — raycast limitation + shapes/AABB APIs (read directly).
- platform.claude.com vision docs — image content-block format, `w*h/750` token formula, tool_result-image support, size limits.

### Secondary (MEDIUM confidence)
- github.com/PrismarineJS/prismarine-viewer `viewer/README.md` + `examples/headless.js` — `Viewer`/`WorldView` API, `setFirstPersonCamera`, `node-canvas-webgl`, `canvas.createJPEGStream`/`toBuffer`.
- `npm view` for prismarine-viewer (1.33.0), node-canvas-webgl (0.3.0, deps canvas^2.6.0/gl^6.0.0), gl (8.1.6), canvas (3.2.3).
- electronjs.org native-modules doc + github.com/electron/rebuild — ABI rebuild requirement.
- OpenAI developer community — images only allowed on `user` role messages.
- ai.google.dev Gemini OpenAI-compat — `inline_data` / data-URL image parts.

### Tertiary (LOW confidence — flagged for validation)
- prismarine-viewer issue #128 — headless `getUniformLocation of null` (no-GL-context) failure mode; exact Electron-42 buildability of gl/canvas is UNVERIFIED and is the de-risk spike's job.

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM-HIGH — packages verified on registry; native buildability under Electron 42 UNVERIFIED (A2, the spike target).
- Architecture / seams: HIGH — every integration point read directly in the codebase.
- Image-content wiring (VIS-02): HIGH — provider constraints confirmed from official/community sources; mapper seam read directly.
- LOS (VIS-05): HIGH — raycast limitation + shapes/AABB APIs verified in node_modules.
- Render path (VIS-01): MEDIUM — API shape confirmed from official README/example; single-frame headless-under-Electron path is the LOW-confidence spike.
- Proxy cap (VIS-07): HIGH — mirrors a verified existing gate; one open question on bot→proxy signaling.
- Pitfalls: HIGH — three are named Roadmap pitfalls, all confirmed against code.

**Research date:** 2026-06-04
**Valid until:** 2026-07-04 (stable seams) / 2026-06-18 for the native-render packages (node-canvas-webgl is stale; re-check if a maintained alternative appears).
