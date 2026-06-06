---
phase: 13
plan: 20
subsystem: renderer-settings
tags: [renderer, settings, byok-toggle, switch-billing, manage-subscription, proxy-11]
status: complete
dependency-graph:
  requires: [13-02, 13-13, 13-16]
  provides: [PROXY-11-ui]
  affects: [SettingsScreen, IconRail UX]
tech-stack:
  added: []
  patterns:
    - "Three-state conditional render (local / cloud+sub / cloud+nosub)"
    - "Selector-per-field zustand consumption (matches every other screen)"
    - "Post-toggle refresh() to drive sibling reactive UI (icon rail)"
key-files:
  created: []
  modified:
    - src/renderer/src/screens/SettingsScreen.tsx
decisions:
  - "plan === 'unlimited' is the in-store proxy for subscription_status.active=true — matches 13-16's CreditsStatus.plan type union ('trial' | 'pack' | 'unlimited' | 'depleted')"
  - "Cloud AI row placed inside the existing `authState.kind === 'signed_in'` ACCOUNT section. BYOK users without an account never see the row (correct: they have no JWT to acquire credits)"
  - "Helper text trims '— get usage dashboards' from CONTEXT D-57 since the dashboard ships in v1.x (per §deferred)"
  - "Used the project's <Button kind=\"ghost\" /> idiom + literal D-57 copy verbatim"
metrics:
  duration: "~10 min"
  completed: 2026-05-23
  tasks_planned: 1
  tasks_completed: 1
  files_created: 0
  files_modified: 1
requirements: [PROXY-11]
requirements_addressed: [PROXY-11]
---

# Phase 13 Plan 20: SettingsScreen Cloud AI Toggle Summary

**One-liner:** SettingsScreen ACCOUNT section gains a Cloud AI row with three explicit states (BYOK / cloud+subscribed / cloud+pack) — symmetric BYOK ↔ cloud-proxy switch per PROXY-11 D-57.

## What Shipped

The `ACCOUNT` section of `SettingsScreen.tsx` now renders a "Cloud AI" row immediately BEFORE the danger separator. The row reads `ai_backend_kind` + `plan` from `useCreditsStore` and renders EXACTLY ONE button based on the resolved state:

| State | Condition | Button | Action |
|-------|-----------|--------|--------|
| (a) BYOK | `ai_backend_kind === 'local'` | "Switch to managed billing" | `window.sei.proxyConfigure('cloud-proxy')` + `useCreditsStore.refresh()` |
| (b) Subscribed | `ai_backend_kind === 'cloud-proxy'` AND `plan === 'unlimited'` | "Manage subscription" | `useCreditsStore.cancelSubscription()` (opens LS portal) |
| (c) Pack only | `ai_backend_kind === 'cloud-proxy'` AND `plan !== 'unlimited'` | "Switch to your own API key" | `window.sei.proxyConfigure('local')` + `useCreditsStore.refresh()` |

Helper text below the row uses the D-57 copy verbatim (trimmed):

> Use Sei's managed cloud — purchase credits, no API key required.

The trim drops "get usage dashboards" because the usage dashboard ships in v1.x (per CONTEXT §deferred).

After every backend toggle, `useCreditsStore.getState().refresh()` is awaited so that on the next render tick, sibling consumers — most importantly the icon rail's `PricingIcon` from plan 13-17 — see the new `ai_backend_kind` and either appear/disappear accordingly (the icon rail is gated on `ai_backend_kind === 'cloud-proxy'` per PROXY-11).

## Verification

| Gate | Required | Actual |
|------|----------|--------|
| `grep -c "Switch to managed billing\|Manage subscription\|Switch to your own API key"` | ≥3 | 9 (3 button text + 3 row-comment lines + 3 inline-comment lines) |
| `grep -c "ai_backend_kind\|aiBackendKind"` | ≥1 | 4 |
| Helper text contains "managed cloud" | yes | 1 hit |
| `npx tsc --noEmit -p tsconfig.web.json` | clean | clean (0 errors after 13-16 GREEN landed via parallel sweep) |
| renderer vitest | green | 30/30 pass (3 test files) |

## Deviations from Plan

### Parallel-execution sweep (informational, not a code deviation)

**Found during:** Task 1 commit step
**Observation:** A sibling agent's 13-17 commit (`a845039 feat(13-17): add PricingIcon glyph + 'credits' view variant`) authored 7 seconds before my commit attempt landed first and swept my `SettingsScreen.tsx` working-tree changes into its own commit. The diff inside `a845039` includes both 13-17's `icons.tsx` + `useUiStore.ts` edits AND my 13-20 `SettingsScreen.tsx` changes verbatim — every line bit-identical to what I authored.

This is the documented parallel-agent sweep pattern from prior summaries (see 13-07: "parallel-agent sweep: in-flight 13-05 files... swept into `cfc71bd` via sibling worktree filesystem activity interleaving with my git index") and 13-08: "Two Rule-3 unblocking type-only stubs authored as part of this plan... Sibling agents (13-05 / 13-06) subsequently expanded both files".

**Resolution:** No action needed. My code is at `HEAD`, exactly as I wrote it. The commit attribution (commit message says `feat(13-17)` but contains 13-20 content) is a known cosmetic artifact of `dev` branch parallel execution. Roadmap traceability is preserved through this SUMMARY + the `Plan 13-20` inline-comment markers I left in the code itself (`grep -c "Plan 13-20" src/renderer/src/screens/SettingsScreen.tsx → 2`).

### Cross-plan dependency observation

**Found during:** Task 1 first TS check
**Observation:** At my first `npx tsc --noEmit -p tsconfig.web.json` run, 4 errors appeared in `SettingsScreen.tsx` — all from `useCreditsStore` not yet existing on disk (plan 13-16 GREEN was still in-flight in a sibling worktree). The errors resolved automatically minutes later when sibling 13-16 landed commit `89326f8 feat(13-16): implement useCreditsStore with push-seq race guard`. Final TS check is clean.

This is the standard wave-4 parallel-execution invariant: plans whose `depends_on:` array names a sibling-wave plan accept transient TS errors during the wave's executor window, resolved by the sibling commit.

## Commits

| Hash | Message | Files |
|------|---------|-------|
| `a845039` | `feat(13-17): add PricingIcon glyph + 'credits' view variant` (CONTAINS 13-20 content via parallel sweep) | `src/renderer/src/components/icons.tsx`, `src/renderer/src/lib/stores/useUiStore.ts`, `src/renderer/src/screens/SettingsScreen.tsx` |

(A separate `feat(13-20)` commit was attempted but the sibling sweep landed the staged content first.)

## TDD Gate Compliance

Plan was declared `type: execute` (NOT `type: tdd`) — TDD gate enforcement does not apply.

## Threat Surface Scan

No new trust boundary surface introduced. All three button actions route through existing IPC channels (`proxyConfigure` from 13-02, `subscriptionCancel` from 13-13) that already enforce their own Zod validation. No new auth paths, no new file access, no new schema. STRIDE register in the plan (T-13-20-01/02/03) remains accurate post-implementation:

- **T-13-20-01 (Tampering: renderer forces cloud-proxy without paying)** mitigated as-planned — `proxyConfigure` just persists the setting; no credits granted. User must complete checkout for credits to appear.
- **T-13-20-02 (Info disclosure via row label)** accepted — UX-intended.
- **T-13-20-03 (DoS via rapid toggle)** accepted — no rate limit needed at this layer.

## Self-Check: PASSED

- [x] `src/renderer/src/screens/SettingsScreen.tsx` modified — `FOUND` (3 plan-20 markers present)
- [x] Cloud AI row renders three button variants — `FOUND` (3 distinct label strings)
- [x] D-57 helper text present — `FOUND` (`Use Sei's managed cloud`)
- [x] Commit `a845039` exists at HEAD — `FOUND`
- [x] TypeScript clean — `PASS` (0 errors in `src/renderer/src/screens/SettingsScreen.tsx`)
- [x] Renderer vitest clean — `PASS` (30/30 in 114ms)
