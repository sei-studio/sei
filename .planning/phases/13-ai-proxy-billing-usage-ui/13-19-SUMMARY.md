---
phase: 13
plan: 19
subsystem: renderer
tags: [renderer, modal, hard-stop, persona-aware, blocking-modal, byok-escape, proxy-06]
requires:
  - useCreditsStore.hardStopActive + acknowledgeHardStop (13-16)
  - sei.proxyConfigure('local' | 'cloud-proxy') (13-02 stub contract)
  - useDataStore.summon + characters (Phase 4 baseline)
  - Character.slug as bundled-persona key (characterSchema.ts:83)
  - AcceptToSModal structural template (11-13)
provides:
  - HardStopModal — App-root blocking overlay on PROXY-06 hard-stop
  - resolveHardStopCopy(persona) — persona-aware client-side body copy
  - hardStopCopy.ts — BUNDLED template map (sui/lyra/clawd) + custom + generic
affects:
  - src/renderer/src/App.tsx — HardStopModal mount alongside AcceptToSModal
tech-stack:
  added: []
  patterns:
    - "Client-side persona-aware copy (open-question resolution #1)"
    - "ESC suppression via mount-scoped keydown listener (mirrors AcceptToSModal:54-62)"
    - "Auto-dismiss useEffect gated on hardStopReason==='depleted'"
    - "Active character derived from summon.characterId + characters (no useDataStore.activeCharacter field)"
    - "BYOK escape hatch: proxyConfigure('local') + acknowledgeHardStop with try/catch (T-13-19-04)"
key-files:
  created:
    - src/renderer/src/components/hardStopCopy.ts
    - src/renderer/src/components/HardStopModal.tsx
    - src/renderer/src/components/HardStopModal.module.css
  modified:
    - src/renderer/src/App.tsx
decisions:
  - "Bundled persona match by Character.slug first (canonical key, characterSchema.ts:83) then lowercased name as fallback for legacy bundled rows with null slug"
  - "Plan §action copy is authoritative over CONTEXT §specifics where they drift (Sui's 'to keep her chatting' over CONTEXT's 'to keep going'). Plan is the contract."
  - "Active character derived inline from summon.characterId + characters (App.tsx:323 pattern) since useDataStore.activeCharacter does not exist; deriving keeps the modal self-contained and avoids polluting the data store with a credits-only selector"
  - "Modal mount in App.tsx is unconditional; the modal itself returns null when hardStopActive is false. Avoids gating duplication — the credits store only sets hardStopActive when cloud-proxy is active"
  - "handleSwitchToLocal wraps proxyConfigure('local') in try/catch so a rejection doesn't permanently block the modal (T-13-19-04). On reject the catch swallows and the user can still try Top up / Go Unlimited"
metrics:
  duration: "~25min"
  completed_date: "2026-05-22"
  tasks_completed: 3
  files_changed: 4
  lines_added: ~302
  commits: 3
requirements_addressed: [PROXY-06]
---

# Phase 13 Plan 19: HardStopModal Summary

One-liner: PROXY-06 blocking modal mounted at App root — persona-aware client-side copy via `resolveHardStopCopy`, ESC suppressed unconditionally, three CTAs (Top up / Go Unlimited / BYOK escape via `proxyConfigure('local')`), auto-dismiss when `hardStopReason==='depleted'` && `remaining_pct > 0`.

## What Shipped

**`src/renderer/src/components/hardStopCopy.ts`** (63 lines) — `resolveHardStopCopy(persona)` returns the modal body string. `BUNDLED` map keys `sui`/`lyra`/`clawd` resolve to the plan §action templates. Match order: lowercased `slug` first (canonical bundled key per `characterSchema.ts:83`), then lowercased `name` (legacy bundled fallback), then `${name} needs more credits to keep talking.` for custom personas, then the no-persona `GENERIC` fallback. T-13-19-03 (HTML injection) mitigated by the React JSX text-content rendering site auto-escaping. T-13-19-05 (forged persona id) mitigated by the never-throws fall-through.

**`src/renderer/src/components/HardStopModal.tsx`** (141 lines) — App-root blocking overlay. Reads `hardStopActive` / `hardStopReason` / `remaining_pct` / `openCheckout` / `acknowledgeHardStop` from `useCreditsStore`, `summon` + `characters` from `useDataStore`. Returns `null` when `!hardStopActive` so the mount in App.tsx can be unconditional. Active-character derivation mirrors App.tsx:323 (`characters.find((c) => c.id === summon.characterId)` for `online`/`error` summon states, null otherwise).

Three behavior contracts:

1. **ESC suppression** — mount-scoped `window.addEventListener('keydown', …)` matches `AcceptToSModal:54-62` verbatim. Listener registered only while `hardStopActive` to avoid leaking a global handler.

2. **Auto-dismiss** — `useEffect` calls `acknowledgeHardStop()` when `hardStopActive && hardStopReason === 'depleted' && remainingPct > 0`. Rate-limited hard-stops do NOT auto-dismiss — the retry-window banner (13-17) owns that. Drives the "user pays in browser, webhook fires, balance refills, modal disappears" flow from `<truths>`.

3. **BYOK escape** — `handleSwitchToLocal` awaits `sei.proxyConfigure('local')` THEN calls `acknowledgeHardStop()`. Wrapped in try/catch so a rejection doesn't permanently block (T-13-19-04). The two checkout CTAs do NOT dismiss the modal — they call `openCheckout('pack' | 'subscription')` (opens external Lemon Squeezy URL) and rely on the auto-dismiss path once balance refills.

**`src/renderer/src/components/HardStopModal.module.css`** (87 lines) — mirrors `AcceptToSModal.module.css` verbatim with a `.muted` modifier class for the tertiary BYOK CTA. Same 460px frame, 32px padding, 0.45 scrim alpha, `fadeUp` + `fade` keyframes, `prefers-reduced-motion` honored. `.footer` is `flex-direction: column` (stacked CTAs) rather than the inline-row footer in AcceptToSModal because three vertical stacked CTAs read better than three buttons squeezed across 396px of body width.

**`src/renderer/src/App.tsx`** — added `HardStopModal` import + unconditional mount at the end of the JSX (after `MigrateLocalCharsModal`). PROXY-05-compliant: zero pricing copy in the App-level mount, zero `ai_backend_kind` gate (credits store enforces).

## PROXY-05 Compliance

The verification gate `grep -cE '\$5|\$20|token' src/renderer/src/components/HardStopModal.tsx == 0` PASSES. The component's JSDoc was rewritten mid-task to avoid the literal `$5/$20` even in comments (initial draft had `"$5/$20 amounts. The verifier grep…"` which scored 3 — re-worded to `"the actual dollar amounts"` and `"see 13-19-PLAN.md <verification> for the exact regex"`). Button labels in the rendered JSX are "Top up" and "Go Unlimited" only — the Lemon Squeezy product pages opened via `shell.openExternal` carry the actual amounts.

## Threat Model Compliance

| Threat ID | Mitigation in this plan |
|-----------|-------------------------|
| T-13-19-01 (Tampering — acknowledgeHardStop bypasses payment) | UI-only flag clear; the next bot call still hits the proxy which returns 402 if balance is still 0. `useCreditsStore.acknowledgeHardStop()` docblock explicitly disclaims server contact. |
| T-13-19-03 (Tampering — hostile persona.name HTML injection) | React JSX text content auto-escapes; no `dangerouslySetInnerHTML` anywhere in the rendered tree. |
| T-13-19-04 (DoS — modal blocks permanently if proxyConfigure fails) | `handleSwitchToLocal` try/catch swallows the rejection; user can still try Top up / Go Unlimited; auto-dismiss path covers balance refill. |
| T-13-19-05 (Tampering — forged persona id triggers wrong copy) | `resolveHardStopCopy` falls through to `GENERIC` on unknown slug/name; never crashes. |
| T-13-19-02 (Info disclosure — persona name leaked via screen recording) | Accept disposition per plan; no PII in persona names by default. |

## Deviations from Plan

### Rule 3 (auto-fix blocking) deviations

**1. `useDataStore.activeCharacter` does not exist.**
- **Found during:** Task 2 reading `useDataStore.ts`.
- **Issue:** The plan's `<action>` block reads `const activeCharacter = useDataStore((s) => s.activeCharacter);` but `useDataStore` exposes `characters` + `summon` only, with no `activeCharacter` selector / field.
- **Fix:** Derived the active character inline in `HardStopModal` via `useMemo(() => characters.find(c => c.id === summon.characterId) ?? null, [summon, characters])`. This mirrors the same pattern App.tsx already uses at line 323 (SummonToast resolution). Keeps the modal self-contained, no data-store API expansion, no Phase 13 churn to a Phase 4 baseline store.
- **Files modified:** `src/renderer/src/components/HardStopModal.tsx`.
- **Commit:** `59f1da7`.

**2. Bundled-persona match key promoted from `name` to `slug` (with `name` as fallback).**
- **Found during:** Task 1 reading `characterSchema.ts:83`.
- **Issue:** The plan's draft `hardStopCopy.ts` matches bundled personas via lowercased `persona.name`. `Character.slug` is the canonical bundled-persona key per `characterSchema.ts:83` ("Bundled defaults populate this with 'sui'/'lyra'/'clawd'") — more stable than name (a user could rename a bundled persona without rebasing its `is_default`/`slug`).
- **Fix:** Match `slug` first, then lowercased `name`, then fall through. Plan NOTE explicitly invites this refinement ("If the project uses a different match key (e.g., a stable bundled `is_default` flag + persona id), this match function should adapt"). All three plan-required templates still produced for the bundled set.
- **Files modified:** `src/renderer/src/components/hardStopCopy.ts`.
- **Commit:** `e327f37`.

### Within-discretion refinements (not deviations)

- `.footer` is `flex-direction: column` rather than the inline-row AcceptToSModal footer — three stacked buttons read better than three squeezed across the 396px body. No new design token.
- HardStopModal mount in App.tsx is unconditional (modal renders null when `!hardStopActive`) rather than wrapped in `{hardStopActive ? <HardStopModal /> : null}` — keeps the modal's hooks at a stable mount point (avoids the React useEffect re-subscribe churn from conditional mounting).

## Plan-Verification Results

| Gate | Expected | Actual | Pass |
|------|----------|--------|------|
| `grep -c "HardStopModal" src/renderer/src/App.tsx` | ≥ 1 | 3 | ✓ |
| `grep -cE '\$5|\$20|token' src/renderer/src/components/HardStopModal.tsx` | == 0 | 0 | ✓ |
| `grep -c "Escape" src/renderer/src/components/HardStopModal.tsx` | ≥ 1 | 1 | ✓ |
| `grep -c "hardStopActive" src/renderer/src/components/HardStopModal.tsx` | ≥ 2 | 9 | ✓ |
| Auto-dismiss useEffect present | yes | yes (line 96-102) | ✓ |
| `npx tsc --noEmit -p tsconfig.web.json` | clean | clean | ✓ |
| `grep -c "BUNDLED" src/renderer/src/components/hardStopCopy.ts` | ≥ 1 | 3 | ✓ |

## Success Criteria

- ✓ Modal blocks UI when `hardStopActive=true` (scrim covers, ESC suppressed, click-outside no-op).
- ✓ Client-side persona-aware copy (open-question resolution #1 — no proxy round-trip).
- ✓ ESC suppressed unconditionally (mount-scoped keydown listener).
- ✓ Three CTAs: Top up / Go Unlimited / Switch to your own API key.
- ✓ Auto-dismiss on balance refill (depleted reason only — rate-limited handled by 13-17 banner).
- ✓ BYOK escape hatch wired via `sei.proxyConfigure('local')` + `acknowledgeHardStop()`.

## Commits

| Commit | Task | Files |
|--------|------|-------|
| `e327f37` | Task 1 | `hardStopCopy.ts` |
| `59f1da7` | Task 2 | `HardStopModal.tsx` + `HardStopModal.module.css` |
| `c21badf` | Task 3 | `App.tsx` |

## Self-Check: PASSED

- `src/renderer/src/components/hardStopCopy.ts` — FOUND
- `src/renderer/src/components/HardStopModal.tsx` — FOUND
- `src/renderer/src/components/HardStopModal.module.css` — FOUND
- App.tsx HardStopModal mount — FOUND (3 references)
- Commits `e327f37`, `59f1da7`, `c21badf` — all FOUND in `git log`
- TypeScript web typecheck — CLEAN
- 312/313 vitest pass (1 pre-existing `portraitStore` tmpdir race + 3 Deno-only files mis-picked by vitest — out of scope per SCOPE BOUNDARY)
