---
phase: 12-character-sharing-ui-moderation
plan: 11
subsystem: renderer-components
tags: [renderer, components, ui, browse-card, share]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 08
    provides: "BrowseEntry shape (id, name, personaSnippet, creatorLabel, portraitUrl, skinUrl, updatedAt, inMyLibrary) + inMyLibrary precomputed by main against useDataStore.characters (Researcher correction #4)"
  - phase: 12-character-sharing-ui-moderation
    plan: 09
    provides: "useBrowseStore.refresh() — used by Add-to-Mine to flip inMyLibrary after successful download"
  - phase: 12-character-sharing-ui-moderation
    plan: 10
    provides: "CharactersScreen BrowseGrid placeholder — 12-11 replaces the placeholder div with <BrowseCard />"
  - phase: 11-cloud-character-library
    plan: 19
    provides: "window.sei.charsOpenPrepare(id) → cacheOnDemand JSON+skin+portrait download (Add-to-Mine reuse, no new IPC)"
provides:
  - "BrowseCard.tsx — public-character grid card with portrait + name overlay + creator meta + 3-line persona snippet + Report (top-left) + Hover Add-to-Mine OR Already-in-Library pill"
  - "BrowseCard.module.css — Browse-specific styling (composes CharacterCard primitives for chrome)"
  - "CharactersScreen BrowseGrid handlers: handleOpen, handleAddToMine, handleReport — Report sets local reportTarget state ready for 12-13 ReportModal mount"
affects: [12-12-add-to-mine-flow, 12-13-report-modal-mount]

# Tech tracking
tech-stack:
  added: []  # Reuses React + PixelPortrait + pickPalette + existing IPC bindings
  patterns:
    - "Lean component pattern: BrowseCard does NOT subscribe to useAuthStore / useSyncStore / useCloudCharactersStore. All variable state (inMyLibrary) is precomputed server-side by main and shipped as part of BrowseEntry. The card re-renders only when the entry itself changes, so scrolling a 100-card grid doesn't trigger 100 store-subscription re-render fan-outs."
    - "Compose-via-CSS-modules pattern: BrowseCard reuses CharacterCard.module.css primitives (.card, .portraitWrap, .gradient, .nameOverlay, .hoverOverlay) by importing both modules and concatenating class names (`${characterStyles.card} ${styles.cardExtras}`). Browse-specific bits live in BrowseCard.module.css only. Zero CSS duplication; visual coherence with Home grid stays automatic."
    - "stopPropagation on every clickable child of a card-as-button. Both Report and Add-to-Mine buttons (and the Already-in-Library pill is a span, not a button) call e.stopPropagation() — Pitfall 7 mitigation so the card's onClick (handleOpen) doesn't also fire."

key-files:
  created:
    - src/renderer/src/components/BrowseCard.tsx
    - src/renderer/src/components/BrowseCard.module.css
  modified:
    - src/renderer/src/screens/CharactersScreen.tsx

key-decisions:
  - "Open action navigates via the existing useUiStore.navigate({ kind: 'character', id }) — same path HomeGrid uses for cloud-only chars. The plan sketched `window.location.hash` but the actual app uses zustand-driven navigation (App.tsx renders by view.kind); switching to navigate() keeps Browse consistent with Home and avoids introducing a second routing mechanism. v1.0 doesn't ship a separate lightweight preview overlay — CharacterPage renders cloud-only chars per 11-19 so it's fit-for-purpose. Revisit if v1.x wants a lighter inline preview."
  - "Add-to-Mine reuses window.sei.charsOpenPrepare(id) exactly as documented in the plan — no new IPC channel. After success we also call useDataStore.getState().refreshCharacter(id) so an open Home tab picks up the new character without manual reload, then useBrowseStore.refresh() so the inMyLibrary predicate flips on the current Browse card (main recomputes against the updated local characters/index.json)."
  - "Report handler plumbs `reportTarget: BrowseEntry | null` state in advance — 12-13 ships <ReportModal /> behind a single conditional render of that state. For 12-11 we console.info the intent so smoke-testing confirms the wiring fires."
  - "PixelPortrait API match: the plan sketched `<PixelPortrait src={entry.portraitUrl} alt={entry.name} theme={theme} />` but the real PixelPortraitProps shape is `{ seed, palette, size, portraitImage }`. Adapted to the real shape — same pattern CharacterCard uses (seed = id+name, palette = pickPalette(seed, theme), portraitImage = entry.portraitUrl). The PixelPortrait component handles `<img>` fallback on portraitImage load error automatically."
  - "ALREADY-IN-LIBRARY PREDICATE: explicitly relies on main's precomputed `inMyLibrary` field (BrowseEntry contract), which is computed against `useDataStore.characters` local-file presence per Researcher correction #4 in 12-RESEARCH.md. BrowseCard does NOT consult useCloudCharactersStore.cloudIds — that store represents `owner=me` cloud characters, but a Browse entry by user-X is NOT in my cloudIds even after Add-to-Mine. The correct conceptual question is 'is this file on my disk?', answered by `useDataStore.characters.some(c => c.id === browseEntry.id)`, evaluated in main."

patterns-established:
  - "BrowseCard pattern: lean variant of CharacterCard via CSS-module composition (no inheritance, no shared abstract component) — reusable shape for any future card variant (e.g., creator-profile-page card in v1.x)."

requirements-addressed: [SHARE-03, SHARE-04, SHARE-08, SHARE-10]
requirements-completed: []  # SHARE-04 needs 12-12's add-to-mine flow polish; SHARE-08 needs 12-13's ReportModal + submit-report Edge Function; SHARE-10 is the v1.0-acceptable "by user-XXXX" attribution placeholder, but full SHARE-10 closure waits on v1.x creator profile pages.

# Metrics
duration: ~3min
completed: 2026-05-22
---

# Phase 12 Plan 11: BrowseCard Component Summary

**Lean public-character grid card with portrait + creator attribution + 3-line persona snippet + top-left Report button + hover Add-to-Mine / Already-in-Library pill. Reuses CharacterCard.module.css primitives via CSS-module composition so Browse + Home grids share visual chrome with zero duplication. Card does NOT subscribe to useAuthStore / useSyncStore / useCloudCharactersStore — all state (including inMyLibrary) is precomputed by main per BrowseEntry contract, so scrolling a 100-card grid never triggers store-subscription re-render fan-outs. Replaces the 12-10 placeholder div in CharactersScreen.BrowseGrid; wires handleOpen + handleAddToMine + handleReport handlers, with reportTarget state plumbed in advance for the 12-13 ReportModal mount.**

## Component Contract

```ts
interface BrowseCardProps {
  entry: BrowseEntry;
  theme: 'light' | 'dark';
  onOpen: () => void;
  onAddToMine: () => void;
  onReport: () => void;
}
```

**BrowseEntry** (shipped by 12-08; consumed read-only here):

```ts
interface BrowseEntry {
  id: string;
  name: string;
  personaSnippet: string;   // first ~120 chars of persona_source + ellipsis
  creatorLabel: string;     // "by anonymous" | "by user-a1b2"
  portraitUrl: string | null;
  skinUrl: string | null;
  updatedAt: string;        // ISO timestamp
  inMyLibrary: boolean;     // precomputed by main vs useDataStore.characters
}
```

## Visual Anatomy

```
┌──────────────────────────────────────────┐
│ [⚐ Report]                               │   ← top-left, z-index 2, stopPropagation
│                                          │
│        ┌──────────────────┐              │
│        │  PixelPortrait   │              │   ← portraitImage (cloud Storage URL),
│        │  (seeded by      │              │     falls back to procedural canvas
│        │   id+name)       │              │     on image load failure
│        └──────────────────┘              │
│                                          │
│   [linear gradient bottom→top, 50% h]   │   ← .gradient overlay
│   [Name in pixel font, bottom-left]      │   ← .nameOverlay
│                                          │
│   ──────── HOVER OVERLAY ────────         │
│   [ + Add to Mine ] OR                   │   ← inMyLibrary ? pill : button
│   [ Already in My Library ]              │
│                                          │
└──────────────────────────────────────────┘
│ by user-a1b2                             │   ← .creatorMeta
│ persona snippet (3-line clamp,           │   ← .personaSnippet
│ ~120 chars + ellipsis from main)         │
└──────────────────────────────────────────┘
```

## Add-to-Mine Flow

```
BrowseCard onAddToMine
  → handleAddToMine(entry) in BrowseGrid
    → window.sei.charsOpenPrepare(entry.id)        [Phase 11 cacheOnDemand]
       └─ downloads JSON + skin PNG + portrait PNG to local characters/<id>/
    → useDataStore.getState().refreshCharacter(id) [open Home tab picks up new char]
    → useBrowseStore.refresh()                     [inMyLibrary flips on this card]
```

On failure (network drop, signed-out, cache write error): an inline "ADD FAILED — TRY AGAIN" chip renders next to the card. Pattern lifted verbatim from HomeGrid's openPrepare error chip.

## Report Wiring (12-13 prep)

```ts
const [reportTarget, setReportTarget] = useState<BrowseEntry | null>(null);

const handleReport = (entry: BrowseEntry): void => {
  setReportTarget(entry);
  // 12-13 mounts: <ReportModal characterId={reportTarget.id} ... onClose={() => setReportTarget(null)} />
  console.info(`[sei] report target queued: ${entry.id} — ReportModal lands in 12-13`);
};
```

State hook + handler are plumbed now so 12-13 lands behind a single conditional render of `reportTarget`. No CharactersScreen changes will be needed beyond the modal mount itself.

## Open Flow

`handleOpen` reuses the same path HomeGrid takes for cloud-only chars:

```
BrowseCard onOpen
  → handleOpen(entry)
    → sei.charsOpenPrepare(entry.id)         [cache hydrate; tolerates failure]
    → useDataStore.refreshCharacter(id)      [non-fatal]
    → useUiStore.navigate({ kind: 'character', id: entry.id })
```

The plan sketched `window.location.hash = #/character/${id}` but the codebase uses zustand-driven view routing (`App.tsx` renders by `view.kind`), so we use `navigate()`. This keeps Browse consistent with Home and avoids introducing a second routing mechanism. **Open question for v1.x:** users might prefer an inline preview overlay instead of full-page navigation for Browse entries. CharacterPage already renders cloud-only characters per 11-19 so v1.0 is fit-for-purpose; revisit if 12-13 ReportModal lands and the full-page navigation feels jarring.

## Lean-Component Discipline

`grep -E "^import.*useAuthStore|^import.*useSyncStore|^import.*useCloudCharactersStore" src/renderer/src/components/BrowseCard.tsx` returns **0** matches. Mentions in the JSDoc header are documentation only — they call out the discipline explicitly so future maintainers don't accidentally re-introduce these subscriptions. The two `grep -c` matches in the file are both inside comment blocks (lines 19, 25 — the JSDoc explanation of the discipline).

## Commits

| Task | Commit    | Description                                                                           |
| ---- | --------- | ------------------------------------------------------------------------------------- |
| 1    | `0d7262d` | feat(12-11): add BrowseCard component + CSS module                                    |
| 2    | `53ee52e` | feat(12-11): wire BrowseCard into CharactersScreen BrowseGrid                         |

## What landed

### `src/renderer/src/components/BrowseCard.tsx` (new, 109 lines)

Single-component module. Composes CharacterCard.module.css for chrome, BrowseCard.module.css for Browse-specific bits. JSDoc header documents the lean-component discipline + Pitfall 7 stopPropagation requirement + Researcher correction #4 inMyLibrary predicate.

### `src/renderer/src/components/BrowseCard.module.css` (new, 130 lines)

Five styled selectors only:
- `.cardExtras` — position: relative (positioning context for the Report button)
- `.reportBtn` — 24px circular top-left button, --red on hover/focus-visible
- `.addBtn` — hover-overlay "+ Add to Mine" pill using --bg-2 / --text / --border tokens (no accent color so Browse doesn't pulse with Home's Summon color)
- `.alreadyPill` — mono uppercase pill when entry.inMyLibrary === true
- `.metaRow` / `.creatorMeta` / `.personaSnippet` — bottom info rows; persona snippet uses `-webkit-line-clamp: 3`

### `src/renderer/src/screens/CharactersScreen.tsx` (modified, +118/-4 lines)

Inside `BrowseGrid()`:
- New imports: `BrowseCard` from components, `BrowseEntry` type from `@shared/ipc`
- New state: `reportTarget: BrowseEntry | null`, `addToMineError: string | null`
- New handlers: `handleOpen`, `handleAddToMine`, `handleReport`
- Theme detection inline (`document.documentElement.getAttribute('data-theme')`) mirrors HomeGrid pattern
- Grid render replaces `<div>{entry.name}</div>` placeholder with `<BrowseCard ... />` wrapped in a relative-positioned div so the error chip can be absolute-positioned next to it (same shape as HomeGrid's openPrepare error chip)
- Trailing JSX comment marks the 12-13 ReportModal mount site

## Deviations from Plan

**Two minor adaptations to existing codebase APIs — no behavior drift from plan intent.**

### 1. [Rule 3 - Wrong types / API mismatch] PixelPortrait API

- **Found during:** Task 1
- **Issue:** Plan sketched `<PixelPortrait src={entry.portraitUrl} alt={entry.name} theme={theme} />`, but the actual `PixelPortraitProps` is `{ seed, palette, size, portraitImage, style, className, 'aria-label' }`. No `src`/`alt`/`theme` props exist.
- **Fix:** Adapted to the real shape, matching CharacterCard.tsx's existing usage: `<PixelPortrait seed={entry.id + entry.name} palette={pickPalette(...)} size={260} portraitImage={entry.portraitUrl} />`. PixelPortrait handles the `<img>` fallback on load error automatically.
- **Files modified:** src/renderer/src/components/BrowseCard.tsx
- **Commit:** 0d7262d

### 2. [Rule 1 - Wrong navigation primitive] handleOpen uses zustand navigate() not window.location.hash

- **Found during:** Task 2
- **Issue:** Plan sketched `handleOpen` as `window.location.hash = #/character/${entry.id}`, but Sei's renderer uses zustand-driven view routing (App.tsx renders by `view.kind`; there is no hash router). HomeGrid navigates via `useUiStore((s) => s.navigate)({ kind: 'character', id })` and that's the only path that wires CharacterPage correctly.
- **Fix:** Use `navigate({ kind: 'character', id: entry.id })` from `useUiStore`. Also reuses the same `sei.charsOpenPrepare` + `useDataStore.refreshCharacter` cache-hydrate pattern HomeGrid uses for cloud-only chars, so Browse-entry → CharacterPage navigation lands with the character's JSON already on local disk.
- **Files modified:** src/renderer/src/screens/CharactersScreen.tsx
- **Commit:** 53ee52e

## Threat Compliance

Per 12-11 threat register:

| Threat ID    | Disposition | Status                                                                                                                                                                                          |
| ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-11-01   | mitigate    | **MITIGATED** — Report button `onClick={(e) => { e.stopPropagation(); onReport(); }}`. Same pattern on the Add-to-Mine button. Card `onClick` therefore never fires when these buttons are tapped.    |
| T-12-11-02   | mitigate    | **N/A this plan** — handled by 12-01's search_public_characters RPC (filters moderation_status). BrowseCard trusts the precomputed portraitUrl.                                                  |
| T-12-11-03   | accept      | **N/A this plan** — Add-to-Mine downloads via Phase 11 cacheOnDemand which is already image-MIME validated.                                                                                       |
| T-12-11-04   | accept      | **N/A this plan** — creatorLabel formatting (4-char UUID prefix) is computed by main.                                                                                                             |

No new threat surface introduced beyond the BrowseEntry contract (already threat-modeled in 12-08).

## Threat Flags

None — this plan only renders precomputed BrowseEntry data. No new IPC channels, no new auth paths, no new file access patterns. The Add-to-Mine flow reuses the existing `chars:openPrepare` channel introduced in 11-19.

## Verification Status

- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN** (0 errors in renderer/shared)
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**
- `grep -c "stopPropagation\|inMyLibrary\|alreadyPill\|reportBtn\|addBtn" src/renderer/src/components/BrowseCard.tsx` → **9** (plan threshold: ≥4) ✓
- `grep -c "BrowseCard\|handleAddToMine\|charsOpenPrepare\|setReportTarget" src/renderer/src/screens/CharactersScreen.tsx` → **14** (plan threshold: ≥4) ✓
- `grep -E "^import.*useAuthStore|^import.*useSyncStore|^import.*useCloudCharactersStore" src/renderer/src/components/BrowseCard.tsx | wc -l` → **0** (lean component discipline)
- Manual `npm run dev` smoke-test with BROWSE_ENABLED=true + ≥1 public character: **deferred** to 12-17 rollout (no Browse-tab-visible builds locally yet)

## Known Stubs

**1. Report button click handler** — `handleReport(entry)` currently sets `reportTarget` state and console.infos the intent. The actual `<ReportModal />` component lands in 12-13. This is an intentional stub per the plan's `<done>` criterion ("// 12-13 ships ReportModal — for now console.log"). No user-visible "report" affordance reaches a server — clicks are no-ops until 12-13 lands.

## Self-Check

Verifying claimed artifacts and commits exist:

- `src/renderer/src/components/BrowseCard.tsx` — **FOUND**
- `src/renderer/src/components/BrowseCard.module.css` — **FOUND**
- `src/renderer/src/screens/CharactersScreen.tsx` — **MODIFIED** (verified by `grep -c BrowseCard src/renderer/src/screens/CharactersScreen.tsx` → 5)
- Commit `0d7262d` — **FOUND** (Task 1: BrowseCard component + CSS module)
- Commit `53ee52e` — **FOUND** (Task 2: CharactersScreen wiring)
- `npx tsc --noEmit -p tsconfig.web.json` — **CLEAN**
- `npx vitest run src/renderer/ src/shared/` — **19/19 tests pass**

## Self-Check: PASSED
