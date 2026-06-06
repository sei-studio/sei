---
quick_id: 260508-mun
mode: quick
type: execute
description: Electron GUI UI fixes (sidebar gating, Sui edit lockdown, Edit modal, Logs bar, Settings inline edit, back-button align, double-name, wave gradient) + debug bot:summon utilityProcess exit-before-ready regression
files_modified:
  - src/renderer/src/App.tsx
  - src/renderer/src/components/IconRail.tsx
  - src/renderer/src/components/CharacterCard.tsx
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/screens/CharacterPage.module.css
  - src/renderer/src/screens/SettingsScreen.tsx
  - src/renderer/src/screens/SettingsScreen.module.css
  - src/renderer/src/components/EditCharacterModal.tsx
  - src/renderer/src/components/EditCharacterModal.module.css
  - src/renderer/src/components/LogsBar.tsx
  - src/renderer/src/components/LogsBar.module.css
  - src/renderer/src/styles/global.css
  - src/main/botSupervisor.ts
  - src/bot/index.js
autonomous: false
must_haves:
  truths:
    - "During onboarding, the IconRail sidebar is hidden (or its nav is fully blocked) so clicking 'Home' cannot abandon onboarding."
    - "The Sui character (id === 'sui') has no Edit button and no Persona-prompt edit affordance."
    - "The standalone 'Persona prompt' tab and 'Logs' tab on CharacterPage no longer exist."
    - "Clicking 'Edit' on a non-Sui character opens a modal that edits name, description, and persona prompt and persists the changes."
    - "A collapsed Log bar lives at the bottom of the app shell; clicking it expands the LogsPanel; clicking again collapses it."
    - "Each CharacterCard renders the character name exactly once (the 'Ready Start' / pixel-font version)."
    - "Settings shows inline editable fields for the same data the onboarding wizard collects (mc_username, preferred_name, provider, API key); the 'Re-run onboarding / Start over' row is removed."
    - "The Settings 'Back' button is left-aligned, not center-aligned."
    - "The app body background renders a subtle wavy gradient using a near-shade of --desktop; it is faint and does not interfere with foreground readability."
    - "Clicking Summon successfully launches the bot utilityProcess to summon-ready, OR if it still fails the executor has captured a concrete root-cause log line and committed a targeted fix."
  artifacts:
    - path: "src/renderer/src/components/EditCharacterModal.tsx"
      provides: "Modal component for editing character name/description/persona prompt"
    - path: "src/renderer/src/components/LogsBar.tsx"
      provides: "Collapsible bottom log bar wrapping LogsPanel"
    - path: "src/renderer/src/screens/SettingsScreen.tsx"
      provides: "Settings with inline editing (no re-run-onboarding flow)"
  key_links:
    - from: "App.tsx"
      to: "IconRail"
      via: "conditional render — hide rail when view.kind === 'onboarding'"
    - from: "CharacterPage"
      to: "EditCharacterModal"
      via: "Edit button onClick → setEditing(true); modal calls sei.saveCharacter() then refreshCharacter()"
    - from: "App.tsx"
      to: "LogsBar"
      via: "render below the IconRail+main row, full-width, inside MacosWindow body"
---

<objective>
Bundle of Phase-4 follow-up GUI fixes plus a regression in the bot:summon utilityProcess. Restructures CharacterPage (drops two tabs, adds Edit modal), reworks Settings (inline edit, left-align back), gates the sidebar during onboarding, adds a collapsible bottom Log bar, polishes CharacterCard (single name) and the body background (subtle wave gradient), and root-causes + fixes the "Bot exited before summon-ready (code=1)" regression introduced after the Phase-4 cutover.

Purpose: deliver the UX polish and bug-fix bundle the user requested in one quick batch.
Output: working dev build where Summon succeeds and every UI item above is visually confirmed in `npm run dev`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/04-electron-gui-packaging/04-UI-SPEC.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@src/renderer/src/App.tsx
@src/renderer/src/components/IconRail.tsx
@src/renderer/src/components/CharacterCard.tsx
@src/renderer/src/screens/CharacterPage.tsx
@src/renderer/src/screens/SettingsScreen.tsx
@src/renderer/src/components/LogsPanel.tsx
@src/renderer/src/styles/global.css
@src/main/botSupervisor.ts
@src/bot/index.js
@src/shared/characterSchema.ts
@src/shared/ipc.ts
@src/preload/index.ts

<interfaces>
<!-- Extracted contracts the executor needs. Use these directly — no codebase exploration needed for these. -->

From src/renderer/src/lib/stores/useUiStore.ts:
```ts
export type View =
  | { kind: 'loading' }
  | { kind: 'onboarding'; isReonboard: boolean }
  | { kind: 'home' }
  | { kind: 'add-character' }
  | { kind: 'character'; id: string }
  | { kind: 'settings' }
  | { kind: 'coming-soon' };
// store also exposes: navigate, openModal, closeModal, setThemeMode, setPendingSummon
```

From src/renderer/src/lib/stores/useDataStore.ts (verify exact API by reading file):
- characters: Character[]
- summon: { kind: 'idle' | 'connecting' | 'online' | 'error'; ... }
- logs: LogEntry[]
- loadCharacters(), refreshCharacter(id), removeCharacter(id)

From src/shared/characterSchema.ts (read it to confirm field names):
- Character has at minimum: id, name, description, persona_prompt, portrait_image?, last_launched, playtime_ms, created
- UserConfig has: mc_username, preferred_name, provider, theme_mode, ...

From src/preload/index.ts → window.sei (read it; relevant for this plan):
- sei.getConfig(), sei.saveConfig(cfg)
- sei.hasApiKey(), sei.saveApiKey(key) (or similar — verify exact name)
- sei.getCharacter(id), sei.saveCharacter(c) (or sei.upsertCharacter — verify)
- sei.summon(id), sei.stop(), sei.deleteCharacter(id)
- sei.getStartupWarnings()
- onLog / onStatus / onLan push subscriptions

From src/main/botSupervisor.ts (lines 240–360):
- utilityProcess.fork(botEntryPath(), [], { stdio: 'pipe', serviceName, env })
- summonPromise rejects on child.exit before summon-ready with: `Bot exited before summon-ready (code=${code})`
- bot child must post {type:'init-ack'} → {type:'summon-ready'} on the MessagePort

From src/bot/index.js (lines 217–233):
- Electron path: process.parentPort.once('message', ...) receives ports[0], then on 'init' calls bootstrapWithInit(data).
- bootstrapWithInit emits {type:'init-ack'}, then await start(config), then {type:'summon-ready'} (or {type:'error', error:'BOT_CRASH'} on throw).
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Onboarding/Settings shell — sidebar gating + inline-edit Settings + left-align Back</name>
  <files>
    src/renderer/src/App.tsx,
    src/renderer/src/screens/SettingsScreen.tsx,
    src/renderer/src/screens/SettingsScreen.module.css
  </files>
  <action>
    Implement items 1, 7, 8 from the request:

    (a) **Hide sidebar during onboarding (item 1).** In `App.tsx`, the row that renders `<IconRail />` + `<main>...` must conditionally omit `<IconRail />` when `view.kind === 'onboarding'`. Do NOT remove it for other views. Keep the existing flex layout shape (the `<main>` should continue to fill width). Do not delete the IconRail component — only its render gate. The MacosWindow chrome (title bar) and Banner remain visible.

    (b) **Inline edit in Settings (item 7).** Rewrite `SettingsScreen.tsx`:
      - Remove the entire `SETUP / Re-run onboarding / Start over` section.
      - Convert the ACCOUNT section rows from read-only labels to inline-editable fields:
        - **Minecraft username** — TextField (existing `<TextField />` primitive in `src/renderer/src/components/TextField.tsx`); update `cfg.mc_username` on change; debounce-or-on-blur call `sei.saveConfig({...cfg, mc_username})`. Use on-blur save (simpler, no debounce needed) and a "Saved" / "Saving…" subtle status row beneath each field is OPTIONAL; minimum bar = on-blur save with error toast on failure.
        - **Preferred name** — TextField, same pattern → `cfg.preferred_name`.
        - **Provider** — keep as read-only (it's "anthropic" only in v1 per current code; do not add a picker).
        - **API key** — show the bullet placeholder when `hasKey === true`, AND add an "Update" Button (`kind="ghost" size="sm"`) that reveals an inline TextField (type="password" — verify TextField supports it; if not, pass an HTML password attribute through). On Save (button or Enter), call `sei.saveApiKey(value)` (verify exact preload method name from `src/preload/index.ts`), then re-fetch `hasApiKey()` and collapse the editor. On cancel, just collapse.
      - Wire all save calls with try/catch; on error log via console.error and surface a Banner-style inline error if there's a clean way (otherwise console-only for v1).
      - Keep the APPEARANCE section exactly as is (theme toggle).

    (c) **Left-align the Back button (item 8).** Root cause: `SettingsScreen.module.css .root` is `display:flex; flex-direction:column` with default `align-items:stretch`, so the Button (which has `justify-content:center` internally) stretches full-width and centers its text. Fix by EITHER:
       - Adding `align-items: flex-start` to `.root` AND wrapping any other rows that need full-width with their own width-stretching wrapper, OR (simpler)
       - Wrapping ONLY the Back Button in a `<div className={styles.backRow}>` with `align-self: flex-start` (or `display: flex; justify-content: flex-start`), leaving the rest of the layout untouched.

       Pick the second option (less risk of regressing section row layouts). Add `.backRow { align-self: flex-start; }` to the CSS module.

    (d) Update the JSDoc header comment on `SettingsScreen.tsx` to reflect the new behavior (no more re-run-onboarding flow; account is inline-editable).

    Self-check: read `src/renderer/src/components/TextField.tsx` and `src/preload/index.ts` BEFORE writing the new SettingsScreen, so all method names and prop signatures are correct on the first pass.
  </action>
  <verify>
    <automated>npm run build 2>&1 | tail -20 # must complete without TS or vite errors</automated>
  </verify>
  <done>
    - `view.kind === 'onboarding'` no longer renders IconRail.
    - SettingsScreen has editable fields for mc_username, preferred_name, and API key (Update flow); the SETUP/re-run-onboarding row is gone.
    - The Back button visually sits flush to the left edge of the Settings content padding (not centered).
    - `npm run build` succeeds.
  </done>
</task>

<task type="auto">
  <name>Task 2: Persona/Character UI restructure — drop tabs, Edit modal, hide Sui edit, dedupe card name</name>
  <files>
    src/renderer/src/screens/CharacterPage.tsx,
    src/renderer/src/screens/CharacterPage.module.css,
    src/renderer/src/components/CharacterCard.tsx,
    src/renderer/src/components/EditCharacterModal.tsx,
    src/renderer/src/components/EditCharacterModal.module.css
  </files>
  <action>
    Implement items 2, 3, 4, 6:

    (a) **Remove Persona prompt tab + Logs tab from CharacterPage (item 3).**
      - In `CharacterPage.tsx`, drop the `Tab` union to just `'description'` (or remove the tab state entirely if Description is the only remaining content). Delete the tablist `<button>` elements for "Persona prompt" and "Logs", the `expandedPersona` state, and the `tab === 'persona'` / `tab === 'logs'` render branches.
      - Keep the Description card.
      - The `LogsPanel` import becomes unused — remove it (the new bottom LogsBar in Task 3 will own logs rendering).
      - Remove the now-unused `logsTabEnabled`, `MODEL_ID` is still used by the model row — keep that.

    (b) **Edit Persona → Edit modal (items 2, 4).**
      - Create `src/renderer/src/components/EditCharacterModal.tsx` (and matching `.module.css`). Pattern after `LanModal.tsx` / `DeleteConfirmModal.tsx` for backdrop/escape-handling/portal idioms — read both before writing the new modal.
      - Props: `{ character: Character; onClose: () => void; onSaved?: (updated: Character) => void }`.
      - Fields: name (TextField), description (textarea — use a `<textarea>` styled to match TextField if no Textarea primitive exists; check src/renderer/src/components/ first), persona_prompt (multi-line textarea, monospace, ~12 rows).
      - Save: call `sei.saveCharacter({ ...character, name, description, persona_prompt })` (verify exact preload method name — likely `sei.upsertCharacter` or `sei.saveCharacter`). On success: `useDataStore.getState().refreshCharacter(character.id)` then `onClose()`. On error: show inline error in the modal (do not crash).
      - Cancel: `onClose()` without saving. ESC key closes the modal.
      - Validation: name must be non-empty trimmed; persona_prompt must be non-empty trimmed (description may be empty). Use `characterSchema` from `src/shared/characterSchema.ts` if it exposes a Zod schema you can `.safeParse()` against; otherwise inline checks.

      In `CharacterPage.tsx`:
      - Replace the existing `<Button kind="ghost" size="md" disabled title="Edit coming soon">Edit persona</Button>` with `<Button kind="ghost" size="md" onClick={() => setEditing(true)} disabled={isDefault}>Edit</Button>`. Note: button label is exactly "Edit" (item 4).
      - Render the modal: `{editing ? <EditCharacterModal character={character} onClose={() => setEditing(false)} /> : null}`.
      - **Hide for Sui (item 2):** when `isDefault` (i.e., `character.id === 'sui'`), do NOT render the Edit button at all. Use `{!isDefault ? <Button…/> : null}` rather than relying on `disabled`. The standalone Persona-prompt tab is already gone (per (a)), which also satisfies "hide persona prompt for Sui" since there's nothing to hide. Confirm by reading the file post-change that no persona-prompt UI is reachable for Sui.

    (c) **Dedupe character name on CharacterCard (item 6).**
      In `src/renderer/src/components/CharacterCard.tsx` the name renders twice:
       - `.nameOverlay` (pixel-font, on portrait) — KEEP
       - `.infoName` in the `.infoRow` below (sans-serif) — REMOVE the `<div className={styles.infoName}>{c.name}</div>` line
      Adjust the `.infoRow` to render only the `formatLast(...)` meta text (and keep the `<ArrowIcon />` chevron). If the row looks empty/awkward without the name, reduce its padding or rebalance the flex; otherwise leave the visual rebalancing as a follow-up. Do NOT delete `.infoName` from the CSS (harmless), but you may.

    (d) Update the JSDoc header on `CharacterPage.tsx` (currently mentions Persona/Logs tabs and "Edit persona is intentionally a no-op v1 placeholder") to reflect the new structure.
  </action>
  <verify>
    <automated>npm run build 2>&1 | tail -20</automated>
  </verify>
  <done>
    - CharacterPage has no "Persona prompt" tab and no "Logs" tab.
    - Clicking "Edit" on a non-Sui character opens a modal with editable name/description/persona_prompt; saving updates the character and the page reflects it.
    - Sui (id==='sui') has no Edit button rendered.
    - CharacterCard renders the name once (pixel-font overlay only); the sans-serif duplicate beneath the portrait is gone.
    - Build succeeds.
  </done>
</task>

<task type="auto">
  <name>Task 3: Layout polish — collapsible bottom Log bar + subtle wave gradient background</name>
  <files>
    src/renderer/src/components/LogsBar.tsx,
    src/renderer/src/components/LogsBar.module.css,
    src/renderer/src/App.tsx,
    src/renderer/src/styles/global.css
  </files>
  <action>
    Implement items 5 and 10:

    (a) **Collapsible bottom Log bar (item 5).**
      - Create `LogsBar.tsx`:
        - Local state `const [open, setOpen] = useState(false)`.
        - When `open === false`: render a thin bar (~28-32px tall) spanning the full content width, fixed to the bottom of the MacosWindow body. Show a small monospace label like `LOGS` plus the last log line preview (truncated, single line) and a chevron-up affordance. Click anywhere on the bar toggles `open`.
        - When `open === true`: render the bar header (now with chevron-down) + a `<LogsPanel />` instance with a constrained height (e.g., 280px or 40vh). Click on the header collapses.
        - Use existing tokens (`var(--surface)`, `var(--border)`, `var(--mono)`, `var(--muted)`); match the visual language of LogsPanel and the existing wallpaper. Sharp corners (D-28).
        - Read `useDataStore((s) => s.logs)` only for the preview line in collapsed state (last entry's message). Don't subscribe heavily — just `logs.length > 0 ? logs[logs.length - 1].message : ''`.
      - Wire into `App.tsx`: render `<LogsBar />` as a sibling AFTER the `<div style={{ display:'flex', flex:1, minHeight:0 }}>` row that holds IconRail + main, but inside the same flex-column wrapper. So the column becomes: Banner (optional) → flex-row (IconRail + main) → LogsBar (always at bottom). Do NOT render LogsBar during onboarding (`view.kind !== 'onboarding'`) and do NOT render during loading (`view.kind !== 'loading'`).
      - Remove any direct `<LogsPanel />` import from CharacterPage (already done in Task 2). LogsPanel keeps its existing implementation; LogsBar wraps it.

    (b) **Subtle wave gradient background (item 10).**
      - Edit `src/renderer/src/styles/global.css`:
        - Keep the existing `body` `background: var(--desktop)`.
        - Augment the `body::before` rule (which currently holds the radial-gradient wallpaper) so it adds a faint repeating wave on top — done via an SVG data-URL background-image with low opacity, OR a stack of low-amplitude `repeating-linear-gradient` lines at a shallow angle. Recommended approach (stays in CSS, no asset file): add an `inline-svg url("data:image/svg+xml;utf8,...")` overlay with two sine-ish path strokes in `currentColor` at ~6-8% opacity, sized to cover, mixed with `background-blend-mode: soft-light` if it improves the read.
        - Required visual: the wave must be near-tone (use `var(--desktop)` shade only — same hue, slightly darker/lighter; opacity ≤ 0.08 light, ≤ 0.05 dark). It must NOT compete with foreground content; if it does, lower opacity or kill on dark theme.
        - Apply a separate dark-theme override under `:root[data-theme="dark"] body::before` so the wave reads correctly on dark.
        - Keep the existing radial-gradient ambience — layer the waves UNDER or beside it (use `background:` shorthand with multiple layers; the SVG wave goes last so it's on top of the radials, but at low opacity).
      - Validate at runtime that `pointer-events: none` is preserved on the pseudo-element (already set; do not remove).

    Acceptance for both: visual check during the Task 5 dev-server pass.
  </action>
  <verify>
    <automated>npm run build 2>&1 | tail -10 &amp;&amp; grep -q "LogsBar" src/renderer/src/App.tsx</automated>
  </verify>
  <done>
    - LogsBar component exists and is rendered in App.tsx for non-onboarding, non-loading views.
    - Collapsed bar shows a thin row with the latest log preview; clicking expands to show LogsPanel; clicking again collapses.
    - global.css `body::before` includes a subtle wave overlay tuned per theme; foreground text remains clearly readable.
    - Build succeeds.
  </done>
</task>

<task type="auto">
  <name>Task 4: Diagnose &amp; fix bot:summon utilityProcess exit-before-ready regression</name>
  <files>
    src/main/botSupervisor.ts,
    src/bot/index.js
  </files>
  <action>
    Goal: root-cause and fix the error
    `Error occurred in handler for 'bot:summon': Error: Bot exited before summon-ready (code=1) at ForkUtilityProcess.<anonymous> (file:///Users/ouen/slop/sei/dist/main/index.js:693:22)`.

    The supervisor's `child.on('exit', (code) => …)` is firing with code=1 BEFORE the bot child posts `{type:'summon-ready'}` over the MessagePort. That means one of:
      1. The bot module fails to load (ESM resolution / native ABI / missing dep) and the process exits during module evaluation — never reaches `process.parentPort.once('message',…)`.
      2. The bot loads but throws synchronously during `bootstrapWithInit` BEFORE `emitLifecycle({type:'init-ack'})` reaches the port (e.g., env-var or config validation throws inline).
      3. The bot's `start(config)` rejects, and the catch emits `{type:'error', error:'BOT_CRASH'}`, then the process exits — but the user sees the supervisor's exit-before-ready message, which means either (a) the lifecycle 'error' message arrived AFTER the exit, or (b) it never reached `port1` because `port2` was closed early.

    **Step 1 — Reproduce and capture diagnostics (do NOT skip).**
      - Run `npm run dev` and click Summon. Capture:
        - Main-process console output (stderr/stdout from the Electron parent).
        - The router-routed bot stdout/stderr (per supervisor.ts lines 268-276, all `child.stdout`/`stderr` lines pass through `router.append(line)` — they should appear in the renderer's log buffer once we surface them; but BEFORE summon-ready the LogsBar may not be open. Open DevTools (auto-opens in dev per commit 38ba1c9) and check the console as well).
        - The exit code printed in the supervisor's `child.on('exit', (code) =>…)` log line.
      - To force surface bot child output even when it crashes pre-port-bind, ADD a temporary diagnostic in `botSupervisor.ts`: in the `child.stdout?.on('data', …)` and `stderr` sinks, ALSO `console.error('[bot-stderr]', line)` (or stdout) so the Electron main terminal mirrors child output. Keep this diagnostic ON in this commit — it's useful debugging signal for v1.
      - Also augment the `child.on('exit', code)` handler to log the captured stderr buffer tail (`buffers.stderr`) before classifying, so the user's terminal shows the actual crash trace.

    **Step 2 — Inspect likely causes against the recent Phase-4 changes.**
      Compare against commit 38ba1c9 ("emit preload as .cjs and auto-open DevTools in dev"). Likely candidates:
       - **`botEntryPath()` resolution.** In dev, `__dirname` for `dist/main/index.js` is `<repo>/dist/main`, so `path.join(__dirname, '../bot/index.js')` resolves to `<repo>/dist/bot/index.js` — but `src/bot/index.js` is NOT bundled into dist (electron-vite only builds main/preload/renderer per `electron.vite.config.ts`). Verify this path actually resolves to a real file by `ls dist/bot/` after `npm run dev`. If `dist/bot/` does not exist, this is the bug — the supervisor must point to `path.join(repoRoot, 'src/bot/index.js')` or `__dirname/../../src/bot/index.js`. Fix by changing `botEntryPath()` for the dev branch (`!app.isPackaged`) to resolve to `src/bot/index.js` from the repo root (e.g., `path.join(__dirname, '../../src/bot/index.js')`).
       - **`type: "module"` + `.js` ESM vs utilityProcess.** `package.json` has `"type":"module"` and `src/bot/index.js` uses ESM imports. utilityProcess.fork supports ESM in recent Electron, but if there's an interop issue with mineflayer/native deps it would surface here. Check the captured stderr for "Cannot use import statement" or "ERR_REQUIRE_ESM".
       - **Native module ABI.** `better-sqlite3` was mentioned in Phase 4 plans. Check if it's actually a dep used at bot-startup; if `Cannot find module …node_gyp` or `NODE_MODULE_VERSION` mismatch appears, run `npm run postinstall` (which executes `electron-builder install-app-deps`) and re-test.
       - **Missing env dirs.** `paths.userData()` is passed in env. If the bot's `bootstrapWithInit` synchronously creates files in `memDir` without `mkdir -p`, it could throw before `init-ack`. Check `src/bot/index.js` lines 150-200 for any synchronous fs ops.

    **Step 3 — Apply the targeted fix.**
      Based on root cause from Steps 1-2, apply the minimum patch:
       - If it's the path issue: fix `botEntryPath()` and verify dev launch succeeds.
       - If it's ESM/native: rebuild deps (postinstall) and document in commit.
       - If it's a synchronous throw in bot bootstrap: wrap with a try/catch that emits `{type:'error',…}` and `await new Promise(r=>setTimeout(r,50))` before letting the process exit, so the lifecycle message reaches port1.

    **Step 4 — Hardening (orthogonal to root cause).**
      Independent of the immediate fix, harden the supervisor's exit-before-ready path so future regressions surface a useful message:
       - In `child.on('exit', (code) => …)`, include the last 1KB of `buffers.stderr` (or the latest stderr line) in the `message` field so the renderer's Banner shows actionable text. Keep the ErrorClass classification as-is.
       - In `bot/index.js` Electron path: wrap the `process.parentPort.once('message', …)` handler body in try/catch; on caught exception, `console.error('[sei-bot]', err.stack)` and `process.exit(1)` only after a 50ms grace so the parent's stderr sink captures the trace.

    **Step 5 — Confirm fix.**
      Repeat the Summon flow in `npm run dev`. Required outcome: summon completes (status flips to 'online' OR — if the LAN/world is not actually open, status flips to a clear 'LAN_NOT_OPEN' / explicit error class with plain-English copy). The original generic "Bot exited before summon-ready (code=1)" must NOT appear when the world IS open and a key IS present. If you cannot reproduce a successful summon because the developer machine has no LAN world available, document that in the SUMMARY and require the human checkpoint (Task 5) to confirm against a live world.

    Self-check: do NOT prescribe a code change before completing Steps 1-2. The root cause may be different from any of the above guesses; capture the actual stderr first.
  </action>
  <verify>
    <automated>npm run build 2>&1 | tail -10</automated>
  </verify>
  <done>
    - Root cause is identified in writing (commit message + SUMMARY).
    - Targeted fix applied.
    - Supervisor exit-before-ready handler now includes child stderr tail in the message field.
    - Build succeeds.
    - Visual confirmation deferred to Task 5 checkpoint.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 5: Human verification — full UI walk + Summon end-to-end</name>
  <what-built>
    All 10 items from the request bundle:
      1. Sidebar hidden during onboarding
      2. Sui has no Edit/persona-prompt edit affordance
      3. Persona-prompt + Logs tabs removed from CharacterPage
      4. Edit modal (name/description/persona_prompt) functional
      5. Collapsible Log bar at bottom
      6. CharacterCard shows name once (pixel font)
      7. Settings inline editing replaces re-run-onboarding
      8. Settings Back button is left-aligned
      9. bot:summon regression diagnosed and fixed
      10. Subtle wave gradient on body background
  </what-built>
  <how-to-verify>
    Start the dev server in one terminal: `npm run dev` (Electron auto-opens DevTools).

    UI walkthrough (no Minecraft world needed for items 1-8, 10):
      1. **Onboarding sidebar (item 1).** Wipe the API key (or run on a fresh user-data dir; `sei.deleteApiKey()` from DevTools console if exposed, OR clear the keychain entry, OR delete `~/Library/Application Support/sei/config.json` and restart). On boot, Onboarding screen should render WITHOUT the IconRail on the left. There must be no visible Home / Minecraft / Settings buttons during onboarding. After completing onboarding, the sidebar reappears on Home.
      2. **Settings inline edit + back align (items 7, 8).** From Home click Settings. Confirm:
         - "Re-run onboarding / Start over" row is GONE.
         - mc_username and preferred_name are TextFields you can type into; on blur the value persists (close & re-open Settings; values stick).
         - "API key" row has bullets + an "Update" button. Click Update, paste a new key (use a dummy `sk-test-...`), Save → bullets should re-render.
         - Back button is flush against the left padding edge (not centered).
      3. **CharacterCard dedupe (item 6).** Home shows character cards. Each card displays the character name exactly once, in the pixel font, overlaid on the portrait. The sans-serif duplicate beneath the portrait is gone.
      4. **CharacterPage tab removal + Edit modal (items 2, 3, 4).** Open Sui's character page. Confirm: only the "Description" content is visible (no Persona-prompt or Logs tabs). NO Edit button is rendered for Sui. Open a non-Sui character. Confirm "Edit" button (label "Edit", not "Edit persona") is present. Click → modal opens with name, description, persona_prompt fields prefilled. Edit name, save, modal closes, header reflects new name.
      5. **Bottom Log bar (item 5).** On Home / CharacterPage / Settings (NOT during onboarding/loading), a thin bar is anchored to the bottom of the window showing "LOGS" + (if any logs) the latest line preview. Click → expands to a constrained-height log view (~280-40vh). Click header again → collapses.
      6. **Wave gradient (item 10).** Switch theme between light and dark. The body background shows a faint, low-contrast wave pattern in both themes; it does NOT make foreground text harder to read.

    End-to-end summon (item 9) — REQUIRES a live LAN world:
      7. Open Minecraft, open a world to LAN, note the port. With Sei running and an API key set, click Summon on Sui. Expected: status row flips to "Connecting…" then "Online · …". The bot should join the world and respond in chat. If it fails, the error message in the Banner should be plain English (e.g., "No LAN world detected" / "Invalid API key") — NOT the raw "Bot exited before summon-ready (code=1)" string.

    Report any failures with: which item, what you saw, what you expected, the relevant DevTools console line, and the relevant Electron-main terminal line.
  </how-to-verify>
  <resume-signal>Type "approved" if everything works, or describe issues per-item.</resume-signal>
</task>

</tasks>

<verification>
- `npm run build` succeeds (Tasks 1-4 each verify this).
- `npm run dev` launches without console errors at boot.
- Each of the 10 items above passes the human verification walkthrough in Task 5.
- For item 9 specifically: the SUMMARY file documents the root cause and the targeted patch.
</verification>

<success_criteria>
- All 10 items implemented and visually confirmed by the user.
- bot:summon completes successfully against a live LAN world (or, if the developer can't test against a live world, the executor records the root cause + applied fix and the user confirms in Task 5).
- No regressions: existing onboarding flow, character creation, theme toggle, summon-toast, LAN modal, delete-confirm flow all still work.
</success_criteria>

<output>
After completion, write `.planning/quick/260508-mun-make-ui-and-debug-fixes-to-electron-gui-/260508-mun-SUMMARY.md` covering:
  - Each item, files touched, brief description.
  - Item 9 (summon bug): root cause in plain English, the diagnostic evidence (stderr line(s) captured), the fix applied, and any hardening added to the supervisor.
  - Anything deferred or surprises.
</output>
