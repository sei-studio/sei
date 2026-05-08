/**
 * SettingsScreen — Account / Appearance sections (inline-editable).
 *
 * Account section reads from `sei.getConfig()` and `sei.hasApiKey()` on mount,
 * and persists changes inline:
 *  - mc_username / preferred_name → on-blur saveConfig (no debounce; commit
 *    only when focus leaves the field).
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
import { applyTheme, type ThemeMode } from '../lib/theme';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { BackIcon, SunIcon, MoonIcon } from '../components/icons';
import type { UserConfig } from '@shared/characterSchema';
import styles from './SettingsScreen.module.css';

const API_KEY_BULLET_LEN = 24;

export function SettingsScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' ? 'dark' : 'light';
  });

  // Inline edit buffers — typing only updates these; commit happens on blur.
  const [mcDraft, setMcDraft] = useState<string>('');
  const [preferredDraft, setPreferredDraft] = useState<string>('');
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [keyDraft, setKeyDraft] = useState<string>('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void sei.getConfig().then((c) => {
      setCfg(c);
      setMcDraft(c.mc_username ?? '');
      setPreferredDraft(c.preferred_name ?? '');
    });
    void sei.hasApiKey().then((b) => setHasKey(b));
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

  const onMcBlur = (): void => {
    if (!cfg) return;
    if ((cfg.mc_username ?? '') === mcDraft) return;
    void persistConfig({ ...cfg, mc_username: mcDraft });
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

  const providerDisplay = (() => {
    const p = cfg?.provider ?? 'anthropic';
    return p.charAt(0).toUpperCase() + p.slice(1);
  })();

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
        <div className={styles.sectionTitle}>ACCOUNT</div>

        <div className={styles.row} onBlur={onMcBlur}>
          <span className={styles.rowLabel}>Minecraft username</span>
          <span className={styles.rowEditor}>
            <TextField
              value={mcDraft}
              onChange={setMcDraft}
              monospace
              placeholder="—"
              aria-label="Minecraft username"
            />
          </span>
        </div>

        <div className={styles.row} onBlur={onPreferredBlur}>
          <span className={styles.rowLabel}>Preferred name</span>
          <span className={styles.rowEditor}>
            <TextField
              value={preferredDraft}
              onChange={setPreferredDraft}
              placeholder="—"
              aria-label="Preferred name"
            />
          </span>
        </div>

        <div className={styles.row}>
          <span className={styles.rowLabel}>Provider</span>
          <span className={styles.rowValue}>{providerDisplay}</span>
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
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>APPEARANCE</div>
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
      </section>
    </div>
  );
}
