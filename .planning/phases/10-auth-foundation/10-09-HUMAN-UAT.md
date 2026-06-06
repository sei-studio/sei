---
phase: 10-auth-foundation
plan: 09
source: 10-09-export-data-PLAN.md (Task 3 — checkpoint:human-verify)
status: partial
created: 2026-05-20
deferred_from: 10-09 execution (checkpoint deferred at user direction; export flow not yet exercised end-to-end against a real signed-in account + real save dialog)
preconditions:
  - "Sei dev build runnable (`npm run dev`) with phase 10 plans 01–09 merged AND .env populated."
  - "A signed-in Supabase test account."
  - "A writable location on the filesystem (e.g. Desktop) for step 4, AND a read-only location (e.g. /Library/Apple/foo.json without sudo) for step 7."
resume_owner: "Phase 10 gap-closure pass OR `/gsd-verify-work 10`"
references:
  - "deferred-items.md item #11"
  - "10-09-SUMMARY.md"
  - "10-09-export-data-PLAN.md <how-to-verify> (canonical 8-step script)"
---

# Phase 10 Plan 09 — Human UAT (deferred)

**Status:** partial — automated work was comprehensive (35/35 phase-10 tests pass including 5 new in `exportBuilder.test.ts` that lock the D-14 schemaVersion=1 contract; `npx tsc --noEmit` clean; all task-1/2 acceptance grep gates pass). The 8-step live UAT against a real signed-in account + real save dialog remains owed to phase verification.

The original checkpoint copy is preserved verbatim from `10-09-export-data-PLAN.md` (Task 3 `<how-to-verify>`).

## Why this was deferred

At the human-verify checkpoint the user opted to defer the live UAT to phase-10 gap-closure. Rationale:

- The 5 buildExport tests lock the D-14 schema contract directly: `schemaVersion: 1`, `exportedAt` (ISO string), `account: {email, createdAt}`, `characters: []`, `sharing: []` — empty-but-present. Step 5 of the live UAT (the "open the file, verify the 5 top-level keys" step) is what those automated cases already verify against synthetic inputs.
- Established phase-10 precedent (plans 10-05, 10-06, 10-07, 10-08 all deferred their live UATs).

## Preconditions

1. **Dev build runnable** — `npm run dev` opens the Sei window with a signed-in account.
2. **A signed-in Supabase test account** (any state — verified or unverified).
3. **Writable filesystem location** (Desktop is the default in the dialog).

## UAT script (8 steps, all required)

### Step 1. Sign in
- **Action:** Sign in to Sei with any test account.
- **Expected:** Reach Home; Settings → ACCOUNT panel is visible.
- **result:** [pending]

### Step 2. Click Export as JSON
- **Action:** Settings → ACCOUNT panel → Export My Data row → click `Export as JSON`.
- **Expected:** Native save dialog opens.
- **result:** [pending]

### Step 3. Default filename pattern
- **Action:** Inspect the default filename suggested by the dialog.
- **Expected:** Matches `sei-export-YYYY-MM-DD.json` for today's date (e.g. `sei-export-2026-05-20.json`).
- **result:** [pending]

### Step 4. Save to Desktop + success status
- **Action:** Accept the default name; save to Desktop.
- **Expected:** Dialog closes. Settings shows green/neutral helper text reading exactly `Saved to /Users/<you>/Desktop/sei-export-<date>.json`.
- **result:** [pending]

### Step 5. CRITICAL — D-14 schema-lock invariant
- **Action:** Open the saved file in a text editor.
- **Expected:** Pretty-printed JSON (2-space indent). EXACTLY these 5 top-level keys, in this order: `schemaVersion: 1`, `exportedAt: <ISO timestamp>`, `account: { email: <your email>, createdAt: <ISO> }`, `characters: []`, `sharing: []`.
  - If `characters` or `sharing` is MISSING — FAIL the entire UAT. D-14 says the schema MUST be locked NOW; Phase 11 fills characters, Phase 12 fills sharing, neither bumps schemaVersion.
  - `account.email` matches the signed-in user's email exactly.
- **result:** [pending]

### Step 6. Cancel silently
- **Action:** Re-click `Export as JSON` → click Cancel in the dialog.
- **Expected:** No error appears in Settings. The previous "Saved to…" helper text either persists or is cleared (UI choice; either is acceptable as long as no error is shown).
- **result:** [pending]

### Step 7. Read-only path → write_failed error
- **Action:** Re-click `Export as JSON` → navigate to a read-only path (e.g. `/Library/Apple/foo.json` on macOS without sudo, or any path you don't have write access to) → save.
- **Expected:** Settings shows red helper text reading exactly `Couldn't prepare your export. Try again in a moment.`
- **result:** [pending]

### Step 8. Defensive sign-out invariant
- **Action:** Sign out → confirm ACCOUNT panel disappears from Settings (Export button is now unreachable).
- **Expected:** The Export button is GONE because the entire ACCOUNT panel is gated on `authState.kind === 'signed_in'`. (Defensive secondary: the IPC handler also returns `{ok:false, code:'write_failed', message:'Not signed in'}` if invoked while signed out, but you can't trigger that path from the UI directly without DevTools.)
- **result:** [pending]

## Resume signal

Once all 8 steps show `result: [pass]`, reply `approved`.

If step 5 fails, it's a CRITICAL D-14 violation — file an immediate Rule-1 fix and block phase-10 close.

---

*Tracked: AUTH-07 (export cloud data as versioned JSON) + D-14 (schemaVersion=1 locked; characters[], sharing[] empty-but-present)*
*Owner: phase-10 gap-closure / `/gsd-verify-work 10`*
*Last updated: 2026-05-20*
