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
 *  6. Render the modal layer (McSetupModal etc.) above the main view. Live
 *     sessions surface on the character page / chat game area only (260725:
 *     the floating "in your world" popup was removed).
 *
 * Source: CONTEXT.md D-15/D-17/D-33/D-35, UI-SPEC.md §Animation Tokens
 *         (LoadingScreen 1.6s floor) + §Interaction Contracts → Theme toggle.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from './lib/ipcClient';
import { applyTheme, clampThemeMode, subscribeSystemTheme } from './lib/theme';
import { useUiStore } from './lib/stores/useUiStore';
import { useDataStore, subscribeIpc } from './lib/stores/useDataStore';
import { MacosWindow } from './components/MacosWindow';
import { IconRail } from './components/IconRail';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { OnboardApp, type OnboardResult } from './onboard/OnboardApp';
import { TutorialOverlay } from './components/tutorial/TutorialOverlay';
import { useTutorialStore } from './lib/stores/useTutorialStore';
import { SkinSetupScreen } from './screens/SkinSetupScreen';
import { CharactersScreen } from './screens/CharactersScreen';
import { AwakenScreen } from './screens/AwakenScreen';
import { AddCharacterScreen } from './screens/AddCharacterScreen';
import { ComingSoonScreen } from './screens/ComingSoonScreen';
import { CharacterPage } from './screens/CharacterPage';
import { ChatScreen } from './screens/ChatScreen';
import { VoiceCallScreen } from './screens/VoiceCallScreen';
import { DrawScreen } from './components/draw/DrawScreen';
import { ProfileQuestionsScreen } from './screens/ProfileQuestionsScreen';
import { UniqueGenderScreen } from './screens/UniqueGenderScreen';
import { UniqueCastingScreen } from './screens/UniqueCastingScreen';
import { UniqueRevealScreen } from './screens/UniqueRevealScreen';
import { CallMiniBar } from './components/call/CallMiniBar';
import { CallOverlayPusher } from './components/CallOverlayPusher';
import { CrossLaunchConfirmModal } from './components/CrossLaunchConfirmModal';
import { ShareScreenModal } from './components/backseat/ShareScreenModal';
import { GamesPickerModal } from './components/GamesPickerModal';
import { SettingsScreen } from './screens/SettingsScreen';
import { CreditsScreen } from './screens/CreditsScreen';
import { ReceiptScreen } from './screens/ReceiptScreen';
import { McSetupModal } from './components/McSetupModal';
import { SummonConflictModal } from './components/SummonConflictModal';
import { LanHostWarningModal } from './components/LanHostWarningModal';
import { UnsupportedVersionModal } from './components/UnsupportedVersionModal';
import { LanNotOpenModal } from './components/LanNotOpenModal';
import { BotCrashModal } from './components/BotCrashModal';
import { SetupWizardModal } from './components/SetupWizardModal';
import { LogsBar } from './components/LogsBar';
import { UpdatePopup, type UpdatePopupState } from './components/UpdatePopup';
import { NoticesInboxModal } from './components/NoticesInboxModal';
import { useNoticesStore } from './lib/stores/useNoticesStore';
import { Banner } from './components/Banner';
import { ERROR_COPY } from './lib/errors';
import * as authStore from './lib/stores/useAuthStore';
const { useAuthStore } = authStore;
import { useSyncStore } from './lib/stores/useSyncStore';
import { useCreditsStore } from './lib/stores/useCreditsStore';
import { useCloudCharactersStore } from './lib/stores/useCloudCharactersStore';
import { useLibraryStateStore } from './lib/stores/useLibraryStateStore';
import { AuthChoiceScreen } from './screens/AuthChoiceScreen';
import { AcceptToSModal } from './components/AcceptToSModal';
import { OfflineRetryModal } from './components/OfflineRetryModal';
import { HardStopModal } from './components/HardStopModal';
import { SetNewPasswordModal } from './components/SetNewPasswordModal';
import { MigrateLocalCharsModal } from './components/MigrateLocalCharsModal';
import { ImportLocalProfileModal } from './components/ImportLocalProfileModal';
import type { PeekLocalProfileResult } from '../../shared/ipc';

export function App(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  // ui-A7: developer-console visibility toggle. Default OFF — LogsBar only
  // mounts when the Settings → Show developer console toggle is flipped.
  const devConsoleVisible = useUiStore((s) => s.devConsoleVisible);
  const authState = useAuthStore((s) => s.state);
  // Phase 11 D-26 — blocking ToS modal gate. tosAccepted is tristate:
  //   null  → unknown (initial / failed fetch) → DO NOT mount the modal
  //   true  → user has accepted current versions → render normal routes
  //   false → signed in but lacks a current-version acceptance row →
  //           mount AcceptToSModal as a top-level overlay above all other UI.
  const tosAccepted = useAuthStore((s) => s.tosAccepted);
  const refreshTosStatus = useAuthStore((s) => s.refreshTosStatus);
  // 260610 — inconclusive ToS check (offline / DNS failure). Drives the
  // dismissible OfflineRetryModal; dismissal is per-outage (the flag resets
  // when a check succeeds, so a NEW outage re-raises the notice).
  const tosCheckFailed = useAuthStore((s) => s.tosCheckFailed);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  useEffect(() => {
    if (!tosCheckFailed) setOfflineDismissed(false);
  }, [tosCheckFailed]);
  // Password-recovery prompt: set true by the auth:password-recovery push when a
  // reset link lands a recovery session; drives the SetNewPasswordModal overlay.
  const passwordRecovery = useAuthStore((s) => s.passwordRecovery);
  const setPasswordRecovery = useAuthStore((s) => s.setPasswordRecovery);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  // 260724 — custom app background. MacosWindow paints the image itself
  // (window-wide, under the chrome); here we derive the tint the surfaces
  // above it use and mirror the active/tint state onto <html> so module CSS
  // (IconRail, drag strip, chat) can adapt without prop drilling.
  const backgroundImage = useUiStore((s) => s.backgroundImage);
  const backgroundOpacity = useUiStore((s) => s.backgroundOpacity);
  // In-app game fullscreen (260728): the mounted game surface owns this flag.
  const gameFullscreen = useUiStore((s) => s.gameFullscreen);
  useEffect(() => {
    const root = document.documentElement;
    if (backgroundImage) {
      root.setAttribute('data-app-bg', '');
      root.style.setProperty('--app-bg-tint', `${Math.round((1 - backgroundOpacity) * 100)}%`);
    } else {
      root.removeAttribute('data-app-bg');
      root.style.removeProperty('--app-bg-tint');
    }
  }, [backgroundImage, backgroundOpacity]);
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const modal = useUiStore((s) => s.modal);
  // In-app updater (quick/260604-uoy). A single discriminated state drives the
  // UpdatePopup across every updater stage (optional-available → downloading →
  // downloaded/forced, plus the standalone post-update what's-new). null = no
  // popup. The subscriptions below funnel each main-pushed event into the
  // matching state; dismissable states (available-optional / whats-new) clear
  // to null on Later/Got it, while downloading/downloaded/forced are
  // non-dismissable (a restart is in flight).
  const [updatePopup, setUpdatePopup] = useState<UpdatePopupState | null>(null);
  // Plan 11-18 (D-20) — one-shot local→cloud migration prompt. Auto-mounts
  // the first time a user is signed_in + ToS-accepted + has at least one
  // local-only character + has not yet seen this prompt. Re-openable from
  // Settings independently of this flag.
  const [autoMigrateOpen, setAutoMigrateOpen] = useState<boolean>(false);
  // 260603: on first sign-in to a fresh account, offer to import the anonymous
  // `local` profile's companion. Non-null = the import-offer modal is shown.
  const [importOffer, setImportOffer] = useState<PeekLocalProfileResult | null>(null);
  // RESEARCH §Pitfall 3 — Linux-only basic_text safeStorage warning. Main
  // computes this from `apiKeyStore.safeStorageBackendKind()` and exposes it via the
  // app:warnings IPC. The keychain banner (api_key.bin) is dismissed for the
  // rest of the session on first click. Phase 10 (Pitfall A2) adds the
  // sessionFallbackPlaintext banner for session.bin — its dismissal persists
  // across launches via UserConfig.linuxBasicTextWarnDismissed.
  const [warnings, setWarnings] = useState<{
    keychainFallbackPlaintext: boolean;
    keychainDismissed: boolean;
    sessionFallbackPlaintext: boolean;
    sessionDismissed: boolean;
  }>({
    keychainFallbackPlaintext: false,
    keychainDismissed: false,
    sessionFallbackPlaintext: false,
    sessionDismissed: false,
  });

  // ── First-sign-in questionnaire gate state + shared runner ─────────────────
  //    (260703 procgen, spec item 6; race fix 260706.) The gate decides, once a
  //    signed-in user is on Home, whether to interpose the companion
  //    questionnaire. Two call sites share the same runner + refs:
  //      • the Home gate effect below (app relaunch / bootstrap path), and
  //      • the onScopeChanged re-bootstrap handler (fresh sign-in path).
  //
  //    Why both: the sign-in path routes home via onScopeChanged, which is
  //    emitted asynchronously AFTER the local data scope switch settles — well
  //    after the synchronous auth:state push. A gate that fired off the auth
  //    push alone would read the PRE-switch scope (wrong profile) and then get
  //    clobbered back to Home by onScopeChanged's own navigate — exactly the
  //    reported flash-skip. `scopeSwitchPendingRef` suppresses the premature
  //    Home-gate run during that window; onScopeChanged clears it and runs the
  //    gate itself against the settled scope.
  //
  //    `prefsCheckedForUserRef` records the user id we already routed so the
  //    check never loops; it is stamped only AFTER prefsGet resolves so a
  //    transient failure genuinely retries. A "Later" dismiss stamps it too (via
  //    the screen's onDefer) so the questionnaire is not re-opened this session.
  const prefsCheckedForUserRef = useRef<string | null>(null);
  const prefsCheckInFlightRef = useRef(false);
  const scopeSwitchPendingRef = useRef(false);
  const runQuestionnaireGate = useCallback(
    async (
      uid: string,
      opts?: { landHome?: boolean; isCancelled?: () => boolean },
    ): Promise<void> => {
      if (prefsCheckedForUserRef.current === uid || prefsCheckInFlightRef.current) return;
      prefsCheckInFlightRef.current = true;
      try {
        const res = await sei.prefsGet();
        prefsCheckedForUserRef.current = uid;
        if (opts?.isCancelled?.()) return;
        if (res.needed) {
          // A brand-new user (no completed profile at all) is walked through as
          // a 'first-fill' so Finish continues into the unique-companion flow.
          // A profile that already completed but is missing a newer question is
          // just a 'missing' top-up that returns to Home.
          const firstFill = !res.profile?.completed_at;
          navigate({
            kind: 'profile-questions',
            next: 'home',
            mode: firstFill ? 'first-fill' : 'missing',
          });
        } else if (opts?.landHome) {
          setHomeTab('home');
          navigate({ kind: 'home' });
        }
      } catch {
        // Best-effort — leave the ref unset so the next Home render retries.
      } finally {
        prefsCheckInFlightRef.current = false;
      }
    },
    [navigate, setHomeTab],
  );

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

  // ── One-time auth:state subscription (Phase 10 — mirrors main's AuthState). ──
  useEffect(() => {
    const teardown = authStore.subscribeAuthState();
    return teardown;
  }, []);

  // ── One-time sync-queue subscription (Phase 11 D-18 — sync pill surface).
  //    useSyncStore.init() subscribes to sei.onSyncStatusUpdate and seeds via
  //    sei.syncStatus(). Fire-and-forget — failures fall back to no-pill until
  //    the next push arrives. The store-internal `initialized` flag makes init
  //    idempotent under React Strict-Mode double-invoke.
  useEffect(() => {
    void useSyncStore.getState().init();
  }, []);

  // ── One-time credits-status subscription (Phase 13-17 — PricingIcon surface).
  //    useCreditsStore.init() subscribes to sei.onCreditsStatusUpdate +
  //    sei.onCreditsHardStop, then seeds via sei.creditsGet(). Same idempotent
  //    fire-and-forget pattern as useSyncStore above. Backs the PricingIcon
  //    RailButton in IconRail (only mounts when ai_backend_kind==='cloud-proxy').
  useEffect(() => {
    void useCreditsStore.getState().init();
  }, []);

  // ── WR-02 (Phase 13 REVIEW): reset useCreditsStore on auth transitions.
  //
  //    The store's init() early-returns when `initialized` is already true.
  //    Without an auth-aware reset, a user who signs out and signs in to a
  //    DIFFERENT account keeps the previous account's plan, usage_pct and
  //    ai_backend_kind until either (a) a proxy call
  //    fires a push, (b) refresh() is called manually, or (c) the renderer
  //    reloads. PricingIcon, CreditsScreen, and HardStopModal would show
  //    the previous user's data to the new user.
  //
  //    Mirrors the useCloudCharactersStore pattern below (lines 154-162).
  //    Track the user.id across renders so a 'signed_in' → 'signed_in'
  //    transition with a different user.id triggers a reset+init too —
  //    not just 'signed_in' ⇄ 'local'.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentUserId =
      authState.kind === 'signed_in' ? authState.user.id : null;
    if (currentUserId !== prevUserIdRef.current) {
      // Transition: tear down old subscriptions + clear state, then
      // re-init (idempotent — init() checks `initialized` and rewires
      // the IPC subscriptions against the new session).
      useCreditsStore.getState().reset();
      // 260725: init() runs for signed-OUT transitions too. reset() leaves
      // ai_backend_kind UNKNOWN (null) and tears down the proxy:kind-changed
      // subscription; without a re-init the signed-out UI would show neither
      // mode forever. The signed-out creditsGet placeholder reports the real
      // local-profile kind, and re-subscribing keeps main's kind feed live.
      void useCreditsStore.getState().init();
      prevUserIdRef.current = currentUserId;
    }
  }, [authState]);

  // ── Cloud-character id refresh (Phase 11 plan 17 — LOCAL ONLY chip surface).
  //    Pulls the signed-in user's cloud character UUIDs and caches them in
  //    useCloudCharactersStore.cloudIds. CharacterCard uses the set to decide
  //    whether to render the subtle "LOCAL ONLY" chip on legacy local-mode
  //    characters (signed_in + !is_default + id ∉ cloudIds).
  //
  //    Fires every transition into signed_in. Signed-out → main returns an
  //    empty set (which keeps every user-created char unchipped, matching the
  //    "signed_out has no local-vs-cloud distinction" invariant from CONTEXT).
  //    On signed_in → local we also clear the set so a previously-signed-in
  //    user's cloud ids don't leak into a fresh local session.
  useEffect(() => {
    if (authState.kind === 'signed_in') {
      void useCloudCharactersStore.getState().refresh();
      // Pick up any deletions the main-side owner reconciliation just
      // performed (foreign-owned local leaks get wiped on sign-in).
      // Tiny stagger so the unlink calls have likely completed before we
      // re-read the index. The reconciler is best-effort and races with
      // this load; a second refresh fires when cloudIds resolves.
      const t = window.setTimeout(() => {
        void useDataStore.getState().loadCharacters();
      }, 600);
      return () => window.clearTimeout(t);
    } else {
      // Reset to the initial empty-set / uninitialized state on sign-out so
      // a stale cloudIds set can't make a chip appear when it shouldn't.
      useCloudCharactersStore.setState({ cloudIds: new Set<string>(), initialized: false });
    }
  }, [authState]);

  // ── Auto-mount the one-shot migration prompt (Plan 11-18, D-20). ─────
  //    Fires once per device after the user is signed_in AND has accepted ToS
  //    AND has at least one local-only character. The migration:shown flag
  //    (persisted at <userData>/migration-modal-shown.json) suppresses
  //    re-firing across launches; the Settings re-open entry remains.
  //
  //    Sequencing:
  //      1. Only run when signed_in AND tosAccepted === true (don't compete
  //         with AcceptToSModal — that one blocks everything else).
  //      2. Check the persisted shown flag — bail if already set.
  //      3. Pull the LOCAL ONLY list — only mount when non-empty (avoid the
  //         "empty modal pops up on a fresh account" UX).
  useEffect(() => {
    if (authState.kind !== 'signed_in' || tosAccepted !== true) return;
    let cancelled = false;
    void (async () => {
      try {
        const { shown } = await sei.migrationShown('get');
        if (cancelled || shown) return;
        // LR-03 — name this `localOnlyChars` so it does not shadow the outer
        // `characters = useDataStore((s) => s.characters)` selector and trip
        // a future maintainer who reaches for `.length` inside this effect.
        const { characters: localOnlyChars } = await sei.migrationListLocal();
        if (cancelled || localOnlyChars.length === 0) return;
        setAutoMigrateOpen(true);
      } catch {
        // Silent — auto-mount is a best-effort UX. The Settings re-open entry
        // remains, so the user can always reach this flow manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authState, tosAccepted]);

  // ── In-app updater subscriptions (quick/260604-uoy). ──────────────────────
  //    Wired ONCE at mount. Each main-pushed event maps to a UpdatePopup state.
  //    onUpdateAvailable fires only for OPTIONAL updates (mandatory ones
  //    download silently); progress/downloaded reflect an in-flight download;
  //    whats-new is the post-update changelog on the next launch.
  useEffect(() => {
    const unsubs = [
      sei.onUpdateAvailable((info) => {
        setUpdatePopup({
          kind: 'available-optional',
          currentVersion: info.currentVersion,
          latestVersion: info.latestVersion,
          changelog: info.changelog,
        });
      }),
      sei.onUpdateProgress((ev) => {
        setUpdatePopup({ kind: 'downloading', percent: ev.percent });
      }),
      sei.onUpdateDownloaded((ev) => {
        if (ev.forced) {
          // apply:'now' mandatory — main restarts automatically after a brief
          // delay; show the non-dismissable critical overlay until it does.
          setUpdatePopup({ kind: 'forced' });
        } else if (ev.onRestart) {
          // Mandatory on-restart — transition the (foreground) download bar to a
          // dismissable "ready, restart to apply" popup so it can't hang at 100%.
          // Applies on next quit regardless; "Restart now" just does it sooner.
          setUpdatePopup({ kind: 'downloaded-on-restart' });
        } else {
          // Optional/consented flow — show "restarting…" then ask main to
          // quit-and-install.
          setUpdatePopup({ kind: 'downloaded' });
          void sei.installUpdate();
        }
      }),
      sei.onWhatsNew((ev) => {
        setUpdatePopup({ kind: 'whats-new', version: ev.version, changelog: ev.changelog });
      }),
      // Notices ride the update check's cadence in main, so their subscription
      // belongs here too. init() both listens and does the race-proof pull; the
      // store opens the inbox itself for a notice that has never been announced.
      useNoticesStore.getState().init(),
    ];
    // Pull any pending post-update changelog on mount. The onWhatsNew push above
    // fires during early main bootstrap (before this listener exists) and is
    // dropped — most visibly on a forced apply:"now" restart — so the push alone
    // never reliably shows the changelog. This pull is the race-proof path; the
    // guard avoids stomping a live optional-update popup if one is already up.
    void sei.getWhatsNew().then((ev) => {
      if (ev) setUpdatePopup((prev) => prev ?? { kind: 'whats-new', version: ev.version, changelog: ev.changelog });
    });
    return () => unsubs.forEach((u) => u());
  }, []);

  // ── Per-profile scope change (260603): re-bootstrap onto the new account. ──
  //    Main pushes app:scope-changed AFTER it has torn down the bot, switched
  //    the local data scope, and seeded the new profile. We reload the new
  //    profile's config + characters and re-route:
  //      • sign-out (account → local) → the scene's sign-in panel (260729,
  //        signin variant): re-auth as someone else, "I'm new here" for the
  //        full scene, or continue locally;
  //      • otherwise a profile with no mc_username is treated as a fresh install
  //        → onboarding (the signed-in onboarding flow only asks MC username +
  //        preferred name); a profile with an mc_username → home.
  //    This is what makes switching accounts "start fresh like a new install".
  //    Credits/cloud-id stores reset via their own authState-keyed effects
  //    above; this handles the local-file-backed stores + routing.
  useEffect(() => {
    return sei.onScopeChanged((ev) => {
      void (async () => {
        // The local data scope has now settled onto the (possibly new) account,
        // so the Home questionnaire gate may safely read it. Clear the pending
        // flag that suppressed the premature Home-gate run during the switch,
        // and drop any stamp a premature run left so the gate re-decides here.
        scopeSwitchPendingRef.current = false;
        prefsCheckedForUserRef.current = null;
        // Onboarding completion is keyed on preferred_name (the "Name" field);
        // the Minecraft-username step was retired from the GUI (260605).
        let onboardedName = '';
        let skinPending = false;
        try {
          const cfg = await sei.getConfig();
          onboardedName = (cfg.preferred_name ?? '').trim();
          skinPending = cfg.skin_setup_pending === true;
          // Default to the midnight "Summoning Terminal" theme on fresh
          // installs; legacy 'dark'/'light' values are clamped to the new names.
          const mode = clampThemeMode(cfg.theme_mode ?? 'midnight');
          setThemeMode(mode);
          applyTheme(mode);
          useUiStore.getState().setDevConsoleVisible(!!cfg.dev_console_visible);
          // Appearance & feel: seed the "Realistic typing" pacing toggle
          // (default ON) so useChatStore.send() reads the right value.
          useUiStore.getState().setRealisticTyping(cfg.realistic_typing !== false);
          // Appearance & feel: call captions (default OFF).
          useUiStore.getState().setCallCaptions(cfg.call_captions === true);
          // Appearance & feel: always-on-top call overlay (default OFF).
          useUiStore.getState().setCallOverlayEnabled(cfg.call_overlay_enabled === true);
          // Conversation starters on quiet calls (default ON).
          useUiStore.getState().setConvoStartersEnabled(cfg.call_convo_starters !== false);
          // Sticky chat side-panel visibility (default shown).
          useUiStore.getState().setChatPanelHidden(cfg.chat_panel_hidden === true);
          // Product analytics opt-out (default OFF = analytics on).
          useUiStore.getState().setAnalyticsOptOut(cfg.analytics_opt_out === true);
          // Custom app background (Theme section, 260724).
          useUiStore.getState().setBackgroundImage(cfg.background_image ?? null);
          useUiStore.getState().setBackgroundOpacity(cfg.background_opacity ?? 0.5);
          useUiStore.getState().setBackgroundBrightness(cfg.background_brightness ?? 1);
        } catch {
          // Fall through with empty onboardedName → onboarding (fresh profile).
        }
        // Replace the previous profile's character list + library state.
        try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
        try { await useLibraryStateStore.getState().refresh(); } catch { /* no hidden defaults */ }
        // Sign-out (account → local): straight to the scene's sign-in panel
        // (260729; replaced AuthChoice here). Same signin variant as the boot
        // route below — a signing-out user usually just wants to switch
        // accounts, so no cutscene; re-auth, "I'm new here" (full scene), and
        // continue-locally are all on the panel, covering the old "must show
        // the chooser" concern (fix 260605). This handler wins the navigation
        // race against the authState push because app:scope-changed is
        // emitted after the async scope teardown, so the sign-out routing
        // must live here.
        if (ev.reason === 'sign-out') { navigate({ kind: 'onboard', signin: true }); return; }
        // Re-seed the credits store now that the scope has ACTUALLY switched.
        // The authState-keyed effect above already reset()+init()'d it from the
        // SYNCHRONOUS signed_in push — which fires BEFORE this async scope switch
        // wrote the cloud-proxy billing default into the new profile's
        // config.json — so that init() read the OLD scope's
        // `ai_backend_kind: 'local'`. authState doesn't change again here, so it
        // never re-reads. reset()+init() re-seeds against the settled scope; the
        // reset() bumps the store's loadEpoch, which discards the earlier
        // in-flight creditsGet() (it would otherwise resolve late and clobber us
        // back to local). Net effect: a freshly signed-in user lands on cloud
        // mode, deterministically, regardless of which read resolves first.
        try {
          useCreditsStore.getState().reset();
          await useCreditsStore.getState().init();
        } catch { /* keep last */ }
        // 260728 Sui onboarding: while the first-run scene is driving (view
        // 'onboard'), it owns navigation — the sign-in that just landed came
        // from the scene's own panel, and the scene continues into setup +
        // generation itself. The data reloads above still ran.
        if (useUiStore.getState().view.kind === 'onboard') return;
        // Onboarded but skin-setup still pending → resume the dedicated step.
        if (onboardedName && skinPending) { navigate({ kind: 'skin-setup' }); return; }
        // Onboarded account → home, on the HOME tab (which shows the welcome
        // message) — NOT the playtime/credits screen users reported landing on
        // after sign-in and disliked. Route through the questionnaire gate so a
        // signed-in account that never completed it (or is missing a newer
        // question) is walked through BEFORE landing on Home. Running it here —
        // after the scope settled — is what keeps the gate's navigate from being
        // clobbered by this handler (the reported flash-skip). landHome makes
        // the gate settle Home itself when nothing is needed, so there is no
        // intermediate Home→questionnaire flash.
        if (onboardedName) {
          const st = useAuthStore.getState().state;
          if (st.kind === 'signed_in') {
            void runQuestionnaireGate(st.user.id, { landHome: true });
          } else {
            useUiStore.getState().setHomeTab('home');
            navigate({ kind: 'home' });
          }
          return;
        }
        // Fresh account. On FIRST sign-in only (never account→account), offer to
        // import the anonymous local profile's companion if there's anything to
        // bring across; the modal routes onward. Otherwise → onboarding.
        if (ev.reason === 'sign-in') {
          try {
            const peek = await sei.profilePeekLocal();
            if (peek.hasData) { setImportOffer(peek); return; }
          } catch { /* fall through to onboarding */ }
        }
        navigate({ kind: 'onboard' });
      })();
    });
  }, [navigate, setThemeMode, runQuestionnaireGate]);

  // Resolve the import-offer modal: re-read config (the import may have copied
  // preferred_name across) + reload characters, then route home-or-onboarding.
  async function handleImportOfferDone(_didImport: boolean): Promise<void> {
    setImportOffer(null);
    let onboardedName = '';
    let skinPending = false;
    try {
      const cfg = await sei.getConfig();
      onboardedName = (cfg.preferred_name ?? '').trim();
      skinPending = cfg.skin_setup_pending === true;
    } catch { /* onboarding */ }
    try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
    if (!onboardedName) { navigate({ kind: 'onboard' }); return; }
    if (skinPending) { navigate({ kind: 'skin-setup' }); return; }
    useUiStore.getState().setHomeTab('home');
    navigate({ kind: 'home' });
  }

  // ── Initial bootstrap: config → characters → first view (with floor) ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Tracks whether the active profile has completed onboarding (has a
      // preferred_name). Drives the signed-in routing decision below so a
      // freshly signed-up account that hasn't onboarded yet lands on
      // onboarding rather than a home screen whose summons would fail.
      let onboardedName = '';
      // Whether the onboarding skin-setup step is still pending — drives the
      // resume-to-skin-setup routing below (set on onboarding submit, cleared
      // when the user finishes/skips the SkinSetupScreen).
      let skinPending = false;
      // Load persisted config + theme
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        onboardedName = (cfg.preferred_name ?? '').trim();
        skinPending = cfg.skin_setup_pending === true;
        // Default to the midnight "Summoning Terminal" theme on fresh
        // installs; legacy 'dark'/'light' values are clamped to the new names.
        const mode = clampThemeMode(cfg.theme_mode ?? 'midnight');
        setThemeMode(mode);
        applyTheme(mode);
        // ui-A7: seed the developer-console visibility from persisted config
        // BEFORE the first render of any view that mounts LogsBar — the
        // gate below reads useUiStore.devConsoleVisible directly.
        if (typeof cfg.dev_console_visible === 'boolean') {
          useUiStore.getState().setDevConsoleVisible(cfg.dev_console_visible);
        }
        // Appearance & feel: seed the "Realistic typing" pacing toggle before
        // first render (default ON when the field is absent).
        useUiStore.getState().setRealisticTyping(cfg.realistic_typing !== false);
        // Appearance & feel: call captions (default OFF when absent).
        useUiStore.getState().setCallCaptions(cfg.call_captions === true);
        // Appearance & feel: always-on-top call overlay (default OFF when absent).
        useUiStore.getState().setCallOverlayEnabled(cfg.call_overlay_enabled === true);
        // Conversation starters on quiet calls (default ON when absent).
        useUiStore.getState().setConvoStartersEnabled(cfg.call_convo_starters !== false);
        // Sticky chat side-panel visibility (default shown).
        useUiStore.getState().setChatPanelHidden(cfg.chat_panel_hidden === true);
        // Product analytics opt-out (default OFF = analytics on). Without this
        // seed the store's `false` default made the Settings toggle show ON
        // even when the profile's config.json had analytics_opt_out: true
        // (the scope-changed handler hydrated it, the initial bootstrap
        // didn't) — fix 260720.
        useUiStore.getState().setAnalyticsOptOut(cfg.analytics_opt_out === true);
        // Custom app background (Theme section, 260724).
        useUiStore.getState().setBackgroundImage(cfg.background_image ?? null);
        useUiStore.getState().setBackgroundOpacity(cfg.background_opacity ?? 0.5);
        useUiStore.getState().setBackgroundBrightness(cfg.background_brightness ?? 1);
      } catch {
        // Defaults already applied (themeMode='system' from store)
      }

      // Load character list (best-effort — empty array if rejection)
      try {
        await useDataStore.getState().loadCharacters();
      } catch {
        // Stores stay empty; screens render the empty-state.
      }

      // Seed the library-state store (removed_default_ids). Best-effort.
      try {
        await useLibraryStateStore.getState().refresh();
      } catch {
        // Empty Set is a safe default — no defaults hidden.
      }

      // Startup warnings (Linux basic_text safeStorage fallback). Best-effort.
      try {
        const w = await sei.getStartupWarnings();
        if (cancelled) return;
        // Phase 10: sessionDismissed seeded from UserConfig.linuxBasicTextWarnDismissed
        // so a previously-dismissed LinuxKeyringBanner stays dismissed across launches.
        const cfgForWarn = await sei.getConfig().catch(() => null);
        const sessionDismissed = cfgForWarn?.linuxBasicTextWarnDismissed ?? false;
        setWarnings({
          keychainFallbackPlaintext: w.keychainFallbackPlaintext,
          keychainDismissed: false,
          sessionFallbackPlaintext: w.sessionFallbackPlaintext,
          sessionDismissed,
        });
      } catch {
        // No warnings surfaced; default state already false.
      }

      // ── Pitfall A8 routing (Phase 10) ─────────────────────────────────
      //   session.bin OK            → kind:'home' (signed-in path)
      //   no session, api_key.bin OK → AuthChoice; Continue Locally → home
      //   no session, no api_key.bin → AuthChoice; Continue Locally → onboarding
      //
      // We read the renderer's mirror of AuthState (useAuthStore). Main pushes
      // the initial AuthState during initAuthState bootstrap, replayed on every
      // did-finish-load — by the time this effect resolves after the awaited
      // config + character load above, the value is correct.
      //
      // B5: the LoadingScreen wallclock floor was removed. The renderer routes
      // straight to the initial view; the boot pulse is gone.
      if (cancelled) return;
      const currentAuth = useAuthStore.getState().state;
      if (currentAuth.kind === 'signed_in') {
        // 260603: a signed-in account that hasn't onboarded yet (no
        // preferred_name in its profile) is a fresh account → the Sui
        // onboarding scene (260728; it skips its sign-in step when a session
        // is already live). Onboarded-but-skin-pending → resume the dedicated
        // skin-setup step. Otherwise home, on the Home tab.
        if (!onboardedName) {
          navigate({ kind: 'onboard' });
        } else if (skinPending) {
          navigate({ kind: 'skin-setup' });
        } else {
          useUiStore.getState().setHomeTab('home');
          navigate({ kind: 'home' });
        }
      } else if (!onboardedName) {
        // Fresh install (nothing configured on the local profile) → the Sui
        // onboarding scene, which owns sign-in/sign-up/continue-locally.
        navigate({ kind: 'onboard' });
      } else {
        // Signed-out profile that HAS onboarded: the scene mounted directly
        // at its sign-in panel (260729; replaced AuthChoice). No cutscene —
        // a local BYOK launch stays one "Continue locally" click.
        navigate({ kind: 'onboard', signin: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, setThemeMode]);

  // Skin setup runs the first time the Minecraft surface is opened (260725,
  // maybeOfferSkinSetup in lib/gameLaunch.ts) — onboarding no longer arms
  // skin_setup_pending. The SkinSetupScreen resume routing below is kept for
  // profiles that armed the gate under the old flow (it self-clears on
  // finish/skip); the Settings → "Re-run setup" entry remains for everyone.

  // ── Auth-state transitions driven by the Supabase auth-event push
  //    (initAuthState → onAuthState). We don't await any IPC ourselves.
  //
  //    Upward (local → signed_in): land on home from auth-choice/loading.
  //    Downward (signed_in → local): BL-04 fix — sign-out from Settings or a
  //    successful delete-account flips authState to 'local' but the user was
  //    parked on the Settings view, whose Account panel is now hidden,
  //    leaving them stranded. Route them to the Sui onboarding scene so the
  //    next step (re-sign-in, or proceed as local) is reachable.
  //
  //    ITEM 16 (quick/260523-t8d): the previous unconditional
  //    "authState.kind === 'local' && view.kind === 'settings' → auth-choice"
  //    redirect ALSO fired when a local-mode user deliberately navigated to
  //    Settings via IconRail — bouncing them straight back to AuthChoice. The
  //    redirect must ONLY fire on the DOWNWARD signed_in → local transition.
  //    We track the previous authState kind in a ref and only redirect when
  //    this render is the actual transition edge.
  const prevAuthKindRef = useRef<typeof authState.kind | null>(null);
  useEffect(() => {
    const prev = prevAuthKindRef.current;
    // On any fresh sign-in, default the Home/World tab to Home — it shows the
    // welcome message and is the intended landing surface (not the playtime/
    // credits screen). Only fire on the actual upward edge (prev was a
    // non-signed_in kind), never on initial mount.
    if (authState.kind === 'signed_in' && prev !== null && prev !== 'signed_in') {
      setHomeTab('home');
      // A fresh sign-in triggers an async local-scope switch in main that ends
      // with an app:scope-changed push. Suppress the Home questionnaire gate
      // until that push lands (onScopeChanged clears this) so the gate reads the
      // SETTLED scope, not the pre-switch one, and its navigate is not clobbered
      // by onScopeChanged's own routing (the reported flash-skip).
      scopeSwitchPendingRef.current = true;
    }
    if (authState.kind === 'signed_in' && (view.kind === 'auth-choice' || view.kind === 'loading')) {
      navigate({ kind: 'home' });
    } else if (
      authState.kind === 'local' &&
      view.kind === 'settings' &&
      prev === 'signed_in'
    ) {
      // Only bounce on the actual downward transition — direct navigation to
      // Settings from IconRail while ALREADY in local mode is allowed.
      // 260729: lands on the scene's sign-in panel, same destination as the
      // scope-changed sign-out route above.
      navigate({ kind: 'onboard', signin: true });
    }
    prevAuthKindRef.current = authState.kind;
  }, [authState, view.kind, navigate, setHomeTab]);

  // ── First-sign-in questionnaire gate (260703 procgen, spec item 6). ────────
  //    Once a signed-in user lands on Home, run the shared gate (declared near
  //    the top) which asks main whether the companion questionnaire is still
  //    needed and, if so, routes to ProfileQuestionsScreen BEFORE they use Home
  //    — mirroring how onboarding/skin-setup gate the home route.
  //
  //    This effect covers the app-relaunch / bootstrap path (a returning
  //    signed-in user whose session is restored at launch: no scope switch, so
  //    the pending guard is already clear). The fresh sign-in path is handled by
  //    onScopeChanged, which runs the SAME gate once the scope has settled;
  //    `scopeSwitchPendingRef` suppresses this effect during that window so the
  //    two paths never fight. A sign-out clears the checked-ref so a different
  //    account is re-checked next time.
  const tutorialActive = useTutorialStore((s) => s.active);
  useEffect(() => {
    if (authState.kind !== 'signed_in') {
      prefsCheckedForUserRef.current = null;
      return;
    }
    if (view.kind !== 'home') return;
    if (scopeSwitchPendingRef.current) return; // wait for onScopeChanged
    // 260728: never interrupt Sui's tour with the questionnaire (a user who
    // skipped companion creation has unanswered prefs; the Awaken gate — or
    // this effect on the next Home render after the tour — re-asks).
    if (tutorialActive) return;
    let cancelled = false;
    void runQuestionnaireGate(authState.user.id, { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [authState, view.kind, tutorialActive, runQuestionnaireGate]);

  // ── Sui onboarding completion (260728): route + arm the tutorial. ─────
  const handleOnboardComplete = useCallback(
    (res: OnboardResult) => {
      void (async () => {
        // The scene saved config + possibly generated a companion; pull the
        // fresh state before landing anywhere.
        try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
        try { await useLibraryStateStore.getState().refresh(); } catch { /* none */ }
        // Re-fetch ToS status: the store's cached value was read at the
        // signed_in transition, racing the signup path's fire-and-forget
        // acceptance insert, and a stale `false` mounts the blocking legal
        // modal over the tutorial (260729).
        void useAuthStore.getState().refreshTosStatus();
        if (res.tutorial) {
          useTutorialStore.getState().start(res.characterId);
          if (res.characterId) {
            // Land on the character reveal page (portrait + "Say hello"); the
            // tour's say-hi step spotlights that button.
            navigate({ kind: 'unique-reveal', characterId: res.characterId });
          } else {
            setHomeTab('home');
            navigate({ kind: 'home' });
          }
        } else {
          setHomeTab('home');
          navigate({ kind: 'home' });
        }
      })();
    },
    [navigate, setHomeTab],
  );

  // B5: LoadingScreen is gone — the renderer routes directly to the initial
  // view in the bootstrap effect above. The 'loading' view variant is a
  // transient state before that effect resolves; render nothing for a frame
  // rather than mounting the prior boot pulse.
  if (view.kind === 'loading') return <></>;

  // 260728: the Sui onboarding scene is chromeless — no MacosWindow drag
  // strip, no version tag, no rail; the mac traffic lights hide over IPC
  // while it is mounted (OnboardApp's own effect).
  if (view.kind === 'onboard') {
    // key: a signin-variant mount must not reuse a full-scene instance's
    // state (and vice versa) if the view flips between them.
    return (
      <OnboardApp
        key={view.signin ? 'signin' : 'full'}
        startAtSignIn={view.signin === true}
        onStartFresh={() => navigate({ kind: 'onboard' })}
        onComplete={handleOnboardComplete}
      />
    );
  }

  // The IconRail is suppressed on the full-page entry surfaces (onboarding /
  // sign-in / skin setup). MacosWindow needs the same signal so its top-bar
  // hairline can span the full width (including under the macOS traffic lights)
  // when there's no rail to read as continuous chrome on the left.
  const railHidden =
    view.kind === 'onboarding' ||
    view.kind === 'auth-choice' ||
    view.kind === 'skin-setup' ||
    // 260703 procgen — the unique-companion flow + first-sign-in questionnaire
    // are full-page ritual surfaces (like onboarding), so the rail is hidden.
    view.kind === 'profile-questions' ||
    view.kind === 'unique-gender' ||
    view.kind === 'unique-casting' ||
    view.kind === 'unique-reveal' ||
    // 260728 — a game surface asked for in-app fullscreen. No view test is
    // needed: the flag is set and cleared by the mounted game surface itself
    // (see useUiStore.gameFullscreen), so it cannot outlive the game.
    gameFullscreen;

  // ── Custom background (260724) ────────────────────────────────────────
  // The image (plus its brightness dim) is painted WINDOW-WIDE by
  // MacosWindow's bgLayer, under the chrome — so the IconRail, the top drag
  // strip, and chat show it too. Surfaces above it swap their opaque fills
  // for a theme-colored tint whose strength is the inverse of the opacity
  // slider ("opacity 100%" shows the image bare, "0%" is indistinguishable
  // from no background): <main> and the elbow wrapper get inline styles here;
  // the rail / drag strip / chat adapt via `:root[data-app-bg]` CSS keyed on
  // the --app-bg-tint property maintained by the effect above.
  const tintPct = Math.round((1 - backgroundOpacity) * 100);
  const mainStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'auto',
    background: backgroundImage
      ? `color-mix(in srgb, var(--window) ${tintPct}%, transparent)`
      : 'var(--window)',
    borderTopLeftRadius: 12,
    borderTop: '1px solid var(--border)',
    borderLeft: '1px solid var(--border)',
  };
  const elbowStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    background: backgroundImage
      ? `color-mix(in srgb, var(--elbow) ${tintPct}%, transparent)`
      : 'var(--elbow)',
  };

  return (
    <>
      <MacosWindow railHidden={railHidden}>
        {/*
          MacosWindow's `.body` is a flex row (IconRail | main). To place
          a top-of-window Banner above that row, we render a flex-column
          wrapper as the sole child so the Banner stacks vertically while
          the IconRail+main row keeps its original layout.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          {/*
            Phase 10 (D-04, plan 10-06): VerifyEmailBanner — persistent,
            non-dismissable warn Banner shown whenever the user is signed in
            but Supabase has not yet flipped email_confirmed_at. Stacking
            order per UI-SPEC §Layout rule 7: VerifyEmailBanner FIRST (top),
            keychain warning SECOND (below). Disappears on the next render
            after Pitfall A6's USER_UPDATED event flips emailVerified true
            (T-10-06-06: condition is computed live, no stale closure).
          */}
          {authState.kind === 'signed_in' && !authState.user.emailVerified ? (
            <Banner
              kind="warn"
              message="Verify your email to publish companions or buy credits. Check your inbox for a link from Sei."
            />
          ) : null}
          {/*
            Phase 10 (plan 10-07, UI-SPEC §Linux basic_text warning Banner + §Layout
            rule 7). LinuxKeyringBanner — renders ONCE on the first signed-in session
            when safeStorage backend is `basic_text` AND the user hasn't dismissed it
            before. Dismissal persists via UserConfig.linuxBasicTextWarnDismissed.
            Gated on signed_in per UI-SPEC §Q4 (no surface on AuthChoice).
          */}
          {/* LinuxKeyringBanner — gated on signed_in (Pitfall A2, UI-SPEC §Q4). */}
          {authState.kind === 'signed_in' && warnings.sessionFallbackPlaintext && !warnings.sessionDismissed ? (
            <Banner
              kind="warn"
              /* signed_in-gated by the conditional above */
              message="Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection."
              onDismiss={() => {
                // Optimistic local dismiss + best-effort persistence.
                setWarnings((w) => ({ ...w, sessionDismissed: true }));
                void (async () => {
                  try {
                    const cfg = await sei.getConfig();
                    await sei.saveConfig({ ...cfg, linuxBasicTextWarnDismissed: true });
                  } catch {
                    // In-session dismissal already applied; persistence is best-effort.
                  }
                })();
              }}
            />
          ) : null}
          {warnings.keychainFallbackPlaintext && !warnings.keychainDismissed ? (
            <Banner
              kind="warn"
              message={ERROR_COPY.KEYCHAIN_FALLBACK_PLAINTEXT}
              onDismiss={() => setWarnings((w) => ({ ...w, keychainDismissed: true }))}
            />
          ) : null}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {!railHidden ? <IconRail /> : null}
            {/*
              Right-side column stacks the active screen and the LogsBar.
              Wrapping the LogsBar inside this column (rather than as a
              sibling of the IconRail+main row) keeps the IconRail at full
              window height when the LogsBar expands — the expansion takes
              from the main content area, not from the rail.
            */}
            {/* Elbow backdrop so the content panel's rounded top-left corner
                reveals the rail/header junction behind it (chrome-blue in light,
                a lighter pocket in dark — see --elbow). Tinted translucent when
                a custom background is active, like the rest of the chrome. */}
            <div style={elbowStyle}>
              <main style={mainStyle}>
                {view.kind === 'auth-choice' && (
                  <AuthChoiceScreen
                    onChooseLocal={() => {
                      // Pitfall A8: api_key.bin OK → home (already onboarded);
                      // else onboarding step 0. An onboarded local user with
                      // skin setup still pending resumes the dedicated step.
                      void (async () => {
                        try {
                          const hasKey = await sei.hasApiKey();
                          if (!hasKey) { navigate({ kind: 'onboarding', isReonboard: false }); return; }
                          const cfg = await sei.getConfig();
                          if (cfg.skin_setup_pending) { navigate({ kind: 'skin-setup' }); return; }
                          navigate({ kind: 'home' });
                        } catch {
                          navigate({ kind: 'onboarding', isReonboard: false });
                        }
                      })();
                    }}
                  />
                )}
                {view.kind === 'onboarding' && (
                  <OnboardingScreen
                    isReonboard={view.isReonboard}
                    signedIn={authState.kind === 'signed_in'}
                  />
                )}
                {view.kind === 'skin-setup' && <SkinSetupScreen />}
                {view.kind === 'home' && <CharactersScreen />}
                {view.kind === 'awaken' && <AwakenScreen />}
                {view.kind === 'add-character' && (
                  <AddCharacterScreen importFirst={view.importFirst === true} />
                )}
                {view.kind === 'character' && <CharacterPage id={view.id} />}
                {view.kind === 'chat' && <ChatScreen characterId={view.characterId} />}
                {view.kind === 'voice-call' && (
                  <VoiceCallScreen characterId={view.characterId} />
                )}
                {view.kind === 'draw' && <DrawScreen characterId={view.characterId} />}
                {view.kind === 'settings' && <SettingsScreen />}
                {view.kind === 'credits' && <CreditsScreen />}
                {view.kind === 'receipt' && <ReceiptScreen />}
                {view.kind === 'coming-soon' && <ComingSoonScreen />}
                {view.kind === 'profile-questions' && (
                  <ProfileQuestionsScreen
                    next={view.next}
                    mode={view.mode}
                    onDefer={() => {
                      // "Later" on the first step: record the deferral so the
                      // Home gate does not re-open the questionnaire this
                      // session (it offers it again on the next launch).
                      if (authState.kind === 'signed_in') {
                        prefsCheckedForUserRef.current = authState.user.id;
                      }
                    }}
                  />
                )}
                {view.kind === 'unique-gender' && <UniqueGenderScreen />}
                {view.kind === 'unique-casting' && (
                  <UniqueCastingScreen gender={view.gender} />
                )}
                {view.kind === 'unique-reveal' && (
                  <UniqueRevealScreen characterId={view.characterId} />
                )}
              </main>
              {/* 260722 — the app-level call watchdog (renders nothing): the
                  auto-return-to-fullscreen-call behavior when the last game
                  surface closes. In-game call controls live in GameSurface's
                  chrome row; elsewhere the icon-rail badge is the ambient
                  call indicator. */}
              <CallMiniBar />
              {/*
                LogsBar — quick task 260508-mun item 5. Hidden during
                onboarding and auth-choice (pre-app surfaces).
                ui-A7: ALSO hidden unless the user has explicitly flipped
                the Settings → Show developer console toggle.
              */}
              {devConsoleVisible &&
              view.kind !== 'onboarding' &&
              view.kind !== 'auth-choice' &&
              view.kind !== 'skin-setup' ? (
                <LogsBar />
              ) : null}
            </div>
          </div>
        </div>
      </MacosWindow>
      {/* Task 4 — drives the always-on-top call overlay window (renders nothing;
          pushes call state to main, which owns the overlay window). */}
      <CallOverlayPusher />
      {modal?.kind === 'mc-setup' ? (
        <McSetupModal tab={modal.tab} searching={modal.searching} />
      ) : null}
      {modal?.kind === 'summon-conflict' ? (
        <SummonConflictModal
          attemptedName={modal.attemptedName}
          conflictName={modal.conflictName}
          username={modal.username}
        />
      ) : null}
      {/* 260709 — pre-summon disclaimer when the LAN host is modded or Lunar. */}
      {modal?.kind === 'lan-host-warning' ? (
        <LanHostWarningModal
          characterId={modal.characterId}
          warning={modal.warning}
          host={modal.host}
          fromChat={modal.fromChat}
        />
      ) : null}
      {/* 260709 — the world runs an unsupported Minecraft version; the Play
          flow previously failed with no visible feedback. */}
      {modal?.kind === 'unsupported-version' ? (
        <UnsupportedVersionModal characterId={modal.characterId} message={modal.message} />
      ) : null}
      {/* 260720 — a summon died with LAN_NOT_OPEN; numbered open-to-LAN steps. */}
      {modal?.kind === 'lan-not-open' ? <LanNotOpenModal characterId={modal.characterId} /> : null}
      {modal?.kind === 'bot-crash' ? <BotCrashModal characterId={modal.characterId} /> : null}
      {/* Phase 18/19 — chat "Play together" surface: the game picker grid
          (per-game info is a hover popup inside it). */}
      {modal?.kind === 'games-picker' ? (
        <GamesPickerModal characterId={modal.characterId} />
      ) : null}
      {/* 260803 — the screen-share source picker, opened from the call
          controls' share button (the games-picker tile is gone). */}
      {modal?.kind === 'share-screen' ? (
        <ShareScreenModal characterId={modal.characterId} />
      ) : null}
      {/* 260721 — launching a game while another one is active: confirm ends
          the previous session via its normal end path, then proceeds. */}
      {modal?.kind === 'cross-launch' ? (
        <CrossLaunchConfirmModal
          characterId={modal.characterId}
          fromId={modal.fromId}
          fromName={modal.fromName}
          toName={modal.toName}
        />
      ) : null}
      {/* The skin-setup onboarding page renders the wizard inline (via
          WizardStepMachine), so suppress the global modal there to avoid a
          double-render. Elsewhere (Settings "Re-run setup") it works as before. */}
      {view.kind !== 'skin-setup' ? <SetupWizardModal /> : null}
      {updatePopup ? (
        <UpdatePopup
          state={updatePopup}
          onUpdateNow={() => {
            // 'downloaded-on-restart' reuses the primary action as "Restart
            // now" → quit-and-install the already-downloaded update.
            if (updatePopup.kind === 'downloaded-on-restart') {
              void sei.installUpdate();
              return;
            }
            // Consent to download the optional update; switch the popup to the
            // downloading state immediately so the user sees the bar before the
            // first progress tick arrives.
            setUpdatePopup({ kind: 'downloading', percent: 0 });
            void sei.downloadUpdate();
          }}
          onDismiss={() => setUpdatePopup(null)}
        />
      ) : null}
      {/* Notices inbox (260725). Self-mounting: the store decides visibility, so
          this renders null until a notice arrives (opens once) or the user
          reopens it from Playtime → Inbox. */}
      <NoticesInboxModal />
      {/*
        Phase 11 D-26 — BLOCKING ToS+Privacy acceptance modal. Mounts as the
        LAST modal layer so it overlays every other modal/toast at the same
        z-index when the user is signed in without a current-version
        tos_acceptance row (catch-all for Phase 10 alpha accounts, Google OAuth
        first-time users that bypassed the signup checkbox, and any user signed
        in before a TOS_VERSION bump). On accept, refreshTosStatus() flips
        tosAccepted → true and this conditional unmounts.
        260729: suppressed while Sui's tutorial runs. Onboarding already
        handled ToS (signup checkbox / the scene's own gate); this modal
        appearing there was a stale cache read racing the fire-and-forget
        acceptance insert, and it sat over the tour and froze it.
        handleOnboardComplete re-fetches the status, so a genuinely
        unaccepted user still gets the gate right after the tour.
      */}
      {authState.kind === 'signed_in' && tosAccepted === false && !tutorialActive ? (
        <AcceptToSModal
          onAccepted={() => {
            // Mirror main's privacy re-consent (tos:accept clears
            // analytics_opt_out) so the Settings toggle shows ON without a
            // reload — fix 260720.
            useUiStore.getState().setAnalyticsOptOut(false);
            void refreshTosStatus();
          }}
        />
      ) : null}
      {/*
        260610 — offline-retry notice. Mounts when the ToS status check was
        INCONCLUSIVE (couldn't reach the database) for a signed-in user, in
        place of the blocking legal modal — an already-accepted user launching
        offline used to get re-prompted and then trapped on the duplicate-key
        insert error. Mutually exclusive with AcceptToSModal: tosCheckFailed
        implies tosAccepted === null. Dismissible; auto-retries when the OS
        reports connectivity returning.
      */}
      {authState.kind === 'signed_in' && tosCheckFailed && !offlineDismissed ? (
        <OfflineRetryModal onDismiss={() => setOfflineDismissed(true)} />
      ) : null}
      {/*
        Plan 11-18 (D-20) — one-shot local→cloud migration prompt. Mounts
        only when the auto-mount effect above set autoMigrateOpen true (signed_in
        + tosAccepted + has local-only chars + flag not yet set). Mutually
        exclusive with AcceptToSModal because of the tosAccepted gate.
      */}
      {autoMigrateOpen ? (
        <MigrateLocalCharsModal onClose={() => setAutoMigrateOpen(false)} />
      ) : null}
      {/*
        260603 — first sign-in to a fresh account: offer to bring the anonymous
        local profile's companion (characters + memory + onboarding) into the
        account. onScopeChanged sets importOffer; the modal routes onward.
      */}
      {importOffer ? (
        <ImportLocalProfileModal peek={importOffer} onDone={(d) => void handleImportOfferDone(d)} />
      ) : null}
      {/*
        Phase 13 — Plan 13-19 (PROXY-06). HardStopModal mounts at the App
        root so the out-of-credits / rate-limited blocking overlay sits
        above every screen and modal layer. Mount is unconditional — the
        component itself reads useCreditsStore.hardStopActive and returns
        null when there's nothing to render, so we don't gate by auth /
        view / ai_backend_kind here (the credits store only emits
        hardStopActive when the cloud-proxy backend is active anyway).
      */}
      <HardStopModal />
      {/*
        Password-reset (recovery) prompt. Mounts when a reset link has landed a
        recovery session (passwordRecovery flag, set by the auth:password-recovery
        push). Gated on signed_in because the recovery exchange always leaves the
        user signed in; on success or dismissal the modal clears the flag. Highest
        modal z-index (1200) so it sits above AcceptToSModal et al.
      */}
      {passwordRecovery && authState.kind === 'signed_in' ? (
        <SetNewPasswordModal onClose={() => setPasswordRecovery(false)} />
      ) : null}
      {/*
        260728 — Sui's post-onboarding tour. Unconditional mount: the
        component returns null unless useTutorialStore.active. Sits above
        every modal (z 4000) because the games-popup step spotlights the open
        GamesPickerModal.
      */}
      <TutorialOverlay />
    </>
  );
}
