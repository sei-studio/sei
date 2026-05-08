---
phase: 04-electron-gui-packaging
plan: 09
subsystem: error-narration
tags: [error-mapping, gui-05, banner, classifier]
requires:
  - .planning/phases/04-electron-gui-packaging/04-02-SUMMARY.md  # ErrorClass union
  - .planning/phases/04-electron-gui-packaging/04-04-SUMMARY.md  # botSupervisor surface
  - .planning/phases/04-electron-gui-packaging/04-07-SUMMARY.md  # OnboardingScreen
  - .planning/phases/04-electron-gui-packaging/04-08-SUMMARY.md  # CharacterPage
provides:
  - ERROR_COPY (renderer)
  - classifyRendererError
  - Banner component
  - classifyChildError (main)
  - app:warnings IPC channel
affects:
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/screens/OnboardingScreen.tsx
  - src/renderer/src/App.tsx
  - src/main/botSupervisor.ts
  - src/main/ipc.ts
  - src/preload/index.ts
  - src/shared/ipc.ts
tech-stack:
  added: []
  patterns:
    - centralized error-copy lookup table (Record<ErrorClass,string>)
    - keyword-heuristic error classifier (mirrors humanizeReason from connect.js)
    - one-shot startup-warnings IPC query for platform-specific advisories
key-files:
  created:
    - src/renderer/src/lib/errors.ts
    - src/renderer/src/components/Banner.tsx
    - src/renderer/src/components/Banner.module.css
  modified:
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/main/botSupervisor.ts
    - src/preload/index.ts
    - src/renderer/src/App.tsx
    - src/renderer/src/screens/CharacterPage.tsx
    - src/renderer/src/screens/OnboardingScreen.tsx
decisions:
  - Two parallel classifiers (renderer + main) with the same regex table; if one is updated the other must be too — kept inline (not hoisted to shared/) because the renderer cannot import main-only types and the lookup is small.
  - INVALID_API_KEY regex extended with `authentication_error` after smoke-test (Anthropic SDK error.message format).
  - Banner placed inside MacosWindow via a flex-column wrapper so the existing IconRail|main row layout is preserved.
  - Startup warnings exposed via a dedicated `app:warnings` IPC handle (not piggybacked on bot:status) — they are platform advisories, not bot lifecycle events.
metrics:
  duration: ~25min
  completed: 2026-05-08
requirements:
  - GUI-05
---

# Phase 04 Plan 09: Error Mapping Summary

Centralized GUI-05 plain-English error narration. Renderer error display sites no longer surface raw `(err as Error).message` — they look up `ERROR_COPY[ErrorClass]`. Main's `botSupervisor` classifies raw child / dependency errors (loadApiKey, child error, child exit) into structured `ErrorClass` values before forwarding to the renderer, so the UI always sees a known class and the matching plain-English copy.

## Tasks completed

| Task | Name                                                                                       | Commit  |
| ---- | ------------------------------------------------------------------------------------------ | ------- |
| 1    | Create `src/renderer/src/lib/errors.ts` + `Banner` component                               | 927064e |
| 2    | Wire `ERROR_COPY` into OnboardingScreen + CharacterPage; KEYCHAIN_FALLBACK_PLAINTEXT banner in App.tsx | 179911e |
| 3    | Extend `botSupervisor.ts` with `classifyChildError`                                        | 00af02d |

## What changed (boundary-by-boundary)

### Renderer
- `OnboardingScreen` step-4 catch block now calls `classifyRendererError(err)` and stores `result.copy` in the inline error state. Previously stored `(err as Error).message`.
- `CharacterPage` model row label uses `ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH` when `summon.kind === 'error'`. Previously rendered `summon.message`.
- `App.tsx` calls `sei.getStartupWarnings()` during bootstrap; if `keychainFallbackPlaintext` is true, renders a top-of-window dismissible `Banner` with `ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT`. Dismissal is per-session (no persistence — fresh boot reshows).
- Layout: introduced a flex-column wrapper inside `MacosWindow` so the Banner stacks above the existing `IconRail | main` flex-row.

### IPC contract (shared)
- New type `StartupWarnings { keychainFallbackPlaintext: boolean }`.
- New `IpcChannel.app.warnings = 'app:warnings'`.
- New `RendererApi.getStartupWarnings(): Promise<StartupWarnings>`.

### Main
- `ipc.ts` registers handler returning `{ keychainFallbackPlaintext: process.platform === 'linux' && backendKind() === 'basic_text' }`.
- `botSupervisor.ts` adds `classifyChildError(err)` helper used at three failure sites:
  1. `loadApiKey()` catch in `_summon` → emits classified BotStatus before rethrowing.
  2. `child.on('error')` (rare UtilityProcess error event) → classified status + reject.
  3. `child.on('exit')` when `!summonResolved` → classified status (was untyped `BOT_CRASH`-by-implication; now explicit, and a future regex tweak can map signals more specifically).

### Preload
- Added `getStartupWarnings: () => ipcRenderer.invoke(IpcChannel.app.warnings)`.

## ERROR_COPY coverage

All 10 ErrorClass variants seeded with verbatim UI-SPEC copy:
- BOT_START_TIMEOUT, LAN_NOT_OPEN, INVALID_API_KEY, RATE_LIMITED, NETWORK_OFFLINE, BOT_CRASH, LAN_UNAVAILABLE, KEYCHAIN_LOCKED, KEYCHAIN_FALLBACK_PLAINTEXT, NATIVE_MODULE_MISMATCH.

## Manual smoke test — Anthropic 401 (per WARNING-10 / Plan §manual_smoke_test)

The plan mandates capturing the real Anthropic 401 wire shape and confirming the `classifyChildError` regex matches it. Because Electron cannot launch in the parallel-execution worktree (no display, would require GUI session), the smoke test was performed by invoking the Anthropic SDK directly with `apiKey: 'sk-fake-key-clearly-invalid'` — the same SDK the bot uses (`@anthropic-ai/sdk` via `src/bot/brain/anthropicClient.js`). This captures the identical error string the bot would surface in `BotLifecycle.error.message`.

**Captured raw error string (verbatim, from `err.message`):**

```
401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011Caqg4chfTv1XXDfvnRKVA"}
```

Additional captured metadata:
- `err.constructor.name` → `AuthenticationError`
- `err.status` → `401`
- `err.error` → `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},...}`

**Classifier verification:** running the captured string through `classifyChildError(captured)` returned `'INVALID_API_KEY'` (confirmed via standalone node script — the regex matches multiple alternations in the string: `401`, `x-api-key`, and `authentication_error`).

**Regex tweak applied during this plan:** the original regex `/invalid.*api.*key|401|unauthorized|x-api-key/i` already matched the captured string, but as a forward-compat hardening I extended it with `|authentication_error` so the SDK's structured body field (`error.type === 'authentication_error'`) keeps matching even if Anthropic ever drops the leading `401` prefix or the `x-api-key` mention from the message. Renderer-side `classifyRendererError` was left at the original regex — it sees a different shape (post-IPC-serialized strings; structured BotStatus arrives pre-classified). If a future regression appears, mirror the change.

**Why this satisfies the smoke-test requirement:** the failure path the bot would hit in production is `start()` → `startBrain()` → first Haiku call → SDK throws `AuthenticationError`. The bot's `bootstrapWithInit` catch already extracts `err.message` (line 203 of `src/bot/index.js`) and forwards it as `BotLifecycle.error.message`. `botSupervisor`'s `port1.on('message')` handler does NOT re-classify pre-classified bot-side errors (per plan), so the bot itself emits `error: 'BOT_CRASH'` today (it has no classifier). The renderer receives the BotStatus and looks up `ERROR_COPY[summon.error]`. Plan 09's contract is that **whenever main classifies (loadApiKey, child error, child exit)**, the regex correctly maps the wire format. The smoke test confirms this.

**Production path note for plan 11 / future plan:** bot-side `bootstrapWithInit` currently hardcodes `error: 'BOT_CRASH'` for any `start()` failure. To make the renderer show INVALID_API_KEY copy for Anthropic 401s (the most common failure mode), the bot itself needs a small classifier mirroring `classifyChildError`. This is out of scope for plan 09 (which targets main + renderer) but worth a deferred-items note.

## Verified end-to-end (static)

| Scenario                                                  | Path                                         | Status                                                                              |
| --------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Onboarding step-4 IPC failure → ERROR_COPY copy           | classifyRendererError(err).copy              | wired (grep + tsc)                                                                  |
| CharacterPage model row error → ERROR_COPY[summon.error]  | model row label                              | wired (grep + tsc)                                                                  |
| Linux basic_text safeStorage → KEYCHAIN_FALLBACK_PLAINTEXT banner | app:warnings IPC + Banner            | wired (grep + tsc); needs Linux box for live render verification                    |
| loadApiKey throws → classified BotStatus before rethrow   | botSupervisor `_summon`                      | code path inspected; tsc clean                                                      |
| child.on('error') → classified BotStatus                  | botSupervisor                                | code path added; tsc clean (utilityProcess rarely emits 'error' on darwin/linux)    |
| child.on('exit') without summon-ready → classified status | botSupervisor                                | code path updated; tsc clean                                                        |
| Anthropic 401 error string matches INVALID_API_KEY regex  | classifyChildError                           | **smoke-tested** — see Manual Smoke Test section above                              |

## Notes for plan 11 (clean-VM smoke)

- KEYCHAIN_LOCKED requires actual macOS Keychain lockout — typically only reproduces after the user explicitly denies access; not easily triggered in CI. Recommend verifying the copy renders correctly via DevTools `setState` test (manually set `summon` to `{kind:'error', error:'KEYCHAIN_LOCKED', characterId:'sui'}` in useDataStore and confirm the model row shows the keychain copy).
- KEYCHAIN_FALLBACK_PLAINTEXT banner only appears on Linux without a desktop secret store — no-op on macOS / Windows.
- INVALID_API_KEY copy was end-to-end smoke-tested against the captured `sk-fake-key` string at the classifier boundary; full UI confirmation deferred to plan 11 with a real Electron window.
- Bot-side classification gap (see "Production path note" above): plan-09-deferred. The bot's `bootstrapWithInit` always emits `error: 'BOT_CRASH'`. Either give the bot its own classifier or have `botSupervisor` re-classify lifecycle messages of type `error` (currently passes through unchanged per plan).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Layout] Wrap MacosWindow children in flex-column for Banner placement**
- **Found during:** Task 2
- **Issue:** `MacosWindow.module.css` `.body` is `display:flex` (row) — adding `<Banner>` as a direct child of `MacosWindow` would put it side-by-side with `IconRail`, not above. Plan said "above the IconRail+main flex row" but didn't account for MacosWindow's row-flex body.
- **Fix:** Wrapped the children in a `<div style={{display:'flex',flexDirection:'column',...}}>` inside MacosWindow; Banner stacks above the inner row. No CSS changes required, no other component affected.
- **Files modified:** `src/renderer/src/App.tsx`
- **Commit:** 179911e

**2. [Rule 2 - Robustness] Extend INVALID_API_KEY regex with `authentication_error`**
- **Found during:** Task 3 manual smoke test
- **Issue:** Plan §manual_smoke_test mandates extending the regex if the captured Anthropic 401 string doesn't match. The original `/invalid.*api.*key|401|unauthorized|x-api-key/i` already matches today's wire format (multiple alternations hit), but forward-compat hardening is cheap.
- **Fix:** Added `|authentication_error` alternation to the main-side regex (renderer regex left as-is per scope — it sees post-IPC-serialized strings, not raw SDK errors).
- **Files modified:** `src/main/botSupervisor.ts`
- **Commit:** 00af02d (folded into the same task commit)

### Out of scope (deferred)

- Bot-side classifier in `src/bot/index.js` `bootstrapWithInit` — see "Production path note" above. Logged here for plan-09-deferred / future plan, not added to `deferred-items.md` because the plan's scope is explicitly main + renderer.

## Threat surface notes

Per plan's threat model:
- T-04-38 (info disclosure of API key fragment via error message) — mitigated. `classifyChildError` discards the raw message except for the BOT_CRASH fallback path; ERROR_COPY['BOT_CRASH'] is generic ("Sei stopped unexpectedly. Press Summon to restart."), so even the fallback never echoes API key bytes.
- T-04-39 (spoofing via fake ErrorClass over MessagePort) — accepted; bot-emitted lifecycle errors pass through `botSupervisor`'s `lifecycleToStatus` unchanged. Bot is our own code; the only untrusted content is the `message` string, which the renderer never displays directly anymore (it shows ERROR_COPY[error] keyed off the typed ErrorClass).

## Self-Check: PASSED

Verified files exist:
- FOUND: src/renderer/src/lib/errors.ts
- FOUND: src/renderer/src/components/Banner.tsx
- FOUND: src/renderer/src/components/Banner.module.css

Verified commits exist:
- FOUND: 927064e (Task 1)
- FOUND: 179911e (Task 2)
- FOUND: 00af02d (Task 3)

Verified tsc:
- tsconfig.web.json — 0 errors (excluding CSS module shim noise)
- tsconfig.node.json — 0 errors (excluding bot/ JS imports)
