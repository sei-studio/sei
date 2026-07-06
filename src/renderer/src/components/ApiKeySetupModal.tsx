/**
 * ApiKeySetupModal — BYOK ("use my own API key") setup prompt.
 *
 * Opened from HardStopModal's "Use my own API key" CTA. Prompts the user to
 * pick a model provider and paste an API key, then switches the AI backend to
 * local (BYOK) mode — the focused escape hatch from cloud playtime. Renders on
 * ModalShell's 'stacked' tier so it sits above the HardStopModal that opened it.
 *
 * Commit ordering (mirrors OnboardingScreen.tsx final submit): saveConfig
 * BEFORE saveApiKey BEFORE proxyConfigure('local'). The backend is only flipped
 * once the key is in hand, so a cancel — or any failure — leaves the user
 * exactly where they were (cloud-proxy, still hard-stopped). On a thrown step we
 * surface an inline error and keep the modal mounted for a clean retry.
 *
 * proxyConfigure('local') is the source of truth for the backend flip — it
 * persists ai_backend_kind via apiKeyStore.setAiBackendKind AND live-switches
 * the running bot (main/ipc.ts proxy.configure handler). We still write
 * ai_backend_kind:'local' through saveConfig so the persisted UserConfig agrees.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { ProviderSelect, type Provider } from './ProviderSelect';
import { TextField } from './TextField';
import styles from './ApiKeySetupModal.module.css';

// Mirrors OnboardingScreen's step-3 label map so the key prompt names the
// selected provider ("Paste your Anthropic API key").
const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
  grok: 'Grok',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  together: 'Together',
  groq: 'Groq',
  fireworks: 'Fireworks',
  cerebras: 'Cerebras',
  perplexity: 'Perplexity',
};

export interface ApiKeySetupModalProps {
  /** Close without switching — returns to the hard-stop modal. */
  onCancel: () => void;
  /** Provider + key saved and the backend switched to local. */
  onComplete: () => void;
}

export function ApiKeySetupModal({ onCancel, onComplete }: ApiKeySetupModalProps): React.ReactElement {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Pre-select the provider the user last configured (best-effort — falls back
  // to the 'anthropic' default if the config read fails).
  useEffect(() => {
    let cancelled = false;
    void sei
      .getConfig()
      .then((cfg) => {
        if (!cancelled && cfg.provider) setProvider(cfg.provider as Provider);
      })
      .catch(() => {
        /* keep the default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key) {
      setError('API key cannot be empty.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Spread the existing config so the provider + backend flip don't clobber
      // mc_username / preferred_name / theme etc. (saveConfig replaces wholesale).
      const cfg = await sei.getConfig();
      await sei.saveConfig({
        ...cfg,
        provider,
        provider_config: cfg.provider_config ?? {},
        ai_backend_kind: 'local',
      });
      await sei.saveApiKey(key);
      await sei.proxyConfigure('local');
      onComplete();
    } catch {
      setError("Couldn't save your key. Try again.");
      setSaving(false);
    }
  };

  const providerLabel = PROVIDER_LABELS[provider] ?? 'API';
  const canSave = apiKey.trim() !== '' && !saving;

  return (
    <ModalShell title="Use your own API key" tier="stacked" onClose={onCancel} escClose={false}>
      <p className={styles.body}>
        Pick a provider and paste a key. Sei runs on your key instead of playtime.
      </p>
      <ProviderSelect value={provider} onChange={setProvider} compact />
      <div className={styles.keyField}>
        <span className={styles.fieldLabel}>Paste your {providerLabel} API key</span>
        <TextField
          value={apiKey}
          onChange={(v) => {
            setApiKey(v);
            setError(null);
          }}
          type="password"
          monospace
          placeholder="sk-…"
          autoFocus
          onEnter={() => {
            if (canSave) void save();
          }}
          aria-label="API key"
          aria-invalid={!!error}
        />
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      <ModalFooter>
        <Button kind="quiet" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button kind="primary" disabled={!canSave} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save & switch'}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
