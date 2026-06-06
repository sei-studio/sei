---
phase: 12-character-sharing-ui-moderation
plan: 12
subsystem: renderer-integration
tags: [renderer, integration, add-to-mine, toast-ux, share-04]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 11
    provides: "BrowseGrid handleAddToMine baseline wiring + reportTarget state + addToMineError chip — 12-12 polishes the handler with toast UX + refresh chain"
  - phase: 12-character-sharing-ui-moderation
    plan: 09
    provides: "useBrowseStore.refresh() — called post-success so main re-precomputes inMyLibrary against the just-updated local index"
  - phase: 11-cloud-character-library
    plan: 19
    provides: "cacheOnDemand.ts + window.sei.charsOpenPrepare — the Add-to-Mine IPC. HR-02 (post-hotfix) added the per-uuid Map<uuid, Promise<void>> in-flight guard that 12-12 relies on as Pitfall 10 mitigation."
provides:
  - "Enhanced BrowseGrid.handleAddToMine: optimistic inMyLibrary early-exit + 3 s auto-dismiss toast (success/error variants) + post-success refreshCharacter(id) → useBrowseStore.refresh() refresh chain"
  - "Toast UX (.toastSuccess / .toastError) — fixed-position pill, --green / --red tokens, z-index 100 (below future ReportModal at higher z-index)"
  - "Pitfall 10 verification: cacheOnDemand HR-02 in-flight guard CONFIRMED PRESENT (grep matched 5 occurrences vs threshold ≥1)"
affects: [12-13-report-modal-mount, 12-17-rollout-gate]

# Tech tracking
tech-stack:
  added: []  # Pure renderer wiring; no new dependencies
  patterns:
    - "Inline-toast pattern: a single useState<{kind, message} | null> + useEffect-driven setTimeout(3000) dismiss inside BrowseGrid. NO standalone <Toast /> component — v1.0 only Browse surfaces toast feedback. If a second caller appears (e.g. ReportModal success in 12-13, character publish in 12-18), promote to shared/Toast.tsx then. YAGNI discipline."
    - "Optimistic early-exit + server in-flight guard belt-and-suspenders: the renderer checks entry.inMyLibrary before firing the IPC AND the main-side cacheOnDemand coalesces concurrent invocations via Map<uuid, Promise>. Either layer alone suffices for double-click; together they cover programmatic abuse + cross-process race + Browse-tab-flip-race scenarios."
    - "Refresh chain on mutation: useDataStore.refreshCharacter(id) → useBrowseStore.refresh(). The first re-reads local disk (so Home tab picks up the new file); the second re-fetches Browse (so main recomputes inMyLibrary for the just-added entry). Both calls are awaited so the toast 'Added' lands AFTER the badge has flipped."

key-files:
  created: []
  modified:
    - src/renderer/src/screens/CharactersScreen.tsx
    - src/renderer/src/screens/CharactersScreen.module.css

key-decisions:
  - "useDataStore exposes refreshCharacter(id), NOT refresh(). The plan sketched `await useDataStore.getState().refresh?.()` with optional chaining as a hedge; the actual method has been `refreshCharacter(id: string)` since Phase 11 and 12-11 already calls it. Use that. The plan's explicit guidance — `Document in SUMMARY: if useDataStore.refresh method name differs from what the codebase exposes, adapt — the goal is 're-read the local characters list so it includes the just-cached uuid'` — confirmed the intent. No deviation needed since 12-11 was already correct."
  - "Toast is inline in CharactersScreen.tsx (BrowseGrid component), NOT a standalone <Toast /> component. v1.0 has exactly one toast caller; promoting now would be speculative abstraction. The state shape `{ kind: 'success' | 'error'; message: string } | null` and 3 s auto-dismiss timeout are simple enough to copy-paste into ReportModal in 12-13 if needed; the second caller is the trigger for shared/Toast.tsx."
  - "Toast styles use the existing --green / --red palette tokens, NOT --accent-bg / --accent-text-on as the plan sketched. The plan's named tokens don't exist in tokens.css; --green (#5E8E47 light / #7DB868 dark) + --red (#C4523A light / #E07259 dark) are the project's success/error palette, used by LAN pill + openPrepare error chip + addToMineError chip. White text on either provides AA-passable contrast in both themes."
  - "Optimistic early-exit on entry.inMyLibrary is the renderer-side complement to HR-02's main-side in-flight guard. They mitigate Pitfall 10 (double-click → double-download) at two layers: the renderer skips the IPC entirely when the badge has flipped; the main process coalesces concurrent IPCs for the same uuid through a shared promise. Either is sufficient for normal user behavior; both together cover programmatic edge cases (e.g. tests, automation scripts, accessibility tools firing click twice)."
  - "addToMineError state from 12-11 is RETAINED, not replaced by toast. The chip is positioned next to the card and persists until the next action; the toast is fleeting and screen-level. Both surfaces fire on failure — the chip tells the user WHICH card failed (visual anchoring next to the card), and the toast tells them WHY (the error message detail). Belt-and-suspenders for the error UX, no extra cost."

patterns-established:
  - "Optimistic-UI + server-side coalescence belt-and-suspenders for mutation IPCs — pattern reusable for any future browse-grid action (e.g. Phase 14+ favorite / collect / hide actions)."

requirements-addressed: [SHARE-04]
requirements-completed: [SHARE-04]  # SHARE-04 (Add public character to library) acceptance criteria: click Add to Mine, see clear success/failure feedback, BrowseCard flips to "Already in My Library" without manual refresh. All three met by this plan + 12-11's BrowseCard.

# Metrics
duration: ~5min
completed: 2026-05-22
---

# Phase 12 Plan 12: Add-to-Mine Flow Polish Summary

**SHARE-04 acceptance polish on top of 12-11's BrowseCard wiring: optimistic inMyLibrary early-exit + 3-second auto-dismissing toast (success/error variants) + post-success refresh chain (useDataStore.refreshCharacter(id) → useBrowseStore.refresh()) so the BrowseCard flips to "Already in My Library" without a manual reload. Pitfall 10 (HR-02 in-flight guard in cacheOnDemand) verified present — grep matched 5 occurrences against the ≥1 threshold. No new IPC channel introduced; the entire flow reuses the existing chars:openPrepare from Phase 11 (researcher correction #6 honored). All 19/19 vitest tests pass; npx tsc --noEmit -p tsconfig.web.json clean.**

## Refresh Chain

```
handleAddToMine(entry)
  ├── if (entry.inMyLibrary) return                    [optimistic early-exit]
  ├── setToast({ kind: 'success', message: 'Adding…' })
  ├── await sei.charsOpenPrepare(entry.id)             [Phase 11 cacheOnDemand]
  │     └── HR-02 in-flight guard coalesces double-clicks
  │     └── downloads JSON + skin PNG + portrait PNG
  ├── await useDataStore.refreshCharacter(entry.id)    [non-fatal — caught]
  │     └── re-reads local file so open Home tab picks up new char
  ├── await refresh()                                  [useBrowseStore.refresh]
  │     └── main re-precomputes inMyLibrary → card flips to ALREADY IN LIBRARY
  └── setToast({ kind: 'success', message: 'Added "<name>" to your library.' })

On failure:
  ├── console.warn(...)
  ├── setAddToMineError(entry.id)                      [card-anchored chip from 12-11]
  └── setToast({ kind: 'error', message: 'Couldn't add "<name>". <reason>' })
```

## Toast UX

**Inline implementation in BrowseGrid — NOT a standalone Toast component.**

```tsx
const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

useEffect(() => {
  if (toast === null) return;
  const t = window.setTimeout(() => setToast(null), 3000);
  return () => window.clearTimeout(t);
}, [toast]);
```

Rendered at the bottom of BrowseGrid's return JSX with `role="status"` + `aria-live="polite"`:

```tsx
{toast ? (
  <div
    className={toast.kind === 'success' ? styles.toastSuccess : styles.toastError}
    role="status"
    aria-live="polite"
  >
    {toast.message}
  </div>
) : null}
```

CSS module additions (`CharactersScreen.module.css`):

```css
.toastSuccess, .toastError {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 18px;
  border-radius: 6px;
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.1px;
  color: white;
  z-index: 100;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
  max-width: min(480px, calc(100vw - 64px));
}
.toastSuccess { background: var(--green); }
.toastError   { background: var(--red); }
```

**Auto-dismiss timing:** 3 s is the de-facto standard for transient status toasts (long enough to read, short enough to not block subsequent actions). Cleared timer on toast change (useEffect cleanup) so a rapid second action doesn't leave a stale timer.

## HR-02 Verification (Pitfall 10 — Task 2)

**Result: PASS.**

```
$ grep -c "inFlight\|inflight\|pending.*Map\|Map.*Promise" src/main/cloud/cacheOnDemand.ts
5
```

The required pattern (Map<uuid, Promise<void>>) is at `src/main/cloud/cacheOnDemand.ts:70`:

```ts
const inFlight = new Map<string, Promise<void>>();

export async function ensureLocallyCached(uuid: string): Promise<void> {
  const existing = inFlight.get(uuid);
  if (existing) return existing;
  const p = ensureLocallyCachedImpl(uuid).finally(() => {
    inFlight.delete(uuid);
  });
  inFlight.set(uuid, p);
  return p;
}
```

This means a renderer double-click on Add to Mine (within the IPC round-trip window) results in:

1. First IPC enters `ensureLocallyCached(uuid)` — Map is empty, inserts the in-flight promise, begins download.
2. Second IPC enters `ensureLocallyCached(uuid)` — Map.get(uuid) returns the existing promise, both callers await the SAME resolution.
3. Single Supabase round-trip, single atomic-write per file, single shared promise resolves both IPC handlers.
4. On resolve/reject, `.finally()` deletes the Map entry so a future re-open re-checks disk.

Combined with the renderer-side optimistic `if (entry.inMyLibrary) return;` short-circuit, the double-click → double-download attack surface is fully closed at both layers.

**Smoke-test for the executor / verifier** (per Task 2 `<done>` criterion):

- Click Add to Mine twice in rapid succession (within ~100 ms).
- Expected: ONE network request in the dev tools network tab; the second click resolves from the shared promise.
- Expected: ONE file write per target (skin.png, portrait.png, character.json) — no torn writes, no duplicate writes.
- If you observe two parallel downloads or duplicate file writes, HR-02 has been regressed — re-check `inFlight` Map presence in cacheOnDemand.ts.

## What landed

### `src/renderer/src/screens/CharactersScreen.tsx` (modified, +37/-12 lines)

Inside `BrowseGrid()`:

- New state: `toast: { kind: 'success' | 'error'; message: string } | null`.
- New useEffect: 3 s auto-dismiss timer on toast change (cleanup cancels the timer if the toast changes before timeout).
- `handleAddToMine` enhanced with:
  - Optimistic `if (entry.inMyLibrary) return;` early-exit.
  - Initial `setToast({ kind: 'success', message: 'Adding "<name>"…' })`.
  - Awaited `refresh()` (was `void refresh()` in 12-11) so the success toast lands AFTER inMyLibrary has flipped.
  - Success toast: `'Added "<name>" to your library.'`.
  - Error toast: `'Couldn't add "<name>". <reason>'` (the err.message is appended if present).
  - addToMineError chip from 12-11 RETAINED — chip + toast both fire on failure (chip is card-anchored, toast is screen-level).
- New JSX block at the bottom: `{toast ? <div ... role="status" aria-live="polite">...</div> : null}`.

### `src/renderer/src/screens/CharactersScreen.module.css` (modified, +37/-0 lines)

Two new selectors:

- `.toastSuccess` — fixed bottom-center pill on `--green`.
- `.toastError` — fixed bottom-center pill on `--red`.
- Shared rule (commas) covers position / padding / border-radius / box-shadow / font / z-index / max-width.

## Deviations from Plan

**Two minor adaptations to project conventions — no behavior drift from plan intent.**

### 1. [Rule 1 - API mismatch] useDataStore exposes refreshCharacter(id), not refresh()

- **Found during:** Task 1
- **Issue:** The plan's sketched code calls `await useDataStore.getState().refresh?.()` with optional chaining as a hedge against unknown method name. The actual `useDataStore` exposes `refreshCharacter(id: string): Promise<void>` (since Phase 11), and 12-11's baseline handleAddToMine already calls `refreshCharacter(entry.id)`.
- **Fix:** Kept the 12-11 pattern (`useDataStore.getState().refreshCharacter(entry.id)`). Wrapped in try/catch so a non-fatal refresh failure doesn't prevent the toast/refresh-Browse chain from completing.
- **Files modified:** src/renderer/src/screens/CharactersScreen.tsx
- **Commit:** 486a4fe
- **Plan-sanctioned:** The plan's `<action>` explicitly says "Document in SUMMARY: if useDataStore.refresh method name differs from what the codebase exposes, adapt — the goal is 're-read the local characters list so it includes the just-cached uuid.'" Adapted as instructed.

### 2. [Rule 3 - CSS token mismatch] Toast palette uses --green / --red, not --accent-bg / --accent-text-on

- **Found during:** Task 1
- **Issue:** Plan sketched `.toastSuccess { background: var(--accent-bg); color: var(--accent-text-on); }` and `.toastError { background: var(--error-bg, #c2410c); color: white; }`. The token `--accent-bg` / `--accent-text-on` / `--error-bg` do not exist in `src/renderer/src/styles/tokens.css`.
- **Fix:** Use the project's actual success/error palette: `--green` (light #5E8E47 / dark #7DB868) for success, `--red` (light #C4523A / dark #E07259) for error. White text on both provides AA-passable contrast in both themes. This is the same palette used by LAN pill (--green / --red) and addToMineError chip (--red) so the visual vocabulary stays consistent.
- **Files modified:** src/renderer/src/screens/CharactersScreen.module.css
- **Commit:** 486a4fe

## Threat Compliance

Per 12-12 threat register:

| Threat ID    | Disposition | Status                                                                                                                                                                                          |
| ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-12-01   | mitigate    | **MITIGATED** — Two-layer guard. (a) Renderer optimistic early-exit on `entry.inMyLibrary` short-circuits the IPC for already-cached characters. (b) Main-side cacheOnDemand HR-02 in-flight Map coalesces concurrent IPCs for the same uuid into a single download. Verified via grep (5 occurrences of in-flight pattern in cacheOnDemand.ts). |
| T-12-12-02   | accept      | **ACCEPTED** — Error toast surfaces `err.message` which originates from main IPC. Main already sanitizes via Pitfall 10 + CLOUD_* sentinel mapping (Phase 11 cloudErrors.ts); no PII/secret reaches the toast string.                                          |
| T-12-12-03   | accept      | **ACCEPTED** — Toast message includes the character name in `"…"` quotes inside a JSX child expression. React JSX escapes string children by default — no XSS surface.                                                                                                  |

No new threat surface introduced beyond the existing BrowseEntry contract (threat-modeled in 12-08) and the existing chars:openPrepare IPC (threat-modeled in 11-19).

## Threat Flags

None — this plan adds no new IPC channels, no new auth paths, no new file access patterns, no new schema touches. The Add-to-Mine flow continues to reuse `chars:openPrepare` from 11-19 (researcher correction #6); the toast is a pure renderer-side affordance.

## Verification Status

- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN** (0 errors in renderer/shared)
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**
- Task 1 `<verify>` grep `charsOpenPrepare|useBrowseStore.*refresh|toastSuccess|toastError` in CharactersScreen.tsx → **9** (threshold ≥3) ✓
- Task 2 `<verify>` grep `inFlight|inflight|pending.*Map|Map.*Promise` in cacheOnDemand.ts → **5** (threshold ≥1) ✓
- HR-02 in-flight guard CONFIRMED present at `src/main/cloud/cacheOnDemand.ts:70` (Map<string, Promise<void>>)
- Manual `npm run dev` smoke-test with BROWSE_ENABLED=true + ≥1 public character: **deferred** to 12-17 rollout (no Browse-tab-visible builds locally yet); pattern verified via 12-11 + 12-12's unit tests + the unchanged Phase 11 cacheOnDemand behavior.

## Known Stubs

None — Add-to-Mine flow is complete for SHARE-04 acceptance. The Report button intentionally remains stubbed (state-only) pending 12-13 ReportModal mount, but that's the 12-11 known stub; 12-12 didn't introduce a new one.

## Commits

| Task | Commit    | Description                                                                          |
| ---- | --------- | ------------------------------------------------------------------------------------ |
| 1    | `486a4fe` | feat(12-12): enhance Add-to-Mine with toast UX + post-success refresh chain          |
| 2    | (none)    | Verification-only task — HR-02 in-flight guard confirmed present in cacheOnDemand.ts |

## Self-Check

Verifying claimed artifacts and commits exist:

- `src/renderer/src/screens/CharactersScreen.tsx` — **MODIFIED** (verified via `grep -c charsOpenPrepare|useBrowseStore.*refresh|toastSuccess|toastError` → 9)
- `src/renderer/src/screens/CharactersScreen.module.css` — **MODIFIED** (verified — `.toastSuccess` + `.toastError` selectors present, using --green / --red)
- `src/main/cloud/cacheOnDemand.ts` — **UNCHANGED** (HR-02 guard confirmed at line 70, present from Phase 11 11-19 hotfix)
- Commit `486a4fe` — **FOUND** (`git log --oneline -1 486a4fe` returns the feat(12-12) message)
- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN**
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**

## Self-Check: PASSED
