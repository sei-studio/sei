/**
 * UI store — current view, modal stack, theme override, pending summon id.
 *
 * Pure state machine for what's on screen. Subscriptions and side-effects live
 * in App.tsx (theme apply, IPC subscribe) — this store is only concerned with
 * what the user is currently looking at.
 *
 * Source: 04-CONTEXT.md (Onboarding/Home/AddCharacter/CharacterPage/Settings/ComingSoon
 * view list) + 04-UI-SPEC.md §Interaction Contracts (modal lifecycle).
 */

import { create } from 'zustand';
import type { ThemeMode } from '../theme';

export type View =
  | { kind: 'loading' }
  | { kind: 'auth-choice' }
  | { kind: 'onboarding'; isReonboard: boolean }
  // Dedicated full-screen onboarding step (after name/API, before home) that
  // runs the Minecraft skin setup wizard inline. Routed to from OnboardingScreen
  // and resumed on relaunch while UserConfig.skin_setup_pending is true.
  | { kind: 'skin-setup' }
  | { kind: 'home' }
  | { kind: 'add-character' }
  | { kind: 'character'; id: string }
  | { kind: 'settings' }
  | { kind: 'credits' }
  | { kind: 'coming-soon' }
  // quick/260525-sbo Task 6 — FTC 16 CFR §425.5 in-app receipt after a
  // first-time subscription activation. Auto-navigated by useCreditsStore
  // when the plan transitions from non-'unlimited' → 'unlimited' (once per
  // transition; guarded by a module-level prevPlan ref).
  | { kind: 'receipt' };

export type Modal =
  | null
  | { kind: 'lan'; mode: 'info' | 'searching' }
  | { kind: 'delete-confirm'; characterId: string }
  // One-time "run skin setup" nudge shown on the first summon attempt by a
  // user who has never completed skin setup. Carries the character id so a
  // "skip for now" choice can resume the deferred summon.
  | { kind: 'skin-setup-prompt'; characterId: string }
  // Multi-summon guard: blocks summoning a character whose in-game username
  // collides with an already-summoned one (the world would kick the second
  // with `name_taken`). Carries both names + the shared username for the copy.
  | { kind: 'summon-conflict'; attemptedName: string; conflictName: string; username: string };

/**
 * B4 — which tab CharactersScreen should open on. The compass icon in the
 * IconRail (B3) sets this to 'world' before navigating to home, so
 * CharactersScreen reads it on mount and applies the World tab as default.
 * Default 'home'.
 */
export type HomeTab = 'home' | 'world';

interface UiState {
  view: View;
  modal: Modal;
  themeMode: ThemeMode;
  /**
   * If a summon was attempted while LAN was not connected, the pending
   * character id is held here until LAN flips to connected (D-24/D-56).
   */
  pendingSummonId: string | null;
  /** B3/B4 — IconRail compass + CharactersScreen tab persistence. */
  homeTab: HomeTab;
  /**
   * ui-A7 — Show the developer console (LogsBar) at the bottom of the
   * window. Default OFF; persisted via UserConfig.dev_console_visible so
   * a relaunch preserves the choice. App.tsx's bootstrap hydrates this
   * from getConfig() before the first render of a view that would mount
   * LogsBar.
   */
  devConsoleVisible: boolean;
  /**
   * Phase 15 (D-10/VIS-03) — whether the active bot's LLM provider is
   * vision-capable. Fed by the `vision:capability` push (bot→main→renderer,
   * subscribed in useDataStore.subscribeIpc). The 15-05 Settings auto-render
   * toggle reads `useUiStore(s => s.visionCapable)` to gate its `disabled`
   * state — a REAL provider signal, not an ai_backend_kind inference and not a
   * deferral. Default FALSE (fail-closed): the toggle stays disabled until a
   * VLM-backed bot reports true, so a non-VLM provider can never enable it.
   */
  visionCapable: boolean;
  /**
   * Session-only flag: flips true the first time the user leaves the Home
   * screen — either by navigating to another view (character/settings/etc.)
   * or by switching CharactersScreen to the World tab. The Home header
   * greeting ("Welcome to Sei" / "Welcome back") shows only while this is
   * false; once the user has left Home once, it reads "Summons" for the rest
   * of the session. In-memory only (not persisted), so each app launch shows
   * one greeting until the user navigates away.
   */
  homeGreetingDismissed: boolean;

  navigate: (view: View) => void;
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setPendingSummon: (id: string | null) => void;
  setHomeTab: (tab: HomeTab) => void;
  setDevConsoleVisible: (v: boolean) => void;
  /** Phase 15 (D-10/VIS-03): set from the vision:capability push. */
  setVisionCapable: (v: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { kind: 'loading' },
  modal: null,
  themeMode: 'system',
  pendingSummonId: null,
  homeTab: 'home',
  devConsoleVisible: false,
  // Phase 15 (D-10/VIS-03): fail-closed — false until a VLM-backed bot reports
  // capabilities.vision === true over the vision:capability push.
  visionCapable: false,
  homeGreetingDismissed: false,

  // Leaving Home (any non-'home' view) dismisses the greeting for the session.
  navigate: (view) =>
    set(view.kind === 'home' ? { view, modal: null } : { view, modal: null, homeGreetingDismissed: true }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setPendingSummon: (id) => set({ pendingSummonId: id }),
  // Switching to the World tab also counts as leaving Home.
  setHomeTab: (tab) =>
    set(tab === 'world' ? { homeTab: tab, homeGreetingDismissed: true } : { homeTab: tab }),
  setDevConsoleVisible: (v) => set({ devConsoleVisible: v }),
  setVisionCapable: (v) => set({ visionCapable: v }),
}));
