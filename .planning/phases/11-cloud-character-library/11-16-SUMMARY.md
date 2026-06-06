---
phase: 11
plan: 16
subsystem: ui / sync-status
tags: [ui, sync, status-pill, home-screen, zustand]
requires:
  - 11-09 (sei.syncStatus / sei.syncRetry / sei.onSyncStatusUpdate IPC surface + SyncStatus / SyncStatusPushEvent types)
provides:
  - "useSyncStore — renderer zustand store mirroring main's cloud-sync queue (pending count, pendingByUuid map); subscribes once at App.tsx mount; exposes init/refresh/retry/getStatus"
  - "Per-card inline sync pill on CharacterCard — 'SYNCING' (pulse) while in flight, clickable 'SYNC FAILED — RETRY' (warn) when failed, no pill when synced"
  - "Bundled defaults (is_default=true) never render the pill — D-22 defense-in-depth at the renderer surface"
affects:
  - "src/renderer/src/App.tsx: one-time useSyncStore.init() call at mount alongside the existing auth-state subscription"
  - "src/renderer/src/components/CharacterCard.tsx: subscribes to useSyncStore.pendingByUuid with shallow selector; renders sync pill via inline-positioned StatusPill"
tech-stack:
  added: []
  patterns:
    - "Renderer sync-state store mirroring useAuthStore's zustand shape — init() seeds via IPC snapshot then subscribes to push channel; identical to useAuthStore.subscribeAuthState lifetime contract"
    - "Inline CSS-variable overrides (--text, --text-2) on the pill wrapper to keep StatusPill labels readable on the dark chip overlay without touching StatusPill.module.css (CSS module ownership boundary respected for parallel plan 11-17)"
    - "Shallow zustand selectors gate per-card rendering — a sibling card's status flip never re-renders unrelated cards (T-11-16-02 mitigation)"
key-files:
  modified:
    - src/renderer/src/App.tsx
    - src/renderer/src/components/CharacterCard.tsx
  created:
    - src/renderer/src/lib/stores/useSyncStore.ts
key-decisions:
  - "Inline-positioned (absolute, top-right of portraitWrap) rather than modifying CharacterCard.module.css. The plan's `files_modified` lists CharacterCard.tsx only; per the sequential-execution prompt, CharacterCard.module.css is reserved for plan 11-17. Inline-style positioning keeps the pill alongside (not below) the CUSTOM/DEFAULT chip without CSS-module collision."
  - "Did not extend StatusPill with an onClick prop. The plan suggested adding onClick to StatusPill if absent; instead, wrapped StatusPill in a `<button>` from CharacterCard's call site. Cleaner separation — StatusPill stays a pure visual primitive (consistent with the SkinEditor / MC-install / Setup-wizard call sites), and clickability is a CharacterCard-local concern. StatusPill.tsx was not in the plan's `files_modified` either, so this also keeps the file-touch footprint minimal."
  - "HomeScreen.tsx was listed in `files_modified` but required no changes — the per-card pill lives in CharacterCard which HomeScreen already renders unchanged."
  - "CSS-variable overrides (--text:white; --text-2:rgba(255,255,255,0.85)) on the pill wrapper. The existing chip overlay is `rgba(0,0,0,0.55)` so StatusPill's `.label { color: var(--text); }` would otherwise be dark-on-dark in light theme. The local override stays scoped to the pill wrapper subtree."
patterns-established:
  - "Sync pill rendering contract: card consumers read `useSyncStore(state => state.pendingByUuid[id])` with shallow equality, gate on !is_default, render pulse/warn pill via StatusPill"
  - "Boot-time sync-store wiring: App.tsx's mount-time useEffect calls useSyncStore.getState().init() — idempotent under Strict-Mode double-invoke via internal `initialized` flag"
requirements-completed: [LIB-05]
duration: ~20min
completed: 2026-05-22
---

# Phase 11 Plan 16: Sync Status Pill (HomeScreen) Summary

**Renderer-side cloud-sync queue mirror via zustand + per-card 'SYNCING' / 'SYNC FAILED — RETRY' pill on CharacterCard; pill disappears on sync, never renders on bundled defaults.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-22T05:40:55Z
- **Completed:** 2026-05-22T05:45:49Z
- **Tasks:** 2
- **Files modified:** 2 (+ 1 created)

## Accomplishments

- D-18 (mirror-cloud-immediately) gets its user-visible surface: every cloud-backed character card shows in-flight state at-a-glance.
- LIB-05 (user observes the cloud mirror state) — fully satisfied. The sync queue state from Plan 11-09 is now visible in the only place users care about (HomeScreen grid), not buried in Settings.
- Click-to-retry on failure — recoverability without re-opening the character page.
- D-22 defense-in-depth at the renderer: defaults can never show a sync pill, even if main somehow leaked a default UUID into the pending map.

## Task Commits

Each task was committed atomically on `dev`:

1. **Task 1: useSyncStore + App.tsx boot wiring** — `3ad6765` (feat)
2. **Task 2: Per-card sync pill on CharacterCard** — `ac98fab` (feat)

## Files Created/Modified

- `src/renderer/src/lib/stores/useSyncStore.ts` (created) — zustand store: pending, pendingByUuid, initialized; init/refresh/retry/getStatus actions; subscribes to sei.onSyncStatusUpdate once and seeds via sei.syncStatus().
- `src/renderer/src/App.tsx` (modified) — added `useSyncStore` import + one-shot `useEffect(() => { void useSyncStore.getState().init(); }, [])` alongside the existing auth-state subscription.
- `src/renderer/src/components/CharacterCard.tsx` (modified) — added StatusPill + useSyncStore imports; reads `pendingByUuid[c.id]` with a shallow selector (gated on !isDefault so defaults short-circuit at the selector); renders 'SYNCING' (tone=pulse, non-interactive) or 'SYNC FAILED — RETRY' (tone=warn, wrapped in a `<button>` that calls `retry(c.id)` with stopPropagation so the card click doesn't fire); no pill when synced.

## Decisions Made

- **Inline positioning over CSS-module edit.** Plan 11-17 owns CharacterCard.module.css; the pill is positioned with inline `position:absolute; top:10px; right:10px` instead of adding a CSS class. The CUSTOM/DEFAULT chip stays at top-left; the sync pill sits at top-right. Conceptually alongside, visually unambiguous.
- **No StatusPill onClick extension.** Plan suggested adding `onClick` to StatusPill if absent. Wrapped the pill in a `<button>` from CharacterCard instead — keeps StatusPill a pure visual primitive matching every other call site (SkinEditor empty-states, MC-install rows, Setup-wizard panel).
- **CSS variable overrides for label readability.** Inline `--text: white; --text-2: rgba(255,255,255,0.85)` on the pill wrapper. The dark `rgba(0,0,0,0.55)` chip background would otherwise hide the label (which uses `color: var(--text)` from StatusPill.module.css). Local scope only — no global impact.
- **HomeScreen.tsx unchanged** despite being in `files_modified`. The per-card pill lives entirely in CharacterCard; HomeScreen.tsx already passes the right props.
- **Shallow selector gate on isDefault.** `useSyncStore(s => isDefault ? undefined : s.pendingByUuid[c.id])` — when a card is default, the selector returns undefined unconditionally, so updates to `pendingByUuid` for other characters never re-render default cards.

## Deviations from Plan

None — plan executed exactly as written, modulo the three judgment calls noted in "Decisions Made" above (inline positioning, no StatusPill extension, HomeScreen left untouched). None of the auto-fix rules triggered.

## Issues Encountered

- **Readability against the dark chip overlay.** First implementation rendered StatusPill labels in `var(--text)` (dark text), invisible on the `rgba(0,0,0,0.55)` background. Fixed inline via CSS variable overrides on the wrapper — no StatusPill.module.css edit needed.

## Threat Model Outcomes

| Threat ID | Status |
|-----------|--------|
| T-11-16-01 (pill leaks cloud-backed-char existence to a screen recorder) | accepted — pill text is non-secret; user already sees their own char list. |
| T-11-16-02 (queue mutation → renderer re-render storm) | mitigated — shallow zustand selectors on CharacterCard + main's state-change-only broadcast from Plan 11-09 (notifyStatusChange fires only on mutation, not on tick). |

## Verification Results

| Check | Result |
|-------|--------|
| `test -f src/renderer/src/lib/stores/useSyncStore.ts` | exists |
| `grep -c "onSyncStatusUpdate" useSyncStore.ts` | 3 |
| `grep -cE "sei\.syncStatus\|sei\.syncRetry" useSyncStore.ts` | 4 |
| `grep -c "useSyncStore" App.tsx` | 3 |
| `grep -c "useSyncStore.getState().init()" App.tsx` | 1 |
| `grep -c "useSyncStore" CharacterCard.tsx` | 3 |
| `grep -cE "SYNCING\|SYNC FAILED" CharacterCard.tsx` | 2 |
| `grep -c "is_default" CharacterCard.tsx` | 2 |
| `npx tsc --noEmit -p tsconfig.web.json` | exit 0 |
| `npx tsc --noEmit -p tsconfig.node.json` | exit 0 (only the two pre-existing errors in loopbackPkce.ts + supabaseClient.test.ts surface — observable on baseline and unchanged by this plan, per Plan 11-09 SUMMARY §Deferred Items) |

## Next Phase Readiness

- LIB-05 satisfied — Phase 12 (Browse + Add-to-Mine) can rely on the sync pill as the established surface for cloud-state feedback. The same pattern (zustand store + StatusPill + shallow selector) extends to per-row moderation status pills in Phase 12 if needed.
- Plan 11-17 (next plan) modifies CharacterCard.tsx for a different purpose; this plan's edits to CharacterCard.tsx are localized to the chip-row area and a small import block, so the 11-17 plan should merge cleanly. CharacterCard.module.css was untouched as instructed.

## Self-Check: PASSED

- src/renderer/src/lib/stores/useSyncStore.ts: FOUND
- src/renderer/src/App.tsx: FOUND
- src/renderer/src/components/CharacterCard.tsx: FOUND
- Commit 3ad6765: FOUND
- Commit ac98fab: FOUND

---
*Phase: 11-cloud-character-library*
*Completed: 2026-05-22*
