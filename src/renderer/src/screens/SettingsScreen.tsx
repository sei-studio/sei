/**
 * SettingsScreen — centered "Party" settings column (§4.7).
 *
 * Recomposed to the mockup rhythm: a 560px column of Oswald-headed groups,
 * each row a [label | optional value | control] line with hairline borders,
 * using the shared Seg / Toggle primitives. Every prior row + behavior is
 * preserved:
 *  - preferred_name ("Name") → on-blur saveConfig (commit on focus-leave).
 *  - API key → inline "Set/Update" reveals a password field; Save persists,
 *    re-checks hasApiKey(), collapses.
 *  - Provider change wipes the stored key (prior key is a different vendor's).
 *  - Backend Seg (Cloud / My key) opens SwitchBackendConfirmModal; selection
 *    reverts on cancel because the Seg value is derived from ai_backend_kind,
 *    which only changes after a confirmed proxyConfigure.
 *  - Theme Seg persists theme_mode (dark / light / system) via saveConfig.
 *  - Reset-all iterates the character list; resend-verification / export /
 *    update-check state machines unchanged; all modal opens unchanged.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §1 + §4.7.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { applyTheme, type ThemeMode } from '../lib/theme';
import {
  tokensRemainingToPlaytime,
  DEFAULT_TOKENS_PER_MIN,
  VISION_MULTIPLIER,
} from '../lib/playtimeEstimate';
import { Button } from '../components/Button';
import { Seg } from '../components/Seg';
import { Toggle } from '../components/Toggle';
import { TextField } from '../components/TextField';
import { SignOutConfirmModal } from '../components/SignOutConfirmModal';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { MigrateLocalCharsModal } from '../components/MigrateLocalCharsModal';
import { SwitchBackendConfirmModal } from '../components/SwitchBackendConfirmModal';
import { ResetAllMemoriesConfirmModal } from '../components/ResetAllMemoriesConfirmModal';
import { DmcaContactModal } from '../components/DmcaContactModal';
import { ProviderSelect, type Provider } from '../components/ProviderSelect';
import { PortraitImagePicker } from '../components/PortraitImagePicker';
import { InfoTip } from '../components/InfoTip';
import { CopyIcon } from '../components/icons';
import type { UserConfig } from '@shared/characterSchema';
import { CHAT_LANGUAGES, clampChatLanguage, type ChatLanguage } from '@shared/chatLanguage';
import type { WizardState } from '@shared/ipc';
import styles from './SettingsScreen.module.css';

const API_KEY_BULLET_LEN = 24;

export function SettingsScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  // ui-A7: developer-console toggle. Default OFF; SettingsScreen owns the
  // surface that flips it. Persisted via UserConfig.dev_console_visible so
  // a relaunch preserves the choice.
  const devConsoleVisible = useUiStore((s) => s.devConsoleVisible);
  const setDevConsoleVisible = useUiStore((s) => s.setDevConsoleVisible);
  // Appearance & feel: "Realistic typing" pacing toggle (default ON). Persisted
  // via UserConfig.realistic_typing; the chat store + bot read it for reading /
  // typing delays.
  const realisticTyping = useUiStore((s) => s.realisticTyping);
  const setRealisticTyping = useUiStore((s) => s.setRealisticTyping);
  // 260707: product-analytics opt-out. The toggle shows analytics ENABLED,
  // so its `on` state is the inverse of the opt-out flag.
  const analyticsOptOut = useUiStore((s) => s.analyticsOptOut);
  const setAnalyticsOptOut = useUiStore((s) => s.setAnalyticsOptOut);
  const callCaptions = useUiStore((s) => s.callCaptions);
  const callOverlayEnabled = useUiStore((s) => s.callOverlayEnabled);
  const convoStartersEnabled = useUiStore((s) => s.convoStartersEnabled);
  const setCallOverlayEnabled = useUiStore((s) => s.setCallOverlayEnabled);
  const setConvoStartersEnabled = useUiStore((s) => s.setConvoStartersEnabled);
  const setCallCaptions = useUiStore((s) => s.setCallCaptions);
  const authState = useAuthStore((s) => s.state);
  // "Is ANY bot running" — gates the live backend switch. Multi-summon: true
  // when one or more characters are connecting/online.
  const botRunning = useDataStore((s) =>
    Object.values(s.summons).some((st) => st.kind === 'connecting' || st.kind === 'online'),
  );
  // ui-A9: "Reset all character memories" iterates over the renderer's
  // character list. refreshCharacter pulls the post-reset row back into the
  // store so EditCharacterModal / CharacterPage observe last_launched=null
  // + playtime_ms=0 without a manual reload.
  const allCharacters = useDataStore((s) => s.characters);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);

  // Cloud AI toggle (PROXY-11 BYOK escape hatch). The Backend Seg drives the
  // ai_backend_kind between cloud-proxy and local; symmetric BYOK ↔ cloud per
  // CONTEXT D-57. Subscription cancel/manage lives on the Playtime screen →
  // "Manage billing" (Polar portal), not here.
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  // Cloud playtime estimate ("~Xh left"). Uses the same remaining_tokens source
  // as UsageBar / playtimeEstimate; continuous vision burns faster (D-07).
  const remainingTokens = useCreditsStore((s) => s.remaining_tokens);
  // WR-05 follow-up: flipping the backend mid-bot applies LIVE — main's
  // proxy.configure handler rebuilds the running utilityProcess's Anthropic SDK
  // in place. This notice is a positive confirmation that the swap reached the
  // running bot; it self-clears on the next bot lifecycle transition.
  const [switchNotice, setSwitchNotice] = useState<null | 'switched-to-cloud' | 'switched-to-local'>(
    null,
  );
  // Switching cloud ⇄ local is uncommon and consequential (it changes billing
  // and applies to a running bot immediately), so the Seg opens a confirmation
  // modal instead of toggling directly. Non-null = modal is open for that
  // target backend; cancelling leaves ai_backend_kind (and the Seg) untouched.
  const [pendingSwitch, setPendingSwitch] = useState<null | 'cloud-proxy' | 'local'>(null);
  useEffect(() => {
    if (!botRunning) setSwitchNotice(null);
  }, [botRunning]);
  const confirmSwitch = async (): Promise<void> => {
    const target = pendingSwitch;
    if (!target) return;
    await window.sei.proxyConfigure(target);
    // Refresh credits store so the icon rail (plan 13-17) reacts on next tick.
    await useCreditsStore.getState().refresh();
    if (botRunning) {
      setSwitchNotice(target === 'cloud-proxy' ? 'switched-to-cloud' : 'switched-to-local');
    }
    setPendingSwitch(null);
  };
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [hasKey, setHasKey] = useState<boolean>(false);
  // Phase 18/19 — the user's chat avatar (path ref '_user.png' or null), seeded
  // from sei.userGetProfile() on mount. PortraitImagePicker owns apply/remove
  // via the user-profile IPC overrides below.
  const [userPic, setUserPic] = useState<string | null>(null);
  // The user's 4-char public handle (profiles.handle) — shown as the Account ID
  // instead of the long Supabase UUID. Null until the profile loads / when offline.
  const [userHandle, setUserHandle] = useState<string | null>(null);
  // Updates section. appVersion is read once via getVersion(); updateStatus
  // reflects live updater events while the user is on this screen. The actual
  // update FLOW (changelog popup, download, restart) is owned by App.tsx's
  // UpdatePopup — this section only triggers a check + surfaces inline status.
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  >('idle');
  // "Advanced updates" channel. Off = stable only (the default); on = beta
  // (pre-releases included). Seeded from config on open; persisted + pushed to
  // the live updater on toggle. Local state, since only this screen reads it.
  const [advancedUpdates, setAdvancedUpdates] = useState<boolean>(false);

  // Inline edit buffers — typing only updates these; commit happens on blur.
  const [preferredDraft, setPreferredDraft] = useState<string>('');
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [keyDraft, setKeyDraft] = useState<string>('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Phase 10 (D-11) — Account panel state. Modals + transient action statuses.
  const [signOutModalOpen, setSignOutModalOpen] = useState<boolean>(false);
  // WR-10: capture the account email at modal-open time so the modal can
  // remain mounted across the SIGNED_OUT transition that fires mid-flow.
  const [deleteAccountState, setDeleteAccountState] = useState<{ email: string } | null>(null);
  // Plan 11-18 — re-open entry for the one-shot migration modal.
  const [migrateModalOpen, setMigrateModalOpen] = useState<boolean>(false);
  // Plan 12-14 — DMCA Designated Agent info modal. Visible to BOTH signed-in
  // and signed-out users since DMCA is a public-law surface (CONTEXT D-35a).
  const [dmcaModalOpen, setDmcaModalOpen] = useState<boolean>(false);
  const [resendStatus, setResendStatus] = useState<
    'idle' | 'sending' | 'sent' | 'rate-limited' | 'error'
  >('idle');
  const [exportStatus, setExportStatus] = useState<{ savedPath?: string; error?: string } | null>(
    null,
  );
  // 1.5s "Copied" flash for the Account ID copy affordance. Local UI only.
  const [uuidCopied, setUuidCopied] = useState<boolean>(false);
  // ui-A9: reset-all-memories progress state.
  const [resetAllModalOpen, setResetAllModalOpen] = useState<boolean>(false);
  const [resetAllProgress, setResetAllProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [resetAllDone, setResetAllDone] = useState<boolean>(false);
  const [resetAllError, setResetAllError] = useState<string | null>(null);

  const onResendVerification = async (): Promise<void> => {
    setResendStatus('sending');
    const res = await sei.resendVerification();
    if (res.ok) {
      setResendStatus('sent');
      window.setTimeout(() => setResendStatus('idle'), 4000);
    } else if (res.code === 'rate_limited') {
      setResendStatus('rate-limited');
      window.setTimeout(() => setResendStatus('idle'), 4000);
    } else {
      setResendStatus('error');
      window.setTimeout(() => setResendStatus('idle'), 4000);
    }
  };

  const onExport = async (): Promise<void> => {
    setExportStatus(null);
    const res = await sei.exportData();
    if (res.ok) {
      setExportStatus({ savedPath: res.savedPath });
    } else if (res.code !== 'cancelled') {
      setExportStatus({ error: "Couldn't prepare your export. Try again in a moment." });
    }
  };

  const accountEmail = authState.kind === 'signed_in' ? authState.user.email : '';
  const resendStatusText =
    resendStatus === 'sending'
      ? 'Sending…'
      : resendStatus === 'sent'
        ? `We sent a new verification link to ${accountEmail}.`
        : resendStatus === 'rate-limited'
          ? 'Hold on, wait a minute before requesting another link.'
          : resendStatus === 'error'
            ? "Couldn't resend. Try again in a moment."
            : '';

  useEffect(() => {
    void sei.getConfig().then((c) => {
      setCfg(c);
      setPreferredDraft(c.preferred_name ?? '');
      // ui-A7: seed devConsoleVisible from persisted config on Settings open.
      if (typeof c.dev_console_visible === 'boolean') {
        setDevConsoleVisible(c.dev_console_visible);
      }
      // Seed the advanced-updates channel toggle from persisted config.
      setAdvancedUpdates(c.advanced_updates === true);
    });
    void sei.hasApiKey().then((b) => setHasKey(b));
    // Seed the user's profile picture for the chat-avatar section below.
    void sei
      .userGetProfile()
      .then((p) => {
        setUserPic(p.profilePicture);
        setUserHandle(p.handle);
      })
      .catch(() => {
        /* non-fatal — section just shows the empty/NONE state */
      });
  }, [setDevConsoleVisible]);

  // Updates section: load the current version once, and subscribe to updater
  // events while this screen is mounted so the inline status line reflects an
  // in-flight manual check. onUpdateAvailable here just flips the status to
  // "available" — the changelog popup is App.tsx's job.
  useEffect(() => {
    void sei.getVersion().then(setAppVersion);
    const unsubs = [
      sei.onUpdateChecking(() => setUpdateStatus('checking')),
      sei.onUpdateNotAvailable(() => setUpdateStatus('up-to-date')),
      sei.onUpdateAvailable(() => setUpdateStatus('available')),
      sei.onUpdateError(() => setUpdateStatus('error')),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const persistConfig = async (next: UserConfig): Promise<void> => {
    try {
      await sei.saveConfig(next);
      setCfg(next);
      setSaveError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig failed', err);
      setSaveError('Failed to save. Try again.');
    }
  };

  const onPreferredBlur = (): void => {
    if (!cfg) return;
    if ((cfg.preferred_name ?? '') === preferredDraft) return;
    void persistConfig({ ...cfg, preferred_name: preferredDraft });
  };

  const onSaveKey = async (): Promise<void> => {
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      setKeyError('API key cannot be empty.');
      return;
    }
    try {
      await sei.saveApiKey(trimmed);
      const has = await sei.hasApiKey();
      setHasKey(has);
      setKeyDraft('');
      setEditingKey(false);
      setKeyError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveApiKey failed', err);
      setKeyError('Failed to save key. Try again.');
    }
  };

  const onCancelKey = (): void => {
    setKeyDraft('');
    setEditingKey(false);
    setKeyError(null);
  };

  // Theme Seg: dark / light / system. Every move writes straight through —
  // setThemeMode (App re-applies + wires the system listener), applyTheme for
  // an immediate paint, and saveConfig persists the mode.
  const onSelectTheme = async (mode: ThemeMode): Promise<void> => {
    if (mode === themeMode) return;
    setThemeMode(mode);
    applyTheme(mode);
    if (cfg) {
      const updated: UserConfig = { ...cfg, theme_mode: mode };
      try {
        await sei.saveConfig(updated);
        setCfg(updated);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[SettingsScreen] saveConfig (theme) failed', err);
      }
    }
  };

  const currentProvider: Provider = (cfg?.provider ?? 'anthropic') as Provider;

  // 260709: conversation language. Chat and voice calls pick the change up on
  // the next message/call; a companion already summoned in-game keeps its
  // session language until the next summon (same fork-time bridging as
  // vision_mode). Optimistic-then-rollback like the toggles above.
  const chatLanguage: ChatLanguage = clampChatLanguage(cfg?.chat_language);
  const onSelectLanguage = async (next: ChatLanguage): Promise<void> => {
    if (!cfg || next === chatLanguage) return;
    const updated: UserConfig = { ...cfg, chat_language: next };
    setCfg(updated);
    try {
      await sei.saveConfig(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (chat_language) failed', err);
      setCfg(cfg);
      setSaveError('Failed to save. Try again.');
    }
  };

  // ui-A1: provider tile click changes config.provider AND clears any existing
  // api key (the prior key is for a different vendor; reusing it would silently
  // 401 against the new baseURL). On clear we leave the editor open so the user
  // can paste the new vendor's key next.
  const onChangeProvider = async (next: Provider): Promise<void> => {
    if (!cfg) return;
    if (cfg.provider === next) return;
    try {
      await sei.saveConfig({ ...cfg, provider: next, provider_config: cfg.provider_config ?? {} });
      setCfg({ ...cfg, provider: next });
      try {
        await sei.saveApiKey('');
        setHasKey(false);
      } catch {
        // best-effort
      }
      setEditingKey(true);
      setKeyDraft('');
      setKeyError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (provider) failed', err);
      setSaveError('Failed to save provider. Try again.');
    }
  };

  // ui-A7: persist developer-console toggle. Update zustand FIRST so the UI
  // reacts immediately, then write through (roll back on failure).
  const onToggleDevConsole = async (next: boolean): Promise<void> => {
    setDevConsoleVisible(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, dev_console_visible: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (dev_console_visible) failed', err);
      setDevConsoleVisible(!next);
    }
  };

  // About: persist the "Advanced updates" channel toggle, then push it to the
  // live updater so it takes effect without a re-launch. Optimistic-then-
  // write-through, same as the dev-console toggle; setUpdateChannel(true) also
  // re-checks so a waiting beta surfaces right away.
  const onToggleAdvancedUpdates = async (next: boolean): Promise<void> => {
    setAdvancedUpdates(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, advanced_updates: next };
      await sei.saveConfig(updated);
      setCfg(updated);
      await sei.setUpdateChannel(next);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (advanced_updates) failed', err);
      setAdvancedUpdates(!next);
    }
  };

  // Appearance & feel: persist the "Realistic typing" pacing toggle. Same
  // optimistic-then-write-through pattern as the dev-console toggle.
  const onToggleRealisticTyping = async (next: boolean): Promise<void> => {
    setRealisticTyping(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, realistic_typing: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (realistic_typing) failed', err);
      setRealisticTyping(!next);
    }
  };

  // 260707: persist the analytics opt-out via its dedicated IPC (which also
  // applies it to the live analytics client), NOT saveConfig — so it never
  // clobbers a concurrent config write. `enabled` is the toggle state
  // (analytics ON); opt-out is the inverse.
  const onToggleAnalytics = async (enabled: boolean): Promise<void> => {
    setAnalyticsOptOut(!enabled);
    try {
      await sei.setAnalyticsOptOut(!enabled);
      if (cfg) setCfg({ ...cfg, analytics_opt_out: !enabled });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] setAnalyticsOptOut failed', err);
      setAnalyticsOptOut(enabled); // rollback
    }
  };

  // Appearance & feel: live captions on the voice-call screen (default OFF).
  // Same optimistic-then-write-through pattern as the toggles above.
  const onToggleCallCaptions = async (): Promise<void> => {
    const next = !callCaptions;
    setCallCaptions(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, call_captions: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (call_captions) failed', err);
      setCallCaptions(!next);
    }
  };

  // Appearance & feel: always-on-top call overlay (default OFF). The overlay
  // window itself is spawned/torn down by the pusher in App.tsx off this flag.
  const onToggleCallOverlay = async (): Promise<void> => {
    const next = !callOverlayEnabled;
    setCallOverlayEnabled(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, call_overlay_enabled: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (call_overlay_enabled) failed', err);
      setCallOverlayEnabled(!next);
    }
  };

  // Conversation starters (260707, default ON): during a quiet stretch on a
  // live call, a companion may bring up a topic on its own.
  const onToggleConvoStarters = async (): Promise<void> => {
    const next = !convoStartersEnabled;
    setConvoStartersEnabled(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, call_convo_starters: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (call_convo_starters) failed', err);
      setConvoStartersEnabled(!next);
    }
  };

  // Write through vision_mode to UserConfig (the config is the source of truth;
  // botSupervisor bridges it into config.vision at fork). Mirrors the toggle
  // optimistic-then-rollback discipline. Always editable — not gated on a live
  // bot session (changes apply at the next summon).
  const writeVisionConfig = async (patch: Partial<UserConfig>): Promise<void> => {
    if (!cfg) return;
    const updated: UserConfig = { ...cfg, ...patch };
    setCfg(updated);
    try {
      await sei.saveConfig(updated);
      setSaveError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (vision) failed', err);
      setCfg(cfg);
      setSaveError('Failed to save. Try again.');
    }
  };

  const onSelectVisionMode = (mode: 'off' | 'on-demand' | 'continuous'): void => {
    if (mode === (cfg?.vision_mode ?? 'on-demand')) return;
    void writeVisionConfig({ vision_mode: mode });
  };

  // ui-A9: "Reset all character memories" — open the confirm popup. The actual
  // wipe runs in runResetAllMemories once the user confirms.
  const onResetAllMemoriesClick = (): void => {
    setResetAllError(null);
    setResetAllDone(false);
    setResetAllModalOpen(true);
  };

  const runResetAllMemories = async (): Promise<void> => {
    const snapshot = allCharacters.slice();
    setResetAllModalOpen(false);
    setResetAllProgress({ done: 0, total: snapshot.length });
    setResetAllError(null);
    setResetAllDone(false);
    let firstError: string | null = null;
    for (let i = 0; i < snapshot.length; i += 1) {
      const c = snapshot[i];
      try {
        await sei.resetMemory(c.id);
        // Chat transcript lives in the wiped memory dir — evict the cache.
        useChatStore.getState().evictLocal(c.id);
        await refreshCharacter(c.id);
      } catch (err) {
        if (firstError === null) {
          firstError = err instanceof Error ? err.message : 'Failed to reset some memories.';
        }
      }
      setResetAllProgress({ done: i + 1, total: snapshot.length });
    }
    setResetAllProgress(null);
    if (firstError) setResetAllError(firstError);
    else {
      setResetAllDone(true);
      window.setTimeout(() => setResetAllDone(false), 2000);
    }
  };

  const isCloud = aiBackendKind === 'cloud-proxy';
  const backendSegValue: 'cloud' | 'mykey' = isCloud ? 'cloud' : 'mykey';
  const visionMode = cfg?.vision_mode ?? 'on-demand';
  const playtimeRate =
    visionMode === 'continuous' ? DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER : DEFAULT_TOKENS_PER_MIN;
  const playtimeDisplay = tokensRemainingToPlaytime(remainingTokens, playtimeRate).display;

  // Version value: "v{x}" alone, or "v{x} · <status>" after a check.
  const versionSuffix =
    updateStatus === 'checking'
      ? ' · checking…'
      : updateStatus === 'up-to-date'
        ? ' · up to date'
        : updateStatus === 'available'
          ? ' · update available'
          : updateStatus === 'error'
            ? ' · check failed'
            : '';
  const versionValue = appVersion ? `v${appVersion}${versionSuffix}` : '–';

  const resetAllLabel = resetAllDone
    ? 'All memories reset'
    : resetAllProgress
      ? `Resetting ${resetAllProgress.done} of ${resetAllProgress.total}…`
      : 'Reset all memories…';

  return (
    <div className={styles.root}>
      <div className={styles.col}>
        {saveError ? <div className={styles.errorRow}>{saveError}</div> : null}

        {/* ── Profile ─────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Profile</h3>
          <div className={styles.profileRow} onBlur={onPreferredBlur}>
            <PortraitImagePicker
              variant="avatar"
              value={userPic}
              onChange={setUserPic}
              applyOverride={(a) => sei.userApplyProfilePicture(a)}
              removeOverride={() => sei.userRemoveProfilePicture()}
            />
            <span className={styles.profileName}>
              <TextField
                value={preferredDraft}
                onChange={setPreferredDraft}
                placeholder="Your name"
                aria-label="Name"
              />
            </span>
          </div>
        </div>

        {/* ── Account (signed-in only) ────────────────────────── */}
        {authState.kind === 'signed_in' ? (
          <div className={styles.group}>
            <h3 className={styles.groupTitle}>Account</h3>

            <div className={styles.row}>
              <span className={styles.label}>Email</span>
              <span className={styles.monoValue}>{authState.user.email}</span>
              <Button kind="ghost" size="sm" onClick={() => setSignOutModalOpen(true)}>
                Sign out
              </Button>
            </div>
            {resendStatus !== 'idle' ? (
              <p className={styles.helper}>{resendStatusText}</p>
            ) : null}
            {!authState.user.emailVerified ? (
              <div className={styles.row}>
                <span className={styles.label}>Verify email</span>
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() => void onResendVerification()}
                  disabled={resendStatus === 'sending'}
                >
                  Resend verification
                </Button>
              </div>
            ) : null}

            {/* Playtime — cloud users only. Estimate from the same source as
                UsageBar; Add routes to the Playtime (credits) screen. */}
            {isCloud ? (
              <div className={styles.row}>
                <span className={styles.label}>Playtime</span>
                <span className={styles.value}>{playtimeDisplay}</span>
                <Button kind="primary" size="sm" onClick={() => navigate({ kind: 'credits' })}>
                  Add
                </Button>
              </div>
            ) : null}

            {/* Account ID — the short 4-char public handle (profiles.handle) for
                support workflows, not the long Supabase UUID. Falls back to the
                UUID only until the profile loads (or if no handle is assigned). */}
            <div className={styles.row}>
              <span className={styles.label}>Account ID</span>
              <span className={styles.idValue}>
                <span className={styles.monoValue}>{userHandle ?? authState.user.id}</span>
                <button
                  type="button"
                  className={styles.copyBtn}
                  aria-label="Copy account ID"
                  data-tip={uuidCopied ? 'Copied' : 'Copy'}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(userHandle ?? authState.user.id)
                      .then(() => {
                        setUuidCopied(true);
                        window.setTimeout(() => setUuidCopied(false), 1500);
                      })
                      .catch(() => {
                        setUuidCopied(false);
                      });
                  }}
                >
                  <CopyIcon size={15} />
                </button>
              </span>
            </div>

            {/* 260706: full questionnaire retake (age feel / what you're
                looking for / art style), prefilled, returning here. */}
            <div className={styles.row}>
              <span className={styles.label}>Companion preferences</span>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => navigate({ kind: 'profile-questions', next: 'settings', mode: 'all' })}
              >
                Update my preferences
              </Button>
            </div>

            <div className={styles.row}>
              <span className={styles.label}>Migrate local companions</span>
              <Button kind="ghost" size="sm" onClick={() => setMigrateModalOpen(true)}>
                Migrate
              </Button>
            </div>

            <div className={styles.row}>
              <span className={styles.label}>Export data</span>
              <Button kind="ghost" size="sm" onClick={() => void onExport()}>
                Export as JSON
              </Button>
            </div>
            {exportStatus?.savedPath ? (
              <p className={styles.helper}>Saved to {exportStatus.savedPath}</p>
            ) : null}
            {exportStatus?.error ? (
              <p className={`${styles.helper} ${styles.helperError}`}>{exportStatus.error}</p>
            ) : null}
          </div>
        ) : null}

        {/* ── AI ──────────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>AI</h3>

          {/* Conversation language (260709): what companions speak in chat, on
              calls, and in game. Not the app UI language. Chat and calls apply
              it immediately; an in-game companion picks it up at next summon. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Chat language
              <InfoTip
                label="About chat language"
                text="The language your companions speak and understand, in chat, on voice calls, and in game. The app itself stays in English. A companion already in your world switches on its next summon."
              />
            </span>
            <Seg
              aria-label="Chat language"
              value={chatLanguage}
              options={CHAT_LANGUAGES.map((l) => ({ value: l.code, label: l.native }))}
              onChange={(v) => void onSelectLanguage(v)}
            />
          </div>

          {/* Backend switch — signed-in only (main rejects cloud-proxy for
              signed-out callers; a signed-out user is always local). Selecting
              the other option opens the confirm modal; the Seg value tracks
              ai_backend_kind, so cancelling reverts the selection. */}
          {authState.kind === 'signed_in' ? (
            <div className={styles.row}>
              <span className={styles.label}>
                Backend
                <InfoTip
                  label="About the AI backend"
                  text={
                    isCloud
                      ? 'Switching to your own API key turns off managed billing and routes Sei through the key stored on this device. Your subscription keeps renewing until you cancel it.'
                      : 'Cloud turns off your local API key and routes Sei through our managed cloud. Switch back any time.'
                  }
                />
              </span>
              <Seg
                aria-label="AI backend"
                value={backendSegValue}
                options={[
                  { value: 'cloud', label: 'Cloud' },
                  { value: 'mykey', label: 'My key' },
                ]}
                onChange={(v) => {
                  const target = v === 'cloud' ? 'cloud-proxy' : 'local';
                  if (target !== aiBackendKind) setPendingSwitch(target);
                }}
              />
            </div>
          ) : null}
          {switchNotice !== null ? (
            <p className={styles.helper} role="status">
              {switchNotice === 'switched-to-cloud'
                ? 'Switched. Your running bot now routes through Sei’s managed cloud.'
                : 'Switched. Your running bot now uses your own API key.'}
            </p>
          ) : null}

          {/* Provider + API key — local (BYOK) mode only. */}
          {aiBackendKind === 'local' ? (
            <>
              <div className={styles.row}>
                <span className={styles.label}>Provider</span>
                <ProviderSelect
                  value={currentProvider}
                  onChange={(p) => void onChangeProvider(p)}
                  compact
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label}>API key</span>
                {editingKey ? (
                  <span className={styles.editor}>
                    <TextField
                      value={keyDraft}
                      onChange={setKeyDraft}
                      type="password"
                      placeholder="sk-…"
                      autoFocus
                      onEnter={() => void onSaveKey()}
                      aria-label="API key"
                    />
                    <Button kind="primary" size="sm" onClick={() => void onSaveKey()}>
                      Save
                    </Button>
                    <Button kind="quiet" size="sm" onClick={onCancelKey}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <>
                    <span className={styles.monoValue}>
                      {hasKey ? '•'.repeat(API_KEY_BULLET_LEN) : 'Not set'}
                    </span>
                    <Button kind="ghost" size="sm" onClick={() => setEditingKey(true)}>
                      {hasKey ? 'Update' : 'Set'}
                    </Button>
                  </>
                )}
              </div>
              {keyError ? <div className={styles.errorRow}>{keyError}</div> : null}
            </>
          ) : null}
        </div>

        {/* ── Minecraft ───────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Minecraft</h3>
          <SkinSetupRow />
          {/* Looking (vision): Off / On-demand / Continuous. Every move writes
              straight through. Continuous uses more playtime, surfaced as the
              shrunk "~Xh left" on the Playtime screen (D-07), never a number
              here. The mode explanation lives behind the (i) tip. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Visual gameplay
              <InfoTip
                label="About visual gameplay"
                text="Companions usually play from lightweight snapshots of the world, but can pull a full render of what's around them when they need to see it, for example when building or navigating."
              />
            </span>
            <Seg
              aria-label="Visual gameplay mode"
              value={visionMode}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on-demand', label: 'On-demand' },
                { value: 'continuous', label: 'Continuous' },
              ]}
              onChange={onSelectVisionMode}
            />
          </div>
        </div>

        {/* ── Appearance ──────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Appearance</h3>
          <div className={styles.row}>
            <span className={styles.label}>Theme</span>
            <Seg
              aria-label="Theme"
              value={themeMode}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'system', label: 'System' },
              ]}
              onChange={(m) => void onSelectTheme(m)}
            />
          </div>
          {/* Appearance & feel: "Realistic typing" pacing. On by default. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Realistic typing
              <InfoTip
                label="About realistic typing"
                text="Pauses to read your message, then paces typing to a human speed, in chat and in-game. Off replies instantly."
              />
            </span>
            <Toggle
              aria-label="Realistic typing"
              on={realisticTyping}
              onChange={(v) => void onToggleRealisticTyping(v)}
            />
          </div>
          {/* ui-A7: developer console toggle. Off by default — App.tsx gates
              <LogsBar /> on this flag. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Developer console
              <InfoTip
                label="About the developer console"
                text="Useful for debugging skin and bot issues."
              />
            </span>
            <Toggle
              aria-label="Show developer console"
              on={devConsoleVisible}
              onChange={(v) => void onToggleDevConsole(v)}
            />
          </div>
          {/* 260707: product-analytics opt-out. On by default; toggling off
              stops all analytics immediately. See privacy.html. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Usage analytics
              <InfoTip
                label="About usage analytics"
                text="Shares anonymous usage data (feature counts, versions, errors) to help improve Sei. Never your chats, characters, or personal info. Turn off any time."
              />
            </span>
            <Toggle
              aria-label="Usage analytics"
              on={!analyticsOptOut}
              onChange={(v) => void onToggleAnalytics(v)}
            />
          </div>
          {/* Call captions (260705): live subtitle lines on the voice-call
              screen. Off by default. Calls read as audio, not subtitles. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Call captions
              <InfoTip
                label="About call captions"
                text="Shows live captions during voice calls: what the companion said and what Sei heard you say."
              />
            </span>
            <Toggle
              aria-label="Call captions"
              on={callCaptions}
              onChange={() => void onToggleCallCaptions()}
            />
          </div>
          {/* Call overlay (260706): always-on-top companion circles pinned to the
              bottom-right during a call, lit while speaking. Off by default. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Call overlay
              <InfoTip
                label="About the call overlay"
                text="During a voice call, floats your companions' avatars on top of every app in the bottom-right corner, lit while they speak. Good for streaming."
              />
            </span>
            <Toggle
              aria-label="Call overlay"
              on={callOverlayEnabled}
              onChange={() => void onToggleCallOverlay()}
            />
          </div>
          {/* Conversation starters (260707): on a quiet call, a companion may
              bring up a topic on its own. On by default. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Conversation starters
              <InfoTip
                label="About conversation starters"
                text="When a voice call goes quiet for a bit, your companion can bring up a topic on their own instead of waiting for you to speak."
              />
            </span>
            <Toggle
              aria-label="Conversation starters"
              on={convoStartersEnabled}
              onChange={() => void onToggleConvoStarters()}
            />
          </div>
        </div>

        {/* ── About ───────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>About</h3>
          <div className={styles.row}>
            <span className={styles.label}>Version</span>
            <span className={styles.value}>{versionValue}</span>
            <Button
              kind="ghost"
              size="sm"
              disabled={updateStatus === 'checking'}
              onClick={() => {
                setUpdateStatus('checking');
                void sei.checkForUpdates();
              }}
            >
              Check now
            </Button>
          </div>
          {/* Advanced updates: opt into the beta channel. Off by default so a
              normal user is never moved onto a pre-release build. */}
          <div className={styles.row}>
            <span className={styles.label}>
              Advanced updates
              <InfoTip
                label="About advanced updates"
                text="Get beta releases early, before they roll out to everyone. Betas are less tested and may have rough edges. Leave this off for the stable version."
              />
            </span>
            <Toggle
              aria-label="Advanced updates"
              on={advancedUpdates}
              onChange={(v) => void onToggleAdvancedUpdates(v)}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Terms of Service</span>
            <Button
              kind="ghost"
              size="sm"
              onClick={() => void sei.openExternal('https://sei.gg/terms.html')}
            >
              Open
            </Button>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Privacy Policy</span>
            <Button
              kind="ghost"
              size="sm"
              onClick={() => void sei.openExternal('https://sei.gg/privacy.html')}
            >
              Open
            </Button>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Report copyright infringement (DMCA)</span>
            <Button kind="ghost" size="sm" onClick={() => setDmcaModalOpen(true)}>
              Open
            </Button>
          </div>
        </div>

        {/* ── Danger ──────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Danger</h3>
          <div className={styles.row}>
            <span className={styles.label}>Reset all companion memories</span>
            <Button
              kind="danger"
              size="sm"
              disabled={resetAllProgress !== null || allCharacters.length === 0}
              onClick={onResetAllMemoriesClick}
            >
              {resetAllLabel}
            </Button>
          </div>
          <p className={styles.helper}>
            Wipes saved chat history and playtime for every companion on this device. Persona,
            portrait, and skin are kept.
          </p>
          {resetAllError ? (
            <p className={`${styles.helper} ${styles.helperError}`} role="alert">
              {resetAllError}
            </p>
          ) : null}
          {authState.kind === 'signed_in' ? (
            <>
              <div className={styles.row}>
                <span className={styles.label}>Delete account</span>
                <Button
                  kind="danger"
                  size="sm"
                  onClick={() => {
                    if (authState.kind === 'signed_in') {
                      setDeleteAccountState({ email: authState.user.email });
                    }
                  }}
                >
                  Delete account…
                </Button>
              </div>
              <p className={styles.helper}>
                Permanently deletes your cloud data within 30 days. Local files stay.
              </p>
            </>
          ) : null}
        </div>
      </div>

      {signOutModalOpen ? (
        <SignOutConfirmModal
          botRunning={botRunning}
          onCancel={() => setSignOutModalOpen(false)}
          onConfirm={async () => {
            await sei.signOut();
            setSignOutModalOpen(false);
          }}
        />
      ) : null}
      {/*
        WR-10: gated only on the captured deleteAccountState, NOT authState.kind.
        Once the modal opens we hold the email locally so the modal can render
        its 1200ms "Account scheduled for deletion. Signing you out…" state even
        after supabase.auth.signOut() flips authState.kind to 'local'.
      */}
      {deleteAccountState ? (
        <DeleteAccountModal
          accountEmail={deleteAccountState.email}
          onCancel={() => setDeleteAccountState(null)}
          onConfirmed={() => setDeleteAccountState(null)}
        />
      ) : null}
      {migrateModalOpen ? (
        <MigrateLocalCharsModal onClose={() => setMigrateModalOpen(false)} />
      ) : null}
      {pendingSwitch ? (
        <SwitchBackendConfirmModal
          direction={pendingSwitch}
          onCancel={() => setPendingSwitch(null)}
          onConfirm={confirmSwitch}
        />
      ) : null}
      {resetAllModalOpen ? (
        <ResetAllMemoriesConfirmModal
          characterCount={allCharacters.length}
          onCancel={() => setResetAllModalOpen(false)}
          onConfirm={runResetAllMemories}
        />
      ) : null}
      {dmcaModalOpen ? <DmcaContactModal onClose={() => setDmcaModalOpen(false)} /> : null}
    </div>
  );
}

/**
 * SkinSetupRow — Minecraft skin setup wizard status row.
 *
 * "Run setup" / "Re-run setup" opens SetupWizardModal in re-entry mode. The
 * pill state (enabled-install count) refreshes whenever the wizard closes.
 */
function SkinSetupRow(): React.ReactElement {
  const openWizard = useWizardStore((s) => s.openWizard);
  // Re-read the persisted wizard state whenever the wizard CLOSES so a
  // completed "Re-run setup" flips the label without reopening Settings.
  const wizardOpen = useWizardStore((s) => s.open);
  const [state, setState] = useState<WizardState | null>(null);

  useEffect(() => {
    // Skip while the wizard is open — the fetch would race its in-flight
    // install. The effect re-runs when wizardOpen flips back to false.
    if (wizardOpen) return;
    let cancelled = false;
    void sei.getWizardState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [wizardOpen]);

  const enabledCount = state?.enabledInstallIds.length ?? 0;

  return (
    <div className={styles.row}>
      <span className={styles.label}>
        Custom skins
        <InfoTip
          label="About custom skins"
          text="Give your companion a Minecraft skin so it looks right in your world. This runs a quick one-time setup for your Minecraft install."
        />
      </span>
      <Button kind="ghost" size="sm" onClick={() => openWizard(true)}>
        {enabledCount > 0 ? 'Re-run setup' : 'Run setup'}
      </Button>
    </div>
  );
}
