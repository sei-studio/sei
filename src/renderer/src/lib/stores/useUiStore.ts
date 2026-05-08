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
  | { kind: 'onboarding'; isReonboard: boolean }
  | { kind: 'home' }
  | { kind: 'add-character' }
  | { kind: 'character'; id: string }
  | { kind: 'settings' }
  | { kind: 'coming-soon' };

export type Modal =
  | null
  | { kind: 'lan'; mode: 'info' | 'searching' }
  | { kind: 'delete-confirm'; characterId: string };

interface UiState {
  view: View;
  modal: Modal;
  themeMode: ThemeMode;
  /**
   * If a summon was attempted while LAN was not connected, the pending
   * character id is held here until LAN flips to connected (D-24/D-56).
   */
  pendingSummonId: string | null;

  navigate: (view: View) => void;
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setPendingSummon: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { kind: 'loading' },
  modal: null,
  themeMode: 'system',
  pendingSummonId: null,

  navigate: (view) => set({ view, modal: null }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setPendingSummon: (id) => set({ pendingSummonId: id }),
}));
