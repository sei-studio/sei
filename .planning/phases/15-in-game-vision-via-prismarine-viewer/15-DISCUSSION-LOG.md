# Phase 15: In-Game Vision via prismarine-viewer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-04
**Phase:** 15-in-game-vision-via-prismarine-viewer
**Areas discussed:** Idle auto-render cadence, Opt-in toggle + cost warning, visualize scope + BYO users

---

## Gray-area selection

Presented four candidate areas (render mechanics are locked by the roadmap, so
these were the behavior/UX gray areas). User selected three; "Render visibility
in GUI" was left to Claude's discretion.

| Area | Selected |
|------|----------|
| Render visibility in GUI | (deferred to Claude) |
| Idle auto-render cadence | ✓ |
| Opt-in toggle + cost warning | ✓ |
| visualize scope + BYO users | ✓ |

---

## Idle auto-render cadence

| Option | Description | Selected |
|--------|-------------|----------|
| Scene-change gated | Render only when the view meaningfully changed | |
| Throttled interval (~3-5 min) | Fixed minimum interval | |
| Every idle tick (~60s) | Fires on the existing P3 idle fallback | ✓ (start here) |

**User's choice:** "We'll start with every idle tick, and a function that the bot can call at anytime to render surroundings. We will compress the images greatly before giving it to the LLM, as long as it can see general shapes and views. Have a prismarine config file where I can adjust the render frequency, auto-render on/off, and image quality"
**Notes:** Adds an explicit always-available `visualize` action; aggressive compression acceptable (general shapes only); config-file knobs for frequency / on-off / quality.

| Dedupe option | Description | Selected |
|--------|-------------|----------|
| Yes — skip duplicates | Cheap frame/position hash; skip ~identical frames | ✓ |
| No — always send on fire | Send whenever cadence fires | |

**User's choice:** Yes — skip duplicates.

---

## Opt-in toggle + cost warning

| Option | Description | Selected |
|--------|-------------|----------|
| Config file + GUI toggle | Config source-of-truth; per-character CharacterPage toggle + cost warning | ✓ (as Settings line, not CharacterPage) |
| Config file only (defer GUI) | Ship config file, defer GUI + warning | |
| GUI toggle only (no file) | No separate config file | |

**User's choice:** "Config file + GUI toggle. Toggle is just one additional line in settings with popup confirm window."
**Notes:** Toggle lives in the **Settings** screen (one line) with a confirm popup — not CharacterPage. Single global toggle (single-bot-at-a-time makes this effectively per-active-character).

| Cost-UX option | Description | Selected |
|--------|-------------|----------|
| Playtime framing | Tie to playtime estimate (Nx faster, shorter sessions) | ✓ (via estimate shrink) |
| Qualitative only | Non-numeric "uses credits much faster" | partial (popup copy) |
| Images-per-hour count | Approx frames/hour figure | |

**User's choice:** "When toggling, just tell users it'll use more playtime. Shrink the playtime figure in playtime estimate page appropriately."
**Notes:** Popup = plain "uses more playtime" (no numbers); the numeric impact shows up as a reduced "~Xh" on the Playtime/Credits estimate page when auto-render is on.

---

## visualize scope + BYO users

| BYO option | Description | Selected |
|--------|-------------|----------|
| Allow, no proxy cap | Capability-gated + compressed, no cap, no playtime warning | ✓ |
| Allow + local soft cap | Add client-side per-hour limiter | |
| Explicit-only for BYO | Disable idle auto-render for BYO | |

**User's choice:** Allow, no proxy cap.

| Cap-scope option | Description | Selected |
|--------|-------------|----------|
| Count all vision calls | Explicit + idle share one per-hour ceiling | |
| Only cap idle renders | Cap idle, leave explicit uncapped | |
| (User override) Only cap explicit/active renders | Idle already bounded by cadence; explicit is unbounded | ✓ |

**User's choice:** "Opposite, actually. Only rate limit active renders called by the bot (say, 10 every hour), since that is unbounded. Idle renders are already bounded by one idle tick every x seconds."
**Notes:** Explicit `visualize` is the unbounded risk (LLM could loop). Cap ~10/hour on explicit renders; idle renders bounded by cadence. Explicit renders are ungated by owner-proximity (16-block + LOS gate governs idle only).

---

## Claude's Discretion

- Render visibility in the GUI — defaulting to a small thumbnail in the chat log of what the bot saw (may fall back to silent-feed if too heavy).
- Compression target (≈256px + low JPEG quality), dedupe hash algorithm, LOS helper internals (VIS-05), degradation copy ("I can't see clearly right now"), explicit-render cap default number.

## Deferred Ideas

- Scene-change-gated idle cadence (start with every-tick + dedupe).
- Per-character (vs global) vision settings — revisit only if multi-bot ships.
- Modded-texture extraction into the viewer atlas — Phase 16.
- Frame-fidelity tuning (FOV / entities / hand-HUD) — render-path research.
