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
 *  6. Render modal layer (LanModal) and toast layer (SummonToast on summon
 *     transitions) above the main view.
 *
 * Plan 08 fills the final two screen placeholders (CharacterPage + Settings),
 * adds the modal/toast layers, and removes the placeholder defs from this file.
 *
 * Source: 04-CONTEXT.md D-15/D-17/D-33/D-35, 04-UI-SPEC.md §Animation Tokens
 *         (LoadingScreen 1.6s floor) + §Interaction Contracts → Theme toggle +
 *         §Summon flow (toast on summon).
 */

import React, { useEffect, useState } from 'react';
import { sei } from './lib/ipcClient';
import { applyTheme, subscribeSystemTheme, type ThemeMode } from './lib/theme';
import { useUiStore, type View } from './lib/stores/useUiStore';
import { useDataStore, subscribeIpc } from './lib/stores/useDataStore';
import { MacosWindow } from './components/MacosWindow';
import { IconRail } from './components/IconRail';
import { LoadingScreen } from './screens/LoadingScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { HomeScreen } from './screens/HomeScreen';
import { AddCharacterScreen } from './screens/AddCharacterScreen';
import { ComingSoonScreen } from './screens/ComingSoonScreen';
import { CharacterPage } from './screens/CharacterPage';
import { SettingsScreen } from './screens/SettingsScreen';
import { LanModal } from './components/LanModal';
import { SummonToast } from './components/SummonToast';
import { Banner } from './components/Banner';
import { ERROR_COPY } from './lib/errors';

const LOADING_FLOOR_MS = 1600;

export function App(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const navigate = useUiStore((s) => s.navigate);
  const modal = useUiStore((s) => s.modal);
  const summon = useDataStore((s) => s.summon);
  const characters = useDataStore((s) => s.characters);
  const [bootStartedAt] = useState(() => Date.now());
  const [toast, setToast] = useState<{ id: string; name: string } | null>(null);
  const [lastToastedSummonId, setLastToastedSummonId] = useState<string | null>(null);
  // RESEARCH §Pitfall 3 — Linux-only basic_text safeStorage warning. Main
  // computes this from `apiKeyStore.backendKind()` and exposes it via the
  // app:warnings IPC. Dismissed for the rest of the session on first click.
  const [warnings, setWarnings] = useState<{
    keychainFallbackPlaintext: boolean;
    dismissed: boolean;
  }>({ keychainFallbackPlaintext: false, dismissed: false });

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

      // Startup warnings (Linux basic_text safeStorage fallback). Best-effort.
      try {
        const w = await sei.getStartupWarnings();
        if (cancelled) return;
        setWarnings({ keychainFallbackPlaintext: w.keychainFallbackPlaintext, dismissed: false });
      } catch {
        // No warnings surfaced; default state already false.
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

  // ── Toast on summon transition (UI-SPEC §Summon flow) ─────────────────
  // Fire SummonToast when a new summon enters 'connecting' (request acked) or
  // 'online'. We track the last toasted character id so a single summon only
  // emits one toast as it walks through connecting → online.
  useEffect(() => {
    if (summon.kind === 'connecting') {
      // We don't yet know the target character id at the connecting stage
      // (BotStatus.connecting has no characterId). Skip — the toast fires on
      // 'online' transition with the resolved character id.
      return;
    }
    if (summon.kind === 'online') {
      if (summon.characterId === lastToastedSummonId) return;
      const c = characters.find((x) => x.id === summon.characterId);
      if (!c) return;
      setToast({ id: c.id, name: c.name });
      setLastToastedSummonId(summon.characterId);
      return;
    }
    // Reset on idle/error so the next summon fires a fresh toast.
    if (summon.kind === 'idle' || summon.kind === 'error') {
      if (lastToastedSummonId !== null) setLastToastedSummonId(null);
    }
  }, [summon, characters, lastToastedSummonId]);

  if (view.kind === 'loading') return <LoadingScreen />;

  return (
    <>
      <MacosWindow subtitle={subtitleForView(view)}>
        {/*
          MacosWindow's `.body` is a flex row (IconRail | main). To place
          a top-of-window Banner above that row, we render a flex-column
          wrapper as the sole child so the Banner stacks vertically while
          the IconRail+main row keeps its original layout.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          {warnings.keychainFallbackPlaintext && !warnings.dismissed ? (
            <Banner
              kind="warn"
              message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT}
              onDismiss={() => setWarnings((w) => ({ ...w, dismissed: true }))}
            />
          ) : null}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {view.kind !== 'onboarding' ? <IconRail /> : null}
            <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
              {view.kind === 'onboarding' && <OnboardingScreen isReonboard={view.isReonboard} />}
              {view.kind === 'home' && <HomeScreen />}
              {view.kind === 'add-character' && <AddCharacterScreen />}
              {view.kind === 'character' && <CharacterPage id={view.id} />}
              {view.kind === 'settings' && <SettingsScreen />}
              {view.kind === 'coming-soon' && <ComingSoonScreen />}
            </main>
          </div>
        </div>
      </MacosWindow>
      {modal?.kind === 'lan' ? <LanModal mode={modal.mode} /> : null}
      {toast ? (
        <SummonToast
          characterId={toast.id}
          characterName={toast.name}
          onDone={() => setToast(null)}
        />
      ) : null}
    </>
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
