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
import type { LanHost, LanHostWarning } from '@shared/ipc';
import type { AvatarMode, AvatarPrefs } from '@shared/characterSchema';

export type View =
  | { kind: 'loading' }
  | { kind: 'auth-choice' }
  // First-run Sui onboarding scene (260728): the full-window animated ritual
  // (OnboardApp). Fresh installs and fresh accounts land here; the legacy
  // 'onboarding' QuestionShell flow below remains for Settings re-onboard.
  // signin (260729): mount directly at the sign-in panel on the empty sky —
  // no walk-in, no dialogue. Used wherever an already-onboarded profile
  // needs to (re)auth: BOOT while signed out, and sign-out from Settings
  // (both replaced AuthChoice). One click to proceed, like the old chooser;
  // the panel's "I'm new here" link remounts the full scene.
  | { kind: 'onboard'; signin?: boolean }
  | { kind: 'onboarding'; isReonboard: boolean }
  // Full-screen Minecraft skin setup page (wizard inline). Legacy resume
  // surface: onboarding no longer arms UserConfig.skin_setup_pending (260725,
  // skin setup moved to the first Minecraft open — see lib/gameLaunch.ts),
  // but profiles that armed it under the old flow still resume here once.
  | { kind: 'skin-setup' }
  | { kind: 'home' }
  // Party redesign §4.3 — the "awaken a companion" chooser view (replaces
  // AddCompanionChooserModal). A normal in-app surface: the rail stays visible.
  | { kind: 'awaken' }
  // `importFirst` (260725): entered via the Awaken "Import from another
  // platform" tile — the wizard opens with the knowledge-upload phase before
  // the usual questions.
  | { kind: 'add-character'; importFirst?: boolean }
  | { kind: 'character'; id: string }
  // Phase 18/19 — Discord-style in-app chat with a companion, plus a
  // placeholder Discord-style voice-call surface. Both are normal in-app
  // surfaces (the IconRail stays visible, unlike the full-page entry flows).
  | { kind: 'chat'; characterId: string }
  | { kind: 'voice-call'; characterId: string }
  // 260727 Draw! — the sketch-guessing minigame. A full-page surface (rail
  // hidden) because it is deliberately its own visual world: a white page in
  // a handdrawn register, canvas beside chat, rather than the chat screen's
  // top/bottom game split.
  | { kind: 'draw'; characterId: string }
  | { kind: 'settings' }
  | { kind: 'credits' }
  | { kind: 'coming-soon' }
  // 260703 procgen — the "unique companion" (system-generated) flow. Both are
  // renderer-only full-page surfaces (rail hidden), routed from Awaken:
  //   - sui-meet          : "meet my companion", run by Sui — any unanswered
  //                          preference questions, the gender question, her
  //                          walk-off, and the casting bar (replaced
  //                          unique-gender + unique-casting, 260731).
  //   - unique-reveal     : the "meet <name>" moment after a successful gen.
  //
  // 260802: there was a third, `profile-questions` — the questionnaire as a
  // dark-chrome FORM, routed here by whichever gate noticed a gap first (a
  // Home gate on sign-in, the Awaken cast gate, the tail of onboarding). It
  // is deleted, gates and all. The questionnaire is only ever asked by Sui
  // now, in a scene the player chose to open: sui-meet when the cast needs an
  // answer it does not have, or sui-prefs when they came to change one.
  | { kind: 'sui-meet' }
  | { kind: 'unique-reveal'; characterId: string }
  // 260731 — "update my preferences", asked by Sui in the onboarding scene
  // rather than as a form. `next` is the surface the entry link lives on, and
  // where leaving the scene returns to.
  | { kind: 'sui-prefs'; next: 'awaken' | 'settings' }
  // quick/260525-sbo Task 6 — FTC 16 CFR §425.5 in-app receipt after a
  // first-time subscription activation. Auto-navigated by useCreditsStore
  // when the plan moves up into a paid tier (once per
  // transition; guarded by a module-level prevPlan ref).
  | { kind: 'receipt' };

export type Modal =
  | null
  // Minecraft setup window (260721, replaces the old LanModal): tabs for the
  // open-to-LAN steps ('world') and skin setup pointers ('skin'). `searching`
  // is true only on the launch-blocked path (Launch pressed, no open world):
  // the world tab then shows the searching animation and auto-resumes the
  // pending summon when LAN flips open.
  | { kind: 'mc-setup'; tab: 'world' | 'skin'; searching: boolean }
  | { kind: 'delete-confirm'; characterId: string }
  // Multi-summon guard: blocks summoning a character whose in-game username
  // collides with an already-summoned one (the world would kick the second
  // with `name_taken`). Carries both names + the shared username for the copy.
  | { kind: 'summon-conflict'; attemptedName: string; conflictName: string; username: string }
  // 260709 — pre-summon compatibility disclaimer. Shown once per session per
  // warning kind when the detected LAN host is modded (Forge/NeoForge/Fabric)
  // or Lunar Client. Never blocks: "Summon anyway" resumes the summon.
  | {
      kind: 'lan-host-warning';
      characterId: string;
      warning: LanHostWarning;
      host: LanHost;
      fromChat: boolean;
    }
  // 260709 — the world runs a Minecraft version outside what Sei's networking
  // stack supports. Opened centrally from the onStatus subscription
  // (useDataStore.wireIpc) so EVERY summon entry point surfaces it: the Play
  // flow previously failed silently (the error only reached the character
  // page's model row). `message` is the already-humanized bot error text.
  | { kind: 'unsupported-version'; characterId: string; message: string }
  // 260720 — a summon died with LAN_NOT_OPEN (world closed, kicked, or the
  // pre-gate raced a closing world). Opened centrally from the onStatus
  // subscription like unsupported-version, so every summon entry point gets
  // the step-by-step "open to LAN" guidance instead of a one-line status.
  | { kind: 'lan-not-open'; characterId: string }
  // 260720 — a LIVE bot session died unexpectedly (BotStatus error with
  // midSession, e.g. the child was killed or crashed) with no dedicated
  // surface for its error class. Opened centrally from the onStatus
  // subscription; before this, a mid-session death showed nothing at all.
  | { kind: 'bot-crash'; characterId: string }
  // Phase 18/19 — chat "Games" affordance: a tiled grid of supported games.
  // Per-game info is a hover-only popup inside the picker (no about modal).
  | { kind: 'games-picker'; characterId: string }
  // 260721 — launching a game while ANOTHER game is active for the same
  // companion. Confirming ends the previous session via its normal end path
  // (lib/gameLaunch.ts holds the parked launch), then proceeds.
  | {
      kind: 'cross-launch';
      characterId: string;
      fromId: 'chess' | 'minecraft' | 'draw' | 'backseat';
      fromName: string;
      toName: string;
    }
  // 260803 — the screen-share source picker, opened from the call controls.
  // Not a games-picker panel any more: sharing is a call feature, not a game.
  | { kind: 'share-screen'; characterId: string };

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
   * deferred summon (LAN-not-open → McSetupModal auto-resume) lands back in chat
   * too. Set alongside pendingSummonId; consumed + cleared by the resume.
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
   * 260707 — product-analytics opt-OUT flag (PostHog). Default false
   * (analytics on) per the disclosed opt-out model. Persisted via
   * UserConfig.analytics_opt_out and hydrated at App.tsx bootstrap; the
   * Settings "Usage analytics" toggle flips it (main persists + applies).
   */
  analyticsOptOut: boolean;
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
   * Mute state for the active voice call, kept here (not in VoiceCallScreen
   * local state) so it is shared between the full call surface and the
   * bottom-center CallMiniBar. Reset to false whenever a call ends.
   */
  callMuted: boolean;
  /**
   * Deafen state for the active voice call (260705): silences everything the
   * call plays (companion voice + ambience) without touching the mic. Same
   * home as callMuted for the same reasons (shared surfaces). Reset to false
   * whenever a call ends.
   */
  callDeafened: boolean;
  /** Appearance & feel: live captions on the voice-call screen (persisted via
   * UserConfig.call_captions; App.tsx hydrates). Off by default. */
  callCaptions: boolean;
  /** Appearance & feel (260804): when the always-on-top avatar overlay shows.
   * Persisted via UserConfig.avatar_mode (App.tsx hydrates through
   * effectiveAvatarMode, which folds in the deprecated call_overlay_enabled).
   * 'off' by default (it floats over every app). Read by the overlay pusher
   * in App.tsx to decide whether to spawn the overlay window. */
  avatarMode: AvatarMode;
  /** Per-character avatar tile preferences (260804), sparse: absent id =
   * defaults (circle frame, talking indicator on). Persisted via
   * UserConfig.avatar_prefs; App.tsx hydrates; the profile Avatar tab writes. */
  avatarPrefsByCharacter: Record<string, AvatarPrefs>;
  /** Conversation starters (260707): a quiet stretch on a live call nudges a
   * companion to bring up a topic on its own. Persisted via
   * UserConfig.call_convo_starters; App.tsx hydrates. ON by default. */
  convoStartersEnabled: boolean;
  /**
   * 260730 — call backdrop mode, per character: true = show the character's
   * scene (or their art) instead of the avatar tiles. Keyed by the DIALED
   * character's id, which is also the key a group call uses, so "how I like
   * calling Sui" survives inviting someone else along.
   *
   * A character absent from the map has no stored preference, and the default
   * depends on them: someone with a custom scene opens in it, everyone else
   * opens on the familiar avatar view. That is why this is a sparse map and
   * not a boolean per character defaulted to false — writing false for every
   * character on first call would erase the distinction.
   *
   * Persisted via UserConfig.call_backdrop; App.tsx hydrates.
   */
  callBackdropByCharacter: Record<string, boolean>;
  /**
   * 260724 — custom app background. `backgroundImage` is the portrait path ref
   * ('_bg.png', served via sei-portrait://) or null when no background is set;
   * opacity (0..1, how visible the image is through the theme's window color)
   * and brightness (0.2..1) are the two Theme-section sliders. Persisted via
   * UserConfig.background_image/opacity/brightness; App.tsx hydrates at
   * bootstrap + scope change and paints the layered background on <main>.
   * `backgroundBust` is a cache-buster bumped on each re-upload (the ref is a
   * FIXED path, so the URL never changes without it).
   */
  backgroundImage: string | null;
  backgroundOpacity: number;
  backgroundBrightness: number;
  backgroundBust: number;
  /**
   * 260728 — IN-APP fullscreen for a game surface. Not the OS window's
   * fullscreen (that is what this button used to do, and it was the wrong
   * verb: a game does not need the whole display, it needs the whole app).
   * True means "give the mounted game every pixel the app has": the IconRail
   * goes (App.tsx folds this into railHidden) and, for the games hosted in the
   * chat screen's game area, the chat below goes too (ChatScreen folds it into
   * chatHidden).
   *
   * Session-only and OWNED BY THE MOUNTED SURFACE: whichever game surface is
   * on screen sets it, and clears it on unmount. That is what keeps the rail
   * from staying hidden after the game is gone, and it is why there is no
   * "which view is this" test in railHidden. Any future game surface gets the
   * behaviour by doing the same two things.
   */
  gameFullscreen: boolean;

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
  setAnalyticsOptOut: (v: boolean) => void;
  setChatPanelHidden: (v: boolean) => void;
  /** Phase 15 (D-10/VIS-03): set from the vision:capability push. */
  setVisionCapable: (v: boolean) => void;
  /** Phase 18/19: record the chat a CharacterPage was opened from (or null). */
  setChatReturnId: (id: string | null) => void;
  /** #6: set the active call's mute state (shared by both call surfaces). */
  setCallMuted: (muted: boolean) => void;
  /** 260705: set the active call's deafen state (output silence). */
  setCallDeafened: (deafened: boolean) => void;
  /** Appearance & feel: set the call-captions toggle. */
  setCallCaptions: (v: boolean) => void;
  /** Appearance & feel: set the avatar overlay mode. */
  setAvatarMode: (mode: AvatarMode) => void;
  /** 260804: replace the whole per-character avatar-prefs map (App.tsx hydration). */
  setAvatarPrefs: (prefs: Record<string, AvatarPrefs>) => void;
  /** 260804: set one character's avatar tile preferences. */
  setAvatarPrefsFor: (characterId: string, prefs: AvatarPrefs) => void;
  /** Set the conversation-starters toggle (quiet calls, companion starts a topic). */
  setConvoStartersEnabled: (v: boolean) => void;
  /** 260730: replace the whole per-character backdrop map (App.tsx hydration). */
  setCallBackdropPrefs: (prefs: Record<string, boolean>) => void;
  /** 260730: remember how this character's calls should open. */
  setCallBackdropFor: (characterId: string, on: boolean) => void;
  /** 260724: set the custom background image ref; bumps the cache-buster. */
  setBackgroundImage: (ref: string | null) => void;
  /** 260724: set the background sliders (opacity 0..1, brightness 0.2..1). */
  setBackgroundOpacity: (v: number) => void;
  setBackgroundBrightness: (v: number) => void;
  setGameFullscreen: (v: boolean) => void;
  /** #6: hang up / dismiss the call (resets mute + deafen). */
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
  // Analytics on by default (opt-out); App.tsx re-hydrates from UserConfig.
  analyticsOptOut: false,
  // Panel open by default; App.tsx re-hydrates from UserConfig.chat_panel_hidden.
  chatPanelHidden: false,
  // Phase 15 (D-10/VIS-03): fail-closed — false until a VLM-backed bot reports
  // capabilities.vision === true over the vision:capability push.
  visionCapable: false,
  homeGreetingDismissed: false,
  chatReturnId: null,
  callMuted: false,
  callDeafened: false,
  callCaptions: false,
  avatarMode: 'off',
  avatarPrefsByCharacter: {},
  convoStartersEnabled: true,
  // Empty = nobody has a stored preference yet; each character falls back to
  // whether they have a scene. App.tsx hydrates from persisted config.
  callBackdropByCharacter: {},
  // Custom background: none until App.tsx hydrates from persisted config.
  backgroundImage: null,
  backgroundOpacity: 0.5,
  backgroundBrightness: 1,
  backgroundBust: 0,
  gameFullscreen: false,

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
  setBackgroundImage: (ref) =>
    set((s) => ({ backgroundImage: ref, backgroundBust: s.backgroundBust + 1 })),
  setBackgroundOpacity: (v) => set({ backgroundOpacity: v }),
  setBackgroundBrightness: (v) => set({ backgroundBrightness: v }),
  setGameFullscreen: (v) => set({ gameFullscreen: v }),
  setRealisticTyping: (v) => set({ realisticTyping: v }),
  setAnalyticsOptOut: (v) => set({ analyticsOptOut: v }),
  setChatPanelHidden: (v) => set({ chatPanelHidden: v }),
  setVisionCapable: (v) => set({ visionCapable: v }),
  setChatReturnId: (id) => set({ chatReturnId: id }),
  setCallMuted: (muted) => set({ callMuted: muted }),
  setCallDeafened: (deafened) => set({ callDeafened: deafened }),
  setCallCaptions: (v) => set({ callCaptions: v }),
  setAvatarMode: (mode) => set({ avatarMode: mode }),
  setAvatarPrefs: (prefs) => set({ avatarPrefsByCharacter: prefs }),
  setAvatarPrefsFor: (characterId, prefs) =>
    set((s) => ({ avatarPrefsByCharacter: { ...s.avatarPrefsByCharacter, [characterId]: prefs } })),
  setConvoStartersEnabled: (v) => set({ convoStartersEnabled: v }),
  setCallBackdropPrefs: (prefs) => set({ callBackdropByCharacter: prefs }),
  setCallBackdropFor: (characterId, on) =>
    set((s) => ({ callBackdropByCharacter: { ...s.callBackdropByCharacter, [characterId]: on } })),
  endCall: () => set({ callMuted: false, callDeafened: false }),
}));
