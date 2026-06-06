---
phase: 04-electron-gui-packaging
plan: 07
type: execute
wave: 5
depends_on: [01, 02, 05, 06]
files_modified:
  - src/renderer/src/screens/OnboardingScreen.tsx
  - src/renderer/src/screens/HomeScreen.tsx
  - src/renderer/src/screens/AddCharacterScreen.tsx
  - src/renderer/src/screens/ComingSoonScreen.tsx
  - src/renderer/src/components/CharacterCard.tsx
  - src/renderer/src/components/AddCard.tsx
  - src/renderer/src/components/QuestionShell.tsx
  - src/renderer/src/components/ProviderTiles.tsx
  - src/renderer/src/components/SeiPixelMark.tsx
  - src/renderer/src/lib/slug.ts
autonomous: true
requirements: [GUI-01, GUI-04]
must_haves:
  truths:
    - "OnboardingScreen walks the user through 5 steps (Welcome → MC username → preferred name → provider → API key) and on Finish persists config + safeStorage and navigates to Home"
    - "HomeScreen shows characters as a grid with hover-overlay Summon button and an AddCard at the end"
    - "LAN pill in HomeScreen header reflects useDataStore.lan and opens LanModal in info-mode on click (LanModal itself ships in plan 08)"
    - "AddCharacterScreen 3 steps create a new character JSON with collision-safe id slug; persists via sei.saveCharacter; navigates to its CharacterPage"
    - "Provider tile picker shows 4 tiles with Anthropic enabled and OpenAI/Google/Local disabled with 'Coming soon' chip + aria-disabled"
    - "ComingSoonScreen renders the 'Other games' stub with 'Back to Minecraft' CTA"
  artifacts:
    - path: src/renderer/src/screens/OnboardingScreen.tsx
      provides: "5-step onboarding flow"
      exports: ["OnboardingScreen"]
    - path: src/renderer/src/screens/HomeScreen.tsx
      provides: "Character grid + LAN pill + + New button"
      exports: ["HomeScreen"]
    - path: src/renderer/src/screens/AddCharacterScreen.tsx
      provides: "3-step add-character flow"
      exports: ["AddCharacterScreen"]
    - path: src/renderer/src/screens/ComingSoonScreen.tsx
      provides: "'Other games' stub"
      exports: ["ComingSoonScreen"]
    - path: src/renderer/src/components/CharacterCard.tsx
      provides: "Hover-overlay grid card with PixelPortrait + Summon"
      exports: ["CharacterCard"]
    - path: src/renderer/src/components/AddCard.tsx
      provides: "Dashed 'New character' tile (ends the grid)"
      exports: ["AddCard"]
    - path: src/renderer/src/components/QuestionShell.tsx
      provides: "Onboarding/AddCharacter shell with StepDots + Back/Next CTAs"
      exports: ["QuestionShell"]
    - path: src/renderer/src/components/ProviderTiles.tsx
      provides: "4-tile provider picker (Anthropic enabled; rest disabled)"
      exports: ["ProviderTiles"]
    - path: src/renderer/src/components/SeiPixelMark.tsx
      provides: "Inline Sei wordmark via mask-image (used in LoadingScreen + onboarding step 0)"
      exports: ["SeiPixelMark"]
    - path: src/renderer/src/lib/slug.ts
      provides: "slugify(name, existingIds) → kebab-case id with collision-safe -2/-3 suffixes"
      exports: ["slugify"]
  key_links:
    - from: src/renderer/src/screens/OnboardingScreen.tsx
      to: src/renderer/src/lib/ipcClient.ts
      via: "sei.saveConfig + sei.saveApiKey on Finish"
      pattern: "sei\\.saveApiKey"
    - from: src/renderer/src/screens/HomeScreen.tsx
      to: src/renderer/src/lib/stores/useDataStore.ts
      via: "characters list + lan state subscription"
      pattern: "useDataStore"
    - from: src/renderer/src/screens/AddCharacterScreen.tsx
      to: src/renderer/src/lib/ipcClient.ts
      via: "sei.saveCharacter on Create"
      pattern: "sei\\.saveCharacter"
---

<changes_made>
**Revision pass (Warning 7):** Task 2 OnboardingScreen submit handler is reordered to save UserConfig FIRST, then `saveApiKey`. The previous order (apiKey → config) had a partial-failure window: if `saveApiKey` succeeded but `saveConfig` failed (e.g. validation error or disk full), the next launch would have a saved API key + missing UserConfig — onboarding would re-run and the user would be confused why their MC username wasn't remembered. With the new order, a `saveConfig` failure leaves zero state changes (worst case the user re-types everything). If `saveApiKey` fails after `saveConfig` succeeded, onboarding still surfaces the error inline and the user can retry; the saved UserConfig is harmless without a key (the renderer's hasApiKey gate keeps onboarding open).
</changes_made>

<objective>
Implement the onboarding flow, character grid, add-character flow, and the coming-soon stub. After this plan, a fresh-install user can walk through onboarding to the Home screen, see Sui (after migration) or an empty grid, and add a new character.

Purpose: GUI-01 (setup form), GUI-04 (personality form). Plus the visual polish of the Home grid (D-43..D-45). These are the surfaces the user touches before summoning anything.

Output: 4 screens + 5 supporting components + 1 lib helper. Mockup-direct from `design/project/screens.jsx`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/04-electron-gui-packaging/04-CONTEXT.md
@.planning/phases/04-electron-gui-packaging/04-RESEARCH.md
@.planning/phases/04-electron-gui-packaging/04-PATTERNS.md
@.planning/phases/04-electron-gui-packaging/04-UI-SPEC.md
@.planning/phases/04-electron-gui-packaging/design/project/screens.jsx
@.planning/phases/04-electron-gui-packaging/design/project/app.jsx
@.planning/phases/04-electron-gui-packaging/design/project/ui.jsx
@src/shared/ipc.ts
@src/shared/characterSchema.ts
@src/renderer/src/lib/ipcClient.ts
@src/renderer/src/lib/stores/useUiStore.ts
@src/renderer/src/lib/stores/useDataStore.ts
@src/renderer/src/lib/portraitPalettes.ts
@src/renderer/src/components/Button.tsx
@src/renderer/src/components/TextField.tsx
@src/renderer/src/components/PixelPortrait.tsx
@src/renderer/src/components/StepDots.tsx
@src/renderer/src/components/icons.tsx

<interfaces>
From plan 06 (renderer shell):
- `<Button kind size icon fullWidth>{label}</Button>`
- `<TextField value onChange placeholder type monospace multiline rows autoFocus onEnter>`
- `<StepDots count current />`
- `<PixelPortrait seed palette size portraitImage />`
- icons: BackIcon, ArrowIcon, PlusIcon, SparkleIcon, etc.
- `useUiStore` — view, modal, navigate, openModal, closeModal, themeMode
- `useDataStore` — characters, lan, summon, loadCharacters, addCharacter
- `pickPalette(seed, theme)` from lib/portraitPalettes.ts
- `applyTheme(mode)` from lib/theme.ts

From shared:
- `Character` shape: { id, name, description, persona_prompt, is_default, created, last_launched, playtime_ms, portrait_image }
- `UserConfig`: { mc_username, preferred_name, provider, theme_mode }
</interfaces>

<key_locked_decisions>
- D-26 / D-27: Provider picker — only Anthropic enabled. OpenAI / Google / Local rendered with "Coming soon" chip + aria-disabled.
- D-37..D-42: Onboarding 5 steps verbatim copy. "Welcome to [SeiPixelMark]." baseline-aligned. Step 4 placeholder `sk-ant-...` only on Anthropic.
- D-43..D-45: Home — "Characters" h1, LAN pill + "+ New", grid `repeat(auto-fill, minmax(220px, 1fr))` 18px gap, AddCard at end.
- D-46..D-48: AddCharacter 3 steps with eyebrow / hint / monospace persona prompt.
- D-49: CharacterPage Summon icon is sparkle (NOT play). Plan 08 implements page; this plan's Card overlay also uses sparkle.
- D-14: portrait_image relative path (e.g., `<id>.png`). On add-character, default null (procedural); image-upload override is V2 (out of this phase per CONTEXT — keep null).
- D-58: Settings (plan 08).
- UI-SPEC §Onboarding/Home/AddCharacter — exact eyebrows, hints, validation rules, copy.
- UI-SPEC §Defaults — Step-dot 22x6 active, 6x6 inactive.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Lib helper (slug.ts) + supporting components (QuestionShell, SeiPixelMark, ProviderTiles, AddCard, CharacterCard)</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (entire — QuestionShell, AddCard, CharacterCard, StepDots usage)
    - .planning/phases/04-electron-gui-packaging/design/project/app.jsx (SeiPixelMark + provider list constants)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Component Inventory" §"AddCard" §"CharacterCard" + §"Onboarding" — exact dimensions and copy
    - src/renderer/src/lib/portraitPalettes.ts (pickPalette, fnv1a)
    - src/shared/characterSchema.ts (Character shape — for CharacterCard prop type)
  </read_first>
  <behavior>
    - `slugify(name: string, existingIds: string[]): string` — lowercase, replace whitespace + non-ASCII with `-`, strip leading/trailing `-`, collapse runs. If result is empty, fall back to `'character'`. If result conflicts, append `-2`, `-3`, etc. Iterate until unique.
    - `QuestionShell` — central column with optional eyebrow, optional title, optional hint, children (the field), and a footer Back/Next bar with StepDots. Width 520. Per UI-SPEC §"Question shell max-width 520px".
    - `SeiPixelMark` — `mask-image: url('/img/sei-logo-small.svg')` colored via `background-color: var(--accent)`. Props: height (default 22), color (default `var(--accent)`).
    - `ProviderTiles` — 4-tile 2x2 grid. Anthropic enabled, OpenAI/Google/Local disabled with "Coming soon" chip. Selected tile gets accent border + 30% wash. Per D-26.
    - `AddCard` — Dashed 2px border, hover state in --accent. Centered 56x56 icon tile + "New character" + "Build a fresh persona" subhint. UI-SPEC §AddCard.
    - `CharacterCard` — 1:1 portrait region with PixelPortrait. Status chip top-left ("DEFAULT" green / "CUSTOM" gray). Hover: translateY(-2px), shadow-pop, dim overlay + centered Summon button (kind=accent, SparkleIcon). Card name overlay pixel 14 white. Info row below: name + "Last:<date>" or "Never summoned" + ArrowIcon. UI-SPEC §HomeScreen §CharacterCard.
  </behavior>
  <action>
**Step 1.** `src/renderer/src/lib/slug.ts`:

```ts
export function slugify(name: string, existingIds: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')           // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')                 // non-alnum → hyphen
      .replace(/^-+|-+$/g, '')                     // trim hyphens
      .replace(/-{2,}/g, '-') || 'character';      // collapse + fallback

  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

**Step 2.** `src/renderer/src/components/SeiPixelMark.tsx`:

```tsx
import React from 'react';

export interface SeiPixelMarkProps {
  height?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
}

export function SeiPixelMark(props: SeiPixelMarkProps): React.ReactElement {
  const { height = 22, color = 'var(--accent)', className, ariaLabel = 'Sei' } = props;
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'inline-block',
        height,
        width: height * 5,                          // logo aspect ~5:1 (matches sei-logo-small.svg)
        backgroundColor: color,
        WebkitMaskImage: "url('/img/sei-logo-small.svg')",
        maskImage: "url('/img/sei-logo-small.svg')",
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        verticalAlign: 'baseline',
      }}
    />
  );
}
```

**Step 3.** `src/renderer/src/components/QuestionShell.tsx` (+ adjacent CSS module):

```tsx
import React from 'react';
import { Button } from './Button';
import { StepDots } from './StepDots';
import { BackIcon } from './icons';
import styles from './QuestionShell.module.css';

export interface QuestionShellProps {
  eyebrow?: string;
  title: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
  stepCount: number;
  currentStep: number;
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextKind?: 'primary' | 'accent';
  nextDisabled?: boolean;
  backDisabled?: boolean;
}

export function QuestionShell(p: QuestionShellProps): React.ReactElement {
  return (
    <div className={styles.root}>
      <div className={styles.body}>
        {p.eyebrow ? <div className={styles.eyebrow}>{p.eyebrow}</div> : null}
        <h1 className={styles.title}>{p.title}</h1>
        {p.hint ? <p className={styles.hint}>{p.hint}</p> : null}
        <div className={styles.field}>{p.children}</div>
      </div>
      <div className={styles.footer}>
        <Button
          kind="quiet"
          size="md"
          icon={<BackIcon size={14} />}
          onClick={p.onBack}
          disabled={p.backDisabled}
          aria-label="Back"
        >
          Back
        </Button>
        <StepDots count={p.stepCount} current={p.currentStep} />
        <Button
          kind={p.nextKind ?? 'primary'}
          size="md"
          onClick={p.onNext}
          disabled={p.nextDisabled}
        >
          {p.nextLabel ?? 'Continue'}
        </Button>
      </div>
    </div>
  );
}
```

`QuestionShell.module.css`:
```css
.root { max-width: 520px; margin: 0 auto; padding: 0 56px; display: flex; flex-direction: column; min-height: 100%; }
.body { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 56px 0; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; }
.title { font-family: var(--sans); font-size: 30px; font-weight: 600; line-height: 1.2; letter-spacing: -0.4px; color: var(--text); margin: 0 0 16px; }
.hint { font-family: var(--sans); font-size: 15px; line-height: 1.5; color: var(--text-2); margin: 0 0 24px; }
.field { margin-top: 16px; animation: fade 220ms ease both; }
.footer { display: flex; align-items: center; justify-content: space-between; padding: 24px 0 32px; gap: 16px; }
```

**Step 4.** `src/renderer/src/components/ProviderTiles.tsx` (per D-26):

```tsx
import React from 'react';
import styles from './ProviderTiles.module.css';

export type Provider = 'anthropic' | 'openai' | 'google' | 'local';

const TILES: { id: Provider; label: string; dot: string; enabled: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic',  dot: '#C96442', enabled: true  },
  { id: 'openai',    label: 'OpenAI',     dot: '#10A37F', enabled: false },
  { id: 'google',    label: 'Google',     dot: '#4285F4', enabled: false },
  { id: 'local',     label: 'Local',      dot: '#6E6E6E', enabled: false },
];

export interface ProviderTilesProps {
  value: Provider;
  onChange: (next: Provider) => void;
}

export function ProviderTiles({ value, onChange }: ProviderTilesProps): React.ReactElement {
  return (
    <div className={styles.grid} role="radiogroup" aria-label="Choose a model provider">
      {TILES.map((tile) => {
        const selected = value === tile.id;
        const cls = [styles.tile, selected ? styles.selected : '', tile.enabled ? '' : styles.disabled].join(' ').trim();
        return (
          <button
            key={tile.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!tile.enabled}
            tabIndex={tile.enabled ? 0 : -1}
            className={cls}
            onClick={() => { if (tile.enabled) onChange(tile.id); }}
          >
            <span className={styles.dot} style={{ background: tile.dot }} />
            <span className={styles.label}>{tile.label}</span>
            {tile.enabled ? null : <span className={styles.chip}>Coming soon</span>}
          </button>
        );
      })}
    </div>
  );
}
```

`ProviderTiles.module.css`:
```css
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); padding: 18px 16px; display: flex; align-items: center; gap: 12px; transition: border-color 140ms ease, background 140ms ease; cursor: pointer; }
.tile:hover { border-color: var(--border-strong); }
.selected { border-color: var(--accent); background: var(--accent-soft); }
.disabled { opacity: 0.5; cursor: not-allowed; }
.dot { width: 8px; height: 8px; display: inline-block; }
.label { font-family: var(--sans); font-size: 14px; font-weight: 600; color: var(--text); flex: 1; text-align: left; }
.chip { font-family: var(--sans); font-size: 12px; font-weight: 600; padding: 2px 8px; background: var(--rail-active); color: var(--muted); }
```

**Step 5.** `src/renderer/src/components/AddCard.tsx`:

```tsx
import React from 'react';
import { PlusIcon } from './icons';
import styles from './AddCard.module.css';

export interface AddCardProps { onClick: () => void; }

export function AddCard({ onClick }: AddCardProps): React.ReactElement {
  return (
    <button type="button" className={styles.card} onClick={onClick} aria-label="Add new character">
      <div className={styles.iconTile}>
        <PlusIcon size={26} />
      </div>
      <div className={styles.label}>New character</div>
      <div className={styles.subhint}>Build a fresh persona</div>
    </button>
  );
}
```

`AddCard.module.css`:
```css
.card { background: transparent; border: 2px dashed var(--border-strong); aspect-ratio: 1 / 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; transition: border-color 180ms ease, background 180ms ease, color 180ms ease; color: var(--text-2); cursor: pointer; }
.card:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.iconTile { width: 56px; height: 56px; background: var(--surface); display: flex; align-items: center; justify-content: center; transition: background 180ms ease, color 180ms ease; }
.card:hover .iconTile { background: var(--accent); color: var(--accent-text); }
.label { font-family: var(--sans); font-size: 14px; font-weight: 600; }
.subhint { font-family: var(--sans); font-size: 12px; font-weight: 400; color: var(--muted); }
```

**Step 6.** `src/renderer/src/components/CharacterCard.tsx`:

Port from `design/project/screens.jsx` `CharacterCard`. The hover state shows the centered Summon button overlay; clicking the overlay summons (via parent prop) without firing the card click. Status chip top-left is "DEFAULT" with green dot for `id === 'sui'`, "CUSTOM" with gray dot otherwise.

```tsx
import React from 'react';
import type { Character } from '@shared/characterSchema';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { ArrowIcon, SparkleIcon } from './icons';
import { pickPalette } from '../lib/portraitPalettes';
import styles from './CharacterCard.module.css';

export interface CharacterCardProps {
  character: Character;
  theme: 'light' | 'dark';
  onOpen: () => void;
  onSummon: () => void;
}

function formatLast(iso: string | null): string {
  if (!iso) return 'Never summoned';
  try {
    const d = new Date(iso);
    return `Last: ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  } catch { return 'Never summoned'; }
}

export function CharacterCard({ character: c, theme, onOpen, onSummon }: CharacterCardProps): React.ReactElement {
  const palette = pickPalette(c.id + c.name, theme);
  const isDefault = c.id === 'sui';
  return (
    <div className={styles.card} onClick={onOpen}>
      <div className={styles.portraitWrap}>
        <PixelPortrait seed={c.id + c.name} palette={palette} size={260} portraitImage={c.portrait_image} />
        <div className={styles.gradient} />
        <div className={`${styles.chip} ${isDefault ? styles.chipDefault : styles.chipCustom}`}>
          <span className={styles.chipDot} />
          {isDefault ? 'DEFAULT' : 'CUSTOM'}
        </div>
        <div className={styles.nameOverlay}>{c.name}</div>
        <div className={styles.hoverOverlay}>
          <Button
            kind="accent"
            size="md"
            icon={<SparkleIcon size={12} />}
            onClick={(e) => { e.stopPropagation(); onSummon(); }}
            aria-label={`Summon ${c.name}`}
          >
            Summon
          </Button>
        </div>
      </div>
      <div className={styles.infoRow}>
        <div className={styles.infoText}>
          <div className={styles.infoName}>{c.name}</div>
          <div className={styles.infoMeta}>{formatLast(c.last_launched)}</div>
        </div>
        <ArrowIcon size={14} />
      </div>
    </div>
  );
}
```

`CharacterCard.module.css`:
```css
.card { background: var(--surface); border: 1px solid var(--border); display: flex; flex-direction: column; cursor: pointer; box-shadow: var(--shadow-card); transition: transform 200ms var(--ease-pop), box-shadow 200ms var(--ease-pop); }
.card:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); }
.portraitWrap { position: relative; aspect-ratio: 1 / 1; overflow: hidden; }
.gradient { position: absolute; left: 0; right: 0; bottom: 0; height: 50%; background: linear-gradient(180deg, transparent, rgba(0,0,0,0.55)); pointer-events: none; }
.chip { position: absolute; top: 10px; left: 10px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: rgba(0,0,0,0.55); color: white; font-family: var(--mono); font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; }
.chipDot { width: 6px; height: 6px; }
.chipDefault .chipDot { background: var(--green); }
.chipCustom .chipDot { background: var(--muted); }
.nameOverlay { position: absolute; left: 12px; bottom: 10px; font-family: var(--pixel); font-size: 14px; color: white; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
.hoverOverlay { position: absolute; inset: 0; background: rgba(0,0,0,0.20); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 180ms ease; }
.card:hover .hoverOverlay, .card:focus-within .hoverOverlay { opacity: 1; }
.infoRow { display: flex; align-items: center; padding: 12px 14px; gap: 12px; }
.infoText { flex: 1; min-width: 0; }
.infoName { font-family: var(--sans); font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.infoMeta { font-family: var(--sans); font-size: 11px; color: var(--muted); margin-top: 2px; }
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/lib/slug.ts && test -f src/renderer/src/components/SeiPixelMark.tsx && test -f src/renderer/src/components/QuestionShell.tsx && test -f src/renderer/src/components/ProviderTiles.tsx && test -f src/renderer/src/components/AddCard.tsx && test -f src/renderer/src/components/CharacterCard.tsx && grep -q "export function slugify" src/renderer/src/lib/slug.ts && grep -q "export function SeiPixelMark" src/renderer/src/components/SeiPixelMark.tsx && grep -q "mask-image\\|maskImage" src/renderer/src/components/SeiPixelMark.tsx && grep -q "export function QuestionShell" src/renderer/src/components/QuestionShell.tsx && grep -q "StepDots" src/renderer/src/components/QuestionShell.tsx && grep -q "export function ProviderTiles" src/renderer/src/components/ProviderTiles.tsx && grep -q "Coming soon" src/renderer/src/components/ProviderTiles.tsx && grep -q "aria-disabled" src/renderer/src/components/ProviderTiles.tsx && grep -q "id: .anthropic.,.*enabled: true" src/renderer/src/components/ProviderTiles.tsx && grep -q "id: .openai.,.*enabled: false" src/renderer/src/components/ProviderTiles.tsx && grep -q "export function AddCard" src/renderer/src/components/AddCard.tsx && grep -q "New character" src/renderer/src/components/AddCard.tsx && grep -q "Build a fresh persona" src/renderer/src/components/AddCard.tsx && grep -q "export function CharacterCard" src/renderer/src/components/CharacterCard.tsx && grep -q "SparkleIcon" src/renderer/src/components/CharacterCard.tsx && grep -q "id === .sui." src/renderer/src/components/CharacterCard.tsx && grep -q "Never summoned" src/renderer/src/components/CharacterCard.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(slug|SeiPixelMark|QuestionShell|ProviderTiles|AddCard|CharacterCard)\\.ts.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - All 6 files exist
    - `slug.ts` exports `slugify` with collision-safe `-2`/`-3` suffix logic
    - `SeiPixelMark.tsx` uses `mask-image` (or `maskImage` style) for the recolored logo
    - `QuestionShell.tsx` renders `StepDots`
    - `ProviderTiles.tsx` includes `Coming soon` literal AND `aria-disabled` AND has `id: 'anthropic'` enabled true and `id: 'openai'` enabled false (per D-26)
    - `AddCard.tsx` contains literals `New character` and `Build a fresh persona`
    - `CharacterCard.tsx` references `SparkleIcon` (NOT play icon — D-49)
    - `CharacterCard.tsx` checks `id === 'sui'` for default badge
    - `CharacterCard.tsx` contains `Never summoned` literal (UI-SPEC empty state)
    - `npx tsc --noEmit -p tsconfig.web.json` reports 0 errors for these files (CSS module errors tolerated)
  </acceptance_criteria>
  <done>Helper components ready. Screens consume them in tasks 2 and 3.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: OnboardingScreen + ComingSoonScreen</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (OnboardingScreen + ComingSoonScreen — port verbatim)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"OnboardingScreen — 5 steps" + §"ComingSoonScreen"
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Copywriting Contract" — exact CTA copy
    - src/renderer/src/components/QuestionShell.tsx, ProviderTiles.tsx, SeiPixelMark.tsx, TextField.tsx, Button.tsx (created in Task 1)
    - src/renderer/src/lib/ipcClient.ts
    - src/renderer/src/lib/stores/useUiStore.ts
    - src/shared/characterSchema.ts (UserConfig shape)
  </read_first>
  <behavior>
    - `OnboardingScreen({ isReonboard })`: Steps 0–4. Local React state for `mcUsername`, `preferredName`, `provider`, `apiKey`, `currentStep`.
    - Step 0: Welcome. Centered. Title is `<>Welcome to <SeiPixelMark height={22} color='var(--accent)' />.</>` baseline-aligned. CTA "Begin" (accent), always enabled.
    - Step 1: "What's your Minecraft username?" mono TextField, autoFocus. CTA "Continue", disabled until `.trim() !== ''`.
    - Step 2: "What should they call you?" sans TextField, autoFocus. CTA "Continue", same validation.
    - Step 3: "Which model provider?" — ProviderTiles component. CTA "Continue", always enabled (default anthropic).
    - Step 4: "Paste your Anthropic API key." password TextField mono, placeholder `sk-ant-...`. CTA "Finish" (accent), disabled until `.trim() !== ''`. On submit (WARNING-7 fix — UserConfig saves FIRST):
      1. `await sei.saveConfig({ mc_username, preferred_name, provider, theme_mode })` (passing current themeMode from useUiStore)
      2. `await sei.saveApiKey(apiKey.trim())`
      3. Navigate to home.
      Rationale: a saveConfig failure leaves zero state changes. A saveApiKey failure after saveConfig succeeded surfaces inline and is retryable — saved UserConfig alone is harmless because the home route is gated on `sei.hasApiKey()` returning true.
    - Back button on step 0: if `isReonboard` go to settings; else exit-no-op (just stay on step 0 with disabled).
    - Provider step CTA continues even if user doesn't change anything (Anthropic default).
    - On reonboard: pre-fill `mcUsername`, `preferredName`, `provider` from `await sei.getConfig()` on mount; api key field starts empty (force re-entry per UI-SPEC).
    - Errors during save: display error inline below the field (red mono 13px hint per UI-SPEC §TextField error state). Use `lib/errors.ts` ERROR_COPY (plan 09 ships this — for now, fall back to raw error message; plan 09 wires the proper map).
    - `ComingSoonScreen()`: centered max-width 440. Pixel "Other games" 22px in --accent. H1 "Coming soon." sans 28/600. Button "Back to Minecraft" → navigate({kind:'home'}).
  </behavior>
  <action>
**Step 1.** `src/renderer/src/screens/OnboardingScreen.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { ProviderTiles, type Provider } from '../components/ProviderTiles';
import { SeiPixelMark } from '../components/SeiPixelMark';
import type { UserConfig } from '@shared/characterSchema';

export interface OnboardingScreenProps {
  isReonboard: boolean;
}

const STEPS = 5;

export function OnboardingScreen({ isReonboard }: OnboardingScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const themeMode = useUiStore((s) => s.themeMode);
  const [step, setStep] = useState(0);
  const [mc, setMc] = useState('');
  const [pref, setPref] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isReonboard) return;
    let cancelled = false;
    sei.getConfig().then((cfg: UserConfig) => {
      if (cancelled) return;
      setMc(cfg.mc_username ?? '');
      setPref(cfg.preferred_name ?? '');
      setProvider((cfg.provider ?? 'anthropic') as Provider);
      // apiKey deliberately not pre-filled — UI-SPEC re-onboarding rule
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isReonboard]);

  const back = () => {
    if (step === 0) {
      if (isReonboard) navigate({ kind: 'settings' });
      return;
    }
    setStep((s) => s - 1);
  };

  const next = async () => {
    if (step < STEPS - 1) {
      setStep((s) => s + 1);
      return;
    }
    // Final submit (step 4).
    // WARNING-7 fix: save UserConfig FIRST, then apiKey. If saveConfig
    // fails (validation / disk error), zero state changes — the user
    // re-runs onboarding cleanly. If saveApiKey fails after saveConfig
    // succeeded, the inline error surfaces and the user retries; the
    // saved UserConfig alone is harmless because App.tsx gates the home
    // route on `sei.hasApiKey()` returning true.
    setError(null);
    setSubmitting(true);
    try {
      await sei.saveConfig({
        mc_username: mc.trim(),
        preferred_name: pref.trim(),
        provider,
        theme_mode: themeMode,
      });
      await sei.saveApiKey(apiKey.trim());
      navigate({ kind: 'home' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const validate = (): boolean => {
    if (step === 0) return true;
    if (step === 1) return mc.trim() !== '';
    if (step === 2) return pref.trim() !== '';
    if (step === 3) return true;
    if (step === 4) return apiKey.trim() !== '' && !submitting;
    return false;
  };

  // Step rendering
  if (step === 0) {
    return (
      <QuestionShell
        title={<>Welcome to <SeiPixelMark height={22} />.</>}
        stepCount={STEPS}
        currentStep={step}
        onBack={isReonboard ? back : undefined}
        backDisabled={!isReonboard}
        onNext={next}
        nextLabel="Begin"
        nextKind="accent"
      >
        <span />
      </QuestionShell>
    );
  }
  if (step === 1) {
    return (
      <QuestionShell
        title="What's your Minecraft username?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField value={mc} onChange={setMc} monospace autoFocus onEnter={next} aria-label="Minecraft username" />
      </QuestionShell>
    );
  }
  if (step === 2) {
    return (
      <QuestionShell
        title="What should they call you?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField value={pref} onChange={setPref} autoFocus onEnter={next} aria-label="Preferred name" />
      </QuestionShell>
    );
  }
  if (step === 3) {
    return (
      <QuestionShell
        title="Which model provider?"
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
      >
        <ProviderTiles value={provider} onChange={setProvider} />
      </QuestionShell>
    );
  }
  // step === 4
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'Local';
  return (
    <QuestionShell
      title={`Paste your ${providerLabel} API key.`}
      stepCount={STEPS}
      currentStep={step}
      onBack={back}
      onNext={next}
      nextLabel="Finish"
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField
        value={apiKey}
        onChange={(v) => { setApiKey(v); setError(null); }}
        type="password"
        monospace
        placeholder="sk-ant-..."
        autoFocus
        onEnter={() => { if (validate()) void next(); }}
        aria-label="API key"
        aria-invalid={!!error}
      />
      {error ? <div style={{ marginTop: 12, color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13 }}>{error}</div> : null}
    </QuestionShell>
  );
}
```

**Step 2.** `src/renderer/src/screens/ComingSoonScreen.tsx`:

```tsx
import React from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import styles from './ComingSoonScreen.module.css';

export function ComingSoonScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>Other games</div>
      <h1 className={styles.title}>Coming soon.</h1>
      <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
        Back to Minecraft
      </Button>
    </div>
  );
}
```

`ComingSoonScreen.module.css`:
```css
.root { max-width: 440px; margin: 0 auto; padding: 80px 40px; display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
.eyebrow { font-family: var(--pixel); font-size: 22px; color: var(--accent); margin-bottom: 8px; }
.title { font-family: var(--sans); font-size: 28px; font-weight: 600; letter-spacing: -0.4px; color: var(--text); margin: 0 0 16px; }
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/screens/OnboardingScreen.tsx && test -f src/renderer/src/screens/ComingSoonScreen.tsx && grep -q "export function OnboardingScreen" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "STEPS = 5" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "Welcome to" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "Minecraft username" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "What should they call you" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "model provider" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "API key" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "sk-ant-" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "sei.saveApiKey" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "sei.saveConfig" src/renderer/src/screens/OnboardingScreen.tsx && awk "/sei\\.saveConfig/{c=NR} /sei\\.saveApiKey/{k=NR} END{exit !(c>0 && k>0 && c<k)}" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "navigate({ kind: .home." src/renderer/src/screens/OnboardingScreen.tsx && grep -q "isReonboard" src/renderer/src/screens/OnboardingScreen.tsx && grep -q "export function ComingSoonScreen" src/renderer/src/screens/ComingSoonScreen.tsx && grep -q "Other games" src/renderer/src/screens/ComingSoonScreen.tsx && grep -q "Coming soon" src/renderer/src/screens/ComingSoonScreen.tsx && grep -q "Back to Minecraft" src/renderer/src/screens/ComingSoonScreen.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(OnboardingScreen|ComingSoonScreen)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `OnboardingScreen.tsx` contains literal `STEPS = 5`
    - File contains all 5 step copy strings: `Welcome to`, `Minecraft username`, `What should they call you`, `model provider`, `API key`
    - File contains `sk-ant-` placeholder string
    - File calls `sei.saveApiKey` and `sei.saveConfig` and navigates to `{ kind: 'home' }` on success
    - **WARNING-7 fix:** `sei.saveConfig` appears BEFORE `sei.saveApiKey` in the submit handler (verified by line-order — the line containing `sei.saveConfig` has a smaller line number than the line containing `sei.saveApiKey`). Verify with: `awk '/sei\.saveConfig/{c=NR} /sei\.saveApiKey/{k=NR} END{exit !(c>0 && k>0 && c<k)}' src/renderer/src/screens/OnboardingScreen.tsx`
    - File supports `isReonboard` prop and uses it to pre-populate fields and adjust back behavior
    - `ComingSoonScreen.tsx` contains `Other games` and `Back to Minecraft`
    - Both files compile with no TS errors (CSS module errors tolerated)
  </acceptance_criteria>
  <done>Onboarding flow + ComingSoon stub complete. Plan 06's App.tsx placeholders for these views can now be replaced with real components.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: HomeScreen + AddCharacterScreen + wire screens into App.tsx</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (HomeScreen, AddCharacterScreen — port verbatim)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"HomeScreen" + §"AddCharacterScreen — 3 steps"
    - src/renderer/src/components/CharacterCard.tsx, AddCard.tsx, QuestionShell.tsx, TextField.tsx, Button.tsx (Task 1)
    - src/renderer/src/screens/OnboardingScreen.tsx (Task 2)
    - src/renderer/src/lib/slug.ts (Task 1)
    - src/renderer/src/App.tsx (plan 06 — placeholders to replace)
    - src/shared/characterSchema.ts (Character shape)
  </read_first>
  <behavior>
    - `HomeScreen()`: Renders header row with H1 "Characters" (sans 32 / 600 -0.6 letter-spacing per UI-SPEC), LAN pill (button) + "+ New" Button. LAN pill text: "CONNECTED" / "NOT CONNECTED" / "UNAVAILABLE" per `useDataStore.lan.kind`, with colored 7px square dot. Click on LAN pill: `openModal({kind:'lan', mode:'info'})`. Click "+ New": `navigate({kind:'add-character'})`. Grid below: characters (from `useDataStore.characters`) as CharacterCard — onOpen → `navigate({kind:'character', id})`; onSummon → set pendingSummonId, then if `lan.kind === 'connected'`, call `sei.summon(id)` and `navigate({kind:'character', id})`; else open LAN modal in searching mode (plan 08 picks up the Searching mode). For this plan, the searching-mode wiring is `openModal({kind:'lan', mode:'searching'})` + `setPendingSummon(id)`. Last grid item: AddCard → navigate to add-character.
    - `AddCharacterScreen()`: 3 steps. Step 0: name. Step 1: description (multiline 5 rows, sans). Step 2: persona prompt (multiline 7 rows, mono). Final CTA "Create" (accent). On submit:
      1. Compute id via `slugify(name, existingIds)` from current `useDataStore.characters` map.
      2. Build Character object: `{ id, name, description, persona_prompt, is_default: false, created: new Date().toISOString(), last_launched: null, playtime_ms: 0, portrait_image: null }`.
      3. `await sei.saveCharacter(character)`.
      4. `useDataStore.getState().addCharacter(character)`.
      5. `navigate({kind:'character', id: character.id})`.
    - Back from AddCharacter step 0: navigate({kind:'home'}).
    - Update App.tsx to import and render the real OnboardingScreen / HomeScreen / AddCharacterScreen / ComingSoonScreen instead of the placeholders. Remove placeholder components.
  </behavior>
  <action>
**Step 1.** `src/renderer/src/screens/HomeScreen.tsx`:

```tsx
import React from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { Button } from '../components/Button';
import { CharacterCard } from '../components/CharacterCard';
import { AddCard } from '../components/AddCard';
import styles from './HomeScreen.module.css';

function lanLabel(kind: 'connected' | 'not_connected' | 'unavailable'): string {
  if (kind === 'connected') return 'CONNECTED';
  if (kind === 'not_connected') return 'NOT CONNECTED';
  return 'UNAVAILABLE';
}

export function HomeScreen(): React.ReactElement {
  const characters = useDataStore((s) => s.characters);
  const lan = useDataStore((s) => s.lan);
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  // Resolve theme by reading data-theme attribute (set by lib/theme.ts applyTheme)
  const theme: 'light' | 'dark' = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const lanDotColor = lan.kind === 'connected' ? 'var(--green)' : lan.kind === 'not_connected' ? 'var(--red)' : 'var(--muted)';
  const lanTitle = lan.kind === 'unavailable' ? 'LAN auto-detect unavailable on this network.' : undefined;

  const handleSummon = (id: string) => {
    if (lan.kind === 'connected') {
      // Fire and forget; status row will reflect connecting → online
      sei.summon(id).catch(() => { /* errors surface via onStatus */ });
      navigate({ kind: 'character', id });
    } else {
      setPendingSummon(id);
      openModal({ kind: 'lan', mode: 'searching' });
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Characters</h1>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.lanPill}
            onClick={() => openModal({ kind: 'lan', mode: 'info' })}
            title={lanTitle}
            aria-label={`LAN: ${lanLabel(lan.kind).toLowerCase()}`}
          >
            <span className={styles.lanDot} style={{ background: lanDotColor }} />
            {lanLabel(lan.kind)}
          </button>
          <Button kind="ghost" size="md" onClick={() => navigate({ kind: 'add-character' })}>
            + New
          </Button>
        </div>
      </header>
      <section className={styles.grid}>
        {characters.map((c) => (
          <CharacterCard
            key={c.id}
            character={c}
            theme={theme}
            onOpen={() => navigate({ kind: 'character', id: c.id })}
            onSummon={() => handleSummon(c.id)}
          />
        ))}
        <AddCard onClick={() => navigate({ kind: 'add-character' })} />
      </section>
    </div>
  );
}
```

`HomeScreen.module.css`:
```css
.root { padding: 32px 40px 56px; }
.header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 28px; }
.title { font-family: var(--sans); font-size: 32px; font-weight: 600; letter-spacing: -0.6px; color: var(--text); margin: 0; }
.actions { display: flex; gap: 12px; align-items: center; }
.lanPill { background: transparent; border: 1px solid var(--border-strong); padding: 8px 12px; display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-2); cursor: pointer; }
.lanDot { width: 7px; height: 7px; display: inline-block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
```

**Step 2.** `src/renderer/src/screens/AddCharacterScreen.tsx`:

```tsx
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { QuestionShell } from '../components/QuestionShell';
import { TextField } from '../components/TextField';
import { slugify } from '../lib/slug';
import type { Character } from '@shared/characterSchema';

const STEPS = 3;

export function AddCharacterScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const characters = useDataStore((s) => s.characters);
  const addCharacter = useDataStore((s) => s.addCharacter);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personaPrompt, setPersonaPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const back = () => {
    if (step === 0) { navigate({ kind: 'home' }); return; }
    setStep((s) => s - 1);
  };

  const validate = (): boolean => {
    if (step === 0) return name.trim() !== '';
    if (step === 1) return true;                       // description optional
    if (step === 2) return personaPrompt.trim() !== '' && !submitting;
    return false;
  };

  const next = async () => {
    if (step < STEPS - 1) { setStep((s) => s + 1); return; }
    setError(null);
    setSubmitting(true);
    try {
      const existingIds = characters.map((c) => c.id);
      const id = slugify(name.trim(), existingIds);
      const character: Character = {
        id,
        name: name.trim(),
        description: description.trim(),
        persona_prompt: personaPrompt.trim(),
        is_default: false,
        created: new Date().toISOString(),
        last_launched: null,
        playtime_ms: 0,
        portrait_image: null,
      };
      await sei.saveCharacter(character);
      addCharacter(character);
      navigate({ kind: 'character', id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 0) {
    return (
      <QuestionShell
        title="Name your character."
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
        nextDisabled={!validate()}
      >
        <TextField value={name} onChange={setName} autoFocus onEnter={next} aria-label="Character name" />
      </QuestionShell>
    );
  }
  if (step === 1) {
    return (
      <QuestionShell
        eyebrow="Shown to you"
        title="Describe them."
        hint="A short bio that appears on this character's page. Just for you — purely flavour."
        stepCount={STEPS}
        currentStep={step}
        onBack={back}
        onNext={next}
      >
        <TextField value={description} onChange={setDescription} multiline rows={5} aria-label="Description" />
      </QuestionShell>
    );
  }
  return (
    <QuestionShell
      eyebrow="Sent to the model"
      title="Write the persona prompt."
      hint="The system instruction the language model receives. Speak to the model directly."
      stepCount={STEPS}
      currentStep={step}
      onBack={back}
      onNext={next}
      nextLabel="Create"
      nextKind="accent"
      nextDisabled={!validate()}
    >
      <TextField value={personaPrompt} onChange={setPersonaPrompt} multiline rows={7} monospace aria-label="Persona prompt" />
      {error ? <div style={{ marginTop: 12, color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13 }}>{error}</div> : null}
    </QuestionShell>
  );
}
```

**Step 3.** Update `src/renderer/src/App.tsx`:
- Import the four new screens.
- Replace the four placeholder components with real renders. CharacterPage and Settings stay as placeholders for plan 08 to fill in.

```tsx
// Replace existing placeholder block in App.tsx with:
import { OnboardingScreen } from './screens/OnboardingScreen';
import { HomeScreen } from './screens/HomeScreen';
import { AddCharacterScreen } from './screens/AddCharacterScreen';
import { ComingSoonScreen } from './screens/ComingSoonScreen';

// In the render switch:
{view.kind === 'onboarding' && <OnboardingScreen isReonboard={view.isReonboard} />}
{view.kind === 'home' && <HomeScreen />}
{view.kind === 'add-character' && <AddCharacterScreen />}
{view.kind === 'character' && <CharacterPagePlaceholder id={view.id} />}     {/* plan 08 replaces */}
{view.kind === 'settings' && <SettingsPlaceholder />}                          {/* plan 08 replaces */}
{view.kind === 'coming-soon' && <ComingSoonScreen />}
```

(Remove the `OnboardingPlaceholder`, `HomePlaceholder`, `AddCharacterPlaceholder`, `ComingSoonPlaceholder` from App.tsx — keep `CharacterPagePlaceholder` and `SettingsPlaceholder` for plan 08.)
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/screens/HomeScreen.tsx && test -f src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "export function HomeScreen" src/renderer/src/screens/HomeScreen.tsx && grep -q "export function AddCharacterScreen" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "Characters" src/renderer/src/screens/HomeScreen.tsx && grep -q "CONNECTED" src/renderer/src/screens/HomeScreen.tsx && grep -q "NOT CONNECTED" src/renderer/src/screens/HomeScreen.tsx && grep -q "+ New" src/renderer/src/screens/HomeScreen.tsx && grep -q "openModal" src/renderer/src/screens/HomeScreen.tsx && grep -q "sei.summon" src/renderer/src/screens/HomeScreen.tsx && grep -q "Name your character" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "Describe them" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "Shown to you" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "Sent to the model" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "Write the persona prompt" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "slugify" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "sei.saveCharacter" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "is_default: false" src/renderer/src/screens/AddCharacterScreen.tsx && grep -q "import { OnboardingScreen }" src/renderer/src/App.tsx && grep -q "import { HomeScreen }" src/renderer/src/App.tsx && grep -q "import { AddCharacterScreen }" src/renderer/src/App.tsx && grep -q "import { ComingSoonScreen }" src/renderer/src/App.tsx && ! grep -q "OnboardingPlaceholder\\|HomePlaceholder\\|AddCharacterPlaceholder\\|ComingSoonPlaceholder" src/renderer/src/App.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(HomeScreen|AddCharacterScreen|App)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `HomeScreen.tsx` contains `Characters` h1, `CONNECTED`/`NOT CONNECTED` LAN pill labels, `+ New` button
    - `HomeScreen.tsx` calls `openModal({...lan...})` and `sei.summon`
    - `AddCharacterScreen.tsx` contains all eyebrow + title + hint copy: `Name your character`, `Shown to you`, `Describe them`, `Sent to the model`, `Write the persona prompt`
    - File calls `slugify` and `sei.saveCharacter`
    - File creates a Character with `is_default: false`
    - `App.tsx` imports the four new screens and removes the four corresponding `*Placeholder` references — `CharacterPagePlaceholder` and `SettingsPlaceholder` may remain for plan 08
    - tsc passes for new files (CSS module errors tolerated)
  </acceptance_criteria>
  <done>Onboarding → Home → Add Character flow live end-to-end. User can complete onboarding and add a new character.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user input → main IPC | Onboarding + AddCharacter forms send free-text fields; main re-validates with Zod |
| user-supplied API key → safeStorage | passes plaintext through `sei.saveApiKey`; renderer never persists |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-31 | Tampering | renderer slug crafted to overwrite sui.json | mitigate | slugify uses lower-case + hyphens + collision-safe suffix; main's saveCharacter further validates via Zod; default character delete is gated server-side |
| T-04-32 | Information Disclosure | API key visible in DevTools network tab | accept | Plaintext crosses IPC; DevTools shows it; production builds disable DevTools by default. Renderer NEVER stores plaintext beyond the input field's lifetime (not in any persistent store). |
| T-04-33 | Tampering | renderer attempts to enable disabled provider tile | mitigate | `aria-disabled + tabIndex=-1 + click no-op` in ProviderTiles + Zod enum constraint in main config save (UserConfigSchema only allows 'anthropic') |
</threat_model>

<verification>
- `npm run dev` boots and shows OnboardingScreen on first run (no API key saved)
- Filling all 5 steps and pressing Finish calls `sei.saveApiKey` + `sei.saveConfig`, navigates to Home
- Home shows Sui (after migration) or empty grid + AddCard
- Clicking + New navigates to AddCharacterScreen; entering name/description/persona and pressing Create persists a new character JSON and navigates to its CharacterPage placeholder
- Theme persists: switching theme via IconRail and reloading preserves the choice (via config save)
- `npx tsc --noEmit -p tsconfig.web.json` reports 0 errors for new files
</verification>

<success_criteria>
- Plan 08 (CharacterPage + LanModal + SettingsScreen + LogsPanel) builds on top of these screens for the remaining surface.
- Plan 09 (errors) extends OnboardingScreen's error display to use the centralized ERROR_COPY map.
- Plan 11 verifies the onboarding-then-add-then-summon flow on a clean VM.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-07-SUMMARY.md` documenting:
- The slug collision algorithm (note that re-creating "Sui" while sui exists will produce `sui-2`, etc.)
- Which validation messages are still raw strings (plan 09 replaces them with ERROR_COPY map)
- Note for plan 08 executor: `useUiStore.openModal({kind:'lan', mode:'searching'})` + `setPendingSummon(id)` is the wiring; LanModal must read both and watch `useDataStore.lan` to auto-resume on connected
- Note for plan 09 executor: OnboardingScreen step-4 inline error message currently uses `(err as Error).message` — replace with `ERROR_COPY[errorClass]` once `lib/errors.ts` lands
</output>
