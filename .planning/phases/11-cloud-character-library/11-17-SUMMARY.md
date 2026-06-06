---
phase: 11
plan: 17
subsystem: ui / library-management
tags: [ui, chip, local-only, home-screen, ipc, zustand]
requires:
  - 11-07 (cloudCharacterClient.listMyCharacters — the only network call this plan wraps)
  - 11-09 (sei.sync* IPC surface — established the patterns we mirror for chars.listCloud)
  - 11-10 (useAuthStore.state.kind — the signed_in gate the chip predicate reads)
  - 11-16 (CharacterCard.tsx baseline — sync pill landed first, chip row siblings)
provides:
  - "IpcChannel.chars.listCloud / RendererApi.charsListCloud — returns the signed-in user's cloud character UUID set; signed-out and any listMyCharacters failure both return { ids: [] } so the renderer never flickers a wrong chip on transient errors"
  - "useCloudCharactersStore — renderer zustand store with cloudIds (Set<string>) + initialized flag + refresh() action; isLocalOnly(id) selector helper for O(1) membership tests"
  - "CharacterCard 'LOCAL ONLY' chip — subtle gray pill rendered on signed-in user's legacy local-mode characters (signed_in + !is_default + initialized + id ∉ cloudIds); positioned alongside the existing CUSTOM/DEFAULT chip at top-left"
  - "Defense-in-depth `initialized` gate — chip never flashes during the cold-start window between mount and the first cloud-id refresh resolving"
affects:
  - "src/main/ipc.ts: chars.listCloud handler (lazy-imports cloudCharacterClient.listMyCharacters; supabase auth.getSession for current user.id; matches the tos.status handler shape)"
  - "src/preload/index.ts: charsListCloud binding (one-liner contextBridge passthrough)"
  - "src/shared/ipc.ts: IpcChannel.chars.listCloud constant + RendererApi.charsListCloud method signature"
  - "src/renderer/src/App.tsx: cloud-id refresh effect — pulls on every transition into signed_in, clears on transition to local (no cross-session leak)"
  - "src/renderer/src/components/CharacterCard.tsx: imports useAuthStore + useCloudCharactersStore; derives isLocalOnly; renders <span class=chipLocalOnly>LOCAL ONLY</span> when applicable"
  - "src/renderer/src/components/CharacterCard.module.css: .chipLocalOnly rule — subtle gray (rgba(0,0,0,0.35) background, 78% white label), positioned at left: 80px to sit beside the CUSTOM/DEFAULT chip"
tech-stack:
  added: []
  patterns:
    - "Cloud-list IPC pattern: lazy-import cloudCharacterClient inside the handler body to avoid module-init cycle risk; getClient().auth.getSession() for current user.id (mirrors the tos.status handler shape from plan 11-12)"
    - "Renderer cache-on-demand store pattern: tiny zustand store (cloudIds + initialized + refresh) that App.tsx drives on auth transitions — no eager prefetch, no polling. Mirrors useSyncStore's shape from plan 11-16 but without the push-subscription"
    - "Defense-in-depth chip-render gate: `initialized` flag prevents a momentary mis-render during the IPC round-trip on cold start. Without it, every user-created card flashes 'LOCAL ONLY' for ~50–200ms while the refresh resolves"
    - "Auth-transition-driven cache invalidation: useEffect on authState that refreshes the cloud-id set when entering signed_in and clears it on signed_in → local"
key-files:
  modified:
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts
    - src/renderer/src/App.tsx
    - src/renderer/src/components/CharacterCard.tsx
    - src/renderer/src/components/CharacterCard.module.css
  created:
    - src/renderer/src/lib/stores/useCloudCharactersStore.ts
key-decisions:
  - "left: 80px absolute positioning over flex-container restructure. The existing CUSTOM/DEFAULT chip's `position: absolute` shape is load-bearing for the gradient/hover overlay z-stacking; converting to flex would touch the chipRow ergonomics. An 80px offset gives a ~6px gap after the CUSTOM chip's ~74px rendered width (10px mono with 1.2px letter-spacing) and keeps the diff minimal."
  - "Defense-in-depth `initialized` gate on the chip predicate. Without it, every user-created card flashes the chip during the brief mount→refresh-resolves window on cold start. The plan's specified predicate already calls this out — implementation matches."
  - "App.tsx clears cloudIds on signed_in → local transitions. Plan didn't specify this explicitly, but leaving stale ids in place after sign-out could cause the chip to remain hidden on a re-signed-in different user's freshly-loaded local-mode characters. Same shape as useAuthStore's tosAccepted/pendingShareIntent reset on local transitions."
  - "Subtle gray styling: rgba(0,0,0,0.35) background + rgba(255,255,255,0.78) label. Lighter background than the CUSTOM/DEFAULT chip's rgba(0,0,0,0.55) — visually 'softer', reading as informational rather than identifying. Per CONTEXT §specifics: 'subtle gray pill, not a warning color. Local chars are valid first-class citizens'."
patterns-established:
  - "Cloud-id cache pattern: small zustand store with refresh() + initialized, refreshed on auth transitions, consumed by per-card UI for membership tests. Reusable for any future surface that needs 'is this id in the user's cloud set' decisions (e.g. Phase 12 Browse 'Add to Mine' button state)"
  - "Chip-rendering defense-in-depth: gate every conditional chip on an explicit `initialized` flag, never on the 'is the data here yet' implicit check. Prevents render flashes on cold start"
requirements-completed: [LIB-04]
duration: ~3min
completed: 2026-05-22
---

# Phase 11 Plan 17: LOCAL ONLY Chip Summary

**Subtle gray 'LOCAL ONLY' chip on signed-in users' legacy local-mode characters — drives the migration discoverability story for D-20's one-shot upload prompt (Plan 11-18 modal handles the upload itself).**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-22T05:49:36Z
- **Completed:** 2026-05-22T05:53:23Z
- **Tasks:** 2
- **Files modified:** 6 (+ 1 created)

## Accomplishments

- LIB-04 (cache-on-demand + local-mode-first-class invariant) — fully satisfied for the discoverability surface. Users see at-a-glance which of their characters are local-only and eligible for migration via Plan 11-18's modal.
- D-20 (legacy local-mode chars stay until promoted) gets its first user-visible surface — without this chip, the only signal that a character was "local only" would be the absence of a sync pill, which is too subtle.
- Defense-in-depth `initialized` gate added beyond the plan's spec — prevents the chip from flashing during the IPC round-trip window on cold start.
- Cloud-id cache pattern established as a reusable primitive — Phase 12's Browse / Add-to-Mine flow can reuse the same store for "is this id in the user's cloud set" membership tests.

## Task Commits

Each task was committed atomically on `dev`:

1. **Task 1: chars:list-cloud IPC + useCloudCharactersStore** — `4df0889` (feat)
2. **Task 2: LOCAL ONLY chip + .chipLocalOnly style** — `5f8dc47` (feat)

## Files Created/Modified

- `src/shared/ipc.ts` (modified) — added `IpcChannel.chars.listCloud: 'chars:list-cloud'` + `RendererApi.charsListCloud(): Promise<{ ids: string[] }>`.
- `src/main/ipc.ts` (modified) — added `IpcChannel.chars.listCloud` handler: lazy-imports `cloudCharacterClient.listMyCharacters`, pulls current user.id from `getClient().auth.getSession()`, returns `{ ids: [] }` on signed-out OR listing failure (swallow + console.warn).
- `src/preload/index.ts` (modified) — added `charsListCloud: () => ipcRenderer.invoke(IpcChannel.chars.listCloud)` binding.
- `src/renderer/src/lib/stores/useCloudCharactersStore.ts` (created) — zustand store: `cloudIds: Set<string>`, `initialized: boolean`, `refresh()` action that overwrites local state from `sei.charsListCloud()`, `isLocalOnly(id)` selector helper.
- `src/renderer/src/App.tsx` (modified) — added `useCloudCharactersStore` import + a `useEffect` keyed on `authState` that calls `refresh()` on every transition into `signed_in` and resets cloudIds/initialized on transition to `local`.
- `src/renderer/src/components/CharacterCard.tsx` (modified) — imports `useAuthStore` + `useCloudCharactersStore`; derives `isLocalOnly = authKind === 'signed_in' && !isDefault && cloudInitialized && !inCloudSet`; renders `<span className={styles.chipLocalOnly}>LOCAL ONLY</span>` next to the existing CUSTOM/DEFAULT chip.
- `src/renderer/src/components/CharacterCard.module.css` (modified) — added `.chipLocalOnly` rule: `position: absolute; top: 10px; left: 80px; padding: 4px 8px; background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.78); font-family: var(--mono); font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;`.

## Decisions Made

- **left: 80px absolute positioning over flex restructure.** The existing CUSTOM/DEFAULT chip's `position: absolute` shape is structural — converting to a flex container would impact the gradient overlay z-stacking and require touching every other absolute-positioned chip-row element. 80px offset clears the CUSTOM chip's ~74px rendered width (10px mono with 1.2px letter-spacing) with ~6px breathing room. Minimal diff, no z-stacking surprise.
- **Defense-in-depth `initialized` gate beyond the plan's spec.** The plan's predicate already includes `initialized`, but the SUMMARY notes WHY: without it, every user-created card flashes "LOCAL ONLY" for ~50–200ms while the IPC round-trip resolves on cold start. The gate trades a deterministic "no chip until we know" for a deterministic "no chip flash on boot".
- **App.tsx clears cloudIds on signed_in → local.** Plan didn't specify the down-transition behavior, but leaving stale ids in place after sign-out could cause a chip mis-render if user B signs in immediately after user A (user A's cloudIds set would gate user B's chip decisions until refresh completes). Same shape as useAuthStore's tosAccepted/pendingShareIntent reset on local transitions.
- **Subtle gray (rgba(0,0,0,0.35) + 78% white) over a warmer or warning-toned color.** Per CONTEXT §specifics: "Local chars are valid first-class citizens until the user chooses to promote." A warmer tone would imply urgency or error — wrong message for a chip that's purely informational.
- **No colored dot on `.chipLocalOnly`.** The CUSTOM/DEFAULT chips use the `.chipDot` colored circle to distinguish bot-bundled vs user-created. The LOCAL ONLY chip is a different axis (where-it-lives, not what-it-is) — a third dot color would overload the visual vocabulary. Text alone in the muted palette is enough.

## Deviations from Plan

None — plan executed exactly as written, modulo the implementation choices documented in "Decisions Made" above (left: 80px positioning, App.tsx downward-transition reset, no colored dot). None of the auto-fix rules triggered.

## Issues Encountered

None. The plan's `read_first` list was sufficient — every integration point (auth store shape, sync store shape, cloudCharacterClient.listMyCharacters signature, supabase session retrieval pattern) had a clean precedent to mirror.

## Threat Model Outcomes

| Threat ID | Status |
|-----------|--------|
| T-11-17-01 (Stale cloudIds set marks recently-uploaded chars as LOCAL ONLY) | **accepted** — refresh fires on auth transitions; Plan 11-18 will hook a post-upload refresh so chips vanish without user reload. Brief visual lag between cloud-upload-completes and refresh-resolves is acceptable per the disposition. |
| T-11-17-02 (chars:list-cloud spammed on every render) | **mitigated** — refresh is auth-transition driven, never per-render. The store's selectors (membership test on cloudIds) read from cached state, no IPC. Membership tests are O(1) via Set. |

## Verification Results

| Check | Result |
|-------|--------|
| `grep -c "chars:list-cloud" src/shared/ipc.ts` | 1 |
| `grep -c "IpcChannel.chars.listCloud" src/main/ipc.ts` | 1 |
| `grep -c "charsListCloud" src/preload/index.ts` | 1 |
| `test -f src/renderer/src/lib/stores/useCloudCharactersStore.ts` | exists |
| `grep -c "cloudIds" src/renderer/src/lib/stores/useCloudCharactersStore.ts` | 6 |
| `grep -c "LOCAL ONLY" src/renderer/src/components/CharacterCard.tsx` | 3 |
| `grep -c "isLocalOnly" src/renderer/src/components/CharacterCard.tsx` | 2 |
| `grep -c "useCloudCharactersStore" src/renderer/src/components/CharacterCard.tsx` | 5 |
| `grep -c "chipLocalOnly" src/renderer/src/components/CharacterCard.module.css` | 1 |
| `npx tsc --noEmit -p tsconfig.web.json` | exit 0 |
| `npx tsc --noEmit -p tsconfig.node.json` | exit 1 (only the two pre-existing errors in loopbackPkce.ts + supabaseClient.test.ts — observable on baseline and unchanged by this plan, per Plan 11-16 SUMMARY §Verification Results) |

## Next Phase Readiness

- LIB-04 satisfied — Plan 11-18 (migration modal) can rely on the chip as the user-visible "this is migratable" indicator. After the modal uploads a selected character, Plan 11-18 must call `useCloudCharactersStore.getState().refresh()` so the chip disappears without a reload (acceptance criterion baked into Plan 11-18's own task list per the plan's must_haves).
- Phase 12 (Browse + Add-to-Mine) can reuse `useCloudCharactersStore.cloudIds` for the inverse predicate: when browsing public characters, "is this one already in my cloud library?" gates the Add-to-Mine button state. Same Set + O(1) membership test.
- `chars:list-cloud` IPC can be reused by Phase 12's Browse pagination as a quick "what do I already own" delta filter.

## Self-Check: PASSED

- src/shared/ipc.ts: FOUND
- src/main/ipc.ts: FOUND
- src/preload/index.ts: FOUND
- src/renderer/src/App.tsx: FOUND
- src/renderer/src/components/CharacterCard.tsx: FOUND
- src/renderer/src/components/CharacterCard.module.css: FOUND
- src/renderer/src/lib/stores/useCloudCharactersStore.ts: FOUND
- Commit 4df0889: FOUND
- Commit 5f8dc47: FOUND

---
*Phase: 11-cloud-character-library*
*Completed: 2026-05-22*
