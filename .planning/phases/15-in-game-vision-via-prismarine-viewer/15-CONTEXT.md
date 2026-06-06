# Phase 15: In-Game Vision via prismarine-viewer - Context

**Gathered:** 2026-06-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Give the bot sight of its own world. A headless `prismarine-viewer` renderer
produces a bot-POV frame from the bot's eye position and look direction; the LLM
can call a `visualize` action (gated on the active provider's `capabilities.vision`)
to fetch a fresh frame as an image content block in its next turn; an opt-in
idle auto-render lets a VLM-backed bot periodically look around on its own; and a
custom line-of-sight helper handles non-full blocks, fluids, and entity bounding
boxes for the idle gate. Frames are aggressively compressed before reaching the
LLM, cloud users get a per-hour cap on explicit renders, and the bot degrades
gracefully ("I can't see clearly right now") when chunks aren't loaded.

**Locked upstream (not re-decided here):** bot-POV via `prismarine-viewer`
headless render — NO OS screen capture, NO Fabric mod (Roadmap Locked Decision
1); custom LOS helper, not raw `bot.world.raycast` (VIS-05); idle auto-render
defaults OFF (VIS-04 / Pitfall 8); per-hour proxy cap for cloud users (VIS-07);
graceful degradation (VIS-08). This phase decides HOW these behave, not WHETHER.

**Out of scope:** modded-texture extraction into the viewer atlas (that is
Phase 16, Roadmap Locked Decision 5).
</domain>

<decisions>
## Implementation Decisions

### Render triggers & cadence
- **D-01:** Two render paths. (a) **Explicit `visualize`** — an LLM-callable
  closed-registry action the bot can invoke at any time to render its
  surroundings. (b) **Idle auto-render** — fires on the existing P3 idle tick
  (~60s) when enabled. Start simple: idle = every idle tick (no scene-change
  gating in v1.0).
- **D-02:** **Skip near-duplicate frames.** Before sending an idle frame to the
  LLM, compare it to the last-sent frame via a cheap frame/position hash; if
  effectively unchanged, skip the send (a parked bot must not rack up cost).
- **D-03:** **Aggressive compression.** Downscale and lower quality well below
  the 512×512 ceiling — the model only needs general shapes and layout, not
  detail. (VIS-06's ≤512×512 is the *max*; we go smaller. Target ≈256px + low
  JPEG quality at Claude's discretion.)

### Configuration & opt-in surface
- **D-04:** A dedicated **prismarine/vision config** exposes the knobs:
  **render frequency**, **auto-render on/off**, and **image quality**. Default
  auto-render = **OFF** (VIS-04 launch requirement).
- **D-05:** Auto-render is surfaced as **one additional toggle line in the
  Settings screen** (not a CharacterPage control), gated behind a **confirm
  popup**. Because v1.0 runs a single bot at a time (multi-bot is out of scope),
  a single global toggle scopes to the active character in practice — this
  satisfies VIS-04's "per-character opt-in" in spirit. The toggle writes through
  to the config in D-04 as source of truth.
- **D-06:** The confirm popup tells the user plainly that auto-look **uses more
  playtime** — no token counts, no numeric estimates in the popup (PROXY-05).

### Cost communication
- **D-07:** When auto-render is ON, the **Playtime/Credits estimate page shrinks
  its "~Xh playtime" figure appropriately** (apply a vision multiplier to the
  playtime estimate) so the cost surfaces where users already look — instead of
  a separate scary number at toggle time.

### visualize scope & rate limiting
- **D-08:** **Explicit `visualize` is ungated by owner-proximity.** The 16-block
  + LOS gate (VIS-04 / VIS-05) governs **idle auto-render only**. An explicit
  call renders whatever the bot can see right now; it still degrades gracefully
  (VIS-08) when chunks aren't loaded.
- **D-09:** **Per-hour cap applies to explicit renders only** (~10/hour,
  configurable). Rationale: LLM-invoked explicit renders are *unbounded* (the
  model could call `visualize` in a loop), whereas idle renders are already
  bounded by the idle-tick cadence. This is the concrete reading of VIS-07.
- **D-10:** **VLM gating (VIS-03)** keys off the existing per-provider
  `capabilities.vision` descriptor from Phase 14. When the active provider is
  non-VLM, `visualize` is hidden from the action registry AND the idle
  auto-render toggle is disabled / inert.

### BYO-key / local-VLM users
- **D-11:** BYO-key and local-VLM users get **vision allowed, uncapped, with no
  playtime warning** — same capability gating (D-10) and same compression
  (D-03), but no proxy per-hour cap and no playtime-shrink (they pay their own
  provider, or run local for free). The idle toggle is still available to them.

### Claude's Discretion
- **Render visibility in the GUI:** show a small **thumbnail in the chat log** of
  what the bot saw (transparency/trust). This is net-new renderer work (the chat
  log has no image-block UI today). May be feed-silently-to-model if it proves
  too heavy — but default is to show it.
- Exact compression target (resolution + JPEG quality), the dedupe hash
  algorithm (perceptual hash vs position+yaw/pitch quantization), the LOS
  helper's exact block/fluid/entity handling (per VIS-05), the degradation copy
  wording ("I can't see clearly right now"), and the explicit-render cap default
  number are all Claude's discretion within the decisions above.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` § "Phase 15: In-Game Vision via prismarine-viewer" — goal, success criteria, locked decisions, Pitfalls 8/9/10
- `.planning/REQUIREMENTS.md` — VIS-01..VIS-08 (lines ~84–91); note PROXY-05 (no token counts in UI) constrains the cost-communication decisions here

### Existing capability & registry seam (Phase 14)
- `src/bot/brain/llm/index.js` — `createLlmProvider` factory; per-provider `capabilities: { vision, cached, local }` descriptor that D-10 gates on
- `src/bot/brain/llm/anthropicProvider.js`, `openaiCompatProvider.js`, `geminiProvider.js`, `ollamaProvider.js` — where `capabilities.vision` is declared per provider
- `.planning/phases/14-multi-provider-model-abstraction/14-CONTEXT.md` § decision 6 — capabilities descriptor was added explicitly for this phase

### Closed action registry (where `visualize` registers)
- `src/bot/registry.js` — `createRegistry()` (register/execute/list/schema); registration is unconditional today, so conditional `visualize` registration (D-10) is net-new at the registration site
- `src/bot/adapter/minecraft/registry.js` — `createDefaultRegistry()` pre-populates the minecraft action set; `visualize` is added here

### Idle loop (where idle auto-render hooks)
- `src/bot/brain/fsm.js` — P3_IDLE priority + idle timer (`idleFallbackMs`, default 60s)
- `src/bot/brain/index.js` — idle enqueue path (`sei:idle` at P3)

### LLM image-content-block path (net-new wiring)
- `src/bot/brain/orchestrator.js` — builds tool_result / assistant-content; has NO image content block path today. Feeding a rendered frame back to the model (VIS-02) is brand-new here.

### Proxy per-hour cap (VIS-07 / D-09)
- `proxy/src/rateLimit/buckets.ts`, `gate.ts`, `personaDailyGate.ts`, `ipRateLimitGate.ts` — existing token-bucket / gate framework the explicit-render per-hour cap should follow

### Config + cost UI (D-04..D-07)
- `src/bot/config.js` — bot config schema; the vision/prismarine config block (or sibling file) extends this
- `src/renderer/src/screens/SettingsScreen.tsx` — where the single auto-render toggle line + confirm popup live (D-05/D-06)
- `src/renderer/src/lib/playtimeEstimate.ts` — `DEFAULT_TOKENS_PER_MIN` playtime estimate to shrink when auto-render is on (D-07)
- `src/renderer/src/screens/CreditsScreen.tsx`, `src/renderer/src/components/UsageBar.tsx` — the Playtime/Credits surface that renders the "~Xh" figure
- `src/renderer/src/lib/stores/useCreditsStore.ts` — credits/usage store feeding the estimate

No external ADRs or third-party specs were referenced during discussion —
requirements are fully captured in the decisions above + the roadmap/requirements refs.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Provider capabilities descriptor** (`src/bot/brain/llm/*Provider.js`): `{ vision, cached, local }` already exists per Phase 14 — D-10 reads `capabilities.vision` directly; no new descriptor needed.
- **Closed registry** (`src/bot/registry.js`): clean `register(name, schema, handler, description)` API; `visualize` slots in as one more Zod-typed action.
- **Idle timer** (`src/bot/brain/fsm.js`): P3 idle tick already fires every ~60s — idle auto-render reuses it; no new scheduler.
- **Proxy gate framework** (`proxy/src/rateLimit/*`): `buckets.ts` + gate pattern (see `personaDailyGate.ts`) is the template for the explicit-render per-hour cap.
- **Playtime estimate** (`src/renderer/src/lib/playtimeEstimate.ts`): single `DEFAULT_TOKENS_PER_MIN` knob — D-07's shrink is a multiplier here, not a UI rewrite.

### Established Patterns
- **No image content blocks anywhere yet** — `orchestrator.js` only constructs text/tool_result content. VIS-02 (image block back to the model) is genuinely net-new and is the riskiest wiring in this phase; the planner should research how each provider adapter accepts image input (Anthropic base64 image blocks vs OpenAI/Gemini image parts) given the Phase-14 multi-provider abstraction.
- **prismarine-viewer is NOT a dependency** — headless render needs a new dependency (and likely a native GL/canvas path); native-ABI/bundling risk under Electron utilityProcess is a known Pitfall (CLAUDE.md "Native ABI mismatch"). Researcher should validate the headless render path works in the packaged build, not just dev.

### Integration Points
- Bot/utilityProcess: render must run in the utilityProcess (mineflayer lives there per the three-process invariant).
- Renderer: Settings toggle + confirm popup (D-05/06); playtime estimate shrink (D-07); optional chat-log thumbnail (discretion).
- Proxy: explicit-render per-hour cap (D-09).

### Caution
- **Stale `.js` shadows `.tsx`/`.ts` in the renderer** (known project pitfall): `playtimeEstimate.js`, `UsageBar.js`, `IconRail.js` etc. sit next to their `.ts(x)` sources. Renderer edits in this phase must delete stale artifacts (outside `src/bot`) + restart dev or Vite serves the old file.
</code_context>

<specifics>
## Specific Ideas

- "A function the bot can call at any time to render surroundings" — the explicit `visualize` action (D-01a).
- "Compress the images greatly before giving it to the LLM, as long as it can see general shapes and views" (D-03).
- "Have a prismarine config file where I can adjust the render frequency, auto-render on/off, and image quality" (D-04).
- "Toggle is just one additional line in settings with popup confirm window" (D-05).
- "Just tell users it'll use more playtime. Shrink the playtime figure in playtime estimate page appropriately" (D-06/D-07).
- "Only rate limit active renders called by the bot (say, 10 every hour), since that is unbounded. Idle renders are already bounded by one idle tick every x seconds" (D-09).

</specifics>

<deferred>
## Deferred Ideas

- **Scene-change-gated idle cadence** (render only when the view meaningfully changed — bot moved >N blocks, new biome/structure, owner in view). Starting with every-idle-tick + dedupe (D-01/D-02); smarter gating is a follow-up if cost proves high.
- **Per-character (not global) vision settings.** A global Settings toggle is sufficient while single-bot-at-a-time holds; revisit if multi-bot ever ships.
- **Modded-texture extraction into the viewer atlas** — explicitly Phase 16.
- **Frame-fidelity tuning** (FOV, whether to render entities/other players, hand/HUD) — left to render-path research; not a v1.0 user decision.

None of these block Phase 15.

</deferred>

---

*Phase: 15-in-game-vision-via-prismarine-viewer*
*Context gathered: 2026-06-04*
