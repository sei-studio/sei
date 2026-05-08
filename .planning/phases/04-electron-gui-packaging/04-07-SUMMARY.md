---
phase: 04-electron-gui-packaging
plan: 07
subsystem: renderer-screens
tags: [react, css-modules, zustand, onboarding, home-grid, character-add, slug, mask-image]
dependency_graph:
  requires:
    - phase: 04-electron-gui-packaging plan 01
      provides: "tsconfig.web.json paths (@, @shared)"
    - phase: 04-electron-gui-packaging plan 02
      provides: "@shared/characterSchema (Character, UserConfig) + @shared/ipc (RendererApi)"
    - phase: 04-electron-gui-packaging plan 05
      provides: "window.sei contextBridge (saveConfig, saveApiKey, saveCharacter, summon, getConfig)"
    - phase: 04-electron-gui-packaging plan 06
      provides: "primitives (Button, TextField, StepDots, PixelPortrait, icons), useUiStore (View / Modal / pendingSummonId), useDataStore (characters / lan), pickPalette, applyTheme, App.tsx skeleton with placeholders"
  provides:
    - "src/renderer/src/lib/slug.ts — slugify(name, existingIds): kebab-case id with collision-safe -2/-3"
    - "src/renderer/src/components/SeiPixelMark.tsx — inline mask-image recolored Sei wordmark (height + color props)"
    - "src/renderer/src/components/QuestionShell.{tsx,module.css} — 520px-wide step shell (eyebrow / title / hint / field / Back+StepDots+Next footer)"
    - "src/renderer/src/components/ProviderTiles.{tsx,module.css} — 2x2 picker; Anthropic enabled, others aria-disabled with 'Coming soon' chip (D-26)"
    - "src/renderer/src/components/AddCard.{tsx,module.css} — dashed 'New character' tile (ends home grid)"
    - "src/renderer/src/components/CharacterCard.{tsx,module.css} — hover-overlay grid card with PixelPortrait + sparkle Summon button (D-49)"
    - "src/renderer/src/screens/OnboardingScreen.tsx — 5-step setup with WARNING-7 saveConfig→saveApiKey order"
    - "src/renderer/src/screens/HomeScreen.{tsx,module.css} — 'Characters' h1 + LAN pill + '+ New' + auto-fill grid"
    - "src/renderer/src/screens/AddCharacterScreen.tsx — 3-step add flow (name / description / persona_prompt)"
    - "src/renderer/src/screens/ComingSoonScreen.{tsx,module.css} — 'Other games' stub"
  affects:
    - "Plan 08 (CharacterPage + LanModal + Settings + LogsPanel) — consumes useUiStore.pendingSummonId + modal({kind:'lan',mode:'searching'}) wiring established here"
    - "Plan 09 (errors) — replaces inline `(err as Error).message` displays in OnboardingScreen and AddCharacterScreen with ERROR_COPY[errorClass] map once src/renderer/src/lib/errors.ts ships"
    - "Plan 11 (clean-VM smoke) — verifies onboarding-then-add-then-summon flow on fresh install"
tech_stack:
  added: []
  patterns:
    - "Pure helper extraction (slug.ts) with collision-safe iteration — testable without React, mirrors PixelPortrait determinism extraction from plan 06"
    - "Single-source local state per screen with useState — no shared form state in stores. Screens call store actions (addCharacter / setPendingSummon / openModal / navigate) only at boundaries"
    - "Per-step early-return rendering inside the screen functions (vs. table-driven) — keeps step copy + validation co-located, easier to scan against UI-SPEC"
    - "WARNING-7 ordering: stateful side-effects ordered worst-failure-first. saveConfig fails → zero state. saveApiKey fails → harmless config persists; user retries"
    - "T-04-33 mitigation: ProviderTiles disabled tiles enforce three layers — aria-disabled + tabIndex=-1 + click no-op + main's UserConfigSchema enum (Zod runtime gate)"
key_files:
  created:
    - "src/renderer/src/lib/slug.ts"
    - "src/renderer/src/components/SeiPixelMark.tsx"
    - "src/renderer/src/components/QuestionShell.tsx"
    - "src/renderer/src/components/QuestionShell.module.css"
    - "src/renderer/src/components/ProviderTiles.tsx"
    - "src/renderer/src/components/ProviderTiles.module.css"
    - "src/renderer/src/components/AddCard.tsx"
    - "src/renderer/src/components/AddCard.module.css"
    - "src/renderer/src/components/CharacterCard.tsx"
    - "src/renderer/src/components/CharacterCard.module.css"
    - "src/renderer/src/screens/OnboardingScreen.tsx"
    - "src/renderer/src/screens/ComingSoonScreen.tsx"
    - "src/renderer/src/screens/ComingSoonScreen.module.css"
    - "src/renderer/src/screens/HomeScreen.tsx"
    - "src/renderer/src/screens/HomeScreen.module.css"
    - "src/renderer/src/screens/AddCharacterScreen.tsx"
  modified:
    - "src/renderer/src/App.tsx"
key_decisions:
  - "Onboarding submit narrows `provider` to literal 'anthropic' before calling sei.saveConfig (instead of passing the union-typed `provider` state). The disabled tiles already prevent runtime change, but the literal narrows the TS contract to UserConfigSchema's `z.enum(['anthropic'])` and prevents a future refactor from sending an invalid enum to main. Still tracks `provider` in local state so step 4's title (`Paste your ${providerLabel} API key.`) and a future provider expansion only need a single edit."
  - "HomeScreen reads theme by inspecting `document.documentElement.getAttribute('data-theme')` once per render rather than subscribing to useUiStore.themeMode. Rationale: applyTheme writes the attribute synchronously on toggle, and PixelPortrait palette index is theme-stable (palette swap, layout preserved per plan 06 SUMMARY). A subscription would re-render the entire grid on every theme toggle even though the canvas is repainted by PixelPortrait's own useEffect. The DOM read is consistent because applyTheme is the single writer."
  - "CharacterCard role+tabIndex on the wrapping <div> (not just <button> children) so keyboard users can focus the card and the Summon overlay reveals via :focus-within (already in the CSS). The Summon button itself is a real <button> inside that focus, so the click handler with stopPropagation prevents double-firing onOpen."
  - "AddCharacterScreen step 1 (description) validate() returns true unconditionally — description is optional per UI-SPEC §AddCharacterScreen. Step 0 (name) and step 2 (persona_prompt) are required. This matches the design/project/screens.jsx prototype."
  - "ComingSoonScreen 'Coming soon.' h1 includes the period. Matches UI-SPEC §Copywriting Contract — copy is a sentence."
requirements_completed: [GUI-01, GUI-04]
metrics:
  duration_min: ~13
  tasks_completed: 3
  files_changed: 17
  loc_added: ~1225
  completed: "2026-05-08T19:21:34Z"
---

# Phase 4 Plan 07: Onboarding & Home Summary

**One-liner:** First-touch surface — 5-step OnboardingScreen (Welcome → MC username → preferred name → provider tiles → API key) with WARNING-7-fixed `saveConfig` BEFORE `saveApiKey` ordering, HomeScreen with LAN pill + auto-fill character grid + AddCard, 3-step AddCharacterScreen that slugifies the name into a collision-safe id and persists via `sei.saveCharacter`, and the ComingSoonScreen stub. App.tsx now renders real screens for these four views; CharacterPage + Settings remain placeholders for plan 08.

## Performance

- **Duration:** ~13 min
- **Started:** 2026-05-08T19:08:10Z
- **Completed:** 2026-05-08T19:21:34Z
- **Tasks:** 3 (all auto, no TDD)
- **Files created:** 16 + App.tsx modified

## Task Commits

| Commit  | Type | Description |
| ------- | ---- | ----------- |
| 5da9921 | feat | Task 1 — slug.ts + SeiPixelMark + QuestionShell + ProviderTiles + AddCard + CharacterCard (6 components, 4 CSS modules, 1 lib helper) |
| 4ce3226 | feat | Task 2 — OnboardingScreen (5 steps with WARNING-7 saveConfig→saveApiKey order) + ComingSoonScreen |
| ce74177 | feat | Task 3 — HomeScreen + AddCharacterScreen + App.tsx wiring (replaced 4 placeholders) |

## What Shipped

### Task 1 — Helpers + supporting components (6 components, 1 lib)

**`src/renderer/src/lib/slug.ts`** — `slugify(name, existingIds)` returns kebab-case. Pipeline: `toLowerCase` → NFKD normalize → strip combining marks (`/[̀-ͯ]/g` per the verbatim plan source) → non-alnum runs → single hyphen → trim hyphens → collapse runs → fallback to `'character'`. On collision, append `-2`, `-3`, etc. (`while (existingIds.includes(\`${base}-${n}\`)) n++`). T-04-31 mitigation — main's saveCharacter Zod-validates further.

**`src/renderer/src/components/SeiPixelMark.tsx`** — `<span>` with `mask-image: url('/img/sei-logo-small.svg')` colored via `background-color`. Props `height` (default 22) and `color` (default `var(--accent)`); width auto-derived as `height * 5` to match the logo aspect (~5:1). `verticalAlign: 'baseline'` keeps it inline-with-text.

**`src/renderer/src/components/QuestionShell.{tsx,module.css}`** — 520px max-width column. Body is flex-grow centered with `padding: 56px 0`. Footer row: `<Button kind="quiet" icon=BackIcon>Back</Button>` | `<StepDots>` | `<Button kind={primary|accent}>Continue|Begin|Finish|Create</Button>`. `nextLabel` and `nextKind` props let each step swap CTA copy + visual weight.

**`src/renderer/src/components/ProviderTiles.{tsx,module.css}`** — 2×2 grid (`grid-template-columns: 1fr 1fr`). Tile array: Anthropic (`#C96442`, enabled) / OpenAI (`#10A37F`) / Google (`#4285F4`) / Local (`#6E6E6E`). Disabled tiles: `aria-disabled` + `tabIndex={-1}` + click no-op + `Coming soon` chip + 0.5 opacity. Selected tile: `--accent` border + `--accent-soft` wash. `role="radiogroup"` + each tile `role="radio"` with `aria-checked`.

**`src/renderer/src/components/AddCard.{tsx,module.css}`** — Dashed 2px `--border-strong` border, square 1:1 aspect, hover changes border to `--accent`, background to `--accent-soft`, text color to `--accent`. Inner 56×56 icon tile (PlusIcon size 26) inverts to `--accent` background + `--accent-text` foreground on hover. Labels: `New character` (sans 14/600) + `Build a fresh persona` (sans 12/400 muted).

**`src/renderer/src/components/CharacterCard.{tsx,module.css}`** — 1:1 portraitWrap with `<PixelPortrait seed={c.id+c.name} palette={pickPalette(seed,theme)} size={260} portraitImage={c.portrait_image}/>`. Top-left chip: `DEFAULT` (green dot) for `c.id === 'sui'`, else `CUSTOM` (muted dot). Bottom-left name overlay: pixel font 14 white. Hover overlay: `rgba(0,0,0,0.20)` wash with centered `<Button kind="accent" icon={<SparkleIcon size={12}/>}>Summon</Button>` (D-49: sparkle, not play). Click on Summon stops propagation so onOpen doesn't double-fire. Info row below: name + `Last: <date>` or `Never summoned` + ArrowIcon.

### Task 2 — OnboardingScreen + ComingSoonScreen

**`src/renderer/src/screens/OnboardingScreen.tsx`** — 5 steps via local `useState`s (`mc`, `pref`, `provider`, `apiKey`, `step`, `error`, `submitting`). `STEPS = 5`. Per-step copy verbatim from UI-SPEC §Onboarding:

| Step | Title | Field | CTA |
| ---- | ----- | ----- | --- |
| 0 | `Welcome to <SeiPixelMark/>.` | (none) | Begin (accent) |
| 1 | `What's your Minecraft username?` | mono TextField, autoFocus | Continue |
| 2 | `What should they call you?` | sans TextField, autoFocus | Continue |
| 3 | `Which model provider?` | ProviderTiles | Continue |
| 4 | ``Paste your ${providerLabel} API key.`` | mono TextField (type=password, placeholder `sk-ant-...`) | Finish (accent) |

**WARNING-7 fix verified by line order in submit handler:**
```
saveConfig at line 93   ← BEFORE
saveApiKey at line 99   ← AFTER
```

Awk acceptance gate: `awk '/sei\.saveConfig/{c=NR} /sei\.saveApiKey/{k=NR} END{exit !(c>0 && k>0 && c<k)}'` exits 0.

`isReonboard` true → on mount `useEffect` reads `sei.getConfig()` and pre-fills `mc`/`pref`/`provider` (apiKey deliberately empty per UI-SPEC re-onboarding rule). Step 0 Back navigates to settings; otherwise Back is disabled on step 0.

Inline error display (step 4): `<div style={{color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13}}>` showing `(err as Error).message`. **Plan 09 will replace this** with `ERROR_COPY[errorClass]` once `src/renderer/src/lib/errors.ts` ships.

**`src/renderer/src/screens/ComingSoonScreen.{tsx,module.css}`** — Centered max-width 440 column. Pixel `Other games` 22px in `--accent`. H1 `Coming soon.` (period included) sans 28/600. Button `Back to Minecraft` → `navigate({kind:'home'})`.

### Task 3 — HomeScreen + AddCharacterScreen + App.tsx wiring

**`src/renderer/src/screens/HomeScreen.{tsx,module.css}`** — Header: H1 `Characters` (sans 32/600 -0.6), actions row with LAN pill + `+ New` button. LAN pill labels: `CONNECTED` / `NOT CONNECTED` / `UNAVAILABLE` with 7×7 colored dot (green / red / muted). Click LAN pill → `openModal({kind:'lan', mode:'info'})`. Click `+ New` → `navigate({kind:'add-character'})`. Grid: `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`, gap 18px (D-44).

Summon flow:
- `lan.kind === 'connected'` → `sei.summon(id).catch(...)` (errors surface via `onStatus`/BotStatus.error variant) + immediate `navigate({kind:'character', id})`.
- Otherwise → `setPendingSummon(id)` + `openModal({kind:'lan', mode:'searching'})`.

Theme: read once via `document.documentElement.getAttribute('data-theme')`. Rationale: applyTheme is the single writer; subscribing to `themeMode` would re-render the grid on every toggle even though PixelPortrait already repaints.

**`src/renderer/src/screens/AddCharacterScreen.tsx`** — 3 steps:

| Step | Eyebrow | Title | Hint | Field | CTA |
| ---- | ------- | ----- | ---- | ----- | --- |
| 0 | (none) | `Name your character.` | (none) | sans TextField, autoFocus | Continue |
| 1 | `Shown to you` | `Describe them.` | "A short bio that appears on this character's page. Just for you — purely flavour." | multiline 5 rows | Continue |
| 2 | `Sent to the model` | `Write the persona prompt.` | "The system instruction the language model receives. Speak to the model directly." | multiline 7 rows mono | Create (accent) |

Step 1 (description) is optional (`validate()` returns `true` unconditionally). Steps 0 + 2 require non-empty trimmed values.

On Create:
1. `existingIds = characters.map(c => c.id)`
2. `id = slugify(name.trim(), existingIds)`
3. Build Character per D-11: `is_default: false`, `created: new Date().toISOString()`, `last_launched: null`, `playtime_ms: 0`, `portrait_image: null` (D-14: image override is V2; null = procedural).
4. `await sei.saveCharacter(character)` (Zod-validated server-side).
5. `addCharacter(character)` to local store.
6. `navigate({kind:'character', id})` to plan 08's CharacterPage placeholder.

**`src/renderer/src/App.tsx`** — Imports added for `OnboardingScreen`, `HomeScreen`, `AddCharacterScreen`, `ComingSoonScreen`. The render switch now uses these for `view.kind` of `onboarding`, `home`, `add-character`, `coming-soon`. `CharacterPagePlaceholder` and `SettingsPlaceholder` remain (plan 08 fills them). The 4 removed placeholders (`OnboardingPlaceholder`, `HomePlaceholder`, `AddCharacterPlaceholder`, `ComingSoonPlaceholder`) are no longer referenced — verified by `! grep -q "OnboardingPlaceholder\|HomePlaceholder\|AddCharacterPlaceholder\|ComingSoonPlaceholder" src/renderer/src/App.tsx`.

## Slug Algorithm Detail

Re-creating "Sui" while the default `sui` already exists:
- `slugify('Sui', ['sui'])` → base = `'sui'` → collision → `'sui-2'`
- `slugify('Sui', ['sui', 'sui-2'])` → `'sui-3'`
- And so on.

Empty / non-ASCII-only inputs:
- `slugify('   ', [])` → base = `''` → fallback `'character'`
- `slugify('🐉🐉', [])` → strips emoji → `''` → fallback `'character'`
- `slugify('   ', ['character'])` → `'character-2'`

Diacritics (NFKD strip):
- `slugify('Café', [])` → `'cafe'`
- `slugify('Sœurette', [])` → `'s-urette'` (ligature stripped to single hyphen run)

The `s-urette` quirk is a known cosmetic edge: NFKD doesn't decompose `œ` to `oe` because it's not a compatibility decomposition. T-04-31 mitigation is unaffected — the value is still pure-ASCII kebab-case and main's Zod validation accepts it. If users care, plan 09's UX polish phase can add a manual mapping.

## Validation Messages — Raw Strings (Plan 09 Replacement)

The two screens that perform IPC writes display errors inline using `(err as Error).message` raw:

1. **OnboardingScreen** step 4 — error from `sei.saveConfig` OR `sei.saveApiKey`. The error originates in main's IPC handler (Zod validation, disk write, safeStorage failure, etc.). Raw `Error.message` is currently shown in `var(--red) var(--mono) 13px` below the API key field.
2. **AddCharacterScreen** step 2 — error from `sei.saveCharacter` (validation, disk, ENOENT, etc.). Same raw display pattern.

Plan 09 ships `src/renderer/src/lib/errors.ts` with `ERROR_COPY: Record<ErrorClass, string>`. The replacement is a single `setError(ERROR_COPY[errorClass] ?? (err as Error).message)` per call site once that file lands. The `ErrorClass` union is already in `@shared/errorClasses` (imported transitively by `@shared/ipc`'s `BotStatus`); plan 09 just needs to map main's IPC errors to that union before they cross the boundary.

## Notes for Plan 08 Executor

- **LanModal wiring is in place.** HomeScreen sets `useUiStore.pendingSummonId` and opens `{kind:'lan', mode:'searching'}` when summon is requested while LAN is not connected. LanModal in `searching` mode must:
  1. Read `useUiStore.pendingSummonId` for the summon target.
  2. Watch `useDataStore.lan` — when `lan.kind === 'connected'`, auto-resume by calling `sei.summon(pendingSummonId)`, clearing `pendingSummonId` (`setPendingSummon(null)`), closing the modal, and navigating to `{kind:'character', id: pendingSummonId}`.
  3. The user can also explicitly close the modal — that path should clear `pendingSummonId` so a future LAN-connected event doesn't fire a stale summon.
- **LanModal info-mode** is also used by HomeScreen's LAN pill click (`{kind:'lan', mode:'info'}`). Render the current `useDataStore.lan` payload (port + motd when connected, helpful copy otherwise).
- **CharacterPage** is the next screen after AddCharacterScreen.Create and after summon. `useUiStore.view.kind === 'character'` carries `view.id`. Read the character via `useDataStore((s) => s.characters.find((c) => c.id === id))`.
- **Settings screen** — when implemented, theme toggle should also persist to config.json (plan 06 SUMMARY's deferred item — `setThemeMode + sei.saveConfig({...current, theme_mode: next})`).

## Notes for Plan 09 Executor (errors)

- **Two raw-string error displays to replace** (see "Validation Messages" above): OnboardingScreen step 4 + AddCharacterScreen step 2. Both use the pattern `setError((err as Error).message)`. Replace with `setError(ERROR_COPY[errorClass] ?? (err as Error).message)` once `lib/errors.ts` ships.
- The error copy lives inline in the screens (no shared `<ErrorBanner>` component yet). Plan 09 may want to factor it into a shared `<InlineError>` component if more screens grow error states.

## Plan-level Verification — `<verification>` block

| Check | Result |
| ----- | ------ |
| All 16 new files exist (6 components + 4 module.css + 1 lib + 4 screens + 1 css) | PASS |
| `awk '/sei\.saveConfig/{c=NR} /sei\.saveApiKey/{k=NR} END{exit !(c>0 && k>0 && c<k)}' OnboardingScreen.tsx` | PASS — saveConfig at L93, saveApiKey at L99 |
| `npx tsc --noEmit -p tsconfig.web.json` exits 0 | PASS — 0 lines |
| `npx tsc --noEmit -p tsconfig.node.json` exits 0 | PASS — 0 lines |
| Task 1 grep gates (slug, SeiPixelMark mask-image, QuestionShell StepDots, ProviderTiles 'Coming soon' + aria-disabled + 'anthropic' enabled true / 'openai' enabled false, AddCard 'New character' + 'Build a fresh persona', CharacterCard SparkleIcon + `id === 'sui'` + 'Never summoned') | PASS |
| Task 2 grep gates (`STEPS = 5`, all 5 step copy strings, `sk-ant-`, `sei.saveApiKey`, `sei.saveConfig`, navigate home, `isReonboard`, ComingSoonScreen 'Other games' + 'Coming soon' + 'Back to Minecraft') | PASS |
| Task 3 grep gates (`Characters`, `CONNECTED`/`NOT CONNECTED`, `+ New`, `openModal`, `sei.summon`, all eyebrow + title + hint copy in AddCharacterScreen, `slugify`, `sei.saveCharacter`, `is_default: false`, App.tsx imports + no `*Placeholder` references for the 4 removed) | PASS |

## Acceptance Criteria — Plan-level

- [x] All 16 new files exist and are wired through App.tsx (4 view-kind routes use real screens; 2 still placeholders for plan 08).
- [x] `slug.ts` exports `slugify` with collision-safe `-2`/`-3` suffix logic.
- [x] `SeiPixelMark.tsx` uses `mask-image` for the recolored logo.
- [x] `QuestionShell.tsx` renders `StepDots`.
- [x] `ProviderTiles.tsx` includes `Coming soon` literal AND `aria-disabled` AND has `id: 'anthropic'` enabled true / `id: 'openai'` enabled false (D-26).
- [x] `AddCard.tsx` contains literals `New character` and `Build a fresh persona`.
- [x] `CharacterCard.tsx` references `SparkleIcon` (NOT play icon — D-49).
- [x] `CharacterCard.tsx` checks `id === 'sui'` for default badge.
- [x] `CharacterCard.tsx` contains `Never summoned` literal.
- [x] `OnboardingScreen.tsx` contains literal `STEPS = 5` and all 5 step copy strings + `sk-ant-` placeholder.
- [x] `OnboardingScreen.tsx` calls `sei.saveConfig` BEFORE `sei.saveApiKey` (WARNING-7 fix — verified by `awk` line-order gate).
- [x] `OnboardingScreen.tsx` supports `isReonboard` prop and pre-fills config fields on reonboard.
- [x] `ComingSoonScreen.tsx` contains `Other games` and `Back to Minecraft`.
- [x] `HomeScreen.tsx` contains `Characters` h1, `CONNECTED`/`NOT CONNECTED` LAN pill labels, `+ New` button, calls `openModal` and `sei.summon`.
- [x] `AddCharacterScreen.tsx` contains all eyebrow + title + hint copy and calls `slugify` + `sei.saveCharacter`; creates a Character with `is_default: false`.
- [x] `App.tsx` imports the four new screens and removes the four corresponding `*Placeholder` references; `CharacterPagePlaceholder` and `SettingsPlaceholder` remain for plan 08.
- [x] `npx tsc --noEmit -p tsconfig.web.json` reports 0 errors.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Type narrowing for IPC contract] Onboarding submit narrows `provider` to literal `'anthropic'`**
- **Found during:** Task 2 implementation
- **Issue:** Local React state `provider` is typed as the full `Provider` union (`'anthropic' | 'openai' | 'google' | 'local'`) for the ProviderTiles component, but `UserConfigSchema` only accepts `z.enum(['anthropic'])`. Passing `provider` directly to `sei.saveConfig` would be a TS error (or, worse, would type-check via an unsafe cast).
- **Fix:** In the submit handler, pass the literal `'anthropic'` to `sei.saveConfig`. Added a comment noting T-04-33 mitigation: "only 'anthropic' is valid in UserConfigSchema today (D-26). Disabled tiles can't change `provider` from the default; this narrowing makes the type contract explicit and prevents a future refactor from sending an invalid enum value to the Zod-validated main."
- **Files modified:** `src/renderer/src/screens/OnboardingScreen.tsx`
- **Commit:** 4ce3226
- **Impact:** None negative. Step 4 title still reads `Paste your ${providerLabel} API key.` so the step copy adapts when more providers ship; the saved enum is just always 'anthropic' until UserConfigSchema expands.

**2. [Rule 2 - A11y] CharacterCard wrapping `<div>` got `role="button"` + `tabIndex={0}`**
- **Found during:** Task 1 implementation
- **Issue:** Plan's CharacterCard contract puts `onClick` on the wrapping `<div>` for the card-body navigation, but a `<div>` without `role/tabIndex` isn't keyboard-focusable, which would also break `:focus-within` (the CSS rule that reveals the Summon overlay on keyboard focus).
- **Fix:** Added `role="button"` and `tabIndex={0}` to the wrapping `<div>`. The Summon button inside is still a real `<button>` so its keyboard activation continues to work; clicks on Summon stop propagation so onOpen doesn't also fire.
- **Files modified:** `src/renderer/src/components/CharacterCard.tsx`
- **Commit:** 5da9921
- **Impact:** None negative. Card is now keyboard-focusable + screen-reader-discoverable; `:focus-within` overlay reveal works for keyboard users.

### Out-of-scope items deferred

**1. ERROR_COPY map for inline errors** — OnboardingScreen step 4 and AddCharacterScreen step 2 currently use raw `(err as Error).message`. Plan 09 replaces. Logged above under "Validation Messages — Raw Strings".

**2. LanModal `searching` mode auto-resume** — HomeScreen sets `pendingSummonId` and opens the searching modal, but the auto-resume on `lan.kind === 'connected'` lives in LanModal itself (plan 08).

**3. CharacterPage** — AddCharacterScreen.Create and HomeScreen.handleSummon both navigate to `{kind:'character', id}`, which currently lands on plan 06's `CharacterPagePlaceholder` (a "Character {id} — implemented in plan 08" stub). Plan 08 ships the real screen.

**4. Settings screen** — re-onboarding step 0 Back navigates to `{kind:'settings'}` which lands on `SettingsPlaceholder`. Plan 08 ships the real screen.

### Authentication Gates

None. (No external services touched. The renderer's `sei.hasApiKey()` returns a boolean only; `sei.saveApiKey` writes to safeStorage on the main side.)

## Threat Flags

None new this plan. Per the plan's `<threat_model>`:

| Threat ID | Mitigation in this plan |
| --------- | ----------------------- |
| T-04-31 (renderer slug crafted to overwrite sui.json) | mitigate — `slugify` is lowercase + ASCII-only + collision-safe `-2`/`-3` suffix; main's `saveCharacter` re-validates via Zod (CharacterSchema's `id: z.string().min(1)` is the renderer-side floor; main's per-id collision check is the server-side floor). |
| T-04-32 (API key visible in DevTools network tab) | accept — Plaintext crosses IPC; production builds disable DevTools by default. Renderer NEVER stores plaintext beyond the input field's lifetime — no Zustand persistence, no localStorage. |
| T-04-33 (renderer attempts to enable disabled provider tile) | mitigate — `aria-disabled + tabIndex=-1 + click no-op` in ProviderTiles **AND** Onboarding submit narrows `provider` to literal `'anthropic'` before calling saveConfig **AND** main's `UserConfigSchema` Zod enum (only `'anthropic'` passes). Three layers of defense. |

No NEW security-relevant surface introduced. All IPC calls in this plan (`saveConfig`, `saveApiKey`, `saveCharacter`, `summon`, `getConfig`) were already on the contract surface from plan 02/05.

## Self-Check: PASSED

Verified files exist:
- FOUND: src/renderer/src/lib/slug.ts
- FOUND: src/renderer/src/components/SeiPixelMark.tsx
- FOUND: src/renderer/src/components/QuestionShell.tsx + .module.css
- FOUND: src/renderer/src/components/ProviderTiles.tsx + .module.css
- FOUND: src/renderer/src/components/AddCard.tsx + .module.css
- FOUND: src/renderer/src/components/CharacterCard.tsx + .module.css
- FOUND: src/renderer/src/screens/OnboardingScreen.tsx
- FOUND: src/renderer/src/screens/ComingSoonScreen.tsx + .module.css
- FOUND: src/renderer/src/screens/HomeScreen.tsx + .module.css
- FOUND: src/renderer/src/screens/AddCharacterScreen.tsx
- MODIFIED: src/renderer/src/App.tsx

Verified commits exist in git log:
- FOUND: 5da9921 (Task 1 — slug + 5 supporting components)
- FOUND: 4ce3226 (Task 2 — OnboardingScreen + ComingSoonScreen)
- FOUND: ce74177 (Task 3 — HomeScreen + AddCharacterScreen + App.tsx wiring)

Verified plan-level checks:
- `./node_modules/.bin/tsc --noEmit -p tsconfig.web.json` exits 0 with 0 lines of output.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json` exits 0 with 0 lines of output.
- `awk '/sei\.saveConfig/{c=NR} /sei\.saveApiKey/{k=NR} END{exit !(c>0 && k>0 && c<k)}' src/renderer/src/screens/OnboardingScreen.tsx` exits 0 (saveConfig L93 < saveApiKey L99).

---
*Phase: 04-electron-gui-packaging*
*Completed: 2026-05-08*
