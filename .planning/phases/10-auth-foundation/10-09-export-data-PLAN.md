---
phase: 10
plan: 09
type: execute
wave: 5
depends_on: [10-03, 10-04, 10-07]
files_modified:
  - src/main/auth/exportBuilder.ts
  - src/main/auth/exportBuilder.test.ts
  - src/main/auth/authHandlers.ts
autonomous: false
requirements: [AUTH-07]
requirements_addressed: [AUTH-07]
tags: [gdpr, export, json, dialog]
must_haves:
  truths:
    - "exportData returns {ok:true, savedPath} after writing a sei-export-YYYY-MM-DD.json file via electron.dialog.showSaveDialog; user-cancelled save returns {ok:false, code:'cancelled', message:'Cancelled'} (AUTH-07)"
    - "JSON envelope strictly follows schemaVersion=1 contract (D-14): { schemaVersion:1, exportedAt:ISO, account:{email,createdAt}, characters:[], sharing:[] } — characters/sharing are empty arrays in Phase 10 but the KEYS MUST exist (load-bearing for Phase 11/12 forward-compat)"
    - "buildExport(session) is a pure function (no fs/dialog calls) — tested in isolation with stubbed Session shape"
    - "Default suggested filename is sei-export-<ISO YYYY-MM-DD>.json using local-machine date"
    - "Per CLAUDE.md, the save+write is wrapped in a 15s timeout so a stuck filesystem doesn't hang IPC; on timeout returns {ok:false, code:'write_failed', message:'Save timed out'}"
  artifacts:
    - path: "src/main/auth/exportBuilder.ts"
      provides: "buildExport(session) pure function returning SeiExportV1 + the TypeScript interface for Phase 11/12 consumers to extend"
      exports: ["buildExport", "type SeiExportV1"]
    - path: "src/main/auth/authHandlers.ts"
      provides: "Implemented exportData body (replaces plan 03 shell) — fetches session, calls buildExport, prompts save dialog, writes file"
      contains: "buildExport"
  key_links:
    - from: "src/main/auth/authHandlers.ts (exportData)"
      to: "electron.dialog.showSaveDialog"
      via: "dialog.showSaveDialog({defaultPath: 'sei-export-<YYYY-MM-DD>.json'})"
      pattern: "showSaveDialog"
    - from: "src/main/auth/authHandlers.ts (exportData)"
      to: "src/main/auth/exportBuilder.ts (buildExport)"
      via: "buildExport(session)"
      pattern: "buildExport"
---

<objective>
Ship AUTH-07: a signed-in user can export their cloud data as a versioned JSON file. Phase 10 fills only the `account` key (characters/sharing are intentionally empty arrays so the SCHEMA is locked NOW — Phase 11 fills characters, Phase 12 fills sharing).

1. `src/main/auth/exportBuilder.ts` — pure function `buildExport(session)` + exported `SeiExportV1` type. Empty-but-present keys for characters/sharing.
2. `src/main/auth/authHandlers.ts` — implement `exportData` handler: pull current session → buildExport → showSaveDialog with `sei-export-<YYYY-MM-DD>.json` default → writeFile → return {ok:true, savedPath}.
3. Tests for buildExport (schema shape; date formatting; missing email default).

Purpose: AUTH-07 ships; the schemaVersion=1 contract is locked (D-14) so Phase 11/12 can append data without designing a new format.

Output: One pure module + tests, one handler body.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/10-auth-foundation/10-CONTEXT.md
@.planning/phases/10-auth-foundation/10-RESEARCH.md
@.planning/phases/10-auth-foundation/10-UI-SPEC.md
@CLAUDE.md
@src/main/auth/authHandlers.ts
@src/main/auth/supabaseClient.ts
@src/renderer/src/screens/SettingsScreen.tsx
@.planning/phases/10-auth-foundation/10-03-SUMMARY.md
@.planning/phases/10-auth-foundation/10-07-SUMMARY.md

<interfaces>
<!-- D-14 locked schema (CONTEXT + RESEARCH): -->
```typescript
export interface SeiExportV1 {
  schemaVersion: 1;
  exportedAt: string;                // ISO 8601
  account: { email: string; createdAt: string };
  characters: unknown[];             // Phase 10 empty []; Phase 11 fills
  sharing: unknown[];                // Phase 10 empty []; Phase 12 fills
}
```

<!-- Supabase Session shape (from @supabase/supabase-js): -->
interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string | null; created_at: string; ... };
  ...
}

<!-- electron.dialog.showSaveDialog result shape: -->
interface SaveDialogReturnValue {
  canceled: boolean;
  filePath?: string;
}
</interfaces>
</context>

<read_first>
- `src/main/auth/authHandlers.ts` (plan 03 exportData shell)
- `src/main/auth/supabaseClient.ts` (getClient — to fetch the current session)
- `src/renderer/src/screens/SettingsScreen.tsx` (plan 07 — onExport handler already wired to sei.exportData)
- `.planning/phases/10-auth-foundation/10-RESEARCH.md` §Export envelope builder (lines 734–763 — verbatim code template) + §Standard Stack (electron.dialog.showSaveDialog)
- `.planning/phases/10-auth-foundation/10-CONTEXT.md` D-14 (schema contract)
- `.planning/phases/10-auth-foundation/10-UI-SPEC.md` §Account panel + §Empty/Error/Loading states (export error copy)
</read_first>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: buildExport pure function + SeiExportV1 type + tests</name>
  <files>src/main/auth/exportBuilder.ts, src/main/auth/exportBuilder.test.ts</files>
  <read_first>
    - .planning/phases/10-auth-foundation/10-RESEARCH.md §Export envelope builder (full code template)
    - .planning/phases/10-auth-foundation/10-CONTEXT.md D-14
  </read_first>
  <behavior>
    - SeiExportV1 interface exported with EXACTLY 5 keys: schemaVersion (literal 1), exportedAt (string), account (object with email + createdAt), characters (unknown[]), sharing (unknown[]).
    - buildExport(session) takes a Supabase Session-shaped object, returns SeiExportV1 with:
        - schemaVersion: 1
        - exportedAt: new Date().toISOString()
        - account.email: session.user.email ?? ''
        - account.createdAt: session.user.created_at
        - characters: []
        - sharing: []
    - The function is pure (no fs, no fetch, no dialog) — testable in isolation.
    - Tests (vitest, 5 cases):
      1. With a Session-shaped stub containing email and created_at, the returned object has the locked schemaVersion=1 and the 5 keys in the documented shape.
      2. Email null in session.user → account.email is ''.
      3. characters and sharing keys are PRESENT and equal to empty arrays (load-bearing for downstream-phase compatibility).
      4. exportedAt is a valid ISO timestamp parsable by Date.parse().
      5. The object's own enumerable keys are exactly ['schemaVersion','exportedAt','account','characters','sharing'] — no extras (Object.keys assertion).
  </behavior>
  <action>
1. Create `src/main/auth/exportBuilder.ts`:

```typescript
/**
 * Phase 10 — Export envelope builder (AUTH-07).
 *
 * Pure function. Schema is LOCKED at v1 per CONTEXT D-14:
 *   - Phase 10 fills `account` only.
 *   - Phase 11 fills `characters` (cloud character definitions).
 *   - Phase 12 fills `sharing` (public listings the user has published).
 *
 * The EMPTY-BUT-PRESENT contract for `characters` and `sharing` is
 * load-bearing — Phase 11/12 must NOT bump the schemaVersion just because
 * they add data to existing keys. Documented in this file + the type comment.
 *
 * Source: 10-CONTEXT D-14 (schema contract) + 10-RESEARCH §Export envelope.
 */
import type { Session } from '@supabase/supabase-js';

/**
 * v1 export schema. ALL FIVE KEYS are part of the contract; downstream
 * phases REPLACE the values of `characters` and `sharing` with non-empty
 * arrays but MUST NOT remove the keys or invent new top-level keys.
 *
 * When the schema needs to evolve beyond v1, bump schemaVersion to 2 (or
 * add an optional v2-only top-level key) and document a migration in the
 * downstream phase's RESEARCH.
 */
export interface SeiExportV1 {
  schemaVersion: 1;
  exportedAt: string;        // ISO 8601 timestamp of export
  account: {
    email: string;            // empty string if Supabase returned null
    createdAt: string;        // Supabase auth.users.created_at (ISO)
  };
  characters: unknown[];      // Phase 11: filled with cloud character defs
  sharing: unknown[];         // Phase 12: filled with public listings
}

export function buildExport(session: Session): SeiExportV1 {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      email: session.user.email ?? '',
      createdAt: session.user.created_at,
    },
    characters: [],
    sharing: [],
  };
}
```

2. Create `src/main/auth/exportBuilder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildExport, type SeiExportV1 } from './exportBuilder';

function makeSession(overrides: Partial<{ email: string | null; created_at: string }> = {}): any {
  return {
    access_token: 'jwt',
    refresh_token: 'rt',
    user: {
      id: 'user-uuid',
      email: overrides.email !== undefined ? overrides.email : 'test@example.com',
      created_at: overrides.created_at ?? '2026-05-19T00:00:00.000Z',
    },
  };
}

describe('buildExport', () => {
  it('builds a v1 envelope with the locked schemaVersion and 5 keys', () => {
    const out = buildExport(makeSession());
    expect(out.schemaVersion).toBe(1);
    expect(out.account.email).toBe('test@example.com');
    expect(out.account.createdAt).toBe('2026-05-19T00:00:00.000Z');
  });

  it('coerces a null email to empty string', () => {
    const out = buildExport(makeSession({ email: null }));
    expect(out.account.email).toBe('');
  });

  it('characters and sharing are present as empty arrays (load-bearing for forward-compat)', () => {
    const out = buildExport(makeSession());
    expect(out.characters).toEqual([]);
    expect(out.sharing).toEqual([]);
  });

  it('exportedAt is a valid ISO timestamp', () => {
    const out = buildExport(makeSession());
    expect(Number.isFinite(Date.parse(out.exportedAt))).toBe(true);
  });

  it('has exactly the 5 documented top-level keys (no extras, no missing)', () => {
    const out = buildExport(makeSession());
    expect(Object.keys(out).sort()).toEqual(
      ['account', 'characters', 'exportedAt', 'schemaVersion', 'sharing'].sort(),
    );
  });
});
```
  </action>
  <verify>
    <automated>grep -c "export interface SeiExportV1" src/main/auth/exportBuilder.ts | grep -q "^1$" && grep -c "schemaVersion: 1" src/main/auth/exportBuilder.ts | grep -qE "^[1-9]" && grep -c "export function buildExport" src/main/auth/exportBuilder.ts | grep -q "^1$" && grep -c "characters: \\[\\]" src/main/auth/exportBuilder.ts | grep -q "^1$" && grep -c "sharing: \\[\\]" src/main/auth/exportBuilder.ts | grep -q "^1$" && grep -c "email: session.user.email" src/main/auth/exportBuilder.ts | grep -q "^1$" && npx vitest run src/main/auth/exportBuilder.test.ts && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "export interface SeiExportV1" src/main/auth/exportBuilder.ts` equals 1
    - `grep -c "schemaVersion: 1" src/main/auth/exportBuilder.ts` >= 1
    - `grep -c "export function buildExport" src/main/auth/exportBuilder.ts` equals 1
    - `grep -cF "characters: []" src/main/auth/exportBuilder.ts` equals 1
    - `grep -cF "sharing: []" src/main/auth/exportBuilder.ts` equals 1
    - `grep -c "session.user.email" src/main/auth/exportBuilder.ts` equals 1
    - `grep -c "session.user.created_at" src/main/auth/exportBuilder.ts` equals 1
    - `grep -c "toISOString" src/main/auth/exportBuilder.ts` equals 1
    - `npx vitest run src/main/auth/exportBuilder.test.ts` exits 0 with 5 passing tests
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    buildExport is a pure function; SeiExportV1 type exported with the locked 5 keys; empty-but-present contract for characters/sharing documented and tested; 5 vitest cases pass.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Implement exportData handler — getSession → buildExport → showSaveDialog → writeFile</name>
  <files>src/main/auth/authHandlers.ts</files>
  <read_first>
    - src/main/auth/authHandlers.ts (plan 03 exportData shell — replace body)
    - src/main/auth/exportBuilder.ts (just created — buildExport import)
    - src/main/auth/supabaseClient.ts (getClient → getSession)
  </read_first>
  <behavior>
    - exportData:
      1. Pull current session via getClient().auth.getSession(); if error or null → {ok:false, code:'write_failed', message:'Not signed in'}.
      2. Build envelope via buildExport(session).
      3. Compute default filename `sei-export-${YYYY-MM-DD}.json` (local-machine date: `new Date().toISOString().slice(0,10)`).
      4. Get the main BrowserWindow handle (need a way to pass it — the simplest: use `BrowserWindow.getFocusedWindow()` or `BrowserWindow.getAllWindows()[0]`. Or import the existing `mainWindow` reference — check src/main/index.ts for how it's exported / whether there's a `getMainWindow()` helper).
      5. Call `dialog.showSaveDialog(mainWindow, { defaultPath, title: 'Save Sei data export', filters: [{ name: 'JSON', extensions: ['json'] }] })`.
      6. If result.canceled OR !result.filePath → return {ok:false, code:'cancelled', message:'Cancelled'}.
      7. fs.writeFile(result.filePath, JSON.stringify(envelope, null, 2), 'utf8') wrapped with 15s withTimeout — on timeout → {ok:false, code:'write_failed', message:'Save timed out'}.
      8. On write failure (EACCES, ENOSPC, etc.) → {ok:false, code:'write_failed', message: error.message}.
      9. On success → {ok:true, savedPath: result.filePath}.
    - The handler imports electron.dialog and BrowserWindow lazily inside the function so test environments without electron don't trip module-init.
  </behavior>
  <action>
Edit `src/main/auth/authHandlers.ts`. Replace the exportData body:

```typescript
// Add imports at the top of the file (with existing imports):
import { writeFile } from 'node:fs/promises';
import { buildExport } from './exportBuilder';

// Replace exportData body:
export async function exportData(): Promise<ExportDataResult> {
  const supabase = getClient();
  const { data: { session }, error: sessErr } = await supabase.auth.getSession();
  if (sessErr || !session) {
    return { ok: false, code: 'write_failed', message: 'Not signed in' };
  }

  const envelope = buildExport(session);

  // Lazy-import electron so test environments without electron can still
  // type-check this file. dialog + BrowserWindow are main-process-only.
  const { dialog, BrowserWindow } = await import('electron');
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const defaultPath = `sei-export-${today}.json`;

  const saveRes = win
    ? await dialog.showSaveDialog(win, {
        defaultPath,
        title: 'Save Sei data export',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
    : await dialog.showSaveDialog({
        defaultPath,
        title: 'Save Sei data export',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

  if (saveRes.canceled || !saveRes.filePath) {
    return { ok: false, code: 'cancelled', message: 'Cancelled' };
  }

  const filePath = saveRes.filePath;
  const json = JSON.stringify(envelope, null, 2);

  // CLAUDE.md: every external call has a timeout. Filesystem on a network
  // drive can hang; 15s wrap surfaces it as a clean error rather than freezing
  // the IPC channel.
  try {
    await withTimeout(
      writeFile(filePath, json, 'utf8'),
      15_000,
      () => { throw new Error('timeout'); },
    );
    return { ok: true, savedPath: filePath };
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'timeout') return { ok: false, code: 'write_failed', message: 'Save timed out' };
    return { ok: false, code: 'write_failed', message };
  }
}
```

Delete the `// IMPLEMENTED IN PLAN 10-09` comment.

NOTE on withTimeout: this helper was defined in plan 04 inside authHandlers.ts. Verify it's still present and exported (or in-file). If plan 04's version threw via the onTimeout callback, that's exactly what we want here.
  </action>
  <verify>
    <automated>! grep -q "IMPLEMENTED IN PLAN 10-09" src/main/auth/authHandlers.ts && grep -c "buildExport" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "showSaveDialog" src/main/auth/authHandlers.ts | grep -qE "^[1-9]" && grep -c "writeFile" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "sei-export-" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "withTimeout" src/main/auth/authHandlers.ts | grep -qE "^[3-9]" && grep -c "code: 'cancelled'" src/main/auth/authHandlers.ts | grep -q "^1$" && grep -c "code: 'write_failed'" src/main/auth/authHandlers.ts | grep -qE "^[2-9]" && npx tsc --noEmit</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "IMPLEMENTED IN PLAN 10-09" src/main/auth/authHandlers.ts` equals 0
    - `grep -c "buildExport" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "showSaveDialog" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "BrowserWindow" src/main/auth/authHandlers.ts` >= 1
    - `grep -c "writeFile" src/main/auth/authHandlers.ts` equals 1
    - `grep -cF "sei-export-" src/main/auth/authHandlers.ts` equals 1
    - `grep -cF ".json" src/main/auth/authHandlers.ts` >= 2 (defaultPath + filters extension)
    - `grep -c "withTimeout" src/main/auth/authHandlers.ts` >= 3 (signIn + signUp + export)
    - `grep -c "code: 'cancelled'" src/main/auth/authHandlers.ts` equals 1
    - `grep -c "code: 'write_failed'" src/main/auth/authHandlers.ts` >= 2 (not-signed-in + write-fail)
    - `grep -c "JSON.stringify(envelope" src/main/auth/authHandlers.ts` equals 1
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>
    exportData chains session → buildExport → showSaveDialog → writeFile with timeout; cancellation surfaces cleanly; SettingsScreen's onExport (plan 07) now produces a real file.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3 (checkpoint): Verify export flow + schema contract end-to-end</name>
  <files>none — human verification of prior code-producing tasks</files>
  <action>Perform the verification steps listed under <how-to-verify> below. The executor must NOT skip; this checkpoint gates the wave.</action>
  <verify>
    <automated>echo "human checkpoint — see how-to-verify below"; true</automated>
  </verify>
  <done>User has replied "approved" to the resume signal below.</done>
  <what-built>
    AUTH-07: signed-in user exports cloud data to a JSON file via a native save dialog. The schemaVersion=1 contract is locked.
  </what-built>
  <how-to-verify>
    1. Sign in to Sei with any test account.
    2. Settings → ACCOUNT panel → click `Export as JSON`.
    3. The native macOS / Windows / Linux save dialog opens. Default filename matches `sei-export-2026-05-19.json` (or today's date in YYYY-MM-DD).
    4. Save to your Desktop. The dialog closes; in Settings the helper text below the row reads `Saved to /Users/<you>/Desktop/sei-export-<date>.json`.
    5. Open the file in a text editor. Verify the JSON is pretty-printed (2-space indent) and contains EXACTLY these top-level keys:
       ```json
       {
         "schemaVersion": 1,
         "exportedAt": "2026-05-19T...Z",
         "account": { "email": "<your email>", "createdAt": "..." },
         "characters": [],
         "sharing": []
       }
       ```
       Confirm `characters: []` and `sharing: []` are PRESENT (D-14 empty-but-present invariant). If either key is missing, Phase 11/12 will have to bump schemaVersion — fail this checkpoint.
    6. Click `Export as JSON` again, then in the save dialog click `Cancel`. The dialog closes; in Settings NO error message appears (cancellation is silent). exportStatus state is null.
    7. Click `Export as JSON` again, then in the save dialog try to save to a read-only path (e.g. `/Library/Apple/foo.json` on macOS without sudo). The write fails; in Settings the helper text below the row turns red and reads `Couldn't prepare your export. Try again in a moment.` (or similar — plan 07 maps the error code generically).
    8. Sign out → ACCOUNT panel disappears → Export button is no longer reachable. Plan 09 invariant: exportData is only callable while signed in (the handler returns {ok:false, code:'write_failed', message:'Not signed in'} if invoked otherwise).
  </how-to-verify>
  <resume-signal>
    Reply `approved` if all 8 steps pass. If step 5's `characters` or `sharing` key is missing OR the schema includes extra keys, REJECT — the D-14 invariant is the entire point of plan 09.
  </resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Main → Disk | electron.dialog.showSaveDialog asks the user to pick the destination — no path traversal from the renderer. |
| Renderer → Main | exportData IPC is auth-state-aware; rejects when not signed_in (no PII leak in local mode). |
| Schema lock | schemaVersion=1 is the contract for ALL future versions of the file format. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-10-09-01 | Information Disclosure | Export JSON contains PII (email, createdAt) at a user-chosen location | accept | User explicitly chose to export; user explicitly chose the save path. AUTH-07 IS this behavior. |
| T-10-09-02 | Tampering | Renderer fakes exportData to write arbitrary files | mitigate | The handler uses dialog.showSaveDialog which prompts the user; no path comes from the renderer. The renderer's only input is the trigger (no arguments accepted at the IPC layer per plan 03). |
| T-10-09-03 | Denial of Service | Filesystem hangs (network drive offline) | mitigate | withTimeout(writeFile, 15s) returns {code:'write_failed', message:'Save timed out'}. IPC channel doesn't block indefinitely. |
| T-10-09-04 | Information Disclosure | Export JSON contains JWT or refresh token | mitigate | buildExport reads ONLY session.user.email and session.user.created_at — never access_token / refresh_token. Acceptance criterion + test #1 verify the schema shape. |
| T-10-09-05 | Tampering | Phase 11/12 silently bumps schemaVersion → existing exports become unreadable by external tools | mitigate | This plan documents the empty-but-present contract in code comments AND in the SUMMARY. Phase 11/12's SUMMARY must reference it. |
| T-10-09-06 | Spoofing | A different user's session is exported (race condition between sign-out and export) | accept | The handler calls getSession() at invoke time; if the user signed out between clicking Export and confirming the save dialog, the file still contains the correct (now-prior) account email. No security harm. |
</threat_model>

<verification>
1. `npx tsc --noEmit` exits 0.
2. `npx vitest run src/main/auth/exportBuilder.test.ts` — 5 tests pass.
3. Human checkpoint (Task 3) — all 8 steps pass; schema contract verified.
</verification>

<success_criteria>
- buildExport pure function returns SeiExportV1 with the 5 locked keys
- characters: [] and sharing: [] present (empty-but-present contract)
- exportData handler chains session → build → save dialog → file write with 15s timeout
- Cancellation returns {ok:false, code:'cancelled'} silently
- Write failure returns {ok:false, code:'write_failed', message}
- Filename matches sei-export-YYYY-MM-DD.json
- 5 buildExport tests pass; tsc clean
- Human-verified the schema contract on disk
</success_criteria>

<output>
After completion, create `.planning/phases/10-auth-foundation/10-09-SUMMARY.md` covering: the schemaVersion=1 lock (Phase 11/12 must NOT bump just to add data), the empty-but-present contract (characters/sharing keys ALWAYS present), and the default filename pattern (so external import tooling Phase 16 considers can pattern-match).
</output>
