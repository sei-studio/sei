---
phase: 12-character-sharing-ui-moderation
plan: 09
subsystem: renderer-state
tags: [renderer, zustand, store, tdd, debounce, browse, pagination]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 08
    provides: "IpcChannel.browse.list + window.sei.browseList(args) + BrowseEntry interface — pre-joined Browse rows the store iterates"
provides:
  - "useBrowseStore — zustand source of truth for the Browse tab grid + search field"
  - "PAGE_SIZE=24 (CONTEXT D-31b) + DEBOUNCE_MS=250 (CONTEXT D-31a) constants — locked at the store level so any consumer inherits"
  - "In-store debounce contract: setQuery(q) cancels any pending timer + schedules a fresh refresh after DEBOUNCE_MS; debounce lives in the store NOT the screen so multi-consumer renders stay consistent"
  - "Pitfall 8 in-flight guard: loadMore short-circuits on loading || exhausted — prevents the duplicate-fetch regression on slow networks"
  - "Lifecycle invariant: store does NOT self-bootstrap; CharactersScreen MUST call useBrowseStore.getState().refresh() in a useEffect on BrowseTab mount (mirrors useSyncStore.init pattern)"
affects: [12-10-publish-button, 12-13-report-modal, 12-17-browse-enabled-gate, future BrowseTab UI plan]

# Tech tracking
tech-stack:
  added: []  # Reuses zustand + vitest already in package.json
  patterns:
    - "TDD red→green (2 commits) — RED test file landed before the implementation imported by it; GREEN drives 9/9 to pass"
    - "Zustand store shape: interface FooState + interface FooActions, combined via create<State & Actions>(...); initial state hoisted as a const so reset() can spread it"
    - "Window timer typing: window.setTimeout returns number (DOM lib) — not NodeJS.Timeout — mirrors useDataStore convention"
    - "Test mocks window globally so the renderer module under test sees a stubbed window.sei + window.setTimeout that proxies to globalThis (vitest fake-timer aware)"
    - "vi.useFakeTimers + vi.advanceTimersByTimeAsync drive the 250ms debounce window deterministically"
    - "Idempotent reset(): clears every state field AND cancels any pending debounce so a queued refresh from a recent setQuery doesn't fire after reset"

key-files:
  created:
    - src/renderer/src/lib/stores/useBrowseStore.ts
    - src/renderer/src/lib/stores/useBrowseStore.test.ts
  modified: []

key-decisions:
  - "Debounce lives IN THE STORE (CONTEXT D-31a, 12-PATTERNS pitfall): setQuery cancels prev timer + schedules new one via window.setTimeout(...). Any future consumer (ReportModal post-submit refresh in 12-13, programmatic search from a deeplink, etc.) gets the same consistency guarantee without re-implementing debounce."
  - "loadMore short-circuit checks BOTH loading AND exhausted (Pitfall 8). Without the loading guard, rapid scroll on a slow network double-fetches and duplicates entries. Without the exhausted guard, the user can grind the IPC channel against an already-exhausted query."
  - "refresh wipes entries + offset BEFORE the fetch (not after). Slow refresh would otherwise visually double the grid during the network round-trip — entries from the old query persist while waiting for the new query's results. Setting empty BEFORE the await is the cleaner UX even at the cost of a brief loading state."
  - "reset() cancels the pending debounce timer. Without this, a setQuery(...) immediately before reset() would still fire its refresh 250ms later, re-populating the store the consumer thought they had cleared. The test (Test 9) advances 500ms post-reset and asserts browseList was NOT called."
  - "Store does NOT self-bootstrap on module init. CharactersScreen's BrowseTab calls refresh() from a useEffect (analog: useSyncStore.init called from App.tsx). This keeps the module side-effect-free for testability (vi.resetModules() between tests + the test calls reset() before each test) and prevents the store from invoking window.sei before contextBridge is ready."
  - "Error path stores the raw message (e.g., 'browse_load_failed' or the thrown Error's .message). The renderer ERROR_COPY map in 12-11 will decide how to surface this — keeping the store thin means 12-11 can re-route specific main-process error strings to friendly copy without touching this module."

patterns-established:
  - "Renderer TDD harness: stub globalThis.window with { sei: {...mocked methods}, setTimeout: proxy, clearTimeout: proxy } before importing the store; vi.resetModules() between tests; vi.useFakeTimers() drives any timer-based behavior. First renderer-side TDD test file in the project — pattern is reusable for any future store that calls window.sei or uses window.setTimeout."
  - "Idempotent reset() with timer cleanup — pattern for any store that owns a long-running side effect (timer, subscription, etc.) so test isolation between cases doesn't leak."

requirements-completed: [SHARE-01, SHARE-02, SHARE-04]

# Metrics
duration: ~15min
completed: 2026-05-22
---

# Phase 12 Plan 09: useBrowseStore Summary

**Ships the renderer-side Zustand store backing the Browse tab grid + search input. TDD-driven (RED test commit then GREEN impl commit) because the debounce + in-flight guard interactions are subtle — Pitfall 8 says duplicate `loadMore()` during slow networks duplicates entries, easy to regress. 250ms debounce lives IN THE STORE (CONTEXT D-31a) so every future consumer of `useBrowseStore` inherits the same consistency guarantee — the screen never owns timer state. 9/9 tests pass under `vitest`, TypeScript compiles clean across `tsconfig.web.json`.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2 (TDD red + TDD green)
- **Files created:** 2 (`useBrowseStore.ts` 164 lines, `useBrowseStore.test.ts` 218 lines)
- **Files modified:** 0

## Accomplishments

- **`useBrowseStore.ts`** (164 lines) — Zustand store exporting:
  - **State:** `entries: BrowseEntry[]`, `query: string`, `loading: boolean`, `exhausted: boolean`, `offset: number`, `error: string | null`, plus an internal `_debounceHandle: number | null`.
  - **Actions:**
    - `setQuery(q)` — updates `query` immediately (so the input stays responsive while the user types) AND cancels any pending debounce timer + schedules a fresh `refresh()` after `DEBOUNCE_MS = 250`.
    - `loadMore()` — appends the next page; **no-op when `loading || exhausted`** (Pitfall 8 guard). Computes the next offset as `s.offset + page.entries.length` so a server returning a short page doesn't strand the cursor.
    - `refresh()` — sets `entries=[], offset=0, exhausted=false, error=null, loading=true` BEFORE the fetch, then fetches `offset=0` with the current query and replaces entries.
    - `reset()` — cancels any pending debounce timer + resets to initial state. The timer cancel is what prevents a recent `setQuery(...)` from firing 250ms later and re-populating the store post-reset.
  - **Constants:** `PAGE_SIZE = 24` (CONTEXT D-31b), `DEBOUNCE_MS = 250` (CONTEXT D-31a).
- **`useBrowseStore.test.ts`** (218 lines, 9 Vitest blocks) — covers:
  1. setQuery triggers refresh after 250ms (no fire before the window elapses).
  2. Rapid setQuery('a') → setQuery('ab') → setQuery('abc') collapses to ONE browseList call with `query='abc'`.
  3. loadMore is a no-op when loading=true (Pitfall 8 in-flight guard).
  4. loadMore is a no-op when exhausted=true.
  5. loadMore APPENDS to entries; offset advances correctly for the next page request.
  6. refresh REPLACES entries from offset=0 (not appends).
  7. hasMore=false from main → store.exhausted becomes true.
  8. browseList rejection → store.error is set, loading=false.
  9. reset() clears every state field AND cancels any pending debounce (advances 500ms post-reset, asserts browseList was NOT called).
- **TDD gate compliance verified:** RED commit `1ef17e2` (test file with 9 failing tests, store module not yet present) followed by GREEN commit `848324f` (store implementation, 9/9 passing).

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): TDD failing useBrowseStore tests** — `1ef17e2` (test)
2. **Task 2 (GREEN): implement useBrowseStore with in-store debounce** — `848324f` (feat)

## Store Contract for Downstream Plans

The Browse tab UI (future plan, planned alongside the 12-10 CharactersScreen refactor) consumes this store as follows:

```typescript
// On BrowseTab mount — MUST be called from useEffect, the store does NOT self-bootstrap.
useEffect(() => {
  void useBrowseStore.getState().refresh();
}, []);

// Search input:
const query = useBrowseStore((s) => s.query);
const setQuery = useBrowseStore((s) => s.setQuery);
<TextField value={query} onChange={setQuery} placeholder="Search characters..." />;

// Grid:
const entries = useBrowseStore((s) => s.entries);
const loading = useBrowseStore((s) => s.loading);
const exhausted = useBrowseStore((s) => s.exhausted);

// Infinite scroll sentinel:
const loadMore = useBrowseStore((s) => s.loadMore);
// Call loadMore() when the scroll sentinel becomes visible; the store
// short-circuits internally if loading or exhausted.

// ReportModal post-submit (optional, per 12-13):
// useBrowseStore.getState().refresh(); // refetches with the current query
```

**Lifecycle invariant:** the store does NOT self-bootstrap on module init. CharactersScreen MUST call `useBrowseStore.getState().refresh()` from a useEffect on BrowseTab mount. This mirrors `useSyncStore.init()` being called from `App.tsx` rather than self-bootstrapping — keeps the module side-effect-free for testability and prevents the store from invoking `window.sei` before `contextBridge` is ready.

**Constants surfaced (do not duplicate downstream):**
- `PAGE_SIZE = 24` — internal to the store; consumers never set the limit.
- `DEBOUNCE_MS = 250` — internal to the store; consumers never own timer state.

**Error handling:** On a rejected `window.sei.browseList(...)`, the store sets `loading=false` + `error=<message>`. The renderer ERROR_COPY map in 12-11 will decide how to surface this. The browse:list IPC handler in 12-08 already returns `{ entries: [], hasMore: false }` on transport failure (never throws), so in practice the store's `error` field stays null in production and is exercised only by the test suite.

## Deviations from Plan

The plan executed essentially as written, with two small refinements:

1. **Import path:** plan example used `import type { BrowseEntry } from '../../../../shared/ipc'`. The codebase's convention is the `@shared/ipc` path alias (configured in `tsconfig.web.json`), used by every other store in `src/renderer/src/lib/stores/`. Switched to `@shared/ipc` for consistency. **Rule 1 — convention fix.**

2. **Test fixture: `window` stub includes `setTimeout` / `clearTimeout`.** The plan's test sketch only stubbed `window.sei`, but the store implementation uses `window.setTimeout(...)` / `window.clearTimeout(...)` directly (per the explicit Pitfall in 12-PATTERNS.md — timer handle type is `number` not `NodeJS.Timeout`, which requires the DOM-side `window.setTimeout`). When the test replaces `window` wholesale, the store's `window.setTimeout` call throws `TypeError: window.setTimeout is not a function`. Fix: the test's `beforeEach` window stub now proxies `setTimeout` and `clearTimeout` to `globalThis.setTimeout` / `globalThis.clearTimeout` so `vi.useFakeTimers` can drive the debounce window deterministically. **Rule 3 — blocking issue fix** (test couldn't otherwise exercise the implementation under test).

   This is also the first renderer-side TDD test file in the project; the harness pattern (stub `globalThis.window` with both `sei` + timer proxies, `vi.resetModules()` between tests, `vi.useFakeTimers()` for debounce assertions) is reusable for any future store that calls `window.sei` or owns timer state.

None of these are behavior changes relative to the plan's success criteria.

## Issues Encountered

None during execution. Two pre-existing test failures observed when running the full `vitest run` post-implementation (unchanged from 12-08-SUMMARY):

1. `supabase/functions/submit-report/index.test.ts` — Vitest's glob picks up `*.test.ts` under `supabase/functions/` but the file is a Deno test importing `jsr:@std/assert@1`. Pre-existing per 12-08-SUMMARY; a one-line `vitest.config.ts` exclude is the future fix (out of scope for this plan).
2. `src/main/portraitStore.test.ts` — tmpdir cleanup race in `afterEach`. Pre-existing and flaky (didn't trigger on this run); not introduced by this plan.

Both pre-date Phase 12 per SCOPE BOUNDARY rule.

## Threat Surface — Re-verify Against 12-09-PLAN `<threat_model>`

Plan listed 4 STRIDE threats. Implementation status:

| Threat ID  | Disposition | Implemented as                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-09-01 | mitigate    | `setQuery` cancels any prior `_debounceHandle` via `window.clearTimeout(prev)` before scheduling the new one. Only one timer is ever live per store instance — rapid typing causes O(n) cancellations + 1 fire after settling. Test 2 enforces by asserting browseList was called exactly once after three rapid setQuery calls.                                                            |
| T-12-09-02 | accept      | Zustand state is consumed via React selectors; renderer-side direct mutation only affects the local renderer process. Main process source of truth is unaffected. No code change needed.                                                                                                                                                                                                    |
| T-12-09-03 | mitigate    | `loadMore` short-circuits via `if (s.loading || s.exhausted) return` BEFORE setting `loading: true`. Test 3 enforces by leaving the first refresh in a non-resolved Promise (loading stays true), then calling loadMore and asserting `browseList` was called exactly once (the first refresh, not the loadMore). Pitfall 8 / duplicate-loadMore-on-slow-network regression caught.                                                  |
| T-12-09-04 | accept      | Error messages are surfaced to UI as-is via `(e as Error).message ?? 'browse_load_failed'`. The browse:list main handler in 12-08 already sanitizes (catches transport errors and returns `{ entries: [], hasMore: false }`), so production payloads never expose internal info. Test 8 exercises the fallback path with a synthetic Error to confirm the store handles a thrown error gracefully. |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Caller Invariants — Read by Future BrowseTab UI Plan

1. **The store does NOT self-bootstrap.** CharactersScreen / BrowseTab MUST call `useBrowseStore.getState().refresh()` from a useEffect on first mount. Mirrors `useSyncStore.init()` called from `App.tsx`.

2. **Debounce is owned by the store, not the screen.** Pass `setQuery` directly to the search input's `onChange`. Do not wrap it in a screen-side debounce.

3. **`loadMore()` is safe to call on every scroll-sentinel intersection.** The in-flight + exhausted guard means a "tight" intersection observer that fires on every pixel of scroll can call `loadMore()` 100x and only one fetch will go out per page boundary.

4. **`reset()` is the safe teardown.** Call it from the BrowseTab's unmount-cleanup useEffect (or on user sign-out, or any other context-switch where stale Browse state would be wrong to keep). It cancels any pending debounce so a stale refresh doesn't fire post-unmount.

5. **`PAGE_SIZE` and `DEBOUNCE_MS` are internal constants.** Do not re-declare these in the consumer; if a tuning change is ever needed it lands in this module only.

## Next Plan Readiness

**Wave 3 unblocked:**

- **Future BrowseTab UI plan** — can now consume `useBrowseStore` directly per the contract above. Renders the grid, search input, empty-state, error-state, and infinite-scroll sentinel without owning any IPC or timer state.
- **Plan 12-13 (ReportModal)** — after a successful report submission, can optionally call `useBrowseStore.getState().refresh()` to immediately reflect the auto-hide trigger's effects (the next refresh's results will exclude the auto-hidden character). Per CONTEXT, this is optional — the next user-initiated refresh would catch it anyway.
- **Plan 12-17 (BROWSE_ENABLED gate)** — gates whether the BrowseTab + its `useBrowseStore.refresh()` useEffect mounts at all. The store is inert until refreshed, so importing the module under `BROWSE_ENABLED=false` is safe (no side effects on import).

## Self-Check: PASSED

- `src/renderer/src/lib/stores/useBrowseStore.ts` — FOUND (164 lines, plan asserted ≥80)
- `src/renderer/src/lib/stores/useBrowseStore.test.ts` — FOUND (218 lines, plan asserted ≥80)
- `grep -cE "DEBOUNCE_MS\s*=\s*250|PAGE_SIZE\s*=\s*24" src/renderer/src/lib/stores/useBrowseStore.ts` = 4 (plan asserted ≥2)
- `grep -cE "window.setTimeout|window.clearTimeout" src/renderer/src/lib/stores/useBrowseStore.ts` = 4 (plan asserted ≥2)
- `npx vitest run src/renderer/src/lib/stores/useBrowseStore.test.ts` → 9/9 pass
- `npx tsc --build` — no new errors (loopbackPkce + supabaseClient.test pre-existing errors filtered)
- Commit `1ef17e2` (Task 1 RED) — FOUND in git log
- Commit `848324f` (Task 2 GREEN) — FOUND in git log
- TDD gate sequence: `test(...)` commit → `feat(...)` commit (both present, RED before GREEN)

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
