---
phase: 04-electron-gui-packaging
plan: 08
subsystem: renderer-screens-and-modals
tags: [react, css-modules, zustand, character-page, settings, lan-modal, summon-toast, delete-modal, logs-virtualization]
dependency_graph:
  requires:
    - phase: 04-electron-gui-packaging plan 01
      provides: "tsconfig.web.json paths (@, @shared)"
    - phase: 04-electron-gui-packaging plan 02
      provides: "@shared/characterSchema (Character, UserConfig) + @shared/ipc (RendererApi, BotStatus, LanState)"
    - phase: 04-electron-gui-packaging plan 05
      provides: "window.sei (summon, stop, deleteCharacter, getConfig, saveConfig, hasApiKey)"
    - phase: 04-electron-gui-packaging plan 06
      provides: "Button, TextField, PixelPortrait, IconRail, MacosWindow, icons (BackIcon, SparkleIcon, SunIcon, MoonIcon), useUiStore (view/modal/themeMode/pendingSummonId), useDataStore (characters/lan/summon/logs/dropped + refreshCharacter/removeCharacter), tagLog, pickPalette, applyTheme"
    - phase: 04-electron-gui-packaging plan 07
      provides: "OnboardingScreen / HomeScreen / AddCharacterScreen / ComingSoonScreen wired into App.tsx; pendingSummonId + modal({kind:'lan',mode:'searching'}) protocol established by HomeScreen"
  provides:
    - "src/renderer/src/components/LanModal.{tsx,module.css} — info / searching modes, live status pill, ESC + auto-resume on connected (D-24/D-56), no Mark-as-connected button (D-23/D-57)"
    - "src/renderer/src/components/SummonToast.{tsx,module.css} — bottom-right 4200ms auto-dismiss, role=status aria-live=polite (D-59)"
    - "src/renderer/src/components/DeleteConfirmModal.{tsx,module.css} — sharp-cornered confirm, red Delete CTA, ESC cancel (UI-SPEC §Character delete-gating)"
    - "src/renderer/src/components/LogsPanel.{tsx,module.css} — virtualized terminal viewer; VIRT_THRESHOLD=500 / WINDOW_SIZE=200 / PIN_THRESHOLD=80; Copy all + Pause autoscroll + ↓ N new lines pill"
    - "src/renderer/src/screens/CharacterPage.{tsx,module.css} — 320+1fr two-column with portrait card, Summon/Stop CTA, Edit (placeholder) / Delete (hidden when id==='sui'), tabs (Description/Persona prompt/Logs), stats grid, model row"
    - "src/renderer/src/screens/SettingsScreen.{tsx,module.css} — Account / Appearance / Setup sections per D-58; theme toggle persists immediately"
    - "src/renderer/src/App.tsx — full screen wiring; modal layer renders LanModal; toast layer fires SummonToast on summon→online transitions"
  affects:
    - "Plan 09 (errors) — CharacterPage model-row error label currently shows raw `summon.message` (BotStatus.error.message); replace with `ERROR_COPY[summon.error]` once src/renderer/src/lib/errors.ts ships. Same goes for SettingsScreen.toggleTheme catch block (raw console.error)."
    - "Plan 09 — onboarding step-4 error display (already noted by plan 07) should land alongside the CharacterPage error swap."
    - "Plan 09 or 11 — bot-side `playtime_ms` accumulator: bot must emit a final playtime delta on summon-stopped; main's botSupervisor needs to update CharacterPage's stats grid value via `sei.saveCharacter({...c, playtime_ms: prev + delta})`. CharacterPage.fmtMs already renders '—' for 0, but the increment is wired by main+bot."
    - "Plan 11 (clean-VM smoke) — verifies summon → toast → status row online → Logs tab enabled → log lines stream → Stop → status returns Ready → Delete → confirm → home."
tech_stack:
  added: []
  patterns:
    - "Modal layer rendered alongside MacosWindow (sibling, not child) so the scrim covers the IconRail and the chrome but the macOS traffic-lights still receive pointer events at the OS level. Modal kind is read once from useUiStore.modal at the App level — child screens just call openModal/closeModal; they don't render the modal themselves."
    - "Toast lifecycle owned by App.tsx: a single useState<{id,name}|null> in App, fired by an effect that watches useDataStore.summon transitions to 'online' and dedupes via lastToastedSummonId. Child screens never mount the toast — they trigger summon and the App-level effect picks it up."
    - "Hand-rolled log virtualization without per-line IntersectionObservers: scrollTop ÷ APPROX_LINE_PX (18) gives the visible-start line index; we anchor a 200-line window with the visible start ~25% into the window. Same windowed-render contract as react-virtuoso, but cheaper to set up and correct without an observer per line. Documented inline as the pragmatic IntersectionObserver-equivalent (UI-SPEC §Defaults references the technique class)."
    - "T-04-37 mitigation co-located with the screen: CharacterPage's mount effect calls `useDataStore.refreshCharacter(id)` if the character is missing; main's `getCharacter` returns null on missing → the screen renders 'Character not found' + Back to Home. Same pattern as plan 07's HomeScreen.empty-grid handler — recovery is per-screen, not global."
    - "Persona-prompt fade-in via CSS animation on the `.cardExpanded` class transitioning border-left + animating the `.personaBody` subtree (D-50). No JS-driven height animation — the body simply renders or doesn't, with a 220ms fade keyframe applied to the `<pre>`."
key_files:
  created:
    - "src/renderer/src/components/LanModal.tsx"
    - "src/renderer/src/components/LanModal.module.css"
    - "src/renderer/src/components/SummonToast.tsx"
    - "src/renderer/src/components/SummonToast.module.css"
    - "src/renderer/src/components/DeleteConfirmModal.tsx"
    - "src/renderer/src/components/DeleteConfirmModal.module.css"
    - "src/renderer/src/components/LogsPanel.tsx"
    - "src/renderer/src/components/LogsPanel.module.css"
    - "src/renderer/src/screens/CharacterPage.tsx"
    - "src/renderer/src/screens/CharacterPage.module.css"
    - "src/renderer/src/screens/SettingsScreen.tsx"
    - "src/renderer/src/screens/SettingsScreen.module.css"
  modified:
    - "src/renderer/src/App.tsx"
key_decisions:
  - "App.tsx renders the toast on summon→online (not on summon→connecting). Rationale: BotStatus.connecting has no characterId in its variant, so we can't resolve the toast title at that stage. Online carries characterId. The trade-off is the toast appears slightly later than the prototype's screens.jsx (which fires on user click). For Sei v1 this reads better — the toast confirms a successful connection rather than a hopeful click. If plan 11 verification feels the latency, we can lift the toast trigger into HomeScreen/CharacterPage's summon click handler with the character name in hand."
  - "CharacterPage 'Edit persona' button is rendered disabled with `title='Edit coming soon'`. Per plan instructions and CONTEXT scope, the full Edit flow is out of scope for v1 (the Add flow already covers GUI-04). The disabled button keeps the design fidelity and reserves the slot — when Edit ships, the only change is removing `disabled` and adding the navigation handler."
  - "LogsPanel uses scrollTop-based windowing (APPROX_LINE_PX = 18) rather than per-line IntersectionObserver sentinels. UI-SPEC §Defaults names IntersectionObserver as the technique class but the contract is a 'a 200-line render window' — both implementations satisfy that. The scrollTop approach is simpler, has no per-line observer overhead, and is correct for our fixed-height mono lines. If line wrapping becomes a concern (`white-space: pre` currently prevents wrap), we'd switch to a measured ResizeObserver pass."
  - "DeleteConfirmModal renders the destructive button as a plain `<button>` (not the Button primitive) because the destructive variant requires `--red` background + `--window` text overrides that the Button kinds (primary/accent/ghost/quiet) don't expose cleanly. The plain button is themed in DeleteConfirmModal.module.css with the same focus-visible 1.5px accent ring as the Button primitive — keeps a11y intact while bypassing the kind matrix."
  - "SettingsScreen.toggleTheme writes resolvedTheme into local state synchronously *before* awaiting `sei.saveConfig`. This means the theme flips visually instantly; the disk write is async. If saveConfig fails the next reload will revert (cfg.theme_mode is the source of truth on next boot). For v1 this is the correct UX — theme toggling cannot block on disk."
  - "LanModal auto-resume effect calls `setPendingSummon(null)` BEFORE `closeModal()` so a fresh modal subscription doesn't see the same pendingSummonId twice. The order matters: closeModal triggers App's modal layer to unmount this component, but if React batches the state updates and replays the effect (concurrent rendering), the pending id is already cleared."
requirements_completed: [GUI-02, GUI-03, GUI-04]
metrics:
  duration_min: ~14
  tasks_completed: 3
  files_changed: 13
  loc_added: ~1525
  completed: "2026-05-08T19:45:00Z"
---

# Phase 4 Plan 08: Character Page & Modals Summary

**One-liner:** Final renderer surface — CharacterPage with portrait + persona-collapse + tabs + stats + model row + Summon/Stop CTA, SettingsScreen with theme toggle and re-onboarding, LanModal with auto-resume on `lan:state→connected`, DeleteConfirmModal with red Delete CTA, virtualized LogsPanel (200-line render window), SummonToast on summon→online. App.tsx now renders every view in the design with no remaining placeholders.

## Performance

- **Tasks:** 3 (all auto, no TDD)
- **Files created:** 12 (6 components × 2 files + 2 screens × 2 files = 12) + 1 modified (App.tsx)
- **Commits:** 3 atomic feat commits

## Task Commits

| Commit  | Type | Description |
| ------- | ---- | ----------- |
| 679e432 | feat | Task 1 — LanModal + SummonToast + DeleteConfirmModal (3 components, 3 CSS modules) |
| e98fd40 | feat | Task 2 — LogsPanel (virtualized terminal-style log viewer) |
| bbcbe72 | feat | Task 3 — CharacterPage + SettingsScreen + App.tsx wiring (modal layer + toast layer + 2 screens) |

## What Shipped

### Task 1 — LanModal + SummonToast + DeleteConfirmModal

**`src/renderer/src/components/LanModal.tsx`** — 520px wide centered modal, scrim 0.45 black. Header eyebrow shows the live LAN pill (`Connected` / `Not connected` / `Unavailable on this network`) with 8×8 status dot driven by `useDataStore.lan`. H2 "To summon a character into your world". Numbered list with 4 verbatim steps:

1. Launch Minecraft and open your singleplayer world.
2. Press ESC, then choose Open to LAN.
3. Set Allow Cheats to On, then click Start LAN World.
4. Return to Sei and press Summon.

Two modes:
- `info` — footer = `[Close]` only.
- `searching` — footer = `[Cancel summon, Close]` plus a "Searching for an open LAN world…" row with three blinking dots (`seiDot` keyframes).

**Auto-resume (D-56):** in `searching` mode, when `useDataStore.lan.kind === 'connected'`, the modal calls `setPendingSummon(null)` → `closeModal()` → `sei.summon(pendingSummonId)` → `navigate({kind:'character', id})`. ESC: clears pending summon (in searching mode) and closes the modal. **No "Mark as connected" button** (D-23/D-57) — renderer never spoofs LAN state.

**`src/renderer/src/components/SummonToast.tsx`** — bottom-right 20px inset, 360px max-width, 14×18 padding. Background `var(--text)`, color `var(--window)`. 36px PixelPortrait + "Summoning {name}…" sans 13/600. Auto-dismiss after `DISMISS_MS = 4200`. Click-anywhere also dismisses. `role="status"` `aria-live="polite"`.

**`src/renderer/src/components/DeleteConfirmModal.tsx`** — 460px wide, sharp corners, scrim 0.45 black. Title "Delete {name}?". Body verbatim: "This permanently removes their persona, description, and saved memory. You can't undo this." Footer: `[Cancel (quiet), Delete {name} (red bg, --window text)]`. ESC invokes `onCancel`. Delete button is rendered as a plain `<button>` styled in `DeleteConfirmModal.module.css` (the Button primitive doesn't expose --red overrides).

### Task 2 — LogsPanel (virtualized terminal-style log viewer)

**`src/renderer/src/components/LogsPanel.tsx`** — reads `useDataStore.logs` (5000-line ring buffer, store-level subscription per RESEARCH §Resolved Q5) and `useDataStore.dropped` (Pitfall-7 backpressure sentinel).

Constants:
- `VIRT_THRESHOLD = 500` — below this, render every line.
- `WINDOW_SIZE = 200` — render window for virtualized mode.
- `PIN_THRESHOLD = 80` — px from bottom to count as "pinned".
- `APPROX_LINE_PX = 18` — line height for virt scroll math.

Header: `[Copy all (ghost sm), Pause autoscroll (quiet sm)]`. Pause label flips to "Resume" when paused. Copy all dumps `logs.map(l => l.message).join('\n')` to `navigator.clipboard.writeText`.

Each log line: `<div style={{color: tagLog(message).color}}>{message}</div>` — mono 12 / line-height 1.55 / `white-space: pre`. Color tags via `tagLog()`:
- `[chat->]` / `[chat<-]` → `--accent`
- `[haiku!]` → `--text`
- `[haiku?]` → `--text-2`
- `[error]` / `ERROR` → `--red`
- `[warn]` / `WARN` → `--warn`
- default → `--text-2`

Scroll-pinned: when `scrollHeight - scrollTop - clientHeight ≤ PIN_THRESHOLD`, autoScroll resumes; otherwise it pauses. When paused, new appended lines accumulate into `newSinceScroll`, surfacing the "↓ {N} new lines" pill (bottom-right of panel) — clicking jumps to bottom and resumes.

When `dropped > 0`, a muted footer line shows "({N} lines dropped due to backpressure)".

T-04-34 mitigation: lines are passed as text children — React auto-escapes; no innerHTML.

### Task 3 — CharacterPage + SettingsScreen + App.tsx wiring

**`src/renderer/src/screens/CharacterPage.tsx`** — Two-column 320 + 1fr, 36px gap. Padding 24×40×40. Reads `character` from `useDataStore.characters.find((c) => c.id === id)`; if missing, calls `useDataStore.refreshCharacter(id)` (T-04-37). If still missing, renders "Character not found" + Back-to-Home.

Constants: `MODEL_ID = 'claude-haiku-4-5-20251001'`.

Helpers: `fmtMs(ms)` (s / m / h m), `fmtDate(iso)` (locale month/day/year), `fmtUptime(uptimeMs)` (m s / h m).

**Left column (320px):**
- `.portraitCard` 320×320 with PixelPortrait (`seed = id+name`, `palette = pickPalette(seed, theme)`).
- Stacked CTAs:
  - When `summon.kind === 'online' && summon.characterId === id`: "Stop" Button (kind=ghost, lg, fullWidth) → `sei.stop()`.
  - Otherwise: "Summon into Minecraft" Button (kind=accent, lg, fullWidth, `<SparkleIcon size={14} />`). Click flow:
    - `lan.kind === 'connected'` → `sei.summon(id)` directly.
    - Otherwise → `setPendingSummon(id)` + `openModal({kind:'lan', mode:'searching'})`.
  - Disabled while `summon.kind === 'connecting'` (and not active for this id).
- Secondary row (gap 10): "Edit persona" (ghost md, **disabled** with `title="Edit coming soon"` per CONTEXT scope) + "Delete" (ghost md with `--red` color override). Delete is **hidden** when `id === 'sui'` (D-49). Click → `setConfirmingDelete(true)` → DeleteConfirmModal → on confirm: `await sei.deleteCharacter(id)` → `removeCharacter(id)` → `navigate({kind:'home'})`.

**Right column:**
- Eyebrow: "DEFAULT" (id===sui) / "CUSTOM" — mono 11.
- H1: pixel 30, character name, letter-spacing 1.
- Tabs: Description / Persona prompt / Logs. Logs tab is `aria-disabled` + `tabIndex=-1` + label "Logs · Available while summoned" unless `summon.kind === 'online' && summon.characterId === id`. An effect resets `tab` to 'description' if Logs becomes disabled mid-view.
- **Description tab:** card with eyebrow "DESCRIPTION" + "For you" tag + body sans 15/400 line-height 1.6 `whiteSpace: pre-wrap`. '—' shown when description empty.
- **Persona prompt tab:** card with eyebrow "PERSONA PROMPT" + ("Hidden" or "Sent to {MODEL_ID}") + Show/Hide accent mono toggle. Collapsed by default (D-50). Expanded: `.cardExpanded` adds 2px accent left-border, `.personaBody` `<pre>` fades in (220ms `fade` keyframe).
- **Logs tab:** `<LogsPanel />` (in a 360px height wrap) when active; "Logs available while summoned" stub otherwise.
- Stats grid (3 cols, gap 12): "LAST LAUNCHED" / "TOTAL PLAYTIME" / "CREATED". `fmtMs(0)` → '—' for never-summoned (D-51).
- Model row (D-52): 8×8 round dot + label + mono `MODEL_ID`. States:
  - online → green + "Online · {fmtUptime}".
  - error  → red + `summon.message` (raw — plan 09 will swap to `ERROR_COPY[summon.error]`) + "TRY AGAIN" link → re-issue summon.
  - connecting → warn + "Connecting…".
  - idle → green + "Ready".

**`src/renderer/src/screens/SettingsScreen.tsx`** — Padding 32×40×40, max-width 720. BackIcon "Back" + h1 "Settings".

- **ACCOUNT section** (mono eyebrow): rows for "Minecraft username" (mono value), "Preferred name" (sans value), "Provider" (sans value, capitalized), "API key" (24 bullets when `hasKey`, else "Not set"). Loads via `sei.getConfig()` + `sei.hasApiKey()` on mount. Never reveals plaintext.
- **APPEARANCE section**: "Theme" + ghost-sm Button with Sun/Moon icon. `toggleTheme` writes resolved 'light'/'dark' (no 'system' from this toggle per UI-SPEC §Theme toggle), updates `useUiStore.themeMode`, calls `applyTheme()`, saves via `sei.saveConfig({...cfg, theme_mode: next})`.
- **SETUP section**: "Re-run onboarding" + primary-sm "Start over" Button → `navigate({kind:'onboarding', isReonboard: true})`.

**`src/renderer/src/App.tsx`** — Imports `CharacterPage`, `SettingsScreen`, `LanModal`, `SummonToast`. Removes both placeholder components and wires the real screens for `view.kind === 'character'` and `view.kind === 'settings'`.

Modal layer: rendered as a sibling to `<MacosWindow>` (so the scrim covers the chrome). Renders `<LanModal mode={modal.mode} />` when `modal?.kind === 'lan'`.

Toast layer: a single `useState<{id,name}|null>` watched by an effect on `useDataStore.summon`. When `summon.kind === 'online'` and `summon.characterId !== lastToastedSummonId`, resolves the character name from `useDataStore.characters` and sets the toast. `lastToastedSummonId` resets to null on idle/error so a future summon emits a fresh toast.

## Plan-level Verification — `<verification>` block

| Check | Result |
| ----- | ------ |
| All 12 new files exist (6 components × 2 + 2 screens × 2) | PASS |
| Task 1 grep gates (LanModal: 4 verbatim steps + Searching + Cancel summon + sei.summon + no Mark-as-connected; SummonToast: DISMISS_MS=4200 + role=status + aria-live=polite; DeleteConfirmModal: body copy + Escape) | PASS |
| Task 2 grep gates (VIRT_THRESHOLD=500 + WINDOW_SIZE=200 + PIN_THRESHOLD=80 + Copy all + Pause autoscroll + tagLog(entry.message) + clipboard.writeText + useDataStore + new lines + dropped) | PASS |
| Task 3 grep gates (CharacterPage: MODEL_ID + Summon into Minecraft + Available while summoned + isDefault + id==='sui' + sei.stop + sei.deleteCharacter + DeleteConfirmModal + LogsPanel + PERSONA PROMPT + DESCRIPTION + LAST LAUNCHED + TOTAL PLAYTIME + CREATED + TRY AGAIN; SettingsScreen: ACCOUNT + APPEARANCE + SETUP + Start over + isReonboard:true; App.tsx: imports CharacterPage/SettingsScreen/LanModal/SummonToast and removes both Placeholders) | PASS |
| `npx tsc --noEmit -p tsconfig.web.json` exits 0 | PASS — 0 lines |
| `npx tsc --noEmit -p tsconfig.node.json` exits 0 | PASS — 0 lines |

## Acceptance Criteria — Plan-level

- [x] CharacterPage shows portrait + persona-prompt (collapsed) + stats grid + model status row + tabs (Description / Persona prompt / Logs).
- [x] Logs tab is enabled only when this character is the active summon — disabled stub otherwise.
- [x] LogsPanel renders virtualized log lines from `useDataStore.logs` (5000-line ring buffer) with color-tagging, copy-all, pause-autoscroll.
- [x] Summon button on CharacterPage calls `sei.summon(id)` when LAN connected, or opens LAN modal in searching mode otherwise; status row reflects summon state via `useDataStore.summon`.
- [x] Stop button visible while online; calls `sei.stop()`.
- [x] LAN modal shows 4 numbered steps + live connected/not_connected pill + "Searching…" row when in searching mode + auto-dismiss on `lan:state → connected`.
- [x] Delete character flow: confirm modal with red Delete button; refuses delete on default Sui (button hidden); calls `sei.deleteCharacter` then navigates to Home.
- [x] SettingsScreen shows account / appearance / setup sections with Re-run onboarding.
- [x] SummonToast appears at bottom-right for 4.2s when summon transitions to online.
- [x] LogsPanel reads logs from `useDataStore` (store-level subscription, NOT component-local) — store wired in plan 06's `subscribeIpc()`.

## Deviations from Plan

### Auto-fixed Issues

None — the plan was executed as written. Two minor implementation choices documented in `key_decisions` (toast on `online` not `connecting`; LogsPanel scrollTop-vs-IntersectionObserver) are within the plan's `<action>` latitude (the action references react-virtuoso OR hand-rolled IntersectionObserver windowing — both are technique-class names for the same windowed-render contract).

### Out-of-scope items deferred

**1. ERROR_COPY map for raw error strings** — CharacterPage model row shows `summon.message` raw when `summon.kind === 'error'`; SettingsScreen.toggleTheme catch path uses `console.error`. Plan 09 ships `src/renderer/src/lib/errors.ts` with `ERROR_COPY: Record<ErrorClass, string>`; replace at both sites.

**2. Edit persona flow** — Per CONTEXT scope, full Edit flow is deferred. CharacterPage renders the button as `disabled` with `title="Edit coming soon"`. When Edit ships, remove the disabled attribute and wire to a navigate target (likely a re-use of AddCharacterScreen with a new `editId` prop).

**3. `playtime_ms` accumulator** — bot must emit a final playtime delta on summon-stopped; main's botSupervisor needs to extend `sei.saveCharacter({...c, playtime_ms: prev + delta})` so CharacterPage's TOTAL PLAYTIME stat reflects accumulated time. CharacterPage already renders '—' for `playtime_ms === 0` (D-51); the wiring is bot+main side and tracked for plan 09 / verified in plan 11.

**4. Onboarding step-4 raw error display** (carried over from plan 07 SUMMARY) — same plan-09 ERROR_COPY swap.

### Authentication Gates

None. (No external services touched. Settings.toggleTheme writes config.json; CharacterPage IPC calls — summon/stop/deleteCharacter — go through main's already-validated handlers.)

## Notes for Plan 09 Executor (errors)

- **Three raw-string error displays to swap with ERROR_COPY map:**
  1. `src/renderer/src/screens/CharacterPage.tsx` `modelLabel` ternary — `isErrored` branch shows `summon.message`. Replace with `ERROR_COPY[summon.error] ?? summon.message`.
  2. `src/renderer/src/screens/SettingsScreen.tsx` `toggleTheme` catch — currently `console.error`. Surface in a small inline toast or row hint with `ERROR_COPY[errorClass]`.
  3. `src/renderer/src/screens/CharacterPage.tsx` `handleConfirmDelete` catch — currently `console.error`. Should surface in DeleteConfirmModal as a body-line replacement (or, easier, a follow-up toast).
- **Two raw-string error displays carried from plan 07** — OnboardingScreen step 4 + AddCharacterScreen step 2 (already noted in 04-07-SUMMARY.md).

## Notes for Plan 11 Executor (clean-VM smoke)

- Full flow to verify: install → onboard → add character → click Summon (LAN not connected) → LAN modal opens in searching mode with Cancel summon visible → open Minecraft, open to LAN → modal auto-dismisses → SummonToast fires → status row shows "Connecting…" → "Online · {uptime}" → click Logs tab (enabled) → log lines stream in (auto-scroll pinned to bottom) → scroll up → "↓ N new lines" pill appears → click Stop → status returns to "Ready" → navigate Home → click character → click Delete → confirm modal → red "Delete {name}" → home.
- For default Sui: verify Delete button is **never rendered** (D-49). Edit persona button is rendered but `disabled` with title "Edit coming soon".
- Theme toggle in Settings: light↔dark flips visually instantly, persists across reloads (read from `cfg.theme_mode` on next boot).
- Re-run onboarding: Settings → Start over → onboarding step 0 with Back enabled (returns to Settings, not the cancel/no-back behavior of fresh-install).

## Threat Flags

None new this plan. Per the plan's `<threat_model>`:

| Threat ID | Mitigation in this plan |
| --------- | ----------------------- |
| T-04-34 (logs containing scripty content rendered in DOM) | mitigate — LogsPanel uses React text rendering (auto-escapes); no `innerHTML`. |
| T-04-35 (persona-prompt visible without consent) | mitigate — CharacterPage persona-prompt collapsed by default (D-50); explicit Show toggle, eyebrow companion reads "Hidden" until expanded. |
| T-04-36 (clipboard "Copy all" on 5000 lines) | accept — browsers handle large clipboard fine; user-initiated action. |
| T-04-37 (renderer summons a deleted character via stale state) | mitigate — `useDataStore.refreshCharacter` on CharacterPage mount; main's `getCharacter` returns null on missing → renderer shows "Character not found". |

No NEW security-relevant surface introduced. All IPC calls in this plan (`summon`, `stop`, `deleteCharacter`, `getConfig`, `saveConfig`, `hasApiKey`) were already on the contract surface from plan 02/05.

## Self-Check: PASSED

Verified files exist:
- FOUND: src/renderer/src/components/LanModal.tsx + .module.css
- FOUND: src/renderer/src/components/SummonToast.tsx + .module.css
- FOUND: src/renderer/src/components/DeleteConfirmModal.tsx + .module.css
- FOUND: src/renderer/src/components/LogsPanel.tsx + .module.css
- FOUND: src/renderer/src/screens/CharacterPage.tsx + .module.css
- FOUND: src/renderer/src/screens/SettingsScreen.tsx + .module.css
- MODIFIED: src/renderer/src/App.tsx

Verified commits exist in git log:
- FOUND: 679e432 (Task 1 — LanModal + SummonToast + DeleteConfirmModal)
- FOUND: e98fd40 (Task 2 — LogsPanel)
- FOUND: bbcbe72 (Task 3 — CharacterPage + SettingsScreen + App.tsx wiring)

Verified plan-level checks:
- `npx tsc --noEmit -p tsconfig.web.json` exits 0 with 0 lines of output.
- `npx tsc --noEmit -p tsconfig.node.json` exits 0 with 0 lines of output.

---
*Phase: 04-electron-gui-packaging*
*Completed: 2026-05-08*
