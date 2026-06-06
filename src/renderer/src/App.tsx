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
 * Source: CONTEXT.md D-15/D-17/D-33/D-35, UI-SPEC.md §Animation Tokens
 *         (LoadingScreen 1.6s floor) + §Interaction Contracts → Theme toggle +
 *         §Summon flow (toast on summon).
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from './lib/ipcClient';
import { applyTheme, subscribeSystemTheme, type ThemeMode } from './lib/theme';
import { useUiStore } from './lib/stores/useUiStore';
import { useDataStore, subscribeIpc } from './lib/stores/useDataStore';
import { MacosWindow } from './components/MacosWindow';
import { IconRail } from './components/IconRail';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { CharactersScreen } from './screens/CharactersScreen';
import { AddCharacterScreen } from './screens/AddCharacterScreen';
import { ComingSoonScreen } from './screens/ComingSoonScreen';
import { CharacterPage } from './screens/CharacterPage';
import { SettingsScreen } from './screens/SettingsScreen';
import { CreditsScreen } from './screens/CreditsScreen';
import { ReceiptScreen } from './screens/ReceiptScreen';
import { LanModal } from './components/LanModal';
import { SkinSetupPromptModal } from './components/SkinSetupPromptModal';
import { SetupWizardModal } from './components/SetupWizardModal';
import { LogsBar } from './components/LogsBar';
import { SummonToast } from './components/SummonToast';
import { UpdatePopup, type UpdatePopupState } from './components/UpdatePopup';
import { Banner } from './components/Banner';
import { ERROR_COPY } from './lib/errors';
import { useWizardStore } from './lib/stores/useWizardStore';
import * as authStore from './lib/stores/useAuthStore';
const { useAuthStore } = authStore;
import { useSyncStore } from './lib/stores/useSyncStore';
import { useCreditsStore } from './lib/stores/useCreditsStore';
import { useCloudCharactersStore } from './lib/stores/useCloudCharactersStore';
import { useLibraryStateStore } from './lib/stores/useLibraryStateStore';
import { AuthChoiceScreen } from './screens/AuthChoiceScreen';
import { AcceptToSModal } from './components/AcceptToSModal';
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
  // Password-recovery prompt: set true by the auth:password-recovery push when a
  // reset link lands a recovery session; drives the SetNewPasswordModal overlay.
  const passwordRecovery = useAuthStore((s) => s.passwordRecovery);
  const setPasswordRecovery = useAuthStore((s) => s.setPasswordRecovery);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const modal = useUiStore((s) => s.modal);
  const summon = useDataStore((s) => s.summon);
  const characters = useDataStore((s) => s.characters);
  const openWizard = useWizardStore((s) => s.openWizard);
  const [toast, setToast] = useState<{ id: string; name: string } | null>(null);
  const [lastToastedSummonId, setLastToastedSummonId] = useState<string | null>(null);
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
  //    DIFFERENT account keeps the previous account's remaining_pct, plan,
  //    trial_claimed, and ai_backend_kind until either (a) a proxy call
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
      if (currentUserId !== null) {
        void useCreditsStore.getState().init();
      }
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
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // ── Per-profile scope change (260603): re-bootstrap onto the new account. ──
  //    Main pushes app:scope-changed AFTER it has torn down the bot, switched
  //    the local data scope, and seeded the new profile. We reload the new
  //    profile's config + characters and re-route:
  //      • sign-out (account → local) → AuthChoice (the sign-in chooser), so a
  //        user signing out can re-auth as someone else (fix 260605);
  //      • otherwise a profile with no mc_username is treated as a fresh install
  //        → onboarding (the signed-in onboarding flow only asks MC username +
  //        preferred name); a profile with an mc_username → home.
  //    This is what makes switching accounts "start fresh like a new install".
  //    Credits/cloud-id stores reset via their own authState-keyed effects
  //    above; this handles the local-file-backed stores + routing.
  useEffect(() => {
    return sei.onScopeChanged((ev) => {
      void (async () => {
        // Onboarding completion is keyed on preferred_name (the "Name" field);
        // the Minecraft-username step was retired from the GUI (260605).
        let onboardedName = '';
        try {
          const cfg = await sei.getConfig();
          onboardedName = (cfg.preferred_name ?? '').trim();
          // Default to the dark "Summoning Terminal" theme on fresh installs
        // (no persisted theme_mode); users can still pick light / system.
        const mode = (cfg.theme_mode ?? 'dark') as ThemeMode;
          setThemeMode(mode);
          applyTheme(mode);
          useUiStore.getState().setDevConsoleVisible(!!cfg.dev_console_visible);
        } catch {
          // Fall through with empty onboardedName → onboarding (fresh profile).
        }
        // Replace the previous profile's character list + library state.
        try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
        try { await useLibraryStateStore.getState().refresh(); } catch { /* no hidden defaults */ }
        // Sign-out (account → local): return to the sign-in chooser, NOT
        // onboarding. After signing out the user may want to authenticate as a
        // different account, so the next screen must be AuthChoice (email /
        // Google / continue-locally). Routing straight to onboarding here —
        // which this handler does for a local scope with no mc_username — would
        // skip the chooser and force the local-only MC-username → API-key flow
        // on someone who only meant to re-auth. AuthChoice's "Continue locally"
        // still reaches the local path (→ home if an API key is saved, else
        // onboarding). This handler wins the navigation race against the
        // authState push because app:scope-changed is emitted after the async
        // scope teardown, so the sign-out routing must live here. (Fix 260605.)
        if (ev.reason === 'sign-out') { navigate({ kind: 'auth-choice' }); return; }
        // Onboarded account → straight home. Reset the Home/World tab first
        // (item 1) so a scope-change sign-in never lands on the World tab.
        if (onboardedName) { useUiStore.getState().setHomeTab('home'); navigate({ kind: 'home' }); return; }
        // Fresh account. On FIRST sign-in only (never account→account), offer to
        // import the anonymous local profile's companion if there's anything to
        // bring across; the modal routes onward. Otherwise → onboarding.
        if (ev.reason === 'sign-in') {
          try {
            const peek = await sei.profilePeekLocal();
            if (peek.hasData) { setImportOffer(peek); return; }
          } catch { /* fall through to onboarding */ }
        }
        navigate({ kind: 'onboarding', isReonboard: false });
      })();
    });
  }, [navigate, setThemeMode]);

  // Resolve the import-offer modal: re-read config (the import may have copied
  // preferred_name across) + reload characters, then route home-or-onboarding.
  async function handleImportOfferDone(_didImport: boolean): Promise<void> {
    setImportOffer(null);
    let onboardedName = '';
    try { onboardedName = ((await sei.getConfig()).preferred_name ?? '').trim(); } catch { /* onboarding */ }
    try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
    navigate(onboardedName ? { kind: 'home' } : { kind: 'onboarding', isReonboard: false });
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
      // Load persisted config + theme
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        onboardedName = (cfg.preferred_name ?? '').trim();
        // Default to the dark "Summoning Terminal" theme on fresh installs
        // (no persisted theme_mode); users can still pick light / system.
        const mode = (cfg.theme_mode ?? 'dark') as ThemeMode;
        setThemeMode(mode);
        applyTheme(mode);
        // ui-A7: seed the developer-console visibility from persisted config
        // BEFORE the first render of any view that mounts LogsBar — the
        // gate below reads useUiStore.devConsoleVisible directly.
        if (typeof cfg.dev_console_visible === 'boolean') {
          useUiStore.getState().setDevConsoleVisible(cfg.dev_console_visible);
        }
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
        // preferred_name in its profile) is a fresh account → onboarding;
        // otherwise home.
        navigate(onboardedName ? { kind: 'home' } : { kind: 'onboarding', isReonboard: false });
      } else {
        navigate({ kind: 'auth-choice' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, setThemeMode]);

  // ── First-launch skin-setup wizard trigger ─────────────────────────────
  // Auto-open SetupWizardModal when:
  //   1. The user has finished onboarding (hasApiKey === true) — don't pop
  //      the wizard during API-key entry,
  //   2. wizardState.hasRunOnce === false — first launch, not dismissed before,
  //   3. At least one Minecraft install is detected — no "We couldn't find
  //      Minecraft" pop-up on every launch for users without MC.
  // Re-running from Settings is handled by SettingsScreen's SkinSetupRow.
  useEffect(() => {
    // Only consider auto-opening once the user has actually landed on home —
    // before that, hasApiKey may still be false (mid-onboarding) and the
    // effect would no-op. Re-running on view change covers the
    // onboarding → home transition.
    if (view.kind !== 'home') return;
    let cancelled = false;
    (async () => {
      const hasKey = await sei.hasApiKey();
      if (!hasKey || cancelled) return;
      const state = await sei.getWizardState();
      if (cancelled) return;
      if (state.hasRunOnce) return;
      openWizard(false);
    })().catch(() => {
      // Silent — wizard not opening is non-fatal; user can always re-run from Settings.
    });
    return () => {
      cancelled = true;
    };
  }, [openWizard, view.kind]);

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

  // ── Auth-state transitions driven by the Supabase auth-event push
  //    (initAuthState → onAuthState). We don't await any IPC ourselves.
  //
  //    Upward (local → signed_in): land on home from auth-choice/loading.
  //    Downward (signed_in → local): BL-04 fix — sign-out from Settings or a
  //    successful delete-account flips authState to 'local' but the user was
  //    parked on the Settings view, whose Account panel is now hidden,
  //    leaving them stranded. Route them back to AuthChoice so the next step
  //    (re-sign-in, or proceed as local) is reachable.
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
    // Item 1 — on any fresh sign-in, snap the Home/World tab back to Home. A
    // user who was browsing the World tab while signed out (homeTab='world')
    // would otherwise stay on World after authenticating, because homeTab
    // persists across the auth transition. Only fire on the actual upward edge
    // (prev was a non-signed_in kind), never on initial mount.
    if (authState.kind === 'signed_in' && prev !== null && prev !== 'signed_in') {
      setHomeTab('home');
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
      navigate({ kind: 'auth-choice' });
    }
    prevAuthKindRef.current = authState.kind;
  }, [authState, view.kind, navigate, setHomeTab]);

  // B5: LoadingScreen is gone — the renderer routes directly to the initial
  // view in the bootstrap effect above. The 'loading' view variant is a
  // transient state before that effect resolves; render nothing for a frame
  // rather than mounting the prior boot pulse.
  if (view.kind === 'loading') return <></>;

  return (
    <>
      <MacosWindow>
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
              message="Verify your email to publish characters or buy credits. Check your inbox for a link from Sei."
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
            {view.kind !== 'onboarding' && view.kind !== 'auth-choice' ? <IconRail /> : null}
            {/*
              Right-side column stacks the active screen and the LogsBar.
              Wrapping the LogsBar inside this column (rather than as a
              sibling of the IconRail+main row) keeps the IconRail at full
              window height when the LogsBar expands — the expansion takes
              from the main content area, not from the rail.
            */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
              <main style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
                {view.kind === 'auth-choice' && (
                  <AuthChoiceScreen
                    onChooseLocal={() => {
                      // Pitfall A8: api_key.bin OK → home (already onboarded);
                      // else onboarding step 0.
                      sei.hasApiKey()
                        .then((hasKey) => {
                          if (hasKey) navigate({ kind: 'home' });
                          else navigate({ kind: 'onboarding', isReonboard: false });
                        })
                        .catch(() => navigate({ kind: 'onboarding', isReonboard: false }));
                    }}
                  />
                )}
                {view.kind === 'onboarding' && (
                  <OnboardingScreen
                    isReonboard={view.isReonboard}
                    signedIn={authState.kind === 'signed_in'}
                  />
                )}
                {view.kind === 'home' && <CharactersScreen />}
                {view.kind === 'add-character' && <AddCharacterScreen />}
                {view.kind === 'character' && <CharacterPage id={view.id} />}
                {view.kind === 'settings' && <SettingsScreen />}
                {view.kind === 'credits' && <CreditsScreen />}
                {view.kind === 'receipt' && <ReceiptScreen />}
                {view.kind === 'coming-soon' && <ComingSoonScreen />}
              </main>
              {/*
                LogsBar — quick task 260508-mun item 5. Hidden during
                onboarding and auth-choice (pre-app surfaces).
                ui-A7: ALSO hidden unless the user has explicitly flipped
                the Settings → Show developer console toggle.
              */}
              {devConsoleVisible &&
              view.kind !== 'onboarding' &&
              view.kind !== 'auth-choice' ? (
                <LogsBar />
              ) : null}
            </div>
          </div>
        </div>
      </MacosWindow>
      {modal?.kind === 'lan' ? <LanModal mode={modal.mode} /> : null}
      {modal?.kind === 'skin-setup-prompt' ? (
        <SkinSetupPromptModal characterId={modal.characterId} />
      ) : null}
      <SetupWizardModal />
      {toast ? (
        <SummonToast
          characterId={toast.id}
          characterName={toast.name}
          onDone={() => setToast(null)}
        />
      ) : null}
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
      {/*
        Phase 11 D-26 — BLOCKING ToS+Privacy acceptance modal. Mounts as the
        LAST modal layer so it overlays every other modal/toast at the same
        z-index when the user is signed in without a current-version
        tos_acceptance row (catch-all for Phase 10 alpha accounts, Google OAuth
        first-time users that bypassed the signup checkbox, and any user signed
        in before a TOS_VERSION bump). On accept, refreshTosStatus() flips
        tosAccepted → true and this conditional unmounts.
      */}
      {authState.kind === 'signed_in' && tosAccepted === false ? (
        <AcceptToSModal onAccepted={() => { void refreshTosStatus(); }} />
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
    </>
  );
}
