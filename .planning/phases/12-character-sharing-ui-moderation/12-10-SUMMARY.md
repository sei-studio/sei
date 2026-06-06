---
phase: 12-character-sharing-ui-moderation
plan: 10
subsystem: renderer-screens
tags: [renderer, screens, ui, tabs, refactor, browse]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 08
    provides: "window.sei.getCapabilities() → { browseEnabled } — BROWSE_ENABLED feature flag from main"
  - phase: 12-character-sharing-ui-moderation
    plan: 09
    provides: "useBrowseStore — entries, query, loading, exhausted, error, setQuery, loadMore, refresh; debounce + in-flight guards live in the store"
provides:
  - "CharactersScreen.tsx — tabbed parent replacing HomeScreen route; renders <HomeGrid /> + <BrowseGrid /> co-located"
  - "Browse tab IntersectionObserver sentinel pattern (inlined, no separate hook file — only one consumer)"
  - "BROWSE_ENABLED renderer-side gate: tab bar hidden when capabilities.browseEnabled=false, HomeGrid renders alone (visually identical to pre-refactor HomeScreen)"
  - "Placeholder BrowseGrid card div per entry — 12-11 swaps in real BrowseCard component"
affects: [12-11-browse-card, 12-13-report-modal-mount, 12-17-browse-enabled-rollout]

# Tech tracking
tech-stack:
  added: []  # Reuses React + Zustand + existing IPC bindings
  patterns:
    - "Tabbed screen with co-located grid components (HomeGrid / BrowseGrid). Each tab body owns its own data-fetch useEffect so tab switching doesn't refire the other's IPC."
    - "Capabilities-driven tab visibility: gate the tab bar on window.sei.getCapabilities().browseEnabled; render the default tab body alone when false (vs. redirecting to ComingSoonScreen — 12-PATTERNS pitfall)."
    - "IntersectionObserver(rootMargin: '200px') sentinel for infinite scroll, paired with store-level in-flight guard so duplicate callbacks coalesce into one fetch."
    - "Refactor preserves CSS module reuse: HomeGrid imports the original HomeScreen.module.css verbatim for pixel-identical rendering; the new CharactersScreen.module.css owns only tab-bar + Browse-tab styling."

key-files:
  created:
    - src/renderer/src/screens/CharactersScreen.tsx
    - src/renderer/src/screens/CharactersScreen.module.css
  modified:
    - src/renderer/src/App.tsx
  deleted:
    - src/renderer/src/screens/HomeScreen.tsx
  preserved:
    - src/renderer/src/screens/HomeScreen.module.css  # imported by CharactersScreen as `homeStyles` so HomeGrid layout matches pre-refactor

key-decisions:
  - "HomeGrid lifts the pre-refactor HomeScreen body verbatim (LAN pill, '+ New' header, characters.map+CharacterCard, cloud-only placeholder rendering, openPrepare error chip, summon flow). Zero behavior change so phase-11 smoke tests still pass without re-verification."
  - "HomeScreen.module.css is preserved (not migrated) — CharactersScreen.tsx imports it as `homeStyles` and HomeGrid renders against the same class names (.root, .header, .title, .actions, .lanPill, .lanDot, .grid). This makes the refactor a pure code reorganization with no CSS regression risk."
  - "IntersectionObserver hook lives INLINE inside BrowseGrid (no `useInfiniteScroll.ts`). Only one consumer for v1.0; extracting now would be speculative abstraction. Trivial to extract later if 12-13 (ReportModal post-submit refresh) or future plans grow a second use case."
  - "Browse tab visibility is gated EXCLUSIVELY on capabilities.browseEnabled (T-12-10-01 mitigation). When false, the tab bar element does not render at all — no visible affordance for the unreleased Browse surface. HomeGrid renders alone. We do NOT redirect to ComingSoonScreen (12-PATTERNS pitfall: would break the existing home view's character grid)."
  - "useBrowseStore.refresh() called ONCE in BrowseGrid's useEffect on mount, never lifted to CharactersScreen — preserving the 12-09 contract that the store does NOT self-bootstrap. Empty dep array is intentional; refresh closes over the latest store state internally."
  - "The HomeGrid useEffect that fires sei.charsListMerged() stays INSIDE HomeGrid (NOT in CharactersScreen). Lifting it would refire the merged listing on every tab switch — 12-PATTERNS pitfall."
  - "Tab state is local to CharactersScreen (`useState<Tab>`). Persisting last-tab-selected was considered out of scope for v1.0 — users default to Home each session, BrowseTab is opt-in. A future plan can lift the selection into useUiStore if needed."
  - "Option A (delete HomeScreen.tsx) chosen over Option B (re-export shim). No code outside App.tsx imports the component; the only remaining string references to 'HomeScreen' in the codebase are JSDoc comments in LanModal/CharacterCard/useAuthStore which describe pre-refactor context and don't need updating (they document historical mount points)."

patterns-established:
  - "Capabilities-gated UI surface: a top-of-screen optional feature is shown/hidden via window.sei.getCapabilities() — read once on mount, never polled. Same pattern can extend to other unreleased surfaces (e.g. credits UI in Phase 13, vision UI in Phase 15)."
  - "Tab-body-owned IPC effects: each co-located tab component owns its own `useEffect` so switching tabs doesn't trigger sibling fetches. Re-usable for any future multi-tab screen."

requirements-addressed: [SHARE-01]
requirements-completed: []  # SHARE-01 needs 12-11 (BrowseCard) + 12-12 (Add-to-Mine flow) + 12-13 (Report modal) before it's fully delivered. This plan ships the structural shell only.

# Metrics
duration: ~5min
completed: 2026-05-22
---

# Phase 12 Plan 10: CharactersScreen Tab Refactor Summary

**Splits the existing `HomeScreen` into a tabbed `CharactersScreen` with two co-located tab bodies — `HomeGrid` (verbatim copy of HomeScreen's existing behaviour) and `BrowseGrid` (new public-character listing backed by `useBrowseStore` from 12-09). Tab bar visibility is gated on `window.sei.getCapabilities().browseEnabled` so the Browse tab is fully invisible in production builds until the BROWSE_ENABLED rollout (D-36). `BrowseGrid` ships the search field + IntersectionObserver sentinel + empty / loading / error states; cards render a placeholder `<div>{entry.name}</div>` per entry until 12-11 swaps in the real `<BrowseCard />` component.**

## Performance

- Tab switch: zero IPC fired (HomeGrid's `sei.charsListMerged()` and BrowseGrid's `useBrowseStore.refresh()` each fire only on their own tab's mount).
- Browse mount cost: one `sei.browseList({ query: '', limit: 24, offset: 0 })` call — store-level in-flight guard prevents duplicate fetches under rapid mount/unmount.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `9f8d1b3` | feat(12-10): add CharactersScreen with Home + Browse tabs |
| 2 | `2117e84` | refactor(12-10): route App.tsx to CharactersScreen, remove HomeScreen.tsx |

## What landed

### `src/renderer/src/screens/CharactersScreen.tsx` (new, ~ 360 lines)

Three components, top-to-bottom:

1. **`CharactersScreen`** (exported) — owns `tab: 'home' | 'browse'` state and `browseEnabled` from `getCapabilities()`. Renders the tab bar conditionally on `browseEnabled`; renders `<HomeGrid />` when `tab==='home'` or `browseEnabled===false`, else `<BrowseGrid />`. Default tab is `'home'`.
2. **`HomeGrid`** (co-located) — pre-refactor HomeScreen body verbatim. Selectors from `useDataStore`/`useAuthStore`/`useUiStore`; `sei.charsListMerged()` useEffect; LAN pill + `+ New` button header; characters.map rendering `CharacterCard`; cloud-only placeholder rendering with CLOUD chip overlay; openPrepare error chip; summon flow. Reuses `HomeScreen.module.css` (imported as `homeStyles`) for pixel-identical layout.
3. **`BrowseGrid`** (co-located) — selectors from `useBrowseStore` (entries, query, loading, exhausted, error, setQuery, loadMore, refresh). Mount-once `refresh()` in useEffect. IntersectionObserver(`rootMargin: '200px'`) on a `sentinelRef` div triggers `loadMore()` when in view. Renders: H1 "Browse" + search input + error banner (if any) + empty-state copy ("No public characters yet — be the first to share one.") + grid of placeholder card divs (one per entry, key=entry.id) + sentinel + loading indicator.

### `src/renderer/src/screens/CharactersScreen.module.css` (new, ~ 100 lines)

Tab-bar segmented control + BrowseGrid bits only. Uses CSS-Module `composes:` to share base `.tab` styles with `.tabActive`. Tab-bar position: `padding: 12px 40px 0` (sits above the same 40px horizontal padding as the grid below). Search field min-width 280px, rounded 6px, themed via existing `--text`, `--text-2`, `--border-strong`, `--bg-2` CSS vars.

### `src/renderer/src/App.tsx` (1-line route swap + import rename)

```diff
-import { HomeScreen } from './screens/HomeScreen';
+import { CharactersScreen } from './screens/CharactersScreen';
...
-                {view.kind === 'home' && <HomeScreen />}
+                {view.kind === 'home' && <CharactersScreen />}
```

`subtitleForView('home')` still returns `'Characters'` so the macOS window title bar is unchanged.

### `src/renderer/src/screens/HomeScreen.tsx` (DELETED)

No remaining component imports (`grep -rn "import.*HomeScreen" src/renderer/` returns only the CSS-module import in CharactersScreen.tsx, which is intentional). Stale string mentions of "HomeScreen" in JSDoc comments (LanModal, CharacterCard, useAuthStore) describe historical mount points and don't need updating.

## Deviations from Plan

**None — plan executed exactly as written.** Minor naming refinements that preserve the plan's intent:

- The plan sketched `<BrowseGrid />` referencing `useBrowseStore()` as a bare destructure; the actual implementation uses individual `useBrowseStore((s) => s.field)` selectors per Zustand idiom in this codebase (mirrors how other screens consume zustand stores: `useDataStore((s) => s.characters)`, `useAuthStore((s) => s.state.kind)`). Functionally identical — selectors are how zustand stores are read across the project.
- The plan's CSS sketch used `var(--accent-bg-soft)`, `var(--accent-text)`, `var(--accent-border)`, `var(--border-subtle)`, `var(--bg-elevated)`, `var(--text-primary)`, `var(--text-secondary)` placeholder names. The actual project CSS-var vocabulary is `--text`, `--text-2`, `--bg-2`, `--border`, `--border-strong`, `--mono`, `--sans`, `--red`, `--green`, `--muted` (consistent with HomeScreen.module.css). Adjusted the CSS module to use the project's actual vars so the tab control themes correctly under both light and dark.

## Threat Flags

None — this plan only refactors existing UI surface. The new `<BrowseGrid />` does fetch via `window.sei.browseList` but that channel was introduced and threat-modeled in 12-08 (already in the plan's threat register).

## Self-Check

Verifying claimed artifacts and commits exist:

- `src/renderer/src/screens/CharactersScreen.tsx` — **FOUND**
- `src/renderer/src/screens/CharactersScreen.module.css` — **FOUND**
- `src/renderer/src/screens/HomeScreen.tsx` — **DELETED (intentional, per plan)**
- `src/renderer/src/screens/HomeScreen.module.css` — **FOUND (preserved, imported by CharactersScreen)**
- `src/renderer/src/App.tsx` — modified, imports + uses `CharactersScreen` (`grep -c CharactersScreen src/renderer/src/App.tsx` → 2)
- Commit `9f8d1b3` — **FOUND** (Task 1)
- Commit `2117e84` — **FOUND** (Task 2)
- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN** (0 errors in renderer/shared)
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**

## Self-Check: PASSED
