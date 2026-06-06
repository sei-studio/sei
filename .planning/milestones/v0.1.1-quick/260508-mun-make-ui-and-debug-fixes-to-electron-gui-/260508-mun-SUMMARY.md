---
quick_id: 260508-mun
phase: quick
mode: quick
tags: [electron, gui, bug-fix, ui-polish, summon, utility-process]
key-files:
  created:
    - src/renderer/src/components/EditCharacterModal.tsx
    - src/renderer/src/components/EditCharacterModal.module.css
    - src/renderer/src/components/LogsBar.tsx
    - src/renderer/src/components/LogsBar.module.css
  modified:
    - src/renderer/src/App.tsx
    - src/renderer/src/screens/SettingsScreen.tsx
    - src/renderer/src/screens/SettingsScreen.module.css
    - src/renderer/src/screens/CharacterPage.tsx
    - src/renderer/src/components/CharacterCard.tsx
    - src/renderer/src/styles/global.css
    - src/main/botSupervisor.ts
    - src/bot/index.js
decisions:
  - In dev mode, fork bot from src/bot/index.js (two levels up from __dirname=dist/main) instead of dist/bot/index.js, because electron-vite does NOT bundle the bot into dist.
  - Mirror bot stdout/stderr to the Electron-main terminal AND keep a 4KB rolling tail per stream, so exit-before-ready surfaces actionable text in BotStatus.message rather than the bare exit code.
  - Wrap process.parentPort dispatch in try/catch + install uncaughtException/unhandledRejection hooks in src/bot/index.js with a 50ms grace exit so lifecycle 'error' messages reach port1 before the process tears down.
  - Settings inline-edit uses on-blur saveConfig (no debounce) — simplest commit point.
  - CharacterPage Edit button uses the literal label 'Edit' (not 'Edit persona') and is OMITTED for Sui (id==='sui'), not just disabled.
metrics:
  duration_minutes: ~25
  completed: 2026-05-08
status: 4-of-5-complete (Task 5 = human-verify checkpoint, deferred per plan)
---

# Quick Task 260508-mun: Electron GUI UI fixes + bot:summon regression Summary

Bundle of 10 UX polish items + 1 utilityProcess regression fix for the Electron GUI shipped in Phase 4. Each item maps to a numbered request from the user. Tasks 1–4 are committed code changes; Task 5 is the blocking human-verify checkpoint where the user walks the dev build to confirm visual + end-to-end Summon behavior.

## Items shipped

### Task 1 — commit `8d2b29f`

**Item 1: Hide IconRail during onboarding.** `App.tsx` now gates `<IconRail />` on `view.kind !== 'onboarding'`. Onboarding cannot be abandoned via the sidebar.

**Item 7: Settings inline editing.** `SettingsScreen.tsx` rewrites the ACCOUNT section. Minecraft username + Preferred name are now `<TextField />` inputs that on-blur call `sei.saveConfig`. The API key row keeps the bullet placeholder when present and exposes an `Update` (or `Set` if not yet present) ghost button which reveals a password `<TextField />` + Save / Cancel; Save calls `sei.saveApiKey`, re-checks `hasApiKey()`, and collapses the editor. Provider stays read-only ("Anthropic"). The previous `SETUP / Re-run onboarding / Start over` row is removed.

**Item 8: Left-align Back button.** `SettingsScreen.module.css` adds `.backRow { align-self: flex-start; }` and the JSX wraps the Back `<Button>` in `<div className={styles.backRow}>`. The button no longer stretches to the column width / centers its label.

### Task 2 — commit `5789328`

**Items 2 + 3: Sui has no edit affordance + drop tabs.** `CharacterPage.tsx` removes the `tab` state, the Persona prompt and Logs tab buttons, the `expandedPersona` state, the `tab === 'persona'` and `tab === 'logs'` render branches, and the `LogsPanel` import. Description card is the only middle-column content. The `Edit` ghost button is rendered ONLY when `!isDefault` (i.e., NOT for `sui`). Delete already had this gate.

**Item 4: Edit modal.** New `EditCharacterModal.tsx` (+ `.module.css`). Backdrop pattern lifted from `LanModal` / `DeleteConfirmModal`: ESC + scrim click close, `aria-modal="true"`. Three fields — name (TextField), description (multiline TextField, 3 rows), persona prompt (multiline monospace TextField, 12 rows). Validates non-empty trimmed name and persona prompt. On Save calls `sei.saveCharacter(...)` then `useDataStore.getState().refreshCharacter(id)` then `onClose()`. Errors render inline.

**Item 6: Dedupe card name.** `CharacterCard.tsx` removes the sans-serif `<div className={styles.infoName}>{c.name}</div>` from the bottom info row. The pixel-font name overlay on the portrait remains. The info row now shows only the meta line ("Last: …" or "Never summoned") + the chevron.

### Task 3 — commit `6d48778`

**Item 5: Bottom collapsible LogsBar.** New `LogsBar.tsx` (+ `.module.css`). Collapsed = 30px header with the `LOGS` label, a truncated preview of the last log message, and a chevron-up. Click toggles the open state. Open = same header (chevron-down) + a 280px `<LogsPanel />` body. Subscribes only to a primitive `string` selector for the preview line so it doesn't churn on every store delta. Wired in `App.tsx` as a sibling AFTER the IconRail+main flex row, inside the same column wrapper. Hidden during `onboarding` and `loading` views.

**Item 10: Subtle wave gradient.** `global.css` `body::before` now stacks the existing two radial-gradient layers PLUS a tiny 240×80 SVG data-URL with two sine paths. Light theme uses black strokes at opacity 0.030–0.045; dark theme uses white strokes at opacity 0.030–0.045. `pointer-events: none` preserved.

### Task 4 — commit `17f3e48`

**Item 9: bot:summon regression.** Root-caused, fixed, and hardened. See dedicated section below.

### Task 5 — human-verify checkpoint (NOT executed by this run)

The plan's Task 5 is a `checkpoint:human-verify` gate — verification of all 10 items, including end-to-end Summon against a live LAN-open Minecraft world, is the user's responsibility. The executor environment for this run has no display server and no Minecraft instance, so visual UI verification and the live-world Summon test were not performed here. They are pending the user's walkthrough per the plan's "How to verify" section.

## Item 9 — bot:summon root cause + fix

### Symptom (verbatim from the user)

```
Error occurred in handler for 'bot:summon': Error: Bot exited before summon-ready (code=1)
    at ForkUtilityProcess.<anonymous> (file:///Users/ouen/slop/sei/dist/main/index.js:693:22)
```

### Diagnostic evidence

Filesystem inspection on the worktree confirmed the root cause without needing a live repro:

```
$ ls /Users/ouen/slop/sei/.claude/worktrees/agent-ab2ad0455444b7ef1/dist
ls: ...dist: No such file or directory          # before build

$ npm run build
... ✓ built in 56ms
... ✓ built in 5ms
... ✓ built in 306ms

$ ls .../dist
main  preload  renderer                         # NO bot/

$ node -e "const p=require('path'); console.log(p.join('/Users/ouen/slop/sei/dist/main', '../bot/index.js'))"
/Users/ouen/slop/sei/dist/bot/index.js          # what botEntryPath() returns in dev
```

### Root cause (plain English)

`botSupervisor.ts:botEntryPath()` in dev mode returned `path.join(__dirname, '../bot/index.js')`. From the bundled main's `__dirname` (`<repo>/dist/main`), this resolves to `<repo>/dist/bot/index.js`. But `electron.vite.config.ts` only declares `main`, `preload`, and `renderer` build entries — `src/bot/**` is never bundled into `dist/`. So the supervisor was telling `utilityProcess.fork` to load a path that **does not exist**. The child process failed module resolution immediately, exited with code 1, and the supervisor's `child.on('exit')` fired before any `summon-ready` lifecycle message could arrive — surfacing the generic "Bot exited before summon-ready (code=1)" error.

This is a regression introduced when Phase 4 split the bot out of the main bundle. The packaged-app branch (`app.isPackaged → app.asar.unpacked/src/bot/index.js`) was correct because electron-builder's `asarUnpack` config handles that path; only the dev path was broken.

### Fix

```ts
// src/main/botSupervisor.ts
function botEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'src/bot/index.js');
  }
  // CHANGED: was '../bot/index.js' (dist/bot/index.js — never built).
  return path.join(__dirname, '../../src/bot/index.js');
}
```

Verified: `path.join('/Users/ouen/slop/sei/dist/main', '../../src/bot/index.js')` → `/Users/ouen/slop/sei/src/bot/index.js`, which exists.

### Hardening (independent of root cause)

So a future regression of this shape doesn't surface as a useless generic message:

1. **stdout/stderr mirroring + tail buffer (`botSupervisor.ts`).** The `sink()` for child output now (a) mirrors every chunk to the parent terminal via `console.log` / `console.error` with a `[bot-stdout]` / `[bot-stderr]` prefix, and (b) keeps a 4KB rolling tail per stream.

2. **Stderr tail in BotStatus.message (`botSupervisor.ts`).** `child.on('exit', ...)` now appends the last 1KB of stderr (or stdout if stderr is empty) to the message field. The renderer's Banner / model row will show the actual crash trace, not just the exit code. The classifier still runs against the combined message so future regex hits can promote `BOT_CRASH` to a more specific `ErrorClass`.

3. **parentPort try/catch + crash hooks (`bot/index.js`).** The Electron-path message dispatch is wrapped in try/catch. `process.on('uncaughtException')` and `process.on('unhandledRejection')` install last-resort handlers. All three call `surfaceCrash(label, err)`, which writes the trace to stderr, emits a `{type:'error', error:'BOT_CRASH', message:...}` lifecycle, and then `setTimeout(() => process.exit(1), 50)` so both the lifecycle postMessage and the stderr buffer flush before the utilityProcess tears down.

## Build status

`npm run build` succeeds for all four task commits:

```
dist/main/index.js  27.66 kB
dist/preload/index.cjs  2.07 kB
dist/renderer/index.html  0.39 kB
dist/renderer/assets/index-*.css  ~37 kB
dist/renderer/assets/index-*.js  ~648 kB
```

## Self-Check

Files created — present:
- src/renderer/src/components/EditCharacterModal.tsx — FOUND
- src/renderer/src/components/EditCharacterModal.module.css — FOUND
- src/renderer/src/components/LogsBar.tsx — FOUND
- src/renderer/src/components/LogsBar.module.css — FOUND

Commits — present in `git log`:
- 8d2b29f — FOUND
- 5789328 — FOUND
- 6d48778 — FOUND
- 17f3e48 — FOUND

## Self-Check: PASSED

## Deferred / Surprises

- **Visual UI verification** for items 1–8, 10 was not performed in this executor environment — no display, no interactive Electron window. Plan's Task 5 (human-verify) covers it.
- **Live-world Summon verification** (item 9) was not performed in this executor environment — no Minecraft instance / LAN world available. The fix is verified by static analysis (path math + filesystem check) plus the hardening that surfaces any remaining failure-modes with actionable text. Pending Task 5.
- **Old `.tabs` / `.tab*` CSS classes** in `CharacterPage.module.css` are now unused but were intentionally left in place to keep churn small (per the plan's "Do NOT delete .infoName from the CSS (harmless)" guidance — same principle).
- **`SettingsScreen` `BlurCommit` first draft** was discarded in favor of relying on React's bubbling `onBlur` directly on the `.row` div (cleaner and handler-driven) — final code matches the plan's recommended pattern.

## Deviations from Plan

None — plan executed as written. Auto-fix rules (1/2/3) were not triggered; no bugs, missing-critical-functionality, or blockers surfaced beyond the diagnosed bot:summon regression which IS the plan's Task 4 work.
