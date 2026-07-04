/**
 * SettingsScreen — Account / Appearance sections (inline-editable).
 *
 * Account section reads from `sei.getConfig()` and `sei.hasApiKey()` on mount,
 * and persists changes inline:
 *  - preferred_name ("Name") → on-blur saveConfig (no debounce; commit
 *    only when focus leaves the field). The Minecraft-username row was
 *    retired from the GUI (260605); mc_username stays in the DB, unedited.
 *  - API key → "Update" button reveals a password TextField; Save calls
 *    sei.saveApiKey, then re-checks hasApiKey() and collapses the editor.
 *  - Provider stays read-only (only "anthropic" is valid in v1).
 *
 * Appearance section toggles light↔dark and persists `theme_mode` immediately.
 *
 * Source: 04-UI-SPEC.md §SettingsScreen + §Re-onboarding (replaced by inline
 * edit in quick task 260508-mun) + D-58.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { applyTheme, type ThemeMode } from '../lib/theme';
import { Button } from '../components/Button';
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
import { BackIcon, SunIcon, MoonIcon, CopyIcon } from '../components/icons';
import type { UserConfig } from '@shared/characterSchema';
import type { WizardState } from '@shared/ipc';
import styles from './SettingsScreen.module.css';

const API_KEY_BULLET_LEN = 24;

export function SettingsScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
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

  // Plan 13-20 — Cloud AI toggle (PROXY-11 BYOK escape hatch). The ACCOUNT MODE
  // section renders exactly ONE button based on backend:
  //   (a) ai_backend_kind === 'local'      → "Switch to managed billing"
  //   (b) cloud-proxy                       → "Switch to your own API key"
  // Symmetric BYOK ↔ cloud per CONTEXT D-57. Subscription cancel/manage lives
  // on the Credits ("Mana") screen → "Manage billing" (Polar portal), not here.
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  // WR-05 follow-up: flipping the backend mid-bot now applies LIVE — main's
  // proxy.configure handler calls supervisor.switchBackend(), which rebuilds
  // the running utilityProcess's Anthropic SDK in place so the next call
  // routes through the new backend (no stop+re-summon). The original WR-05
  // mitigation was a "Restart your bot for the change to take effect" banner;
  // that's no longer true, so this notice is now a positive confirmation that
  // the swap reached the running bot.
  //
  // The notice self-clears on the next bot lifecycle transition (botRunning
  // edge → false) so a stop cycle silently dismisses it.
  const [switchNotice, setSwitchNotice] = useState<null | 'switched-to-cloud' | 'switched-to-local'>(
    null,
  );
  // Switching cloud ⇄ local is uncommon and consequential (it changes billing
  // and applies to a running bot immediately), so the buttons open a
  // confirmation modal instead of toggling directly. Non-null = modal is open
  // for that target backend.
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
  // Updates section (quick/260604-uoy). appVersion is read once via getVersion();
  // updateStatus reflects the live updater events while the user is on this
  // screen ("Check for updates" → checking → up-to-date / available / error).
  // The actual update FLOW (optional changelog popup, download, restart) is
  // owned by App.tsx's UpdatePopup — this section only triggers a check and
  // surfaces a brief inline status line.
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  >('idle');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' ? 'dark' : 'light';
  });

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
  // The 1200ms "Account scheduled for deletion. Signing you out…" state
  // would otherwise unmount within ~50ms of auth.signOut() flipping
  // authState.kind to 'local'.
  const [deleteAccountState, setDeleteAccountState] = useState<{ email: string } | null>(null);
  // Plan 11-18 — re-open entry for the one-shot migration modal. Bypasses the
  // <userData>/migration-modal-shown.json flag (Settings opens it explicitly).
  const [migrateModalOpen, setMigrateModalOpen] = useState<boolean>(false);
  // Plan 12-14 — DMCA Designated Agent info modal. Opened from the LEGAL panel
  // below. Visible to BOTH signed-in and signed-out users since DMCA is a
  // public-law surface (CONTEXT D-35a).
  const [dmcaModalOpen, setDmcaModalOpen] = useState<boolean>(false);
  const [resendStatus, setResendStatus] = useState<
    'idle' | 'sending' | 'sent' | 'rate-limited' | 'error'
  >('idle');
  const [exportStatus, setExportStatus] = useState<{ savedPath?: string; error?: string } | null>(
    null,
  );
  // ITEM 5 (quick/260523-t8d): 1.5s "Copied" flash for the Account ID copy
  // affordance. Local UI state only — no IPC.
  const [uuidCopied, setUuidCopied] = useState<boolean>(false);
  // ui-A9: two-click destructive Reset-all-memories state. confirming flag
  // arms the next click; progress carries "X of N" while iterating; done
  // flashes a confirmation when the loop completes.
  const [resetAllModalOpen, setResetAllModalOpen] = useState<boolean>(false);
  const [resetAllProgress, setResetAllProgress] = useState<{ done: number; total: number } | null>(null);
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
      // App.tsx's bootstrap effect handles the first-launch seed; this entry
      // covers the case where Settings is the first surface to read the
      // persisted flag (e.g. user opens Settings before LogsBar ever
      // checks).
      if (typeof c.dev_console_visible === 'boolean') {
        setDevConsoleVisible(c.dev_console_visible);
      }
    });
    void sei.hasApiKey().then((b) => setHasKey(b));
    // Seed the user's profile picture for the chat-avatar section below.
    void sei
      .userGetProfile()
      .then((p) => setUserPic(p.profilePicture))
      .catch(() => {
        /* non-fatal — section just shows the empty/NONE state */
      });
  }, [setDevConsoleVisible]);

  // Updates section (quick/260604-uoy): load the current version once, and
  // subscribe to updater events while this screen is mounted so the inline
  // status line reflects an in-flight manual check. onUpdateAvailable here just
  // flips the status to "available" — the changelog popup is App.tsx's job.
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

  const UPDATE_STATUS_TEXT = {
    idle: '',
    checking: 'Checking…',
    'up-to-date': "You're up to date.",
    available: 'An update is available.',
    error: "Couldn't check for updates. Try again later.",
  } as const;

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

  const toggleTheme = async (): Promise<void> => {
    const next: ThemeMode = resolvedTheme === 'light' ? 'dark' : 'light';
    setThemeMode(next);
    applyTheme(next);
    setResolvedTheme(next);
    if (cfg) {
      const updated: UserConfig = { ...cfg, theme_mode: next };
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

  // ui-A1: provider tile click changes config.provider AND clears any
  // existing api key (the prior key is for a different vendor; reusing it
  // would silently 401 against the new baseURL). On clear we leave the
  // editor open so the user can paste the new vendor's key next to the
  // newly-selected tile without an extra "Update" click.
  const onChangeProvider = async (next: Provider): Promise<void> => {
    if (!cfg) return;
    if (cfg.provider === next) return;
    try {
      await sei.saveConfig({ ...cfg, provider: next, provider_config: cfg.provider_config ?? {} });
      setCfg({ ...cfg, provider: next });
      // Wipe any saved key — see comment above. saveApiKey('') clears the
      // on-disk api_key.bin (apiKeyStore tolerates the empty string).
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

  // ui-A7: persist developer-console toggle. Mirrors theme toggle pattern —
  // update zustand FIRST so the UI reacts immediately, then write through.
  const onToggleDevConsole = async (): Promise<void> => {
    const next = !devConsoleVisible;
    setDevConsoleVisible(next);
    if (!cfg) return;
    try {
      const updated: UserConfig = { ...cfg, dev_console_visible: next };
      await sei.saveConfig(updated);
      setCfg(updated);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SettingsScreen] saveConfig (dev_console_visible) failed', err);
      // Roll back the optimistic update so UI matches persisted state.
      setDevConsoleVisible(!next);
    }
  };

  // Appearance & feel: persist the "Realistic typing" pacing toggle. Same
  // optimistic-then-write-through pattern as the dev-console toggle.
  const onToggleRealisticTyping = async (): Promise<void> => {
    const next = !realisticTyping;
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

  // Write through vision_mode to UserConfig (the config is the source of truth;
  // botSupervisor bridges it into config.vision at fork). Mirrors
  // onToggleDevConsole's optimistic-then-rollback discipline. The setting is
  // persistent and ALWAYS editable — it is deliberately NOT gated on a live bot
  // session or its provider capability (changes apply at the next summon; a
  // non-VLM provider skips pictures).
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

  // Mode select: every move writes straight through. Continuous (the automatic
  // view) is no longer behind a confirm step; its extra playtime use surfaces
  // as the shrunk "~Xh left" figure on the Playtime screen (D-07).
  const onSelectVisionMode = (mode: 'off' | 'on-demand' | 'continuous'): void => {
    if (mode === (cfg?.vision_mode ?? 'on-demand')) return;
    void writeVisionConfig({ vision_mode: mode });
  };

  // ui-A9: "Reset all character memories" — iterate the current data-store
  // characters and call chars:reset-memory for each. Includes defaults
  // (the IPC handler itself refuses only when the bot is currently summoned
  // to that character). After each row we refreshCharacter() so the
  // store's last_launched / playtime_ms mirror the on-disk reset.
  // Opens the confirm popup. The actual wipe runs in runResetAllMemories once
  // the user confirms in the modal.
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

  return (
    <div className={styles.root}>
      <div className={styles.backRow}>
        <Button
          kind="quiet"
          size="sm"
          icon={<BackIcon size={14} />}
          onClick={() => navigate({ kind: 'home' })}
        >
          Back
        </Button>
      </div>
      <h1 className={styles.title}>Settings</h1>

      {saveError ? <div className={styles.errorRow}>{saveError}</div> : null}

      <section className={styles.section}>
        <div className={styles.sectionTitle}>PROFILE</div>

        {/*
          Phase 18/19 — the user's profile picture + name on one line, no labels.
          The circular avatar (PortraitImagePicker 'avatar' variant) reveals a
          "Change" overlay on hover and opens the same upload/crop/compress
          pipeline on click, targeting the current user (not a character).
          mc_username was retired from the GUI (260605) but is still persisted.
        */}
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

        {/*
          ui-A1: Provider picker + API key row are LOCAL-only. Cloud-proxy
          users have no BYO key — credits + billing replace these surfaces.
          The compact ProviderSelect dropdown re-renders inline (no separate
          picker screen / modal) so a vendor switch is one click.
        */}
        {aiBackendKind === 'local' ? (
          <>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Provider</span>
              <span className={styles.rowEditor}>
                <ProviderSelect
                  value={currentProvider}
                  onChange={(p) => void onChangeProvider(p)}
                  compact
                />
              </span>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel}>API key</span>
              {editingKey ? (
                <span className={styles.rowEditor}>
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
                <span className={styles.rowEditor}>
                  <span className={styles.rowMonoValue}>
                    {hasKey ? '•'.repeat(API_KEY_BULLET_LEN) : 'Not set'}
                  </span>
                  <Button kind="ghost" size="sm" onClick={() => setEditingKey(true)}>
                    {hasKey ? 'Update' : 'Set'}
                  </Button>
                </span>
              )}
            </div>
            {keyError ? <div className={styles.errorRow}>{keyError}</div> : null}
          </>
        ) : null}
      </section>

      {/*
        MINECRAFT SKINS SETUP — shown in BOTH cloud and local mode. Skin
        sideloading (CustomSkinLoader on the host's MC client) is independent
        of the AI-backend billing path, so cloud-proxy users need to be able
        to run / re-run it too. (Previously gated to local-only, which left
        cloud users with no way to fix a broken skin install.)
      */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>MINECRAFT</div>
        <SkinSetupRow />
        {/*
          Looking (vision): Off / On-demand / Continuous. Every move writes
          straight through (no confirm step). The control is ALWAYS enabled; it
          is a persistent setting, not a per-session one. Continuous uses more
          playtime, which surfaces as the shrunk "~Xh left" figure on the
          Playtime screen (D-07), never a number here. The mode-specific
          explanation lives behind the (i) tip so the row stays compact.
        */}
        <div className={styles.row}>
          <span className={styles.rowLabelGroup}>
            <span className={styles.rowLabel}>Visual gameplay</span>
            <InfoTip
              label="About visual gameplay"
              text="Companions usually play from lightweight snapshots of the world, but can pull a full render of what's around them when they need to see it — for example when building or navigating."
            />
          </span>
          <div className={styles.segmented} role="group" aria-label="Visual gameplay mode">
            {(['off', 'on-demand', 'continuous'] as const).map((mode) => (
              <Button
                key={mode}
                kind="ghost"
                size="sm"
                aria-pressed={(cfg?.vision_mode ?? 'on-demand') === mode}
                onClick={() => onSelectVisionMode(mode)}
              >
                {mode === 'off' ? 'Off' : mode === 'on-demand' ? 'On-demand' : 'Continuous'}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>APPEARANCE &amp; FEEL</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Theme</span>
          <Button
            kind="ghost"
            size="sm"
            icon={resolvedTheme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
            onClick={toggleTheme}
          >
            {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
        {/*
          ui-A7: developer console toggle. Off by default — App.tsx gates
          <LogsBar /> on this flag. Persisted via UserConfig so a relaunch
          preserves the choice. Helper copy lives behind the (i) tip.
        */}
        <div className={styles.row}>
          <span className={styles.rowLabelGroup}>
            <span className={styles.rowLabel}>Show developer console</span>
            <InfoTip
              label="About the developer console"
              text="Useful for debugging skin and bot issues."
            />
          </span>
          <Button
            kind="ghost"
            size="sm"
            aria-pressed={devConsoleVisible}
            onClick={() => void onToggleDevConsole()}
          >
            {devConsoleVisible ? 'On' : 'Off'}
          </Button>
        </div>
        {/*
          Appearance & feel: "Realistic typing" pacing. On by default — the chat
          store adds a reading pause before the typing indicator and scales it to
          the reply length; the same pacing is bridged to the in-game bot.
        */}
        <div className={styles.row}>
          <span className={styles.rowLabelGroup}>
            <span className={styles.rowLabel}>Realistic typing</span>
            <InfoTip
              label="About realistic typing"
              text="Pauses to read your message, then paces typing to a human speed, in chat and in-game. Off replies instantly."
            />
          </span>
          <Button
            kind="ghost"
            size="sm"
            aria-pressed={realisticTyping}
            onClick={() => void onToggleRealisticTyping()}
          >
            {realisticTyping ? 'On' : 'Off'}
          </Button>
        </div>
      </section>

      {/*
        UPDATES (quick/260604-uoy) — current version + manual check. The check
        funnels into the same updater flow as the startup auto-check; any
        optional update surfaces App.tsx's changelog popup, while the inline
        status here reflects checking / up-to-date / available / error.
      */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>UPDATES</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Current version</span>
          <span className={styles.rowMonoValue}>{appVersion ? `v${appVersion}` : '-'}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Check for updates</span>
          <span className={styles.rowEditor}>
            {updateStatus !== 'idle' ? (
              <span className={styles.resendStatus}>{UPDATE_STATUS_TEXT[updateStatus]}</span>
            ) : null}
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
          </span>
        </div>
      </section>

      {/*
        ACCOUNT panel — signed-in only. Sits BELOW Profile / Appearance / Skins
        (the more frequently-touched settings) and above Legal, grouping the
        less-used account-management actions (sign out, migrate, export) plus
        the Delete Account danger zone. Subscription cancel/manage lives on the
        Credits ("Mana") screen → "Manage billing", not here.
      */}
      {authState.kind === 'signed_in' ? (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>ACCOUNT</div>

          <div className={styles.row}>
            <span className={styles.rowLabel}>Email</span>
            <span className={styles.rowValue}>
              <span className={styles.monoValue}>{authState.user.email}</span>
            </span>
          </div>
          {!authState.user.emailVerified ? (
            <div className={styles.row}>
              <span className={styles.rowLabel} />
              <span className={styles.rowEditor}>
                {resendStatus !== 'idle' ? (
                  <span className={styles.resendStatus}>{resendStatusText}</span>
                ) : null}
                <Button
                  kind="quiet"
                  size="md"
                  onClick={() => void onResendVerification()}
                  disabled={resendStatus === 'sending'}
                >
                  Resend verification
                </Button>
              </span>
            </div>
          ) : null}

          {/*
            ITEM 5 (quick/260523-t8d): expose the Supabase auth user UUID so
            support / bug-report workflows can identify the account. The
            UUID is non-secret (already appears in URLs + exports) and
            renders in monospace for click-select + a Copy affordance for
            convenience. Placed directly below Email and above Sign Out
            per the plan's "above the API-key row" guidance.
          */}
          <div className={styles.row}>
            <span className={styles.rowLabel}>Account ID</span>
            <span className={`${styles.rowValue} ${styles.uuidRowValue}`}>
              <button
                type="button"
                className={styles.uuidCopyBtn}
                aria-label="Copy account ID"
                data-tip={uuidCopied ? 'Copied' : 'Copy'}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(authState.user.id)
                    .then(() => {
                      setUuidCopied(true);
                      window.setTimeout(() => setUuidCopied(false), 1500);
                    })
                    .catch(() => {
                      // Clipboard API can fail (insecure context, perms
                      // denied) — surface a brief visual cue so the user
                      // knows to long-press / select manually.
                      setUuidCopied(false);
                    });
                }}
              >
                <CopyIcon size={15} />
              </button>
              <span className={styles.monoValue}>{authState.user.id}</span>
            </span>
          </div>

          <div className={styles.row}>
            <span className={styles.rowLabel}>Sign Out</span>
            <Button kind="ghost" size="md" onClick={() => setSignOutModalOpen(true)}>
              Sign out
            </Button>
          </div>

          {/*
            Plan 11-18 — re-open entry for the one-shot local→cloud migration
            modal. Always available regardless of the shown flag — the user can
            come back here to upload any chars they skipped previously.
          */}
          <div className={styles.row}>
            <span className={styles.rowLabel}>Migrate local companions</span>
            <Button kind="ghost" size="md" onClick={() => setMigrateModalOpen(true)}>
              Migrate local companions
            </Button>
          </div>

          <div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Export My Data</span>
              <Button kind="ghost" size="md" onClick={() => void onExport()}>
                Export as JSON
              </Button>
            </div>
            {exportStatus?.savedPath ? (
              <p className={styles.rowHelper}>Saved to {exportStatus.savedPath}</p>
            ) : null}
            {exportStatus?.error ? (
              <p className={styles.rowHelper} style={{ color: 'var(--red)' }}>
                {exportStatus.error}
              </p>
            ) : null}
          </div>

        </section>
      ) : null}

      {/*
        Phase 12 plan 14 — LEGAL panel (D-35a surface (a)).
        Rendered OUTSIDE the signed-in conditional on purpose: DMCA contact +
        ToS + Privacy are public-law surfaces that signed-out users must be
        able to reach. The DMCA row opens DmcaContactModal; the Terms /
        Privacy rows hand off to sei.openExternal (sei.gg allowlist already in
        place from Phase 11).
      */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>LEGAL</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Report copyright infringement (DMCA)</span>
          <Button kind="ghost" size="md" onClick={() => setDmcaModalOpen(true)}>
            Open
          </Button>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Terms of Service</span>
          <Button
            kind="ghost"
            size="md"
            onClick={() => void sei.openExternal('https://sei.gg/terms.html')}
          >
            Open
          </Button>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Privacy Policy</span>
          <Button
            kind="ghost"
            size="md"
            onClick={() => void sei.openExternal('https://sei.gg/privacy.html')}
          >
            Open
          </Button>
        </div>
      </section>

      {/*
        ui-A1: ACCOUNT MODE — destructive-feel zone for the BYOK ⇄ cloud-proxy
        switch. Only signed-in users see this (the toggle moves the AI
        backend kind, which the renderer mirrors via useCreditsStore; main
        rejects the cloud-proxy direction for signed-out callers anyway).
        This is only the mode switch — subscription cancel/manage lives on the
        Credits ("Mana") screen → "Manage billing" (Polar customer portal).
      */}
      {authState.kind === 'signed_in' ? (
        <section className={styles.section}>
          <div className={`${styles.sectionTitle} ${styles.dangerLabel}`}>ACCOUNT MODE</div>
          <div>
            <div className={styles.row}>
              <span className={styles.rowLabelGroup}>
                <span className={styles.rowLabel}>
                  {aiBackendKind === 'local'
                    ? 'You are using your own API key'
                    : 'You are using Sei’s managed cloud'}
                </span>
                <InfoTip
                  label="About account mode"
                  text={
                    aiBackendKind === 'local'
                      ? 'Managed billing turns off your local API key and routes Sei through our cloud. Switch back any time.'
                      : 'Switching back uses the API key stored on this device. Your active subscription keeps renewing until you cancel it.'
                  }
                />
              </span>
              {aiBackendKind === 'local' ? (
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => setPendingSwitch('cloud-proxy')}
                >
                  Switch to managed billing
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => setPendingSwitch('local')}
                >
                  Switch to your own API key
                </button>
              )}
            </div>
            {switchNotice !== null && (
              <p className={styles.rowHelper} role="status">
                {switchNotice === 'switched-to-cloud'
                  ? 'Switched. Your running bot now routes through Sei’s managed cloud.'
                  : 'Switched. Your running bot now uses your own API key.'}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {/*
        DANGER zone — the destructive-zone terminus of Settings. Holds two
        actions: "Reset all character memories" (unconditional — local-mode
        users must be able to reset too, per the original brief) and, for
        signed-in users only, "Delete Account" (moved here from the Account
        panel so all destructive actions live together).
      */}
      <section className={styles.section}>
        <div className={`${styles.sectionTitle} ${styles.dangerLabel}`}>DANGER</div>
        <div>
          <div className={styles.row}>
            <span className={`${styles.rowLabel} ${styles.dangerLabel}`}>
              Reset all companion memories
            </span>
            <button
              type="button"
              className={styles.dangerBtn}
              disabled={resetAllProgress !== null || allCharacters.length === 0}
              onClick={onResetAllMemoriesClick}
            >
              {resetAllDone
                ? 'All memories reset'
                : resetAllProgress
                  ? `Resetting ${resetAllProgress.done} of ${resetAllProgress.total}…`
                  : 'Reset all memories…'}
            </button>
          </div>
          <p className={styles.rowHelper}>
            Wipes saved chat history and playtime for every companion on this
            device. Persona, portrait, and skin are kept.
          </p>
          {resetAllError ? (
            <p className={styles.rowHelper} style={{ color: 'var(--red)' }} role="alert">
              {resetAllError}
            </p>
          ) : null}
        </div>
        {/* Delete Account — signed-in only; lives in the DANGER zone alongside
            the reset action, separated by a rule. */}
        {authState.kind === 'signed_in' ? (
          <div className={styles.dangerSeparator}>
            <div className={styles.row}>
              <span className={`${styles.rowLabel} ${styles.dangerLabel}`}>Delete Account</span>
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={() => {
                  if (authState.kind === 'signed_in') {
                    setDeleteAccountState({ email: authState.user.email });
                  }
                }}
              >
                Delete account…
              </button>
            </div>
            <p className={styles.rowHelper}>
              Permanently deletes your cloud data within 30 days. Local files stay.
            </p>
          </div>
        ) : null}
      </section>

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
        its 1200ms "Account scheduled for deletion. Signing you out…" state
        even after supabase.auth.signOut() flips authState.kind to 'local'.
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
      {dmcaModalOpen ? (
        <DmcaContactModal onClose={() => setDmcaModalOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * SkinSetupRow — Minecraft skin setup wizard status row.
 *
 * Shows the current state of the Minecraft skin setup wizard:
 *   - green pill + count when 1+ installs are enabled
 *   - warn pill when any enabled install has version drift / missing mod
 *   - muted "Not set up yet" when getWizardState().hasRunOnce === false
 *
 * "Re-run setup" button opens SetupWizardModal in re-entry mode (Back-to-settings
 * button visible on welcome step).
 */
function SkinSetupRow(): React.ReactElement {
  const openWizard = useWizardStore((s) => s.openWizard);
  // Re-read the persisted wizard state whenever the wizard CLOSES (open → false)
  // so a "Re-run setup" that completes flips this pill from "Not set up yet" to
  // the enabled-install count without reopening Settings. Without this the row
  // only fetched once on mount and went stale after setup.
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
      <span className={styles.rowLabelGroup}>
        <span className={styles.rowLabel}>Custom skins</span>
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
