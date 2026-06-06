---
phase: 11
status: findings_found
review_scope: "plans 11-15 → 11-19 only"
reviewer_model: opus
created: 2026-05-22T06:30:04Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - src/main/characterStore.ts
  - src/main/cloud/cacheOnDemand.test.ts
  - src/main/cloud/cacheOnDemand.ts
  - src/main/ipc.ts
  - src/main/paths.ts
  - src/preload/index.ts
  - src/renderer/src/App.tsx
  - src/renderer/src/components/CharacterCard.module.css
  - src/renderer/src/components/CharacterCard.tsx
  - src/renderer/src/components/MigrateLocalCharsModal.module.css
  - src/renderer/src/components/MigrateLocalCharsModal.tsx
  - src/renderer/src/lib/stores/useAuthStore.ts
  - src/renderer/src/lib/stores/useCloudCharactersStore.ts
  - src/renderer/src/lib/stores/useSyncStore.ts
  - src/renderer/src/screens/CharacterPage.module.css
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/screens/HomeScreen.tsx
  - src/renderer/src/screens/SettingsScreen.tsx
  - src/shared/ipc.ts
findings:
  blocking: 0
  high: 2
  medium: 3
  low: 5
  nit: 4
  total: 14
---

# Phase 11 (plans 11-15 → 11-19): Code Review Report

**Reviewed:** 2026-05-22T06:30:04Z
**Depth:** standard
**Files Reviewed:** 19
**Status:** findings_found

## Summary

Plans 11-15 through 11-19 deliver the user-facing surface of the Cloud Character Library: public/private toggle, per-card sync pill, LOCAL ONLY chip + cloud-char store, migrate-local modal + IPC, and cache-on-demand. The main-process IPC surface is consistent across `shared/ipc.ts`, `main/ipc.ts`, and `preload/index.ts`. Boundary safety holds — the renderer has no direct `@supabase/supabase-js` imports and all cloud calls funnel through the contextBridge. The new cloud-write site that needed Plan 11-14's gate (`migration:upload`) does enforce `isCloudWriteAllowed()`.

The most consequential defects are UX correctness issues rather than security holes:

1. **HIGH — LOCAL ONLY chip falsely lights up on every signed-in user's character when `chars:listCloud` fails transiently.** The main handler swallows errors and returns `{ids:[]}`, the renderer flips `initialized:true`, and every char's `id ∉ cloudIds` test passes. The defensive code comment claims the opposite of the actual behavior.
2. **HIGH — `chars:openPrepare` has no concurrency guard.** Two near-simultaneous opens of the same cloud-only char (double-click on HomeScreen) both pass the `existsSync` short-circuit, double-download, double-write skin + portrait bytes. Local `withFileLock` protects against torn writes but not against the wasted bandwidth and the second writer racing in a stale-vs-fresh order.
3. **MEDIUM — `consumeShareIntent` does not fire on the "ToS already accepted at sign-in" fast path** when refreshTosStatus is called repeatedly but tosAccepted was already true; intent stays parked.

Other items are minor (unused imports, shadowed identifiers, stale type bridges, missing TypeScript strict-type annotations on inline-style custom properties).

No BLOCKER-grade defects were found. No critical security gaps were found in the new IPC surface. The defense-in-depth gates (`isCloudWriteAllowed`, `is_default` checks, IdSchema UUID validation, app:open-external host allowlist) are present and consistent.

## High

### HR-01: `chars:listCloud` failure causes every signed-in character to render LOCAL ONLY

**Files:** `src/main/ipc.ts:199-211`, `src/renderer/src/lib/stores/useCloudCharactersStore.ts:62-75`, `src/renderer/src/components/CharacterCard.tsx:76-80`
**Issue:** The main handler comment at `ipc.ts:196-198` claims the renderer's `initialized` flag "gates chip render so a transient network failure does NOT light up the chip on every char." The actual behavior is the inverse:

1. `chars:listCloud` always returns `{ ids: [] }` on failure (line 207-209) — never throws.
2. `useCloudCharactersStore.refresh()` resolves successfully with `cloudIds = new Set([])` and `initialized = true`.
3. `CharacterCard` then computes `isLocalOnly = signed_in && !isDefault && cloudInitialized && !inCloudSet` — `true` for every user-created character.

Result: during any transient Supabase outage / offline window, every cloud-backed character flips to LOCAL ONLY in the grid. The chip vanishes again on the next successful `refresh()`, so this is a UX visual flicker rather than data loss, but it produces incorrect product signal ("did my characters disappear from cloud?").

**Fix:** Either propagate a failure flag from main, OR have the renderer treat empty-array-after-error differently. Concrete option: change the main handler to return `{ ids: [], ok: boolean }` and have `useCloudCharactersStore.refresh()` leave `initialized` false when `ok: false`. Equivalent alternative: have the main handler return a tagged union and have the store keep its previous `cloudIds` Set when listing fails.

```typescript
// ipc.ts
ipcMain.handle(IpcChannel.chars.listCloud, async (): Promise<{ ids: string[]; ok: boolean }> => {
  const { getClient } = await import('./auth/supabaseClient');
  const { data: { session } } = await getClient().auth.getSession();
  if (!session?.user?.id) return { ids: [], ok: true };
  try {
    const { listMyCharacters } = await import('./cloud/cloudCharacterClient');
    const chars = await listMyCharacters(session.user.id);
    return { ids: chars.map((c) => c.id), ok: true };
  } catch (err) {
    console.warn(`[sei] chars.listCloud failed: ${(err as Error).message}`);
    return { ids: [], ok: false };
  }
});

// useCloudCharactersStore.ts
refresh: async (): Promise<void> => {
  try {
    const r = await sei.charsListCloud();
    if (r.ok) set({ cloudIds: new Set(r.ids), initialized: true });
    // On failure: keep the prior cloudIds + initialized values so the chip
    // doesn't light up on every char during a transient outage.
  } catch { /* same — don't mark initialized */ }
},
```

### HR-02: `chars:openPrepare` lacks per-uuid concurrency guard — double-click double-downloads

**File:** `src/main/cloud/cacheOnDemand.ts:48-148`
**Issue:** `ensureLocallyCached(uuid)` does an `existsSync` cache-hit check at line 50, then proceeds to download the row + skin + portrait if the file does not exist. Two near-simultaneous invocations (user double-clicks a cloud-only card on HomeScreen; or React Strict-Mode double-invoke on `CharacterPage` mount; or a parallel HomeScreen card click + CharacterPage navigation) both pass the `existsSync` check and both:

1. Hit `supabase.from('characters').select('*').eq('id', uuid)` — wasted roundtrip.
2. Call `saveCharacterRaw(cloud)` — `withFileLock` serializes, so no torn writes, but the second writer may overwrite a slightly fresher row.
3. Download skin + portrait — wasted bandwidth and a second `atomicWrite` racing for the same target.

`saveCharacterRaw` + `withFileLock` protects against corruption, but the second download CAN clobber a fresher row written by the first if the cloud row mutates between the two queries. Low real-world likelihood (cloud rows don't change between back-to-back queries) but the symptom-free wasted bandwidth + lock contention is a quality defect.

**Fix:** Wrap the function body in a per-uuid promise cache, similar to React's `cache()` pattern. Concurrent calls share the same in-flight promise; on resolution the cache entry clears so a future re-open re-checks the disk.

```typescript
const inFlight = new Map<string, Promise<void>>();
export async function ensureLocallyCached(uuid: string): Promise<void> {
  const existing = inFlight.get(uuid);
  if (existing) return existing;
  const p = (async () => { /* existing body */ })();
  inFlight.set(uuid, p);
  try { await p; } finally { inFlight.delete(uuid); }
}
```

## Medium

### MR-01: `consumeShareIntent` not fired when sign-in transition happens with ToS already accepted

**File:** `src/renderer/src/lib/stores/useAuthStore.ts:90-110, 150-167`
**Issue:** Flow: signed-out user clicks Public toggle → `setPendingShareIntent({characterId})` → SignInModal opens → user signs in → `subscribeAuthState` fires `signed_in` transition → calls `void store.refreshTosStatus()`. Inside `refreshTosStatus`:

```typescript
if (s.accepted) {
  void consumeShareIntent();
}
```

This works for the normal case. Now consider: the user already accepted ToS earlier (Phase 11 D-26 — ToS accepted at sign-up). Their first `tos:status` returns `accepted: true`. `refreshTosStatus` calls `consumeShareIntent` — but `consumeShareIntent` reads `useAuthStore.getState()` which sees `state.kind === 'signed_in'` (set immediately by `_setState` just before `refreshTosStatus` was called). So this works.

Subtle bug: if `refreshTosStatus` is called from a non-sign-in path (e.g., after `tos:accept` completes, the AcceptToSModal calls `refreshTosStatus`), and there happens to be a parked share intent, it fires. That's actually the desired behavior. **The real issue:** the share intent never expires. If the user dismisses SignInModal without signing in, the intent stays parked indefinitely. On any future sign-in (potentially hours later, for a different character context), the intent fires `charsSetShared` against a character the user may no longer remember toggling. The `T-11-15-02 mitigation` (clear on sign-out) does not cover the "user dismissed modal without signing in" case.

**Fix:** Clear the intent in the SignInModal dismissal handler in `CharacterPage.tsx`, OR add a TTL / single-modal-lifetime scope.

```typescript
// CharacterPage.tsx — modify the SignInModal onClose:
onClose={() => {
  setShowSignIn(false);
  // If the user dismissed without completing sign-in, clear the parked intent
  // so a future sign-in (in a different context) doesn't unexpectedly toggle
  // this character to public.
  if (useAuthStore.getState().state.kind !== 'signed_in') {
    setPendingShareIntent(null);
  }
}}
```

### MR-02: `migration:listLocal` returns every local char when `listMyCharacters` fails — risk of duplicate upload

**File:** `src/main/ipc.ts:514-525`
**Issue:** When cloud listing throws, `cloudIds` is `new Set()` and the filter `!cloudIds.has(c.id)` matches every local char. The handler comment acknowledges this ("treat every local char as not in cloud so the modal still surfaces them"). On `migration:upload`, the handler then re-`upsert`s rows that may already exist in cloud. `.upsert` is idempotent on the row, but the skin + portrait re-uploads are wasteful, and worse, **the user sees a successful "Done" tick mark for characters that were already in cloud** — masking the listing failure entirely.

**Fix:** Either surface the listing failure in the modal copy ("Couldn't verify which of these are already in cloud — uploading anyway is safe") or skip the upload entirely on transient failure and prompt the user to retry the modal later.

### MR-03: `migration:upload` `is_default` defense-in-depth happens AFTER `upsertCharacter` validation

**File:** `src/main/ipc.ts:555-572`
**Issue:** The handler reads the character via `getCharacter(id)`, then checks `char.is_default`. If `is_default` is true, it pushes a per-uuid failure and continues. This is correct. But on the success path, the handler does NOT pass the loaded `char` through `CharacterSchema.parse` — it relies on `getCharacter`'s internal parse. That's consistent with the rest of the codebase. No bug here; just calling out that the existing chain (getCharacter → CharacterSchema.parse) is what gates schema correctness.

The real issue is more subtle: `upsertCharacter` checks `if (c.portrait_image && c.portrait_image.startsWith('data:'))` and throws `CLOUD_SYNC_REFUSED_DATA_URL`. For migration uploads, any pre-Phase-11 local character that still has an inline data URL portrait will get rejected at upload time with a sentinel error string surfaced in the per-row failure message. The user sees a cryptic `CLOUD_SYNC_REFUSED_DATA_URL: ...` message. Not great UX.

**Fix:** Translate sentinel errors to user-friendly copy in the per-row results. Alternatively, run a portrait-data-URL migration before uploading (decode + atomic-write to `<userData>/portraits/<uuid>.png`, replace `portrait_image` with the filename). Plan 11-05's UUID rename migration was presumably supposed to cover this but I did not verify in this review.

## Low

### LR-01: `cacheOnDemand.ts` retains unused `writeFile` import with `void writeFile;` suppression

**File:** `src/main/cloud/cacheOnDemand.ts:41,147`
**Issue:** `writeFile` is imported but never called; `atomicWrite` + `withFileLock` handle every write. The line `void writeFile;` exists solely to silence the unused-import warning, with a comment explaining "writeFile is kept in the import set as a future hook for a non-locked fallback path." This is a YAGNI anti-pattern.

**Fix:** Remove the import and the `void writeFile;` line. Re-add when needed.

### LR-02: `useAuthStore` `TosStatusBridge` type cast is now dead defensive code

**File:** `src/renderer/src/lib/stores/useAuthStore.ts:15-22`
**Issue:** The comment says "this Plan 11-13 surface lands in parallel with 11-12; the type bridge below lets useAuthStore compile standalone in this worktree and is a no-op once 11-12 types land." Plan 11-12 has shipped (commit history confirms `feat(11-12)` landed before plan 11-13). `RendererApi.tosStatus()` is now defined in `shared/ipc.ts:397`. The bridge cast is a no-op.

**Fix:** Remove the `TosStatusBridge` type and the `sei as ... & TosStatusBridge` cast. Import `sei` directly.

### LR-03: HomeScreen.tsx — outer `characters` shadowed inside auto-migrate effect IIFE

**File:** `src/renderer/src/App.tsx:171`
**Issue:** `const { characters } = await sei.migrationListLocal();` shadows the outer `const characters = useDataStore((s) => s.characters);` (line 70). The outer `characters` is unused inside the effect body, so there's no functional bug — but it's a readability footgun: a future maintainer who inserts a `characters.length` check inside the effect will see the wrong list.

**Fix:** Rename to `localOnlyChars` or `migrationCandidates`:
```typescript
const { characters: localOnlyChars } = await sei.migrationListLocal();
if (cancelled || localOnlyChars.length === 0) return;
```

### LR-04: CharacterCard.tsx — inline `style` custom properties via untyped cast

**File:** `src/renderer/src/components/CharacterCard.tsx:129-140, 153-167`
**Issue:** Inline styles set CSS custom properties via:
```typescript
style={{ '--text': 'white', '--text-2': 'rgba(255,255,255,0.85)' } as React.CSSProperties}
```
The `as React.CSSProperties` cast bypasses TypeScript checking; a typo (`--txet`) would silently fail. The CharacterCard comment acknowledges this is to avoid touching `StatusPill.module.css` for Plan 11-17 ownership reasons.

**Fix (when CSS module ownership unfreezes):** Add a dedicated CSS class to CharacterCard.module.css with the appropriate `--text` override scope:
```css
.syncPillOnDarkChip { --text: white; --text-2: rgba(255,255,255,0.85); /* + position */ }
```

### LR-05: `useSyncStore.init` — small race window between subscribe and initial seed

**File:** `src/renderer/src/lib/stores/useSyncStore.ts:69-78`
**Issue:** Order: subscribe push handler → `set({initialized:true})` → `await refresh()`. If a push fires between the subscribe and the refresh's snapshot setting, the push's newer state lands first, then the older refresh snapshot overwrites it. The fix is straightforward (refresh first, subscribe second — with seeding into a temp variable to bridge the gap) but the practical race window is small enough that this is a code smell, not a defect.

**Fix:** Subscribe first (to not miss pushes), accumulate any pushes that arrive before the initial seed into a pending value, then refresh and merge. Or use a sequence number / timestamp to discard the older snapshot.

## Nit

### NR-01: `chars:openPrepare` IPC handler error wrapping inconsistent

**File:** `src/main/ipc.ts:228-232`
**Issue:** Throws `CLOUD_CHARACTER_NOT_FOUND` / `CLOUD_DOWNLOAD_FAILED` from `ensureLocallyCached` directly back through IPC. The renderer (`CharacterPage.tsx:165`) does `setPrepareError((err as Error).message)` which puts raw sentinel-prefixed strings in the JSX message map. Other IPC handlers in this same file translate sentinel errors to friendly copy. Consider mapping sentinels to user copy in main, OR have the renderer's ERROR_COPY map handle these new families.

### NR-02: `migration.shown` uses sync `mkdirSync` / `writeFileSync` inside an async handler

**File:** `src/main/ipc.ts:603-618`
**Issue:** Mixing sync FS calls in an async IPC handler is OK but inconsistent with the rest of the file (which uses async fs/promises and atomicWrite). The sync calls block the event loop momentarily; here the I/O is small so it's not a real performance issue, but it deviates from the established pattern.

**Fix:**
```typescript
const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir(nodePath.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ shown: true, shownAt: new Date().toISOString() }, null, 2) + '\n');
```

### NR-03: `MigrateLocalCharsModal` has no ESC suppression / blocking behavior despite docblock claim

**File:** `src/renderer/src/components/MigrateLocalCharsModal.tsx:122`
**Issue:** The docblock says "Click-outside SUPPRESSED — no onClick on scrim. Matches DeleteAccountModal idiom." But unlike DeleteAccountModal, this component does NOT install an ESC keydown handler at all. The user can still hit ESC during an in-flight upload and dismiss the modal (browser default), losing visibility into the per-row results. The docblock contract isn't fully honored.

**Fix:** Add a `useEffect` that adds/removes a `keydown` handler suppressing ESC when `phase === 'submitting'`. (DeleteAccountModal does this — model the pattern.)

### NR-04: `HomeScreen.tsx` cloud-only filter recomputes on every render

**File:** `src/renderer/src/screens/HomeScreen.tsx:229-236`
**Issue:** `cloudOnly.filter((co) => !characters.some(...))` runs every render. With many characters this becomes O(N*M). Not a real problem at v1 scale, but the comment ("belt-and-suspenders to prevent a one-frame flicker") suggests the author considered the issue. A `useMemo` keyed on `[cloudOnly, characters]` would be cheap. Out of v1 scope (perf) but mentioning.

---

## Verification Checklist (re-review)

If/when these are addressed and a re-review is requested, the checklist below maps each finding to a verifiable test:

- [ ] HR-01 — Simulate `chars:listCloud` rejection in dev tools; verify cloud-backed characters do NOT show LOCAL ONLY chip.
- [ ] HR-02 — Add a concurrent-call test in `cacheOnDemand.test.ts` asserting `downloadCharacterMock` called exactly once on parallel `ensureLocallyCached` calls.
- [ ] MR-01 — Walkthrough: signed-out toggle → dismiss SignInModal → sign in later; verify no auto-share of the dismissed-context character.
- [ ] MR-02 — Simulate `listMyCharacters` failure in migration:listLocal; verify modal copy reflects the uncertain state.
- [ ] MR-03 — Test character with `portrait_image: 'data:image/png;base64,...'` through migration:upload; verify per-row error is user-friendly.

---

## Fix Summary

**Applied:** 2026-05-22 (review-fix pass after initial standard review)
**Fixer:** Claude Opus 4.7 (gsd-code-fixer)
**Branch:** `reviewfix-11-sv-11-reviewfix-cjl3vg` (merge into `dev`)
**Test gate after each commit:** `tsc --noEmit -p tsconfig.web.json` clean;
`vitest run` 137/138 (1 pre-existing flaky portraitStore ENOTEMPTY; passes on
rerun per 11-VERIFICATION.md — not a regression). HR-02 adds 1 new test
(138 total).

| Finding | Status | Commit | Notes |
|---------|--------|--------|-------|
| HR-01 — `chars:listCloud` false LOCAL ONLY flash | FIXED | `82c6d6c` | Return shape now `{ ids, ok }`; renderer preserves prior cloudIds + initialized on ok=false |
| HR-02 — `ensureLocallyCached` double-download race | FIXED | `6dd2dc8` | Per-uuid in-flight `Map<string, Promise<void>>`; new vitest case `HR-02: concurrent calls for the same uuid share a single download`. Also drops dead `void writeFile;` (LR-01) |
| MR-01 — `pendingShareIntent` leak on modal dismiss | FIXED | `8362833` | onClose clears when not signed in; consumeShareIntent drops intents older than 5 min TTL; PendingShareIntent gains `createdAt` |
| MR-02 — `migration:listLocal` silent cloud-list fallback | FIXED | `7a21b8b` | Return shape now `{ characters, cloudListOk }`; modal shows warn banner when ok=false |
| MR-03 — raw `CLOUD_SYNC_REFUSED_DATA_URL` per-row copy | FIXED | `c57cb4b` | migration:upload translates `CLOUD_SYNC_REFUSED_DATA_URL` + `CLOUD_SYNC_REFUSED_DEFAULT` sentinels to user copy |
| LR-01 — dead `writeFile` import + `void writeFile;` | FIXED | `6dd2dc8` | Folded into HR-02 commit (same file) |
| LR-02 — `TosStatusBridge` dead defensive cast | FIXED | `176055f` | Removed; sei consumed directly from ipcClient |
| LR-03 — `App.tsx` `characters` shadowing | FIXED | `176055f` | Renamed to `localOnlyChars` |
| LR-04 — CharacterCard inline `as React.CSSProperties` | FIXED | `176055f` | Three CSS classes (`syncPillOverlay` + `Passive` + `Button` modifiers) replace the inline cast |
| LR-05 — `useSyncStore.init` subscribe-vs-seed race | FIXED | `176055f` | Push-sequence counter; seed skips `set` if any push arrived during the await |
| NR-01 — `chars:openPrepare` sentinel-to-copy mapping | DEFERRED | — | Out of tail-hygiene scope; renderer-side ERROR_COPY pass is a separate cross-cutting follow-up |
| NR-02 — `migration:shown` sync FS calls | FIXED | `176055f` | Switched to async fs/promises (mkdir/writeFile/access) |
| NR-03 — `MigrateLocalCharsModal` ESC suppression | FIXED | `176055f` | Capture-phase keydown handler swallows ESC while phase === 'submitting' |
| NR-04 — `HomeScreen` cloud-only filter recomputes | DEFERRED | — | Explicit "Out of v1 scope (perf)" in the review; matches user instruction |
| tos:accept missing `invalidateTosCache()` (verifier nit) | FIXED | `176055f` | Added lazy import + call after `recordAcceptance` succeeds |

**Total:** 12 FIXED, 2 DEFERRED, 0 WONT_FIX.

The deferred items (NR-01, NR-04) match the user's "optional tail" framing
and the reviewer's own out-of-scope tagging on NR-04. NR-01 needs a renderer-
side ERROR_COPY map update for the `CLOUD_CHARACTER_NOT_FOUND` /
`CLOUD_DOWNLOAD_FAILED` families and is better tackled when that map is
otherwise being touched.

---

_Reviewed: 2026-05-22T06:30:04Z_
_Reviewer: Claude Opus 4.7 (gsd-code-reviewer)_
_Depth: standard_
_Scope: plans 11-15 → 11-19 only (commits c887158..f7c32b7)_
