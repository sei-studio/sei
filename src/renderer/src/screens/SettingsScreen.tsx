/**
 * SettingsScreen — centered "Party" settings column (§4.7).
 *
 * Recomposed to the mockup rhythm: a 560px column of Oswald-headed groups,
 * each row a [label | optional value | control] line with hairline borders,
 * using the shared Seg / Toggle primitives. Every prior row + behavior is
 * preserved:
 *  - preferred_name ("Name") → on-blur saveConfig (commit on focus-leave).
 *  - 261110: the AI group is one row, "Brain, voice and plan", that opens
 *    the Playtime page. The backend switch, ChatGPT plan, provider / key /
 *    model rows, Voice and the Account ChatGPT link row moved there
 *    (PlaytimeScreen, components/playtime/).
 *  - Theme Seg persists theme_mode (midnight / ice / acorn / mint / system)
 *    via saveConfig; lives in its own Theme group (above Appearance) together
 *    with the custom background picker + sliders (260724).
 *  - Reset-all iterates the character list; resend-verification / export /
 *    update-check state machines unchanged; all modal opens unchanged.
 *
 * Source: docs/design/UI-REDESIGN-PARTY.md §1 + §4.7.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { applyTheme, resolvedScheme, type ThemeMode, type ThemeName } from '../lib/theme';
import { Button } from '../components/Button';
import { Seg } from '../components/Seg';
import { Toggle } from '../components/Toggle';
import { TextField } from '../components/TextField';
import { SignOutConfirmModal } from '../components/SignOutConfirmModal';
import { DeleteAccountModal } from '../components/DeleteAccountModal';
import { VerifyEmailModal } from '../components/VerifyEmailModal';
import { MigrateLocalCharsModal } from '../components/MigrateLocalCharsModal';
import { ResetAllMemoriesConfirmModal } from '../components/ResetAllMemoriesConfirmModal';
import { FactoryResetConfirmModal } from '../components/FactoryResetConfirmModal';
import { DmcaContactModal } from '../components/DmcaContactModal';
import { PortraitImagePicker } from '../components/PortraitImagePicker';
import { BackgroundImagePicker } from '../components/BackgroundImagePicker';
import { InfoTip } from '../components/InfoTip';
import { CopyIcon } from '../components/icons';
import { useLangStore, useT, type UiLanguage } from '../lib/i18n';
import type { AvatarMode, UserConfig } from '@shared/characterSchema';
import styles from './SettingsScreen.module.css';
import { GamesSettingsGroup } from '../components/settings/GamesSettingsGroup';
import { SearchSettingsSection } from '../components/settings/SearchSettingsSection';
import { LocalImportRow } from '../components/settings/LocalImportRow';
import { FacepackDevRow } from '../components/settings/FacepackDevRow';
import { ExperimentalUpdatesRow } from '../components/settings/ExperimentalUpdatesRow';
import { OpenAtLoginRow } from '../components/settings/OpenAtLoginRow';
import { UI_LANGUAGES, UI_LANGUAGE_NATIVE_NAMES, isUiLanguage } from '@shared/uiLanguage';

/**
 * Theme swatches (260724): each theme renders as a circle split diagonally
 * between its two main colors; the name rides the shared data-tip tooltip.
 * Literal hex is deliberate here — a swatch previews ANOTHER theme's palette,
 * which the current theme's tokens cannot express. Keep in sync with the
 * per-theme blocks in tokens.css (bg + accent of each).
 */
const THEME_SWATCHES: { value: ThemeName; label: string; colors: [string, string] }[] = [
  { value: 'midnight', label: 'Midnight', colors: ['#04070f', '#7fb0ff'] },
  { value: 'ice', label: 'Ice', colors: ['#f3f8ff', '#7fb0ff'] },
  { value: 'acorn', label: 'Acorn', colors: ['#f8f3ea', '#ad8a63'] },
  { value: 'mint', label: 'Mint', colors: ['#eff8f2', '#57b47c'] },
];

export function SettingsScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  // 260724 — Theme section: custom background + its two sliders. App.tsx
  // hydrates these from persisted config; changes here write straight through
  // (image via the user:apply/remove-background IPC, sliders via saveConfig on
  // release so a drag doesn't spam disk writes).
  const backgroundImage = useUiStore((s) => s.backgroundImage);
  const backgroundOpacity = useUiStore((s) => s.backgroundOpacity);
  const backgroundBrightness = useUiStore((s) => s.backgroundBrightness);
  const backgroundBust = useUiStore((s) => s.backgroundBust);
  const setBackgroundImage = useUiStore((s) => s.setBackgroundImage);
  const setBackgroundOpacity = useUiStore((s) => s.setBackgroundOpacity);
  const setBackgroundBrightness = useUiStore((s) => s.setBackgroundBrightness);
  // ui-A7: developer-console toggle. Default OFF; SettingsScreen owns the
  // surface that flips it. Persisted via UserConfig.dev_console_visible so
  // a relaunch preserves the choice.
  const devConsoleVisible = useUiStore((s) => s.devConsoleVisible);
  const setDevConsoleVisible = useUiStore((s) => s.setDevConsoleVisible);
  // App UI language (260730): its own Settings section.
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  const t = useT();
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
  const avatarMode = useUiStore((s) => s.avatarMode);
  const convoStartersEnabled = useUiStore((s) => s.convoStartersEnabled);
  const setAvatarMode = useUiStore((s) => s.setAvatarMode);
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

  const [cfg, setCfg] = useState<UserConfig | null>(null);
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
  // "Experimental updates" channel (config key advanced_updates). Off = stable
  // only (the default); on = beta
  // (pre-releases included). Seeded from config on open; persisted + pushed to
  // the live updater on toggle. Local state, since only this screen reads it.
  const [advancedUpdates, setAdvancedUpdates] = useState<boolean>(false);

  // Inline edit buffers — typing only updates these; commit happens on blur.
  const [preferredDraft, setPreferredDraft] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Phase 10 (D-11) — Account panel state. Modals + transient action statuses.
  const [signOutModalOpen, setSignOutModalOpen] = useState<boolean>(false);
  // WR-10: capture the account email at modal-open time so the modal can
  // remain mounted across the SIGNED_OUT transition that fires mid-flow.
  const [deleteAccountState, setDeleteAccountState] = useState<{ email: string } | null>(null);
  // 260728: factory reset (danger zone) confirm popup.
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  // Plan 11-18 — re-open entry for the one-shot migration modal.
  const [migrateModalOpen, setMigrateModalOpen] = useState<boolean>(false);
  // Plan 12-14 — DMCA Designated Agent info modal. Visible to BOTH signed-in
  // and signed-out users since DMCA is a public-law surface (CONTEXT D-35a).
  const [dmcaModalOpen, setDmcaModalOpen] = useState<boolean>(false);
  // 260804 — email-code entry for the signed-in-but-unverified state. Replaced
  // the resend-status line: sending is now the modal's job, so this screen no
  // longer tracks it.
  const [verifyModalOpen, setVerifyModalOpen] = useState<boolean>(false);
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

  const onExport = async (): Promise<void> => {
    setExportStatus(null);
    const res = await sei.exportData();
    if (res.ok) {
      setExportStatus({ savedPath: res.savedPath });
    } else if (res.code !== 'cancelled') {
      setExportStatus({ error: t("Couldn't prepare your export. Try again in a moment.") });
    }
  };

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
      setSaveError(t('Failed to save. Try again.'));
    }
  };

  const onPreferredBlur = (): void => {
    if (!cfg) return;
    if ((cfg.preferred_name ?? '') === preferredDraft) return;
    void persistConfig({ ...cfg, preferred_name: preferredDraft });
  };

  // App UI language (260730). Optimistic store flip (every subscribed
  // component re-renders immediately), then persist through the same
  // saveConfig path as the toggles; roll back on failure.
  const onSelectLanguage = async (next: UiLanguage): Promise<void> => {
    if (next === lang) return;
    const prev = lang;
    setLang(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, ui_language: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (ui_language) failed', err);
      setLang(prev);
    }
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

  // 260724: background image applied/removed. Main already persisted
  // background_image inside the IPC handler; mirror it into the local cfg copy
  // so a later slider commit (which saves the WHOLE cfg) can't resurrect a
  // stale ref.
  const onBackgroundChanged = (ref: string | null): void => {
    setBackgroundImage(ref);
    setCfg((c) => (c ? { ...c, background_image: ref } : c));
  };

  // Sliders update the store on every input (live repaint of the <main>
  // background) and persist on release/blur.
  const commitBackgroundSliders = (): void => {
    if (!cfg) return;
    const { backgroundOpacity: opacity, backgroundBrightness: brightness } = useUiStore.getState();
    if (cfg.background_opacity === opacity && cfg.background_brightness === brightness) return;
    void persistConfig({
      ...cfg,
      background_opacity: opacity,
      background_brightness: brightness,
    });
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

  // About: persist the "Experimental updates" channel toggle (after its inline
  // confirm when turning on, see ExperimentalUpdatesRow), then push it to the
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

  // Appearance & feel: avatar overlay mode (260804, default OFF). Writes
  // avatar_mode; the deprecated call_overlay_enabled boolean is never written
  // again (effectiveAvatarMode folds it in only while avatar_mode is absent).
  // The overlay window itself is spawned/torn down by the pusher in App.tsx.
  const onSelectAvatarMode = async (next: AvatarMode): Promise<void> => {
    const prev = avatarMode;
    setAvatarMode(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, avatar_mode: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (avatar_mode) failed', err);
      setAvatarMode(prev);
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
      setSaveError(t('Failed to save. Try again.'));
    }
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
          firstError = err instanceof Error ? err.message : t('Failed to reset some memories.');
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

  // Version value: "v{x}" alone, or "v{x} · <status>" after a check. The
  // status word is color-coded (green ok / orange in progress / red failed).
  const versionStatus: { text: string; cls: string } | null =
    updateStatus === 'checking'
      ? { text: t('checking…'), cls: styles.statusWarn }
      : updateStatus === 'up-to-date'
        ? { text: t('up to date'), cls: styles.statusOk }
        : updateStatus === 'available'
          ? { text: t('update available'), cls: styles.statusWarn }
          : updateStatus === 'error'
            ? { text: t('check failed'), cls: styles.statusErr }
            : null;
  const versionValue = appVersion ? `v${appVersion}` : '–';

  // (The literal 'Reset all memories…' key below is what D-FIX.3 greps for.)
  const resetAllLabel = resetAllDone
    ? t('All memories reset')
    : resetAllProgress
      ? t('Resetting {done} of {total}…', {
          done: resetAllProgress.done,
          total: resetAllProgress.total,
        })
      : t('Reset all memories…');

  return (
    <div className={styles.root}>
      <div className={styles.col}>
        {saveError ? <div className={styles.errorRow}>{saveError}</div> : null}

        {/* ── Profile ─────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Profile') /* >Profile< */}</h3>
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
                placeholder={t('Your name')}
                aria-label={t('Name')}
              />
            </span>
          </div>
        </div>

        {/* ── Account (signed-in only) ────────────────────────── */}
        {authState.kind === 'signed_in' ? (
          <div className={styles.group}>
            <h3 className={styles.groupTitle}>{t('Account') /* >Account< */}</h3>

            <div className={styles.row}>
              <span className={styles.label}>{t('Email')}</span>
              <span className={styles.monoValue}>{authState.user.email}</span>
              <Button kind="ghost" size="sm" onClick={() => setSignOutModalOpen(true)}>
                {t('Sign out')}
              </Button>
            </div>
            {!authState.user.emailVerified ? (
              <div className={styles.row}>
                <span className={styles.label}>{t('Verify email')}</span>
                {/* 260804 — opens the code modal, which sends a fresh code on
                    mount. The old button only resent the link and left the
                    user to go find it; there is now something to type. */}
                <Button kind="quiet" size="sm" onClick={() => setVerifyModalOpen(true)}>
                  {t('Enter code')}
                </Button>
              </div>
            ) : null}

            {/* 260724: the Playtime row is gone. Weekly usage lives on the plan
                screen (the rail's Plan icon), and there is no time estimate to
                show. */}

            {/* Account ID — the short 4-char public handle (profiles.handle) for
                support workflows, not the long Supabase UUID. Falls back to the
                UUID only until the profile loads (or if no handle is assigned). */}
            <div className={styles.row}>
              <span className={styles.label}>{t('Account ID')}</span>
              <span className={styles.idValue}>
                <span className={styles.monoValue}>{userHandle ?? authState.user.id}</span>
                <button
                  type="button"
                  className={styles.copyBtn}
                  aria-label={t('Copy account ID')}
                  data-tip={uuidCopied ? t('Copied') : t('Copy')}
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
                looking for / art style), prefilled, returning here. 260731:
                Sui asks it, in her scene, rather than a form. */}
            <div className={styles.row}>
              <span className={styles.label}>{t('Companion preferences')}</span>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => navigate({ kind: 'sui-prefs', next: 'settings' })}
              >
                {t('Update my preferences')}
              </Button>
            </div>

            {/* 261023: the own-key (local profile) import, for a player who
                said "Not now" to the offer. Hidden when there is nothing.
                261024: worded apart from the upload row below. This one
                MOVES companions made before signing in (the signed-out
                profile) into this account; that one UPLOADS this account's
                companions that are not in the cloud yet. */}
            <LocalImportRow accountId={authState.user.id} />

            <div className={styles.row}>
              <span className={styles.label}>{t('Upload companions to the cloud')}</span>
              <Button kind="ghost" size="sm" onClick={() => setMigrateModalOpen(true)}>
                {t('Upload')}
              </Button>
            </div>

            <div className={styles.row}>
              <span className={styles.label}>{t('Export data')}</span>
              <Button kind="ghost" size="sm" onClick={() => void onExport()}>
                {t('Export as JSON')}
              </Button>
            </div>
            {exportStatus?.savedPath ? (
              <p className={styles.helper}>{t('Saved to {path}', { path: exportStatus.savedPath })}</p>
            ) : null}
            {exportStatus?.error ? (
              <p className={`${styles.helper} ${styles.helperError}`}>{exportStatus.error}</p>
            ) : null}
          </div>
        ) : null}

        {/* ── AI (261110): every AI, model and voice setting moved to the
            Playtime page (tabs Sei / ChatGPT / My keys); this row opens it.
            Web search stays under Games & search. ── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('AI') /* >AI< */}</h3>
          <div className={styles.row} data-testid="settings-open-playtime">
            <span className={styles.label}>{t('Brain, voice and plan')}</span>
            <Button kind="secondary" size="sm" onClick={() => navigate({ kind: 'credits' })}>
              {t('Open Playtime')}
            </Button>
          </div>
        </div>

        {/* ── Games & search (game adapters, 260908): ONE group for every
            registered game. The left column picks the game, the right column
            shows its rows (GamesSettingsGroup); Minecraft's rows are
            unchanged. 261023: web search (provider + optional key) moved in
            as the last tab; it was its own "Search" group above About. Shown
            in both cloud and local mode: none of it depends on the backend. ── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Games & search') /* >Games & search< */}</h3>
          <GamesSettingsGroup
            config={cfg}
            writeConfig={writeVisionConfig}
            extraTabs={[
              {
                id: 'search',
                title: 'Web search',
                render: () => <SearchSettingsSection config={cfg} saveConfig={persistConfig} />,
              },
            ]}
          />
        </div>

        {/* ── Language (260730) — app UI language, its own section ── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Language')}</h3>
          <div className={styles.row}>
            <span className={styles.label}>
              {t('App language')}
              <InfoTip
                label={t('About the app language')}
                text={
                  // Only Chinese pins new companions to the UI language
                  // (AddCharacterScreen); the 261104 languages translate the
                  // interface alone, so their hint must not promise it.
                  lang === 'zh'
                    ? t(
                        'Switches the whole app to this language. Companions you create while it is on speak it too.',
                      )
                    : t('Switches the whole app to this language.')
                }
              />
            </span>
            {/* A native select, not a Seg: six languages, each named in its
                own language, do not fit a segmented control (261104). */}
            <select
              className={styles.langSelect}
              aria-label={t('App language')}
              value={lang}
              onChange={(e) => {
                if (isUiLanguage(e.target.value)) void onSelectLanguage(e.target.value);
              }}
            >
              {UI_LANGUAGES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {UI_LANGUAGE_NATIVE_NAMES[code]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Theme (260724) — named themes + custom background ── */}
        <div className={styles.group} data-tutorial="theme-group">
          <h3 className={styles.groupTitle}>{t('Theme')}</h3>
          <div className={styles.row}>
            <span className={styles.label}>{t('Theme')}</span>
            {/* Swatch circles instead of a Seg; System was retired from the UI
                (a legacy 'system' mode still resolves, and highlights the
                theme it currently resolves to until the user picks one).
                Labels are pre-translated so the map param can stay `t` (the
                structure test pins the literal data-tip={t.label}). */}
            <div className={styles.swatchRow} role="radiogroup" aria-label={t('Theme')}>
              {THEME_SWATCHES.map((s) => ({ ...s, label: t(s.label) })).map((t) => {
                const active =
                  themeMode === t.value ||
                  (themeMode === 'system' &&
                    t.value === (resolvedScheme() === 'dark' ? 'midnight' : 'ice'));
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={t.label}
                    data-tip={t.label}
                    className={[styles.swatch, active ? styles.swatchOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      // Longhands on purpose: the `background` shorthand resets
                      // background-origin to padding-box, which makes the
                      // gradient tile wrap under the 2px border and ring the
                      // circle with the opposite color. border-box origin runs
                      // the two halves all the way to the rim.
                      backgroundImage: `linear-gradient(135deg, ${t.colors[0]} 50%, ${t.colors[1]} 50%)`,
                      backgroundOrigin: 'border-box',
                      backgroundClip: 'border-box',
                    }}
                    onClick={() => void onSelectTheme(t.value)}
                  />
                );
              })}
            </div>
          </div>
          {/* Custom background image, painted under the theme colors on the
              main content panel. The two sliders only appear once set. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Background')}
              <InfoTip
                label={t('About custom backgrounds')}
                text={t(
                  'Shows your own picture behind the app, under the theme colors. Use the sliders to blend it in.',
                )}
              />
            </span>
            <BackgroundImagePicker
              value={backgroundImage}
              bust={backgroundBust}
              onChange={onBackgroundChanged}
            />
          </div>
          {backgroundImage ? (
            <>
              <div className={styles.row}>
                <span className={styles.label}>{t('Background visibility')}</span>
                <input
                  className={styles.slider}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(backgroundOpacity * 100)}
                  aria-label={t('Background visibility')}
                  onChange={(e) => setBackgroundOpacity(Number(e.target.value) / 100)}
                  onMouseUp={commitBackgroundSliders}
                  onTouchEnd={commitBackgroundSliders}
                  onBlur={commitBackgroundSliders}
                />
                <span className={styles.monoValue}>{Math.round(backgroundOpacity * 100)}%</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>{t('Background brightness')}</span>
                <input
                  className={styles.slider}
                  type="range"
                  min={20}
                  max={100}
                  step={1}
                  value={Math.round(backgroundBrightness * 100)}
                  aria-label={t('Background brightness')}
                  onChange={(e) => setBackgroundBrightness(Number(e.target.value) / 100)}
                  onMouseUp={commitBackgroundSliders}
                  onTouchEnd={commitBackgroundSliders}
                  onBlur={commitBackgroundSliders}
                />
                <span className={styles.monoValue}>{Math.round(backgroundBrightness * 100)}%</span>
              </div>
            </>
          ) : null}
        </div>

        {/* ── Appearance ──────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Appearance') /* >Appearance< */}</h3>
          {/* Appearance & feel: "Realistic typing" pacing. On by default. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Realistic typing')}
              <InfoTip
                label={t('About realistic typing')}
                text={t(
                  'Pauses to read your message, then paces typing to a human speed, in chat and in-game. Off replies instantly.',
                )}
              />
            </span>
            <Toggle
              aria-label={t('Realistic typing')}
              on={realisticTyping}
              onChange={(v) => void onToggleRealisticTyping(v)}
            />
          </div>
          {/* ui-A7: developer console toggle. Off by default — App.tsx gates
              <LogsBar /> on this flag. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Developer console')}
              <InfoTip
                label={t('About the developer console')}
                text={t('Useful for debugging skin and bot issues.')}
              />
            </span>
            <Toggle
              aria-label={t('Show developer console')}
              on={devConsoleVisible}
              onChange={(v) => void onToggleDevConsole(v)}
            />
          </div>
          {/* 260707: product-analytics opt-out. On by default; toggling off
              stops all analytics immediately. See privacy.html. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Usage analytics')}
              <InfoTip
                label={t('About usage analytics')}
                text={t(
                  'Shares anonymous usage data (feature counts, versions, errors) to help improve Sei. Never your chats, characters, or personal info. Turn off any time.',
                )}
              />
            </span>
            <Toggle
              aria-label={t('Usage analytics')}
              on={!analyticsOptOut}
              onChange={(v) => void onToggleAnalytics(v)}
            />
          </div>
          {/* Call captions (260705): live subtitle lines on the voice-call
              screen. Off by default. Calls read as audio, not subtitles. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Call captions')}
              <InfoTip
                label={t('About call captions')}
                text={t(
                  'Shows live captions during voice calls: what the companion said and what Sei heard you say.',
                )}
              />
            </span>
            <Toggle
              aria-label={t('Call captions')}
              on={callCaptions}
              onChange={() => void onToggleCallCaptions()}
            />
          </div>
          {/* Avatar overlay (260804, grew out of the 260706 call overlay):
              always-on-top companion tiles (static portrait or Live2D). Three
              levels: off / during activity (calls, games, screenshare,
              Minecraft) / always while the app is open. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Avatar')}
              <InfoTip
                label={t('About the avatar')}
                text={t(
                  'Floats your companion on top of every app: their picture, or a Live2D model from their profile. "When active" shows it during calls, games, screensharing and Minecraft; "Always" keeps it up while Sei is open. Hover it to move or resize.',
                )}
              />
            </span>
            <Seg<AvatarMode>
              aria-label={t('Avatar')}
              options={[
                { value: 'off', label: t('Off') },
                { value: 'activity', label: t('When active') },
                { value: 'always', label: t('Always') },
              ]}
              value={avatarMode}
              onChange={(next) => void onSelectAvatarMode(next)}
            />
          </div>
          {/* 261107: "Open on login" (WorldLink back after a restart).
              Packaged macOS / Windows only; renders nothing elsewhere. */}
          <OpenAtLoginRow />
          {/* Conversation starters (260707): on a quiet call, a companion may
              bring up a topic on its own. On by default. */}
          <div className={styles.row}>
            <span className={styles.label}>
              {t('Conversation starters')}
              <InfoTip
                label={t('About conversation starters')}
                text={t(
                  'When a voice call goes quiet for a bit, your companion can bring up a topic on their own instead of waiting for you to speak.',
                )}
              />
            </span>
            <Toggle
              aria-label={t('Conversation starters')}
              on={convoStartersEnabled}
              onChange={() => void onToggleConvoStarters()}
            />
          </div>
        </div>

        {/* ── About ───────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('About') /* >About< */}</h3>
          <div className={styles.row}>
            <span className={styles.label}>{t('Version')}</span>
            <span className={styles.value}>
              {versionValue}
              {appVersion && versionStatus ? (
                <>
                  {' · '}
                  <span className={versionStatus.cls}>{versionStatus.text}</span>
                </>
              ) : null}
            </span>
            <Button
              kind="ghost"
              size="sm"
              disabled={updateStatus === 'checking'}
              onClick={() => {
                setUpdateStatus('checking');
                void sei.checkForUpdates();
              }}
            >
              {t('Check now')}
            </Button>
          </div>
          {/* Experimental updates (was "Advanced updates"; config key
              advanced_updates): opt into the beta channel. Off by default so a
              normal user is never moved onto a pre-release build. Turning it
              on asks first, inline under the row. */}
          <ExperimentalUpdatesRow
            on={advancedUpdates}
            onSave={(v) => void onToggleAdvancedUpdates(v)}
          />
          <div className={styles.row}>
            <span className={styles.label}>{t('Terms of Service')}</span>
            <Button
              kind="ghost"
              size="sm"
              onClick={() => void sei.openExternal('https://sei.gg/terms.html')}
            >
              {t('Open')}
            </Button>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>{t('Privacy Policy')}</span>
            <Button
              kind="ghost"
              size="sm"
              onClick={() => void sei.openExternal('https://sei.gg/privacy.html')}
            >
              {t('Open')}
            </Button>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>{t('Report copyright infringement (DMCA)')}</span>
            <Button kind="ghost" size="sm" onClick={() => setDmcaModalOpen(true)}>
              {t('Open')}
            </Button>
          </div>
          <p className={styles.helper}>
            {t('Photo credits: Minecraft artwork by Mojang Studios. Movie night photo by')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal(
                  'https://americanretirementhomes.org/movie-nights-and-in-house-entertainment-options/',
                )
              }
            >
              American Retirement Homes
            </button>{' '}
            {t('(CC licensed).')}
          </p>
          <p className={styles.helper}>
            {t('Speech recognition: SenseVoice-Small by FunAudioLLM (Alibaba),')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal(
                  'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
                )
              }
            >
              {t('FunASR Model License')}
            </button>
            {t('. English voice: trained on LibriTTS-R,')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal('https://creativecommons.org/licenses/by/4.0/')
              }
            >
              CC BY 4.0
            </button>
            {t(
              ', via Piper; converted to ONNX. Chinese voice: trained on AISHELL-3 by Beijing Shell Shell Technology,',
            )}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal('https://www.apache.org/licenses/LICENSE-2.0')
              }
            >
              {t('Apache License 2.0')}
            </button>
            {t(', via icefall.')}{' '}
            {/* 261102: Kokoro credit as its own sentence; the model name links
                to its page, the license to the license text. */}
            {t('Kokoro voice:')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() => void sei.openExternal('https://huggingface.co/hexgrad/Kokoro-82M')}
            >
              Kokoro-82M
            </button>{' '}
            {t('by hexgrad,')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal('https://www.apache.org/licenses/LICENSE-2.0')
              }
            >
              {t('Apache License 2.0')}
            </button>
            {t(', converted by sherpa-onnx. Its pronunciation data comes from espeak-ng,')}{' '}
            <button
              type="button"
              className={styles.creditLink}
              onClick={() =>
                void sei.openExternal('https://github.com/espeak-ng/espeak-ng/blob/master/COPYING')
              }
            >
              GPL v3
            </button>
            {t('.')}
          </p>
          {/* 261028 facepack pilot: renders nothing unless the dev flag is on. */}
          <FacepackDevRow />
        </div>

        {/* ── Danger ──────────────────────────────────────────── */}
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Danger') /* >Danger< */}</h3>
          <div className={styles.row}>
            <span className={styles.label}>{t('Reset all companion memories')}</span>
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
            {t(
              'Wipes saved chat history and playtime for every companion on this device. Persona, portrait, and skin are kept.',
            )}
          </p>
          {resetAllError ? (
            <p className={`${styles.helper} ${styles.helperError}`} role="alert">
              {resetAllError}
            </p>
          ) : null}
          {authState.kind === 'signed_in' ? (
            <>
              <div className={styles.row}>
                <span className={styles.label}>{t('Delete account')}</span>
                <Button
                  kind="danger"
                  size="sm"
                  onClick={() => {
                    if (authState.kind === 'signed_in') {
                      setDeleteAccountState({ email: authState.user.email });
                    }
                  }}
                >
                  {t('Delete account…')}
                </Button>
              </div>
              <p className={styles.helper}>
                {t('Permanently deletes your cloud data within 30 days. Local files stay.')}
              </p>
            </>
          ) : null}
          <div className={styles.row}>
            <span className={styles.label}>{t('Factory reset')}</span>
            <Button kind="danger" size="sm" onClick={() => setFactoryResetOpen(true)}>
              {t('Factory reset…')}
            </Button>
          </div>
          <p className={styles.helper}>
            {t(
              'Erases everything on this device and restarts Sei like a fresh install. Cloud data stays on your account.',
            )}
          </p>
        </div>
      </div>

      {verifyModalOpen && authState.kind === 'signed_in' ? (
        <VerifyEmailModal
          email={authState.user.email}
          onClose={() => setVerifyModalOpen(false)}
        />
      ) : null}
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
      {resetAllModalOpen ? (
        <ResetAllMemoriesConfirmModal
          characterCount={allCharacters.length}
          onCancel={() => setResetAllModalOpen(false)}
          onConfirm={runResetAllMemories}
        />
      ) : null}
      {dmcaModalOpen ? <DmcaContactModal onClose={() => setDmcaModalOpen(false)} /> : null}
      {factoryResetOpen ? (
        <FactoryResetConfirmModal onCancel={() => setFactoryResetOpen(false)} />
      ) : null}
    </div>
  );
}

