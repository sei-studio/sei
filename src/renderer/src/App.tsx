/**
 * App — root component.
 *
 * Responsibilities at mount:
 *  1. Apply persisted theme (or 'system' default → matchMedia) and subscribe to
 *     system theme changes when in 'system' mode.
 *  2. Subscribe to push IPC channels (onLog/onStatus/onLan) ONCE — store-level
 *     subscription per RESEARCH §Resolved Q5; navigation cannot drop log lines.
 *  3. Load characters into useDataStore.
 *  4. Decide first view based on `sei.hasApiKey()`:
 *       - no key → onboarding step 0
 *       - has key → home
 *  5. Hold the loading screen for ≥ LOADING_FLOOR_MS (1.6s) so the boot pulse
 *     animation reads (UI-SPEC §Animation Tokens).
 *
 * Plans 07/08 fill the screen placeholders below with real screens. This plan
 * (06) ships the skeleton only; the placeholders prove the routing graph.
 *
 * Source: 04-CONTEXT.md D-15/D-17/D-33/D-35, 04-UI-SPEC.md §Animation Tokens
 *         (LoadingScreen 1.6s floor) + §Interaction Contracts → Theme toggle.
 */

import React, { useEffect, useState } from 'react';
import { sei } from './lib/ipcClient';
import { applyTheme, subscribeSystemTheme, type ThemeMode } from './lib/theme';
import { useUiStore, type View } from './lib/stores/useUiStore';
import { useDataStore, subscribeIpc } from './lib/stores/useDataStore';
import { MacosWindow } from './components/MacosWindow';
import { IconRail } from './components/IconRail';
import { LoadingScreen } from './screens/LoadingScreen';

const LOADING_FLOOR_MS = 1600;

export function App(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const navigate = useUiStore((s) => s.navigate);
  const [bootStartedAt] = useState(() => Date.now());

  // ── Theme apply + system listener ─────────────────────────────────────
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return;
    return subscribeSystemTheme(() => applyTheme('system'));
  }, [themeMode]);

  // ── One-time IPC subscription (RESEARCH §Resolved Q5) ─────────────────
  useEffect(() => {
    const teardown = subscribeIpc();
    return teardown;
  }, []);

  // ── Initial bootstrap: config → characters → first view (with floor) ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Load persisted config + theme
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        const mode = (cfg.theme_mode ?? 'system') as ThemeMode;
        setThemeMode(mode);
        applyTheme(mode);
      } catch {
        // Defaults already applied (themeMode='system' from store)
      }

      // Load character list (best-effort — empty array if rejection)
      try {
        await useDataStore.getState().loadCharacters();
      } catch {
        // Stores stay empty; screens render the empty-state.
      }

      // Decide first view
      const hasKey = await sei.hasApiKey().catch(() => false);
      if (cancelled) return;

      // LoadingScreen wallclock floor
      const elapsed = Date.now() - bootStartedAt;
      const remaining = Math.max(0, LOADING_FLOOR_MS - elapsed);
      window.setTimeout(() => {
        if (cancelled) return;
        if (!hasKey) {
          navigate({ kind: 'onboarding', isReonboard: false });
        } else {
          navigate({ kind: 'home' });
        }
      }, remaining);
    })();
    return () => {
      cancelled = true;
    };
  }, [bootStartedAt, navigate, setThemeMode]);

  if (view.kind === 'loading') return <LoadingScreen />;

  return (
    <MacosWindow subtitle={subtitleForView(view)}>
      <IconRail />
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {view.kind === 'onboarding' && <OnboardingPlaceholder />}
        {view.kind === 'home' && <HomePlaceholder />}
        {view.kind === 'add-character' && <AddCharacterPlaceholder />}
        {view.kind === 'character' && <CharacterPagePlaceholder id={view.id} />}
        {view.kind === 'settings' && <SettingsPlaceholder />}
        {view.kind === 'coming-soon' && <ComingSoonPlaceholder />}
      </main>
    </MacosWindow>
  );
}

function subtitleForView(view: View): string {
  switch (view.kind) {
    case 'onboarding':
      return 'Onboarding';
    case 'home':
      return 'Characters';
    case 'add-character':
      return 'New character';
    case 'character':
      return ' ';
    case 'settings':
      return 'Settings';
    case 'coming-soon':
      return 'Other games';
    default:
      return '';
  }
}

// ── Plan 06 placeholders. Plans 07/08 replace these with real screens. ────

const Placeholder: React.FC<{ label: string }> = ({ label }) => (
  <div style={{ padding: 40 }}>{label} — implemented in plan 07–08</div>
);
const OnboardingPlaceholder: React.FC = () => <Placeholder label="Onboarding" />;
const HomePlaceholder: React.FC = () => <Placeholder label="Home" />;
const AddCharacterPlaceholder: React.FC = () => <Placeholder label="AddCharacter" />;
const CharacterPagePlaceholder: React.FC<{ id: string }> = ({ id }) => (
  <Placeholder label={`Character ${id}`} />
);
const SettingsPlaceholder: React.FC = () => <Placeholder label="Settings" />;
const ComingSoonPlaceholder: React.FC = () => <Placeholder label="ComingSoon" />;
