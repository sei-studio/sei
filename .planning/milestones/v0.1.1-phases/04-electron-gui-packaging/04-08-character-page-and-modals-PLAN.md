---
phase: 04-electron-gui-packaging
plan: 08
type: execute
wave: 6
depends_on: [01, 02, 05, 06, 07]
files_modified:
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/screens/SettingsScreen.tsx
  - src/renderer/src/components/LanModal.tsx
  - src/renderer/src/components/SummonToast.tsx
  - src/renderer/src/components/DeleteConfirmModal.tsx
  - src/renderer/src/components/LogsPanel.tsx
  - src/renderer/src/App.tsx
autonomous: true
requirements: [GUI-02, GUI-03, GUI-04]
must_haves:
  truths:
    - "CharacterPage shows portrait + persona-prompt (collapsed) + stats grid + model status row + tabs (Description / Persona prompt / Logs)"
    - "Logs tab is enabled only when this character is the active summon — disabled stub otherwise"
    - "LogsPanel renders virtualized log lines from useDataStore.logs (5000-line ring buffer) with color-tagging, copy-all, pause-autoscroll"
    - "Summon button on CharacterPage calls sei.summon(id) when LAN connected, or opens LAN modal in searching mode otherwise; status row reflects summon state via useDataStore.summon"
    - "Stop button visible while online; calls sei.stop()"
    - "LAN modal shows 4 numbered steps + live connected/not_connected pill + 'Searching…' row when in searching mode + auto-dismiss on lan:state → connected"
    - "Delete character flow: confirm modal with red Delete button; refuses delete on default Sui (button hidden); calls sei.deleteCharacter then navigates to Home"
    - "SettingsScreen shows account / appearance / setup sections with Re-run onboarding"
    - "SummonToast appears at bottom-right for 4.2s when summon fires"
  artifacts:
    - path: src/renderer/src/screens/CharacterPage.tsx
      provides: "Two-column character detail with tabs and Summon CTA"
      exports: ["CharacterPage"]
    - path: src/renderer/src/screens/SettingsScreen.tsx
      provides: "Account/Appearance/Setup sections"
      exports: ["SettingsScreen"]
    - path: src/renderer/src/components/LanModal.tsx
      provides: "Modal with 4 steps + live pill + searching mode + auto-dismiss"
      exports: ["LanModal"]
    - path: src/renderer/src/components/SummonToast.tsx
      provides: "4.2s bottom-right toast"
      exports: ["SummonToast"]
    - path: src/renderer/src/components/DeleteConfirmModal.tsx
      provides: "Sharp-cornered confirm modal with red Delete CTA"
      exports: ["DeleteConfirmModal"]
    - path: src/renderer/src/components/LogsPanel.tsx
      provides: "Virtualized terminal-style log viewer with color tagging"
      exports: ["LogsPanel"]
  key_links:
    - from: src/renderer/src/components/LanModal.tsx
      to: src/renderer/src/lib/stores/useDataStore.ts
      via: "subscribes to useDataStore.lan; auto-dismiss on lan.kind === 'connected' when in searching mode"
      pattern: "useDataStore"
    - from: src/renderer/src/components/LogsPanel.tsx
      to: src/renderer/src/lib/tagLog.ts
      via: "tagLog(line) for color classification"
      pattern: "tagLog"
    - from: src/renderer/src/screens/CharacterPage.tsx
      to: src/renderer/src/lib/stores/useDataStore.ts
      via: "characters + summon state + logs"
      pattern: "useDataStore"
---

<objective>
Implement the CharacterPage (the most complex screen — tabs, stats, model row, persona-prompt collapse), SettingsScreen, LanModal (with auto-resume), SummonToast, DeleteConfirmModal, and LogsPanel (virtualized scroll-pinned terminal). Wire them into App.tsx replacing the remaining placeholders.

Purpose: GUI-02 (Start/Stop), GUI-03 (live log viewer), GUI-04 (personality form Edit). After this plan, every screen in the design is live.

Output: 4 new components + 2 new screens + App.tsx update. LogsPanel is the most algorithmically interesting (hand-rolled IntersectionObserver windowing per UI-SPEC §Defaults).
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
@src/shared/ipc.ts
@src/shared/characterSchema.ts
@src/renderer/src/lib/ipcClient.ts
@src/renderer/src/lib/stores/useUiStore.ts
@src/renderer/src/lib/stores/useDataStore.ts
@src/renderer/src/lib/tagLog.ts
@src/renderer/src/components/Button.tsx
@src/renderer/src/components/PixelPortrait.tsx
@src/renderer/src/App.tsx

<interfaces>
From plan 06:
- Button, TextField, PixelPortrait, IconRail, MacosWindow, StepDots
- icons: BackIcon, SparkleIcon, SunIcon, MoonIcon, etc.
- useUiStore (view, modal, themeMode, pendingSummonId, navigate, openModal, closeModal, setPendingSummon, setThemeMode)
- useDataStore (characters, lan, summon, logs, dropped, refreshCharacter, removeCharacter)
- tagLog (line classifier)
- pickPalette

From plan 07:
- CharacterCard, AddCard, QuestionShell, ProviderTiles, SeiPixelMark, slugify

From shared:
- Character, UserConfig, ErrorClass
- BotStatus { kind: 'idle'|'connecting'|'online'|'error' }
- LanState { kind: 'connected'|'not_connected'|'unavailable' }
</interfaces>

<key_locked_decisions>
- D-49: CharacterPage two-column 320 + 1fr, 36px gap. Summon icon = sparkle (NOT play). Delete hidden when id === 'sui'.
- D-50: Persona-prompt collapsed by default; "Hidden" / "Sent to {model}" eyebrow companion. Show/Hide toggle accent mono uppercase. Expanded: 2px accent left-border + fade-in.
- D-51: Stats grid (Last launched / Total playtime / Created); '—' for never-summoned.
- D-52: Model row: green dot Ready/Online + mono model id; red dot + plain-English error + "Try again" link on error.
- D-53: Logs tab enabled only when active summon. 5000-line buffer in renderer.
- D-54..D-57: LAN modal — 4 steps verbatim, live pill in header, Searching mode in summon-while-disconnected, auto-dismiss on connected, ESC aborts pending summon. NO "Mark as connected" button.
- D-58: Settings sections — Account (mc_username, preferred_name, provider, api key shown as bullets), Appearance (theme), Setup (Re-run onboarding).
- D-59: SummonToast bottom-right, 4.2s auto-dismiss, dark bg / window-color text.
- UI-SPEC §Logs panel — color tags + Copy all + Pause autoscroll + auto-scroll-when-bottom + "↓ N new lines" pill when scrolled up.
- UI-SPEC §"LogsPanel" rendering: hand-rolled virtualization with IntersectionObserver + 200-line render window.
- UI-SPEC §"Character delete-gating" — confirm modal copy verbatim.
- UI-SPEC §"Re-onboarding" — Settings → Start over kicks off `OnboardingScreen` in `isReonboard=true` mode.
</key_locked_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: LanModal + SummonToast + DeleteConfirmModal</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (LanModal + SummonToast — port verbatim)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"LanModal" + §"SummonToast" + §"Character delete-gating"
    - src/renderer/src/lib/stores/useUiStore.ts, useDataStore.ts
    - src/renderer/src/lib/ipcClient.ts (sei.summon for auto-resume, sei.deleteCharacter)
    - src/shared/characterSchema.ts (Character)
  </read_first>
  <behavior>
    - `LanModal({ mode })` — 520px wide, scrim 0.45 black, centered, fade-up animation. Header shows live `Connected` / `Not connected` / `Unavailable on this network` pill (consumes useDataStore.lan). H2 "To summon a character into your world." Numbered list (4 steps verbatim). Footer: in `info` mode = `Close` button only. In `searching` mode: also a `Cancel summon` button + "Searching for an open LAN world…" row with three blinking dots.
    - On mount: if mode === 'searching', subscribes to `useDataStore.lan`. When `lan.kind === 'connected'`: closeModal, fire summon for `pendingSummonId` (use `sei.summon(id)`), navigate to that character page, clear pendingSummon.
    - Cancel summon (or ESC) in searching mode: `closeModal()` + `setPendingSummon(null)`.
    - `SummonToast({ name, onDone })` — appears at bottom-right (20px inset), 360px max-width, 14×18 padding, dark bg (`var(--text)`) light text (`var(--window)`). 36px PixelPortrait (procedural; can re-derive palette from name) + "Summoning {name}…". Auto-dismiss after 4200ms via `setTimeout`. Click anywhere on toast also dismisses. role="status" aria-live="polite".
    - `DeleteConfirmModal({ character, onCancel, onConfirm })` — 460px wide, centered, fade-up. Title "Delete {name}?". Body "This permanently removes their persona, description, and saved memory. You can't undo this." Buttons "Cancel" (kind=quiet) + "Delete {name}" (kind=primary, color override → `var(--red)` background, `var(--window)` text). ESC and "Cancel" both invoke `onCancel`.
  </behavior>
  <action>
**Step 1.** `src/renderer/src/components/LanModal.tsx`:

```tsx
import React, { useEffect } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import styles from './LanModal.module.css';

const STEPS = [
  'Launch Minecraft and open your singleplayer world.',
  'Press ESC, then choose Open to LAN.',
  'Set Allow Cheats to On, then click Start LAN World.',
  'Return to Sei and press Summon.',
];

function pillLabel(kind: 'connected'|'not_connected'|'unavailable'): string {
  if (kind === 'connected') return 'Connected';
  if (kind === 'unavailable') return 'Unavailable on this network';
  return 'Not connected';
}
function pillColor(kind: 'connected'|'not_connected'|'unavailable'): string {
  if (kind === 'connected') return 'var(--green)';
  if (kind === 'unavailable') return 'var(--muted)';
  return 'var(--red)';
}

export interface LanModalProps {
  mode: 'info' | 'searching';
}

export function LanModal({ mode }: LanModalProps): React.ReactElement {
  const lan = useDataStore((s) => s.lan);
  const closeModal = useUiStore((s) => s.closeModal);
  const pendingSummonId = useUiStore((s) => s.pendingSummonId);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const navigate = useUiStore((s) => s.navigate);

  // Auto-resume on connected (D-56)
  useEffect(() => {
    if (mode !== 'searching') return;
    if (lan.kind !== 'connected') return;
    if (!pendingSummonId) {
      closeModal();
      return;
    }
    const id = pendingSummonId;
    closeModal();
    setPendingSummon(null);
    sei.summon(id).catch(() => { /* surfaces via onStatus */ });
    navigate({ kind: 'character', id });
  }, [mode, lan, pendingSummonId, closeModal, setPendingSummon, navigate]);

  // ESC handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'searching') setPendingSummon(null);
        closeModal();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, closeModal, setPendingSummon]);

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby="lan-modal-title">
      <div className={styles.modal}>
        <div className={styles.headerEyebrow}>
          <span className={styles.headerDot} style={{ background: pillColor(lan.kind) }} />
          {pillLabel(lan.kind).toUpperCase()}
        </div>
        <h2 id="lan-modal-title" className={styles.title}>To summon a character into your world</h2>
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
            <li key={i} className={styles.step}>
              <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
              <span className={styles.stepBody}>{step}</span>
            </li>
          ))}
        </ol>
        {mode === 'searching' ? (
          <div className={styles.searching}>
            <span className={styles.searchDots}>
              <span style={{ animationDelay: '0ms' }} />
              <span style={{ animationDelay: '160ms' }} />
              <span style={{ animationDelay: '320ms' }} />
            </span>
            Searching for an open LAN world…
          </div>
        ) : null}
        <div className={styles.footer}>
          {mode === 'searching' ? (
            <Button kind="quiet" size="md" onClick={() => { setPendingSummon(null); closeModal(); }}>
              Cancel summon
            </Button>
          ) : null}
          <Button kind="primary" size="md" onClick={closeModal}>Close</Button>
        </div>
      </div>
    </div>
  );
}
```

`LanModal.module.css`:
```css
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade 220ms ease both; }
.modal { width: 520px; background: var(--window); padding: 32px; box-shadow: var(--shadow-pop); animation: fade-up 280ms var(--ease-pop) both; }
.headerEyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; letter-spacing: 1.2px; color: var(--text-2); margin-bottom: 12px; }
.headerDot { width: 8px; height: 8px; }
.title { font-family: var(--sans); font-size: 22px; font-weight: 600; color: var(--text); margin: 0 0 24px; }
.steps { list-style: none; padding: 0; margin: 0 0 24px; display: flex; flex-direction: column; gap: 12px; }
.step { display: flex; gap: 16px; align-items: baseline; }
.stepNumber { font-family: var(--pixel); font-size: 11px; color: var(--accent); width: 22px; flex-shrink: 0; }
.stepBody { font-family: var(--sans); font-size: 14px; line-height: 1.5; color: var(--text); }
.searching { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 12px; color: var(--muted); margin-bottom: 24px; }
.searchDots { display: inline-flex; gap: 4px; }
.searchDots span { width: 6px; height: 6px; background: var(--muted); display: block; animation: seiDot 1100ms ease-in-out infinite; }
.footer { display: flex; gap: 12px; justify-content: flex-end; }
```

**Step 2.** `src/renderer/src/components/SummonToast.tsx`:

```tsx
import React, { useEffect } from 'react';
import { PixelPortrait } from './PixelPortrait';
import { pickPalette } from '../lib/portraitPalettes';
import styles from './SummonToast.module.css';

const DISMISS_MS = 4200;

export interface SummonToastProps {
  characterId: string;
  characterName: string;
  onDone: () => void;
}

export function SummonToast({ characterId, characterName, onDone }: SummonToastProps): React.ReactElement {
  const theme: 'light'|'dark' = (document.documentElement.getAttribute('data-theme') as 'light'|'dark') ?? 'light';
  const palette = pickPalette(characterId + characterName, theme);

  useEffect(() => {
    const t = window.setTimeout(onDone, DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div className={styles.toast} role="status" aria-live="polite" onClick={onDone}>
      <PixelPortrait seed={characterId + characterName} palette={palette} size={36} portraitImage={null} />
      <div className={styles.text}>Summoning {characterName}…</div>
    </div>
  );
}
```

`SummonToast.module.css`:
```css
.toast { position: fixed; bottom: 20px; right: 20px; max-width: 360px; padding: 14px 18px; display: flex; align-items: center; gap: 14px; background: var(--text); color: var(--window); box-shadow: var(--shadow-pop); z-index: 90; animation: fade-up 280ms var(--ease-pop) both; cursor: pointer; }
.text { font-family: var(--sans); font-size: 13px; font-weight: 600; }
```

**Step 3.** `src/renderer/src/components/DeleteConfirmModal.tsx`:

```tsx
import React, { useEffect } from 'react';
import { Button } from './Button';
import styles from './DeleteConfirmModal.module.css';

export interface DeleteConfirmModalProps {
  characterName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmModal({ characterName, onCancel, onConfirm }: DeleteConfirmModalProps): React.ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
      <div className={styles.modal}>
        <h2 id="delete-confirm-title" className={styles.title}>Delete {characterName}?</h2>
        <p className={styles.body}>
          This permanently removes their persona, description, and saved memory. You can't undo this.
        </p>
        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onCancel}>Cancel</Button>
          <button type="button" className={styles.deleteBtn} onClick={onConfirm}>Delete {characterName}</button>
        </div>
      </div>
    </div>
  );
}
```

`DeleteConfirmModal.module.css`:
```css
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade 220ms ease both; }
.modal { width: 460px; background: var(--window); padding: 32px; box-shadow: var(--shadow-pop); animation: fade-up 280ms var(--ease-pop) both; }
.title { font-family: var(--sans); font-size: 22px; font-weight: 600; color: var(--text); margin: 0 0 16px; }
.body { font-family: var(--sans); font-size: 15px; line-height: 1.5; color: var(--text-2); margin: 0 0 24px; }
.footer { display: flex; gap: 12px; justify-content: flex-end; }
.deleteBtn { background: var(--red); color: var(--window); border: 0; padding: 0 16px; height: 38px; font-family: var(--sans); font-size: 14px; font-weight: 600; cursor: pointer; }
.deleteBtn:hover { filter: brightness(1.05); }
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/components/LanModal.tsx && test -f src/renderer/src/components/SummonToast.tsx && test -f src/renderer/src/components/DeleteConfirmModal.tsx && grep -q "export function LanModal" src/renderer/src/components/LanModal.tsx && grep -q "Launch Minecraft" src/renderer/src/components/LanModal.tsx && grep -q "Press ESC" src/renderer/src/components/LanModal.tsx && grep -q "Allow Cheats" src/renderer/src/components/LanModal.tsx && grep -q "Return to Sei" src/renderer/src/components/LanModal.tsx && grep -q "Searching for an open LAN world" src/renderer/src/components/LanModal.tsx && grep -q "Cancel summon" src/renderer/src/components/LanModal.tsx && grep -q "sei.summon" src/renderer/src/components/LanModal.tsx && ! grep -q "Mark as connected\\|Mark connected" src/renderer/src/components/LanModal.tsx && grep -q "export function SummonToast" src/renderer/src/components/SummonToast.tsx && grep -q "DISMISS_MS = 4200" src/renderer/src/components/SummonToast.tsx && grep -q "role=\"status\"" src/renderer/src/components/SummonToast.tsx && grep -q "aria-live=\"polite\"" src/renderer/src/components/SummonToast.tsx && grep -q "export function DeleteConfirmModal" src/renderer/src/components/DeleteConfirmModal.tsx && grep -q "permanently removes their persona" src/renderer/src/components/DeleteConfirmModal.tsx && grep -q "Escape" src/renderer/src/components/DeleteConfirmModal.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(LanModal|SummonToast|DeleteConfirmModal)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - All 3 components exist
    - `LanModal.tsx` contains all 4 verbatim step copy strings (matching D-54)
    - `LanModal.tsx` contains `Searching for an open LAN world` and `Cancel summon` and calls `sei.summon`
    - `LanModal.tsx` does NOT contain `Mark as connected` or similar prototype-only language (D-23, D-57)
    - `SummonToast.tsx` has `DISMISS_MS = 4200` and `role="status"` `aria-live="polite"`
    - `DeleteConfirmModal.tsx` body copy matches UI-SPEC verbatim
    - `DeleteConfirmModal.tsx` handles `Escape` key
    - tsc passes (CSS module errors tolerated)
  </acceptance_criteria>
  <done>Three modals/toast ready. CharacterPage and HomeScreen consume them via App.tsx render layer.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: LogsPanel (virtualized scroll-pinned terminal)</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Logs panel" (lines ~412–430) — full contract
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"Defaults" — Log virtualization "Hand-rolled windowing with IntersectionObserver + a 200-line render window"
    - src/renderer/src/lib/tagLog.ts (color classification)
    - src/renderer/src/lib/stores/useDataStore.ts (logs ring buffer)
    - .planning/phases/04-electron-gui-packaging/04-RESEARCH.md §"Code Examples §6" — bounded ring buffer
    - src/renderer/src/components/Button.tsx
  </read_first>
  <behavior>
    - Renders a fixed-height (e.g., parent's height) scrollable container of mono lines from `useDataStore.logs`.
    - For lists ≤ 500 lines, render plain (no virtualization). For > 500 lines, render only a 200-line window around the user's current scroll position. Use `IntersectionObserver` with sentinel divs to detect scroll position.
    - Each line: `<div style={{color: tagLog(message).color}}>{message}</div>`. Mono 12px. Line-height 1.55.
    - Scroll-pinned: when scrollTop is within 80px of bottom, on each appendLogBatch, scroll to bottom. When user scrolls up >80px, autoscroll pauses and a "↓ N new lines" pill appears (clicking it scrolls to bottom and resumes).
    - Header bar: "Copy all" Button (ghost sm, calls navigator.clipboard.writeText), "Pause autoscroll" toggle Button (quiet sm, label flips between "Pause autoscroll" and "Resume").
    - When `useDataStore.dropped > 0`, show a small "(N lines dropped due to backpressure)" muted footer line.
  </behavior>
  <action>
Create `src/renderer/src/components/LogsPanel.tsx`:

```tsx
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { tagLog } from '../lib/tagLog';
import { Button } from './Button';
import styles from './LogsPanel.module.css';

const VIRT_THRESHOLD = 500;
const WINDOW_SIZE = 200;
const PIN_THRESHOLD = 80;

export function LogsPanel(): React.ReactElement {
  const logs = useDataStore((s) => s.logs);
  const dropped = useDataStore((s) => s.dropped);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0); // for virtualization

  const total = logs.length;
  const useVirtual = total > VIRT_THRESHOLD;

  // Compute the slice to render
  const slice = useMemo(() => {
    if (!useVirtual) return { start: 0, lines: logs };
    // Render WINDOW_SIZE lines anchored on scrollOffset (line index)
    const start = Math.max(0, Math.min(total - WINDOW_SIZE, scrollOffset));
    return { start, lines: logs.slice(start, start + WINDOW_SIZE) };
  }, [useVirtual, logs, total, scrollOffset]);

  // On new logs, autoscroll if pinned
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
      setNewSinceScroll(0);
    } else {
      setNewSinceScroll((n) => n + 1);
    }
  }, [logs.length, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= PIN_THRESHOLD) {
      if (!autoScroll) { setAutoScroll(true); setNewSinceScroll(0); }
    } else {
      if (autoScroll) setAutoScroll(false);
    }
    if (useVirtual) {
      // Translate scroll to a line index — 18px per line approximation
      const linePx = 18;
      const visibleStartLine = Math.floor(el.scrollTop / linePx);
      // Anchor window such that visible start sits ~25% into the window
      const desiredStart = visibleStartLine - Math.floor(WINDOW_SIZE * 0.25);
      setScrollOffset(Math.max(0, Math.min(total - WINDOW_SIZE, desiredStart)));
    }
  };

  const copyAll = () => {
    const text = logs.map((l) => l.message).join('\n');
    void navigator.clipboard.writeText(text);
  };

  const resumeScroll = () => {
    setAutoScroll(true);
    setNewSinceScroll(0);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button kind="ghost" size="sm" onClick={copyAll}>Copy all</Button>
        <Button kind="quiet" size="sm" onClick={() => setAutoScroll((s) => !s)}>
          {autoScroll ? 'Pause autoscroll' : 'Resume'}
        </Button>
      </div>
      <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
        {useVirtual ? (
          <>
            <div style={{ height: slice.start * 18 }} />
            {slice.lines.map((entry, i) => {
              const tagged = tagLog(entry.message);
              return <div key={slice.start + i} className={styles.line} style={{ color: tagged.color }}>{entry.message}</div>;
            })}
            <div style={{ height: Math.max(0, (total - slice.start - slice.lines.length) * 18) }} />
          </>
        ) : (
          slice.lines.map((entry, i) => {
            const tagged = tagLog(entry.message);
            return <div key={i} className={styles.line} style={{ color: tagged.color }}>{entry.message}</div>;
          })
        )}
      </div>
      {dropped > 0 ? (
        <div className={styles.dropNote}>({dropped} lines dropped due to backpressure)</div>
      ) : null}
      {!autoScroll && newSinceScroll > 0 ? (
        <button type="button" className={styles.newLinesPill} onClick={resumeScroll}>
          ↓ {newSinceScroll} new lines
        </button>
      ) : null}
    </div>
  );
}
```

`LogsPanel.module.css`:
```css
.root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--surface-2); border: 1px solid var(--border); }
.header { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.scroll { flex: 1; overflow: auto; padding: 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; }
.line { white-space: pre; }
.dropNote { padding: 4px 12px; font-family: var(--mono); font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
.newLinesPill { position: absolute; bottom: 16px; right: 16px; background: var(--accent); color: var(--accent-text); border: 0; padding: 6px 14px; font-family: var(--mono); font-size: 11px; cursor: pointer; box-shadow: var(--shadow-pop); }
```
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/components/LogsPanel.tsx && grep -q "export function LogsPanel" src/renderer/src/components/LogsPanel.tsx && grep -q "VIRT_THRESHOLD = 500" src/renderer/src/components/LogsPanel.tsx && grep -q "WINDOW_SIZE = 200" src/renderer/src/components/LogsPanel.tsx && grep -q "PIN_THRESHOLD = 80" src/renderer/src/components/LogsPanel.tsx && grep -q "Copy all" src/renderer/src/components/LogsPanel.tsx && grep -q "Pause autoscroll" src/renderer/src/components/LogsPanel.tsx && grep -q "tagLog(entry.message)" src/renderer/src/components/LogsPanel.tsx && grep -q "navigator.clipboard.writeText" src/renderer/src/components/LogsPanel.tsx && grep -q "useDataStore" src/renderer/src/components/LogsPanel.tsx && grep -q "new lines" src/renderer/src/components/LogsPanel.tsx && grep -q "dropped" src/renderer/src/components/LogsPanel.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "LogsPanel\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - File defines `VIRT_THRESHOLD = 500`, `WINDOW_SIZE = 200`, `PIN_THRESHOLD = 80`
    - File contains `Copy all` and `Pause autoscroll` UI labels
    - Calls `tagLog(entry.message)` for color classification
    - Uses `navigator.clipboard.writeText` for copy
    - Reads from `useDataStore` (logs + dropped)
    - Renders the "↓ N new lines" pill when scroll is paused and new lines accumulate
    - tsc passes
  </acceptance_criteria>
  <done>LogsPanel ready — CharacterPage embeds it under the Logs tab.</done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: CharacterPage + SettingsScreen + wire all into App.tsx (modals + toast)</name>
  <read_first>
    - .planning/phases/04-electron-gui-packaging/design/project/screens.jsx (CharacterPage + SettingsScreen — port verbatim)
    - .planning/phases/04-electron-gui-packaging/04-UI-SPEC.md §"CharacterPage" (lines ~484–506) + §"SettingsScreen" (lines ~507–520) + §"Copywriting Contract" §"Empty / never-summoned states" + §"Plain-English error copy"
    - src/renderer/src/lib/stores/useUiStore.ts, useDataStore.ts, ipcClient.ts
    - src/renderer/src/components/{Button,TextField,PixelPortrait,LogsPanel}.tsx
    - src/renderer/src/components/{LanModal,SummonToast,DeleteConfirmModal}.tsx (Task 1)
    - src/renderer/src/lib/portraitPalettes.ts (pickPalette)
    - src/renderer/src/App.tsx (plan 06+07 — placeholders to replace)
    - src/shared/characterSchema.ts
  </read_first>
  <behavior>
    - `CharacterPage({ id })`:
      - Loads `character` from useDataStore.characters by id; if not present, fetch via `sei.getCharacter(id)` and `useDataStore.refreshCharacter(id)`. If still null, show "Character not found" + back to home.
      - Layout: 320px portrait column + 1fr details column, 36px gap. Padding 24×40×40. Breadcrumb row top-left: BackIcon + "All characters" (Button kind=quiet sm) → `navigate({kind:'home'})`.
      - **Left column:** Portrait card 320×320 PixelPortrait. Below: stacked "Summon into Minecraft" (kind=accent size=lg fullWidth, SparkleIcon size=14). When `summon.kind === 'online'` and `summon.characterId === id`, button reads "Stop" (kind=ghost size=lg fullWidth) and calls `sei.stop()`. Row below with Edit/Delete (Delete hidden when `id === 'sui'`).
      - **Right column:**
        - Eyebrow "DEFAULT" or "CUSTOM" (mono 11)
        - H1 pixel 30 character name
        - Tabs strip: Description / Persona prompt / Logs. Logs tab is disabled (aria-disabled, label "Logs · Available while summoned") unless `summon.kind === 'online' && summon.characterId === id`.
        - Tab body:
          - **Description tab:** card surface, "DESCRIPTION" eyebrow + "For you" tag, body 15px sans whiteSpace pre-wrap.
          - **Persona prompt tab:** persona-prompt card. Eyebrow "PERSONA PROMPT" + ("Hidden" or "Sent to {model}" — model = "claude-haiku-4-5-20251001") + Show/Hide accent mono toggle. Collapsed: nothing in body. Expanded: 2px accent left-border + body mono 13 with whiteSpace pre-wrap + fade-in animation.
          - **Logs tab:** `<LogsPanel />` if active summon; else stub "Logs available while summoned".
        - Stats grid (3 cols): Last launched (mono eyebrow + sans value, '—' if null), Total playtime (formatted from playtime_ms; '—' if 0), Created (formatted ISO). Per UI-SPEC.
        - Model status row: dot + label + mono model id. States: idle/connecting/online/error per `summon.kind`. Online shows uptime ticker. Error shows "Try again" link → re-issue `sei.summon(id)`.
      - Edit persona button: navigate to AddCharacterScreen pre-filled — for v1, send to `useUiStore.openModal({kind:'edit-persona', id})`. **Defer full edit flow:** v1 ships with Edit as a no-op placeholder per CONTEXT scope (focus is GUI-04 add flow which already exists). Render the button but mark it disabled with title "Edit coming soon" — keeps the design fidelity, reserves the slot.
      - Delete button: opens DeleteConfirmModal. On confirm: `await sei.deleteCharacter(id)`, `useDataStore.removeCharacter(id)`, navigate to home.

    - `SettingsScreen()`:
      - Padding 32×40×40, max-width 720, BackIcon + Settings h1.
      - Account section: rows for Minecraft username (mono value), Preferred name (sans value), Provider (sans value capitalized), API key (bullets `•` × min(24, length))
      - Appearance: Theme toggle Button kind=ghost size=sm with Moon/Sun icon (depends on current resolved theme)
      - Setup: "Re-run onboarding" Button → `navigate({kind:'onboarding', isReonboard: true})`
      - Loads via `await sei.getConfig()` on mount; saves theme changes via `sei.saveConfig({...current, theme_mode})`.

    - **App.tsx wiring:** import and render `CharacterPage`, `SettingsScreen` replacing the last two placeholders. Add modal layer that renders LanModal + DeleteConfirmModal based on useUiStore.modal. Add toast layer that watches useUiStore.pendingSummonId and useDataStore.summon to show SummonToast on transitions to 'connecting'.
  </behavior>
  <action>
This task is the largest. The executor should be methodical:

1. **CharacterPage.tsx + CharacterPage.module.css** — port from screens.jsx CharacterPage. Key code outlines:

```tsx
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { Button } from '../components/Button';
import { PixelPortrait } from '../components/PixelPortrait';
import { LogsPanel } from '../components/LogsPanel';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { BackIcon, SparkleIcon } from '../components/icons';
import { pickPalette } from '../lib/portraitPalettes';
import type { Character } from '@shared/characterSchema';
import styles from './CharacterPage.module.css';

const MODEL_ID = 'claude-haiku-4-5-20251001';

type Tab = 'description' | 'persona' | 'logs';

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms/1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms/60_000)}m`;
  return `${Math.floor(ms/3_600_000)}h ${Math.floor((ms%3_600_000)/60_000)}m`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return '—'; }
}

export interface CharacterPageProps { id: string; }

export function CharacterPage({ id }: CharacterPageProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const characters = useDataStore((s) => s.characters);
  const summon = useDataStore((s) => s.summon);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const removeCharacter = useDataStore((s) => s.removeCharacter);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const openModal = useUiStore((s) => s.openModal);
  const lan = useDataStore((s) => s.lan);

  const character: Character | undefined = characters.find((c) => c.id === id);
  const [tab, setTab] = useState<Tab>('description');
  const [expandedPersona, setExpandedPersona] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => { if (!character) void refreshCharacter(id); }, [id, character, refreshCharacter]);

  if (!character) {
    return (
      <div className={styles.notFound}>
        <p>Character not found.</p>
        <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>Back to Home</Button>
      </div>
    );
  }

  const isDefault = character.id === 'sui';
  const theme: 'light'|'dark' = (document.documentElement.getAttribute('data-theme') as 'light'|'dark') ?? 'light';
  const palette = pickPalette(character.id + character.name, theme);
  const isActive = summon.kind === 'online' && summon.characterId === id;
  const isErrored = summon.kind === 'error' && summon.characterId === id;
  const isConnecting = summon.kind === 'connecting';

  const handleSummonClick = () => {
    if (isActive) {
      void sei.stop();
      return;
    }
    if (lan.kind === 'connected') {
      void sei.summon(id);
    } else {
      setPendingSummon(id);
      openModal({ kind: 'lan', mode: 'searching' });
    }
  };

  const handleConfirmDelete = async () => {
    try {
      await sei.deleteCharacter(id);
      removeCharacter(id);
      navigate({ kind: 'home' });
    } catch (err) {
      // surface in modal — for v1, just log
      console.error(err);
    }
  };

  const logsTabEnabled = isActive;

  return (
    <div className={styles.root}>
      <div className={styles.crumb}>
        <Button kind="quiet" size="sm" icon={<BackIcon size={14} />} onClick={() => navigate({ kind: 'home' })}>
          All characters
        </Button>
      </div>
      <div className={styles.cols}>
        <aside className={styles.left}>
          <div className={styles.portraitCard}>
            <PixelPortrait seed={character.id + character.name} palette={palette} size={320} portraitImage={character.portrait_image} />
          </div>
          <div className={styles.cta}>
            <Button
              kind={isActive ? 'ghost' : 'accent'}
              size="lg"
              fullWidth
              icon={isActive ? null : <SparkleIcon size={14} />}
              onClick={handleSummonClick}
              disabled={isConnecting}
            >
              {isActive ? 'Stop' : 'Summon into Minecraft'}
            </Button>
            <div className={styles.secondaryRow}>
              <Button kind="ghost" size="md" disabled title="Edit coming soon">Edit persona</Button>
              {!isDefault ? (
                <Button kind="ghost" size="md" onClick={() => setConfirmingDelete(true)}>
                  <span style={{ color: 'var(--red)' }}>Delete</span>
                </Button>
              ) : null}
            </div>
          </div>
        </aside>
        <main className={styles.right}>
          <div className={styles.eyebrow}>{isDefault ? 'DEFAULT' : 'CUSTOM'}</div>
          <h1 className={styles.title}>{character.name}</h1>

          <div className={styles.tabs} role="tablist">
            <button role="tab" aria-selected={tab === 'description'} className={tab === 'description' ? styles.tabActive : styles.tab} onClick={() => setTab('description')}>Description</button>
            <button role="tab" aria-selected={tab === 'persona'} className={tab === 'persona' ? styles.tabActive : styles.tab} onClick={() => setTab('persona')}>Persona prompt</button>
            <button role="tab" aria-selected={tab === 'logs'} aria-disabled={!logsTabEnabled} className={(tab === 'logs' ? styles.tabActive : styles.tab) + (logsTabEnabled ? '' : ' ' + styles.tabDisabled)} onClick={() => { if (logsTabEnabled) setTab('logs'); }}>
              {logsTabEnabled ? 'Logs' : 'Logs · Available while summoned'}
            </button>
          </div>

          {tab === 'description' ? (
            <div className={styles.card}>
              <div className={styles.cardEyebrow}>DESCRIPTION <span className={styles.tag}>For you</span></div>
              <div className={styles.cardBody}>{character.description || '—'}</div>
            </div>
          ) : null}
          {tab === 'persona' ? (
            <div className={`${styles.card} ${expandedPersona ? styles.cardExpanded : ''}`}>
              <div className={styles.cardEyebrow}>
                PERSONA PROMPT <span className={styles.tag}>{expandedPersona ? `Sent to ${MODEL_ID}` : 'Hidden'}</span>
                <button type="button" className={styles.toggle} onClick={() => setExpandedPersona((s) => !s)}>
                  {expandedPersona ? 'HIDE' : 'SHOW'}
                </button>
              </div>
              {expandedPersona ? <pre className={styles.personaBody}>{character.persona_prompt}</pre> : null}
            </div>
          ) : null}
          {tab === 'logs' ? (
            logsTabEnabled
              ? <div className={styles.logsWrap}><LogsPanel /></div>
              : <div className={styles.card}><div className={styles.cardBody}>Logs available while summoned</div></div>
          ) : null}

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>LAST LAUNCHED</div>
              <div className={styles.statValue}>{fmtDate(character.last_launched)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>TOTAL PLAYTIME</div>
              <div className={styles.statValue}>{character.playtime_ms ? fmtMs(character.playtime_ms) : '—'}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>CREATED</div>
              <div className={styles.statValue}>{fmtDate(character.created)}</div>
            </div>
          </div>

          <div className={styles.modelRow}>
            <span className={styles.modelDot} style={{ background: isErrored ? 'var(--red)' : 'var(--green)' }} />
            <span className={styles.modelLabel}>
              {isActive ? 'Online' : isErrored ? `${summon.kind === 'error' ? summon.message : 'Error'}` : isConnecting ? 'Connecting…' : 'Ready'}
            </span>
            <span className={styles.modelSep}>·</span>
            <span className={styles.modelId}>{MODEL_ID}</span>
            {isErrored ? (
              <button type="button" className={styles.tryAgain} onClick={handleSummonClick}>TRY AGAIN</button>
            ) : null}
          </div>
        </main>
      </div>
      {confirmingDelete ? (
        <DeleteConfirmModal
          characterName={character.name}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); void handleConfirmDelete(); }}
        />
      ) : null}
    </div>
  );
}
```

`CharacterPage.module.css`: implement classes referenced above. Include 320px portrait column, 1fr right, 36px gap, sharp corners on cards, accent left-border 2px when expanded persona, fade-in animation on persona expand.

2. **SettingsScreen.tsx + SettingsScreen.module.css** — port from screens.jsx SettingsScreen:

```tsx
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from '../components/Button';
import { BackIcon, SunIcon, MoonIcon } from '../components/icons';
import type { UserConfig } from '@shared/characterSchema';
import styles from './SettingsScreen.module.css';

export function SettingsScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    void sei.getConfig().then(setCfg);
    void sei.hasApiKey().then(setHasKey);
  }, []);

  const resolvedTheme = (document.documentElement.getAttribute('data-theme') as 'light'|'dark') ?? 'light';

  const toggleTheme = async () => {
    const next = resolvedTheme === 'light' ? 'dark' : 'light';
    setThemeMode(next);
    document.documentElement.setAttribute('data-theme', next);
    if (cfg) await sei.saveConfig({ ...cfg, theme_mode: next });
  };

  return (
    <div className={styles.root}>
      <Button kind="quiet" size="sm" icon={<BackIcon size={14} />} onClick={() => navigate({ kind: 'home' })}>Back</Button>
      <h1 className={styles.title}>Settings</h1>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>ACCOUNT</div>
        <div className={styles.row}><span className={styles.rowLabel}>Minecraft username</span><span className={styles.rowMonoValue}>{cfg?.mc_username || '—'}</span></div>
        <div className={styles.row}><span className={styles.rowLabel}>Preferred name</span><span className={styles.rowValue}>{cfg?.preferred_name || '—'}</span></div>
        <div className={styles.row}><span className={styles.rowLabel}>Provider</span><span className={styles.rowValue}>{(cfg?.provider ?? 'anthropic').replace(/^./, (c) => c.toUpperCase())}</span></div>
        <div className={styles.row}><span className={styles.rowLabel}>API key</span><span className={styles.rowMonoValue}>{hasKey ? '•'.repeat(24) : 'Not set'}</span></div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>APPEARANCE</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Theme</span>
          <Button kind="ghost" size="sm" icon={resolvedTheme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />} onClick={toggleTheme}>
            {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>SETUP</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Re-run onboarding</span>
          <Button kind="primary" size="sm" onClick={() => navigate({ kind: 'onboarding', isReonboard: true })}>Start over</Button>
        </div>
      </section>
    </div>
  );
}
```

`SettingsScreen.module.css`: padding 32×40×40, max-width 720, mono uppercase eyebrows for section titles, sans rows.

3. **App.tsx update.** Import the new screens and modal/toast components. Replace the two remaining placeholders. Add modal-layer render below MacosWindow content (rendered conditionally based on useUiStore.modal). Add toast-layer that subscribes to summon transitions to show SummonToast.

```tsx
// Add imports:
import { CharacterPage } from './screens/CharacterPage';
import { SettingsScreen } from './screens/SettingsScreen';
import { LanModal } from './components/LanModal';
import { SummonToast } from './components/SummonToast';

// Replace placeholders in switch:
{view.kind === 'character' && <CharacterPage id={view.id} />}
{view.kind === 'settings' && <SettingsScreen />}

// Add toast tracking (alongside subscribeIpc effect):
const [toast, setToast] = useState<{ id: string; name: string } | null>(null);
const summon = useDataStore((s) => s.summon);
const characters = useDataStore((s) => s.characters);
useEffect(() => {
  if (summon.kind === 'connecting') {
    // no immediate toast — fire when transitioning
  }
  if (summon.kind === 'online') {
    const c = characters.find((x) => x.id === summon.characterId);
    if (c) setToast({ id: c.id, name: c.name });
  }
}, [summon, characters]);

// Render alongside MacosWindow:
const modal = useUiStore((s) => s.modal);
// after </MacosWindow>:
{modal?.kind === 'lan' ? <LanModal mode={modal.mode} /> : null}
{toast ? <SummonToast characterId={toast.id} characterName={toast.name} onDone={() => setToast(null)} /> : null}
```

(Remove the remaining `CharacterPagePlaceholder` and `SettingsPlaceholder` from App.tsx.)
  </action>
  <verify>
    <automated>bash -c 'test -f src/renderer/src/screens/CharacterPage.tsx && test -f src/renderer/src/screens/SettingsScreen.tsx && grep -q "export function CharacterPage" src/renderer/src/screens/CharacterPage.tsx && grep -q "MODEL_ID = .claude-haiku-4-5-20251001." src/renderer/src/screens/CharacterPage.tsx && grep -q "Summon into Minecraft" src/renderer/src/screens/CharacterPage.tsx && grep -q "Available while summoned" src/renderer/src/screens/CharacterPage.tsx && grep -q "isDefault" src/renderer/src/screens/CharacterPage.tsx && grep -q "id === .sui." src/renderer/src/screens/CharacterPage.tsx && grep -q "sei.stop" src/renderer/src/screens/CharacterPage.tsx && grep -q "sei.deleteCharacter" src/renderer/src/screens/CharacterPage.tsx && grep -q "DeleteConfirmModal" src/renderer/src/screens/CharacterPage.tsx && grep -q "LogsPanel" src/renderer/src/screens/CharacterPage.tsx && grep -q "PERSONA PROMPT" src/renderer/src/screens/CharacterPage.tsx && grep -q "DESCRIPTION" src/renderer/src/screens/CharacterPage.tsx && grep -q "LAST LAUNCHED" src/renderer/src/screens/CharacterPage.tsx && grep -q "TOTAL PLAYTIME" src/renderer/src/screens/CharacterPage.tsx && grep -q "CREATED" src/renderer/src/screens/CharacterPage.tsx && grep -q "TRY AGAIN" src/renderer/src/screens/CharacterPage.tsx && grep -q "export function SettingsScreen" src/renderer/src/screens/SettingsScreen.tsx && grep -q "ACCOUNT" src/renderer/src/screens/SettingsScreen.tsx && grep -q "APPEARANCE" src/renderer/src/screens/SettingsScreen.tsx && grep -q "SETUP" src/renderer/src/screens/SettingsScreen.tsx && grep -q "Start over" src/renderer/src/screens/SettingsScreen.tsx && grep -q "isReonboard: true" src/renderer/src/screens/SettingsScreen.tsx && grep -q "import { CharacterPage }" src/renderer/src/App.tsx && grep -q "import { SettingsScreen }" src/renderer/src/App.tsx && grep -q "import { LanModal }" src/renderer/src/App.tsx && grep -q "import { SummonToast }" src/renderer/src/App.tsx && ! grep -q "CharacterPagePlaceholder\\|SettingsPlaceholder" src/renderer/src/App.tsx && npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -E "(CharacterPage|SettingsScreen|App)\\.tsx.*error TS" | grep -v "TS2307.*\\.module\\.css\\|TS6053\\|TS6307" | wc -l | grep -qE "^[[:space:]]*0$"'</automated>
  </verify>
  <acceptance_criteria>
    - `CharacterPage.tsx` defines `MODEL_ID = 'claude-haiku-4-5-20251001'`
    - File contains all UI labels: `Summon into Minecraft`, `Available while summoned`, `PERSONA PROMPT`, `DESCRIPTION`, `LAST LAUNCHED`, `TOTAL PLAYTIME`, `CREATED`, `TRY AGAIN`
    - File checks `id === 'sui'` to gate Delete button
    - File calls `sei.stop`, `sei.deleteCharacter`
    - File renders `DeleteConfirmModal` and `LogsPanel`
    - `SettingsScreen.tsx` contains all 3 section titles: `ACCOUNT`, `APPEARANCE`, `SETUP`
    - File contains `Start over` button text and `isReonboard: true` navigation
    - `App.tsx` imports `CharacterPage`, `SettingsScreen`, `LanModal`, `SummonToast`
    - `App.tsx` does NOT contain `CharacterPagePlaceholder` or `SettingsPlaceholder`
    - tsc passes
  </acceptance_criteria>
  <done>All screens shipped. Renderer is feature-complete (errors mapping comes in plan 09).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user → main IPC | Delete operation refused at main level for sui or active id (defense-in-depth — gate also at renderer) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-34 | Tampering | logs containing scripty content rendered in DOM | mitigate | LogsPanel uses React text rendering (auto-escapes); no innerHTML |
| T-04-35 | Information Disclosure | persona-prompt visible without consent | mitigate | Persona prompt collapsed by default per UI-SPEC §CharacterPage; explicit Show toggle |
| T-04-36 | Denial of Service | clipboard "Copy all" on 5000 lines | accept | Browsers handle large clipboard fine; user-initiated action |
| T-04-37 | Tampering | renderer summons a deleted character via stale state | mitigate | `useDataStore.refreshCharacter` on CharacterPage mount; main's `getCharacter` returns null on missing → renderer shows "Character not found" |
</threat_model>

<verification>
- All screens render and navigate per design
- Summon → toast → status row online → Logs tab enabled → log lines stream
- Stop → status returns to Ready
- Delete → confirm → character removed → home
- Settings theme toggle persists across reloads
- LAN modal auto-dismisses on `connected` when in searching mode (verified by manually opening a LAN world while in modal)
- `npx tsc --noEmit -p tsconfig.web.json` passes
</verification>

<success_criteria>
- Plan 09 (errors) wires `lib/errors.ts` ERROR_COPY into model-row error text and into onboarding step-4 error display.
- Plan 11 verifies the full clean-VM flow: install → onboard → add character → summon → see logs → stop → delete.
</success_criteria>

<output>
After completion, create `.planning/phases/04-electron-gui-packaging/04-08-SUMMARY.md` documenting:
- Note that "Edit persona" button is intentionally a no-op v1 placeholder per CONTEXT scope (full edit flow deferred)
- Confirm playtime_ms accumulator is currently TODO on the bot side: bot must emit a final playtime delta on summon-stopped — main's botSupervisor needs to be extended in plan 09 or noted for plan 11 verification
- Note for plan 09 executor: model-row error label currently shows raw `summon.message`; replace with `ERROR_COPY[summon.error]` once errors.ts ships
- Note for plan 09 executor: onboarding step-4 error similarly shows raw message
</output>
