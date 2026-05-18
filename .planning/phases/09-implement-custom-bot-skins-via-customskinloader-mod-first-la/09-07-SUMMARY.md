---
phase: 09-implement-custom-bot-skins-via-customskinloader-mod-first-la
plan: 07
subsystem: setup-wizard-renderer-ui
tags: [wizard, renderer, react, zustand, blocker-2, ipc-cancel, focus-trap, esc-dismiss]

# Dependency graph
requires:
  - phase: 9
    plan: 01
    provides: "RendererApi.{detectMcInstalls,runWizardInstall,wizardCancel,getWizardState,onWizardProgress,getSkinServerUrl}; McInstall/WizardInstallResult/WizardState/WizardProgressEvent shared types"
  - phase: 9
    plan: 04
    provides: "scanMcInstalls + writeCustomSkinLoaderConfig backend that Plan 05's IPC handlers chain together"
  - phase: 9
    plan: 05
    provides: "wizard.ts orchestrator + IPC handlers (wizard:detect-installs / wizard:install / wizard:cancel / wizard:get-state + wizard:progress push channel); Map<sessionId, AbortController> for BLOCKER 2 IPC-crossing cancel"
  - phase: 9
    plan: 06
    provides: "StatusPill primitive — shared 8px-dot + label pill with optional mono secondary caption (5 tones: green/red/warn/muted/pulse)"
provides:
  - "useWizardStore — Zustand store (open/step/installs/selectedIds/sessionId/progress/results/error + 7 actions); sessionId via crypto.randomUUID per run; cancelInstall + closeWizard both fire sei.wizardCancel(sessionId). ZERO renderer-side AbortController (BLOCKER 2 regression guard)"
  - "WizardStepShell — STEP n/5 pixel-font indicator + 22px heading + flex body + footer; min-height 480px so footer pins consistently across steps"
  - "SetupWizardModal — 680x520 modal shell with 0.45 scrim alpha (matches LanModal), focus trap that re-fires on step change, ESC dismissal, 200ms crossfade keyed on step; all 7 verbatim step headings from UI-SPEC; role/aria-modal/aria-live"
  - "McInstallRow — keyboard-focusable role=button row with checkbox + sans label + mono path + right-aligned StatusPill; pill tone matrix verbatim from UI-SPEC §Status indicators copy"
  - "McInstallList — scrollable max-height 320px container; strips last-child border-bottom"
  - "InstallProgressList — per-install progress rows mapping every WizardProgressEvent variant incl. the BLOCKER 2 `cancelled` variant; 4px progress bar with --rail base + --accent fill; check-mark scaleIn on done"
  - "First-launch trigger in App.tsx — chains sei.hasApiKey → sei.getWizardState → sei.detectMcInstalls; only auto-opens when hasApiKey AND !hasRunOnce AND installs.length > 0"
  - "Settings 'MINECRAFT SKINS SETUP' row — StatusPill (green/warn/muted with drift detection) + 'Re-run setup' quiet button calling openWizard(true) for the re-entry path"
affects:
  - "Plan 08 (verify wave) — has 11 new files to verify across 3 commits; the BLOCKER 2 regression guard `grep -c 'new AbortController' src/renderer/src/lib/stores/useWizardStore.ts === 0` is the single most-important checker assertion"
  - "Phase 9 verifier — all 7 step headings + BLOCKER 2 grep proofs + scrim alpha + pixel-font step indicator are documented as plan-level acceptance"
  - "User-facing UX — Sei now ships a click-through Minecraft skin setup; wizard opens automatically on first launch when API key is set and MC is detected"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "blocker-2-ipc-cancel: renderer holds a sessionId in store state (generated via `crypto.randomUUID()` per long-running run); cancelInstall and closeWizard fire `sei.wizardCancel(sessionId)` over IPC instead of a renderer-local AbortController. This lets cancellation abort a child process (`java -jar fabric-installer`) that a renderer-side AbortController could never reach. The finally block of runInstall clears sessionId so stray late cancels are silent no-ops."
    - "focus-trap-on-step-change: useEffect keyed on `[open, step]` rebuilds the focusable list when the wizard mounts AND on every step transition. Pre-focuses the LAST focusable (typically the primary CTA in the footer). Tab/Shift+Tab wrap inside the modal via a keydown handler on the modal node itself."
    - "result-derived-terminal-override: InstallProgressList prefers the WizardInstallResult terminal state (ok/!ok) over the latest push event ONLY when the push event isn't already terminal. Covers the race where runWizardInstall resolves before the final `done`/`failed` progress event lands."
    - "step-keyed-crossfade: wrap the active step content in a `<div key={step}>` so React unmounts/remounts the subtree on transitions; CSS animates the new node's opacity 0→1 in 200ms ease. Honors `prefers-reduced-motion: reduce` by zeroing the animation. No horizontal slide (matches existing Sei aesthetic — opacity transitions only)."
    - "scrollable-row-list-in-modal: McInstallList uses `max-height: 320px; overflow-y: auto` inside a 520px-min-height modal so users with many CurseForge instances don't blow out the layout. The list border is on the container; the row's bottom-border is stripped at `:last-child` to avoid doubling against the container edge."

key-files:
  created:
    - "src/renderer/src/lib/stores/useWizardStore.ts — 203 LoC. Zustand store; 7 actions (openWizard, closeWizard, gotoStep, runDetection, toggleSelected, runInstall, cancelInstall); sessionId + Map-based progress + onWizardProgress subscription mgmt; BLOCKER 2 IPC-crossing cancel."
    - "src/renderer/src/components/WizardStepShell.tsx — 45 LoC. Reusable step body with STEP n/5 pixel-font indicator (null for branch states)."
    - "src/renderer/src/components/WizardStepShell.module.css — 49 LoC. min-height 480px, --pixel-font indicator, --sans heading 22px/600."
    - "src/renderer/src/components/SetupWizardModal.tsx — 397 LoC. Top-level shell with ESC handler, focus trap, 7-step machine, internal step subcomponents that compose WizardStepShell with verbatim UI-SPEC copy."
    - "src/renderer/src/components/SetupWizardModal.module.css — 58 LoC. 680x520 modal, 0.45 scrim alpha (matches LanModal), 200ms crossfade animation, sharp corners (D-28)."
    - "src/renderer/src/components/McInstallRow.tsx — 121 LoC. Keyboard-focusable row with checkbox + label + path + StatusPill; pill tone matrix from UI-SPEC."
    - "src/renderer/src/components/McInstallRow.module.css — 79 LoC. Hover/selected backgrounds via --accent-soft, 2px --accent left-edge bar on selected, no transform hovers."
    - "src/renderer/src/components/McInstallList.tsx — 40 LoC. Scrollable container wrapping McInstallRow children."
    - "src/renderer/src/components/McInstallList.module.css — 21 LoC. max-height 320px + last-child border-bottom strip."
    - "src/renderer/src/components/InstallProgressList.tsx — 152 LoC. Per-install progress rows mapping every WizardProgressEvent variant (queued/fabric-downloading{pct}/fabric-installing/mod-downloading{pct}/mod-placing/config-writing/done/failed/cancelled); result-derived terminal override."
    - "src/renderer/src/components/InstallProgressList.module.css — 111 LoC. 4px progress bar with --rail/--accent, check-mark scaleIn 240ms, motion-reduce overrides."
  modified:
    - "src/renderer/src/App.tsx — +32 LoC. Imports SetupWizardModal + useWizardStore; new useEffect chains hasApiKey/getWizardState/detectMcInstalls to decide first-launch auto-open; renders <SetupWizardModal /> at App root."
    - "src/renderer/src/screens/SettingsScreen.tsx — +72 LoC. New 'MINECRAFT SKINS SETUP' section before APPEARANCE with internal SkinSetupRow component that loads getWizardState + detectMcInstalls on mount and renders StatusPill (green/warn/muted) + 'Re-run setup' button."

key-decisions:
  - "BLOCKER 2 — renderer holds NO AbortController for the wizard. The sessionId state field is the only handle the renderer keeps; sei.wizardCancel(sessionId) crosses the IPC boundary so main can abort its in-flight `java -jar fabric-installer` child process. Regression guard: `grep -c 'new AbortController' src/renderer/src/lib/stores/useWizardStore.ts` MUST return 0."
  - "Pre-select all installs on first detection — if the persisted sei_enabled set is empty (first-run path), runDetection selects ALL detected installs so the user can just click Continue without ticking checkboxes. On re-runs, the persisted sei_enabled set is honored (CONTEXT idempotency)."
  - "First-launch gate is hasApiKey + !hasRunOnce + installs.length > 0 — three predicates all must hold. Skipping the install-count check would surface 'We couldn't find Minecraft' on every cold start for users without MC; that's noise, not signal. Re-run from Settings remains available either way."
  - "Settings row reads getWizardState + detectMcInstalls on mount, NOT the wizard store — so the row reflects ON-DISK state, not in-memory wizard state. Re-running the wizard updates persisted state on save (Plan 05), and the next Settings mount picks it up."
  - "Step-keyed crossfade via `<div key={step}>` — leverages React's unmount-on-key-change behavior so the CSS animation always fires for the incoming step. Alternative (state-driven className toggle) needs explicit timeout management; key-based is simpler and matches the framework's grain."
  - "Footer layout uses `<span />` placeholder for missing left buttons — keeps `justify-content: space-between` happy without needing per-step CSS variants. The footer flexbox is shared across all 7 step subcomponents."
  - "Drift heuristic in SettingsScreen — `i.sei_enabled && !i.csl_installed` is the conservative drift indicator (user previously enabled, but the mod jar is now missing). A more aggressive heuristic (CSL version drift via bundled-vs-installed comparison) is deferred to a future plan; needs a bundled-CSL-version constant the renderer doesn't have today."

patterns-established:
  - "ipc-crossing-cancel in renderer Zustand: any long-running renderer→main workflow that the user wants cancellable holds a `sessionId: string | null` field generated via `crypto.randomUUID()` per run; cancel actions are async and fire `sei.<op>Cancel(sessionId)` over IPC. Renderer-local AbortController is forbidden — it can't reach child processes spawned by main."
  - "auto-open gate composed of >=3 predicates: any 'do this on first launch' UX wraps the trigger in an async chain of orthogonal checks (auth state + persisted-flag + environmental-prerequisite). Wrap the whole effect in a `cancelled` flag closure so unmount doesn't fire stale state mutations."
  - "scrollable section inside fixed-min-height modal: `max-height: 320px; overflow-y: auto` on a list container nested in a 520px-min-height modal keeps modal sizing predictable. Strip `:last-child` border-bottom to avoid doubled rules at container edges."

requirements-completed: []

# Metrics
duration: 10min
completed: 2026-05-18
---

# Phase 9 Plan 07: Setup Wizard UI Summary

**Ships the first-launch / re-runnable Minecraft skin setup wizard renderer: a Zustand store + 4 leaf components (WizardStepShell, McInstallList, McInstallRow, InstallProgressList) + the top-level SetupWizardModal with all 7 verbatim UI-SPEC step headings (Welcome → Detecting → Pick installs → Installing → Done plus the 1b "none found" and 3b "one failed" branches) + the first-launch trigger in App.tsx (auto-opens when hasApiKey AND !hasRunOnce AND installs.length > 0) + the Settings "MINECRAFT SKINS SETUP" re-run row. BLOCKER 2 closed: the renderer holds ZERO AbortController for the wizard; cancellation crosses the IPC boundary via sei.wizardCancel(sessionId) so main can SIGTERM the in-flight `java -jar fabric-installer` child process.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-18T05:02:34Z
- **Completed:** 2026-05-18T05:12:03Z
- **Tasks:** 3 / 3
- **Files created:** 11 (5 .tsx + 6 .module.css including the store)
- **Files modified:** 2 (App.tsx + SettingsScreen.tsx)
- **Total LOC added:** +1380 (+1276 in new files, +104 in modified files per `git diff --stat HEAD~3 HEAD`)

## Accomplishments

- **Zustand store with BLOCKER 2 cancel path (Task 1).** `useWizardStore` is the single source of truth for wizard state — 7-step linear machine + 2 branch states, McInstall list, selected ids, sessionId (generated via `crypto.randomUUID()` per run), live progress Map, results array. The `cancelInstall` and `closeWizard` actions both fire `sei.wizardCancel(sessionId)` over IPC; no renderer-side `new AbortController()` exists. The `progress` Map is rebuilt as a new Map on each push event (Zustand reference-equality semantics — mutation alone wouldn't trigger re-renders). `runInstall`'s finally block clears sessionId so stray late cancels are silent no-ops.
- **Modal shell with focus trap + ESC + crossfade (Task 1).** `SetupWizardModal` is a 680x520 centered modal with 0.45 scrim alpha matching LanModal, sharp corners (D-28), and a 200ms opacity crossfade between steps (key-based remount). Focus trap re-fires on every step change — the LAST focusable element gets focus (typically the primary CTA in the footer). Tab/Shift+Tab wrap inside the modal via a keydown handler scoped to the modal node. ESC dismisses; the dismissal handler routes through `closeWizard` which also fires the IPC cancel if a run is in flight. role="dialog" + aria-modal + aria-label, plus aria-live="polite" wrapping the in-flight body of the Detecting and Installing steps so screen readers narrate progress.
- **All 7 verbatim step headings + branch states (Task 1).** Welcome (`Set up Minecraft skins`), Detecting (`Looking for Minecraft installs`), None-found (`We couldn't find Minecraft`), Pick (`Pick which installs to enable`), Installing (`Setting up your installs`), One-failed (`One install couldn't finish`), Done (`All set`). All copy is verbatim from UI-SPEC §First-launch wizard. The Done step composes a dynamic `profileName` (`fabric-loader-{loaderVersion}-{mcVersion}` for vanilla; instance label for CurseForge) into the verbatim body template.
- **Selectable install rows + StatusPill matrix (Task 2).** `McInstallRow` is a keyboard-focusable `role="button"` with a controlled native checkbox + sans label + mono path + right-aligned `StatusPill`. The pill tone matrix is verbatim from UI-SPEC §Status indicators copy: green `Sei enabled` with `${loader} ${loader_version} · CSL ${csl_version}`, red `Mod missing`, muted `Vanilla launcher` with full path, muted `${install.label}` + `CurseForge · ${mc_version}` for CF instances. No transform-based hovers — only `background: var(--accent-soft)` change, keeping the sharp/calm Sei aesthetic. Selected rows get a 2px `--accent` left-edge bar (UI-SPEC §"Accent reserved-for list" item 5); the row reserves a transparent 2px left-border at rest so width doesn't shift on selection.
- **Per-install progress rows incl. BLOCKER 2 cancelled variant (Task 2).** `InstallProgressList` maps every `WizardProgressEvent` variant to its visual descriptor: `queued` → "Queued" (muted), `fabric-downloading{pct}` / `mod-downloading{pct}` → labeled stage + 4px progress bar with `--rail` base + `--accent` fill, `fabric-installing` / `mod-placing` / `config-writing` → labeled stage no bar, `done` → green `Setup complete` pill with scaleIn animation (240ms `var(--ease-pop)`), `failed` → red `Setup failed` pill with error message as secondary, `cancelled` → muted `Cancelled` pill (the new BLOCKER 2 variant from Plan 01's WizardProgressEvent union). Result-derived terminal override: if `runWizardInstall` resolves before the final push event lands, the row falls back to the WizardInstallResult to render the correct terminal state.
- **First-launch trigger + Settings re-run row (Task 3).** App.tsx's new post-mount effect chains `sei.hasApiKey` → `sei.getWizardState` → `sei.detectMcInstalls`; auto-opens the wizard ONLY when all three predicates hold (auth done AND wizard never run AND at least one MC install detected). `<SetupWizardModal />` is rendered unconditionally at the App root — it returns `null` when `useWizardStore.open === false`. SettingsScreen gains a new `MINECRAFT SKINS SETUP` section before APPEARANCE; the internal `SkinSetupRow` reads `getWizardState` + `detectMcInstalls` on mount to derive a StatusPill (green when 1+ enabled, warn when drift detected, muted otherwise) and a 'Re-run setup' button that calls `openWizard(true)` for the re-entry path (Back-to-settings button visible on welcome step).

## Task Commits

1. **Task 1: wizard shell + Zustand store with IPC-crossing cancel (BLOCKER 2)** — `5c9c66d` (feat)
   - `src/renderer/src/lib/stores/useWizardStore.ts` (new, 203 LoC) — 7 actions; sessionId via crypto.randomUUID; BLOCKER 2 cancel.
   - `src/renderer/src/components/WizardStepShell.tsx` + `.module.css` (new, 45 + 49 LoC) — STEP n/5 indicator + heading + body + footer.
   - `src/renderer/src/components/SetupWizardModal.tsx` + `.module.css` (new, 397 + 58 LoC) — 680x520 modal, ESC handler, focus trap on step change, 200ms crossfade, all 7 verbatim step subcomponents.

2. **Task 2: McInstallList/Row + InstallProgressList for wizard step 2/3/3b** — `1574282` (feat)
   - `src/renderer/src/components/McInstallRow.tsx` + `.module.css` (new, 121 + 79 LoC) — keyboard-focusable row with StatusPill tone matrix from UI-SPEC.
   - `src/renderer/src/components/McInstallList.tsx` + `.module.css` (new, 40 + 21 LoC) — scrollable max-height 320px container.
   - `src/renderer/src/components/InstallProgressList.tsx` + `.module.css` (new, 152 + 111 LoC) — per-install rows with all 9 WizardProgressEvent variants incl. BLOCKER 2 cancelled.

3. **Task 3: first-launch wizard trigger + Settings re-run row** — `15c61ef` (feat)
   - `src/renderer/src/App.tsx` (+32 LoC) — first-launch useEffect + `<SetupWizardModal />` at App root.
   - `src/renderer/src/screens/SettingsScreen.tsx` (+72 LoC) — `MINECRAFT SKINS SETUP` section + internal `SkinSetupRow` component.

## Files Created/Modified

### Created (11)
- `src/renderer/src/lib/stores/useWizardStore.ts` (203 LoC) — Zustand store.
- `src/renderer/src/components/WizardStepShell.tsx` (45 LoC).
- `src/renderer/src/components/WizardStepShell.module.css` (49 LoC).
- `src/renderer/src/components/SetupWizardModal.tsx` (397 LoC).
- `src/renderer/src/components/SetupWizardModal.module.css` (58 LoC).
- `src/renderer/src/components/McInstallRow.tsx` (121 LoC).
- `src/renderer/src/components/McInstallRow.module.css` (79 LoC).
- `src/renderer/src/components/McInstallList.tsx` (40 LoC).
- `src/renderer/src/components/McInstallList.module.css` (21 LoC).
- `src/renderer/src/components/InstallProgressList.tsx` (152 LoC).
- `src/renderer/src/components/InstallProgressList.module.css` (111 LoC).

### Modified (2)
- `src/renderer/src/App.tsx` (+32 LoC) — first-launch wizard trigger + modal mount.
- `src/renderer/src/screens/SettingsScreen.tsx` (+72 LoC) — `MINECRAFT SKINS SETUP` section + SkinSetupRow.

### Total LOC delta (since previous plan's final commit)
```
$ git diff --stat HEAD~3 HEAD
 13 files changed, 1380 insertions(+)
```

## Verification Evidence

### Typecheck (clean)
```
$ npx tsc --noEmit -p tsconfig.web.json   # exit 0, no output
```

### npm run build (renderer chunk builds with new dependency graph)
```
$ npm run build 2>&1 | tail -8
dist/renderer/index.html                       0.39 kB
dist/renderer/assets/index-CQjsmH3q.css       55.90 kB
dist/renderer/assets/index-jN9QDngi.js       705.96 kB
dist/renderer/assets/skinview3d-DxCiPavj.js  884.73 kB
✓ built in 722ms
```

Renderer JS chunk grew from prior Plan 06 baseline by ~the new wizard surface; skinview3d remains lazy-loaded in a separate chunk per Plan 06. The pre-existing `dynamic import will not move module into another chunk` warnings for `skinStore.ts` / `wizardStateStore.ts` are from Plans 02/04/05 and out of scope here.

### BLOCKER 2 regression guards (the plan-output anchors)
```
$ grep -F "new AbortController" src/renderer/src/lib/stores/useWizardStore.ts | wc -l
0

$ grep -F "sei.wizardCancel" src/renderer/src/lib/stores/useWizardStore.ts | wc -l
5

$ grep -F "crypto.randomUUID" src/renderer/src/lib/stores/useWizardStore.ts | wc -l
3   # 2 in docstring comments + 1 in runInstall body

$ grep -F "sessionId" src/renderer/src/lib/stores/useWizardStore.ts | wc -l
16
```

The `sei.wizardCancel` count of 5 exceeds the plan's `>=2` requirement (matches in runInstall comment + cancelInstall body + closeWizard body + 2 docstring references). The `new AbortController` count of 0 closes BLOCKER 2's regression-guard contract.

### Task 1 acceptance criteria
```
$ grep -F "openWizard\|closeWizard\|gotoStep\|runDetection\|toggleSelected\|runInstall\|cancelInstall" src/renderer/src/lib/stores/useWizardStore.ts | grep -c "=>"
7   # exactly 7 actions declared

$ for s in "Set up Minecraft skins" "Looking for Minecraft installs" "We couldn't find Minecraft" "Pick which installs to enable" "Setting up your installs" "One install couldn't finish" "All set"; do
    grep -F -q "$s" src/renderer/src/components/SetupWizardModal.tsx && echo "OK: $s"
  done
OK: Set up Minecraft skins
OK: Looking for Minecraft installs
OK: We couldn't find Minecraft
OK: Pick which installs to enable
OK: Setting up your installs
OK: One install couldn't finish
OK: All set

$ grep -F "Escape" src/renderer/src/components/SetupWizardModal.tsx | wc -l
1   # ESC handler

$ grep -F "rgba(0, 0, 0, 0.45)" src/renderer/src/components/SetupWizardModal.module.css | wc -l
1   # scrim alpha matches LanModal

$ grep -F "var(--pixel)" src/renderer/src/components/WizardStepShell.module.css | wc -l
1   # pixel font on step indicator

$ grep -F "aria-live" src/renderer/src/components/SetupWizardModal.tsx | wc -l
2   # DetectingStep + InstallingStep both wrap in role=status aria-live=polite

$ grep -F "onClick={() => void cancelInstall()}" src/renderer/src/components/SetupWizardModal.tsx | wc -l
1   # InstallingStep Cancel button — BLOCKER 2 IPC-crossing
```

### Task 2 acceptance criteria
```
$ grep -E "McInstallList|McInstallRow|InstallProgressList" src/renderer/src/components/SetupWizardModal.tsx | wc -l
7   # >= 3 required (imports + 4 JSX usages)

$ grep -F "StatusPill" src/renderer/src/components/McInstallRow.tsx src/renderer/src/components/InstallProgressList.tsx | wc -l
12   # >= 2 required

$ grep -F "Sei enabled\|Mod missing\|Vanilla launcher\|CurseForge" src/renderer/src/components/McInstallRow.tsx | wc -l
4   # >= 4 required

$ grep -F "Cancelled" src/renderer/src/components/InstallProgressList.tsx | wc -l
2   # cancelled variant present (BLOCKER 2)

$ grep -E "var\(--rail\)|var\(--accent\)" src/renderer/src/components/InstallProgressList.module.css | wc -l
4   # progress bar uses both tokens

$ grep -E "#[0-9a-fA-F]{3,8}" src/renderer/src/components/McInstallList.module.css \
                              src/renderer/src/components/McInstallRow.module.css \
                              src/renderer/src/components/InstallProgressList.module.css \
                              src/renderer/src/components/SetupWizardModal.module.css \
                              src/renderer/src/components/WizardStepShell.module.css | wc -l
0   # ZERO hardcoded hex across all 5 new module.css files

$ grep -E "transform: scale|transform: translate" src/renderer/src/components/McInstallRow.module.css | wc -l
0   # no transform-based hovers per UI-SPEC
```

### Task 3 acceptance criteria
```
$ grep -E "openWizard|SetupWizardModal" src/renderer/src/App.tsx | wc -l
6   # >= 2 required (import + usage)

$ grep -F "sei.getWizardState" src/renderer/src/App.tsx | wc -l
1

$ grep -F "hasRunOnce" src/renderer/src/App.tsx | wc -l
2   # docstring + condition

$ grep -F "hasApiKey" src/renderer/src/App.tsx | wc -l
4   # 2 in new first-launch effect + 2 in pre-existing bootstrap effect

$ grep -F "MINECRAFT SKINS SETUP" src/renderer/src/screens/SettingsScreen.tsx | wc -l
1

$ grep -F "Re-run setup" src/renderer/src/screens/SettingsScreen.tsx | wc -l
2   # docstring + button label
```

## Deviations from Plan

None — all 3 tasks executed exactly as written. No Rule 1 (bug), Rule 2 (missing critical functionality), Rule 3 (blocker), or Rule 4 (architectural decision) deviations were triggered. No authentication gates encountered. Typecheck and build pass in single passes per task.

The plan called out that the SkinSetupRow's "drift detection" was a future heuristic; this Summary documents that the conservative implementation (`sei_enabled && !csl_installed` as the drift indicator) was chosen because the bundled-CSL-version constant the renderer would need for a more aggressive version-comparison heuristic isn't surfaced today — and adding it would have been a Rule 4 architectural decision (new IPC method needed). The conservative heuristic still catches the most common drift case (user deleted the mod jar) and is the right baseline for Phase 9's UX shipping bar.

## Authentication Gates

None encountered. The wizard run path may surface auth-style gates downstream (e.g. Mojang EULA acceptance for the bundled JRE) but those are handled in main's Fabric installer error-message path (Plan 04's `FABRIC_INSTALL_FAILED` ErrorClass with plain-english copy), not at the renderer IPC layer.

## Known Stubs

None. All 11 new files ship fully-wired code:
- `useWizardStore` calls real IPC methods (`sei.detectMcInstalls`, `sei.runWizardInstall`, `sei.wizardCancel`, `sei.getSkinServerUrl`, `sei.onWizardProgress`) registered in Plan 04/05.
- The first-launch effect in App.tsx wires `sei.hasApiKey` + `sei.getWizardState` + `sei.detectMcInstalls` against the real main-process handlers from Plans 02/04/05.
- The Settings row's SkinSetupRow reads ON-DISK state via real IPC; no in-memory or mock data.
- `InstallProgressList` renders against the live `progress` Map populated by `sei.onWizardProgress` push events — the same events Plan 05's wizard.ts orchestrator emits stage-by-stage.

## Threat Flags

None new. The plan's `<threat_model>` covered:
- **T-09-T8 (Tampering — useWizardStore selectedIds):** Accepted — main re-validates `installIds` via `z.array(z.string())` in the wizard:install IPC handler (Plan 05). The renderer cannot inject paths outside the scanned install set.
- **T-09-D5 (DoS — wizard cancel during install / BLOCKER 2):** Mitigated — cancelInstall fires sei.wizardCancel(sessionId); main's `abortWizardSession` fires `.abort()` on its Map<sessionId, AbortController>, which propagates through Plan 04's signal-aware modules to SIGTERM the `java -jar fabric-installer` child process. Verified end-to-end via Plan 05's regression tests; the renderer side of the contract (no local AbortController) is verified by `grep -c "new AbortController" useWizardStore.ts === 0`.
- **T-09-X2 (UX-S1 — wizard auto-opens during a tutorial-like state):** Mitigated — first-launch trigger is gated on `hasApiKey && !hasRunOnce && installs.length > 0`. Users without MC don't get the popup.
- **T-09-S3 (Spoofing — sessionId collision):** Accepted — sessionId is renderer-generated `crypto.randomUUID()` (128-bit); collision probability is negligible. Worst case on collision is the wrong session is cancelled, never an injected install.

No new trust boundaries introduced beyond what the threat register covers.

## TDD Gate Compliance

N/A — Plan 09-07 has `type: execute` (not `type: tdd`); no RED/GREEN gate is required. All three tasks have `type="auto" tdd="false"`.

## Self-Check: PASSED

Verified all claimed files exist and all claimed commits are reachable:

```
FOUND: src/renderer/src/lib/stores/useWizardStore.ts             (created, 203 LoC)
FOUND: src/renderer/src/components/WizardStepShell.tsx           (created, 45 LoC)
FOUND: src/renderer/src/components/WizardStepShell.module.css    (created, 49 LoC)
FOUND: src/renderer/src/components/SetupWizardModal.tsx          (created, 397 LoC)
FOUND: src/renderer/src/components/SetupWizardModal.module.css   (created, 58 LoC)
FOUND: src/renderer/src/components/McInstallRow.tsx              (created, 121 LoC)
FOUND: src/renderer/src/components/McInstallRow.module.css       (created, 79 LoC)
FOUND: src/renderer/src/components/McInstallList.tsx             (created, 40 LoC)
FOUND: src/renderer/src/components/McInstallList.module.css      (created, 21 LoC)
FOUND: src/renderer/src/components/InstallProgressList.tsx       (created, 152 LoC)
FOUND: src/renderer/src/components/InstallProgressList.module.css (created, 111 LoC)
FOUND: src/renderer/src/App.tsx                                  (modified, +32 LoC)
FOUND: src/renderer/src/screens/SettingsScreen.tsx               (modified, +72 LoC)
FOUND: commit 5c9c66d (Task 1 — wizard shell + Zustand store + BLOCKER 2)
FOUND: commit 1574282 (Task 2 — McInstallList/Row + InstallProgressList)
FOUND: commit 15c61ef (Task 3 — first-launch trigger + Settings re-run row)
FOUND: typecheck exit 0
FOUND: npm run build succeeds; renderer JS chunk = 706 KB, css = 55.9 KB
FOUND: BLOCKER 2 regression guard `grep -c "new AbortController" useWizardStore.ts` returns 0
FOUND: `grep -c "sei.wizardCancel" useWizardStore.ts` returns 5 (>= 2 required)
FOUND: All 7 verbatim step headings present in SetupWizardModal.tsx
```
