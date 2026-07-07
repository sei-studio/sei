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
import type { UniqueGender } from '@shared/ipc';

export type View =
  | { kind: 'loading' }
  | { kind: 'auth-choice' }
  | { kind: 'onboarding'; isReonboard: boolean }
  // Dedicated full-screen onboarding step (after name/API, before home) that
  // runs the Minecraft skin setup wizard inline. Routed to from OnboardingScreen
  // and resumed on relaunch while UserConfig.skin_setup_pending is true.
  | { kind: 'skin-setup' }
  // Post-onboarding "what would you like to do?" chooser (chat vs minecraft).
  // Shown once right after name onboarding; routes to skin-setup (minecraft) or
  // straight home (chat). A full-page entry surface like onboarding/skin-setup.
  | { kind: 'activity-picker' }
  | { kind: 'home' }
  // Party redesign §4.3 — the "awaken a companion" chooser view (replaces
  // AddCompanionChooserModal). A normal in-app surface: the rail stays visible.
  | { kind: 'awaken' }
  | { kind: 'add-character' }
  | { kind: 'character'; id: string }
  // Phase 18/19 — Discord-style in-app chat with a companion, plus a
  // placeholder Discord-style voice-call surface. Both are normal in-app
  // surfaces (the IconRail stays visible, unlike the full-page entry flows).
  | { kind: 'chat'; characterId: string }
  | { kind: 'voice-call'; characterId: string }
  | { kind: 'settings' }
  | { kind: 'credits' }
  | { kind: 'coming-soon' }
  // 260703 procgen — the "unique companion" (system-generated) flow. All four
  // are renderer-only full-page surfaces (rail hidden), routed from the
  // add-companion chooser or the App-level first-sign-in questionnaire gate:
  //   - profile-questions : the companion questionnaire (age + dynamics +
  //                          art style). `next` decides where Finish lands:
  //                          'activity-picker' (mid-onboarding, signed-in),
  //                          'home' (App gate), 'unique-gender' (Awaken cast
  //                          gate), 'awaken' / 'settings' ("Update my
  //                          preferences" entries — cancel also returns
  //                          there). `mode`: 'missing' asks only unanswered
  //                          questions; 'all' is a full retake prefilled
  //                          with current answers.
  //   - unique-gender     : the single per-slot gender question.
  //   - unique-casting    : the full-screen generation/ritual progress screen.
  //   - unique-reveal     : the "meet <name>" moment after a successful gen.
  | {
      kind: 'profile-questions';
      next: 'home' | 'unique-gender' | 'activity-picker' | 'awaken' | 'settings';
      // 'missing' asks only unanswered questions; 'all' is a full retake
      // prefilled with current answers; 'first-fill' behaves like 'missing' for
      // question selection but, on Finish, continues a brand-new user straight
      // into the "meet your unique companion" flow (gender step) so their first
      // companion gets cast instead of dropping them on an empty Home. A
      // "Later" dismiss on the first step never triggers that continuation.
      mode: 'missing' | 'all' | 'first-fill';
    }
  | { kind: 'unique-gender' }
  | { kind: 'unique-casting'; gender: UniqueGender }
  | { kind: 'unique-reveal'; characterId: string }
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
  | { kind: 'summon-conflict'; attemptedName: string; conflictName: string; username: string }
  // Phase 18/19 — chat "Games" affordance: a tiled grid of supported games
  // (games-picker) and a per-game About sheet with a Summon button (game-about).
  | { kind: 'games-picker'; characterId: string }
  | { kind: 'game-about'; characterId: string; gameId: string };

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
  /**
   * Phase 18/19 (task 6) — when a summon is launched from the chat surface (the
   * "Play together" games popup), the user should be RETURNED to that chat once
   * the bot joins, not yanked to the profile page. This records that intent so a
   * deferred summon (LAN-not-open → LanModal auto-resume) lands back in chat too.
   * Set alongside pendingSummonId; consumed + cleared by the LanModal resume.
   */
  pendingSummonReturnToChat: boolean;
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
   * "Realistic typing" (Appearance & feel). When on, the chat store holds the
   * typing indicator back for a "reading" pause scaled to the user's message
   * length, then keeps it up for a stretch proportional to each reply bubble
   * (fast-reader / fast-typist pacing). Persisted via UserConfig.realistic_typing
   * and hydrated here at App.tsx bootstrap so useChatStore.send() can read it
   * synchronously. Default ON.
   */
  realisticTyping: boolean;
  /**
   * 260705 — the chat presence side panel is open by default; hiding it is a
   * sticky preference across companions and app restarts. Persisted via
   * UserConfig.chat_panel_hidden and hydrated here at App.tsx bootstrap (same
   * pattern as realisticTyping); ChatScreen persists changes on toggle.
   */
  chatPanelHidden: boolean;
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
   * false; once the user has left Home once, it reads "Companions" for the rest
   * of the session. In-memory only (not persisted), so each app launch shows
   * one greeting until the user navigates away.
   */
  homeGreetingDismissed: boolean;
  /**
   * Phase 18/19 — when the CharacterPage is opened FROM a chat (the chat
   * header's Profile button), this records the originating character id so the
   * page's back button returns to that chat instead of going home. Cleared by
   * CharacterPage once it routes back. null = the page was opened the normal way
   * (home / world / rail), so back goes home as before.
   */
  chatReturnId: string | null;
  /**
   * Voice-call minimize (chat change #6). When the user minimizes the
   * full-screen voice call, the call keeps "running" as a small floating widget
   * (MinimizedCall) rendered at the App shell level so it survives navigation.
   * Holds the character on the call; null when no call is minimized. Restoring
   * re-opens the voice-call view; hanging up clears it.
   */
  minimizedCall: { characterId: string } | null;
  /**
   * Mute state for the active voice call, kept here (not in VoiceCallScreen
   * local state) so it survives minimize → restore and is shared with the
   * MinimizedCall widget. Reset to false whenever a call ends.
   */
  callMuted: boolean;
  /**
   * Deafen state for the active voice call (260705): silences everything the
   * call plays (companion voice + ambience) without touching the mic. Same
   * home as callMuted for the same reasons (survives minimize, shared
   * surfaces). Reset to false whenever a call ends.
   */
  callDeafened: boolean;
  /** Appearance & feel: live captions on the voice-call screen (persisted via
   * UserConfig.call_captions; App.tsx hydrates). Off by default. */
  callCaptions: boolean;
  /** Appearance & feel: always-on-top call overlay (bottom-right companion
   * circles). Persisted via UserConfig.call_overlay_enabled; App.tsx hydrates.
   * Off by default (it floats over every app). Read by the overlay pusher in
   * App.tsx to decide whether to spawn the overlay window during a call. */
  callOverlayEnabled: boolean;

  navigate: (view: View) => void;
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setPendingSummon: (id: string | null) => void;
  /** Task 6: record whether the pending summon should return to chat on resume. */
  setPendingSummonReturnToChat: (v: boolean) => void;
  setHomeTab: (tab: HomeTab) => void;
  setDevConsoleVisible: (v: boolean) => void;
  /** Appearance & feel: set the "Realistic typing" pacing toggle. */
  setRealisticTyping: (v: boolean) => void;
  setChatPanelHidden: (v: boolean) => void;
  /** Phase 15 (D-10/VIS-03): set from the vision:capability push. */
  setVisionCapable: (v: boolean) => void;
  /** Phase 18/19: record the chat a CharacterPage was opened from (or null). */
  setChatReturnId: (id: string | null) => void;
  /** #6: collapse the voice call to the floating corner widget. */
  minimizeCall: (characterId: string) => void;
  /** #6: re-open the full voice-call view for the minimized call. */
  restoreCall: () => void;
  /** #6: set the active call's mute state (shared by both call surfaces). */
  setCallMuted: (muted: boolean) => void;
  /** 260705: set the active call's deafen state (output silence). */
  setCallDeafened: (deafened: boolean) => void;
  /** Appearance & feel: set the call-captions toggle. */
  setCallCaptions: (v: boolean) => void;
  /** Appearance & feel: set the always-on-top call-overlay toggle. */
  setCallOverlayEnabled: (v: boolean) => void;
  /** #6: hang up / dismiss the call (clears the widget + resets mute). */
  endCall: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: { kind: 'loading' },
  modal: null,
  themeMode: 'system',
  pendingSummonId: null,
  pendingSummonReturnToChat: false,
  homeTab: 'home',
  devConsoleVisible: false,
  // Appearance & feel: default ON, matching UserConfig.realistic_typing's
  // default. App.tsx re-hydrates this from persisted config before first render.
  realisticTyping: true,
  // Panel open by default; App.tsx re-hydrates from UserConfig.chat_panel_hidden.
  chatPanelHidden: false,
  // Phase 15 (D-10/VIS-03): fail-closed — false until a VLM-backed bot reports
  // capabilities.vision === true over the vision:capability push.
  visionCapable: false,
  homeGreetingDismissed: false,
  chatReturnId: null,
  minimizedCall: null,
  callMuted: false,
  callDeafened: false,
  callCaptions: false,
  callOverlayEnabled: false,

  // Leaving Home (any non-'home' view) dismisses the greeting for the session.
  navigate: (view) =>
    set(view.kind === 'home' ? { view, modal: null } : { view, modal: null, homeGreetingDismissed: true }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setPendingSummon: (id) => set({ pendingSummonId: id }),
  setPendingSummonReturnToChat: (v) => set({ pendingSummonReturnToChat: v }),
  // Switching to the World tab also counts as leaving Home.
  setHomeTab: (tab) =>
    set(tab === 'world' ? { homeTab: tab, homeGreetingDismissed: true } : { homeTab: tab }),
  setDevConsoleVisible: (v) => set({ devConsoleVisible: v }),
  setRealisticTyping: (v) => set({ realisticTyping: v }),
  setChatPanelHidden: (v) => set({ chatPanelHidden: v }),
  setVisionCapable: (v) => set({ visionCapable: v }),
  setChatReturnId: (id) => set({ chatReturnId: id }),
  // Minimizing leaves the call "running" in the corner and drops the user back
  // onto that companion's chat (leaving Home, so dismiss the greeting).
  minimizeCall: (characterId) =>
    set({
      minimizedCall: { characterId },
      view: { kind: 'chat', characterId },
      modal: null,
      homeGreetingDismissed: true,
    }),
  restoreCall: () =>
    set((s) =>
      s.minimizedCall
        ? { view: { kind: 'voice-call', characterId: s.minimizedCall.characterId }, minimizedCall: null }
        : {},
    ),
  setCallMuted: (muted) => set({ callMuted: muted }),
  setCallDeafened: (deafened) => set({ callDeafened: deafened }),
  setCallCaptions: (v) => set({ callCaptions: v }),
  setCallOverlayEnabled: (v) => set({ callOverlayEnabled: v }),
  endCall: () => set({ minimizedCall: null, callMuted: false, callDeafened: false }),
}));
