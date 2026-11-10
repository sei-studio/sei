/**
 * Playtime > My keys (261110, product call 261110; mocks 04 and 05; the
 * mocks call it "Local").
 *
 * Not in use: one line and "Switch to my keys".
 * In use: Brain (provider, model, the saved key masked with Change key: the
 * BYOK rows that used to live in Settings > AI), what this week and this
 * month cost, the spend per day, the monthly alert, and Voice.
 *
 * Spend is OUR estimate: tokens counted on this device times a public
 * per-model price table (shared/llmUsage.ts). A model with no price shows
 * tokens instead. The alert only warns (one line), it never blocks.
 */
import React, { useEffect, useState } from 'react';
import type { UserConfig } from '@shared/characterSchema';
import { DEFAULT_MODELS } from '@shared/llmCatalog';
import {
  DEFAULT_SPEND_ALERT_USD,
  EMPTY_LEDGER,
  SPEND_ALERT_AMOUNTS,
  formatTokens,
  formatUsd,
  summarizeUsage,
} from '@shared/llmUsage';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useUsageStore } from '../../lib/stores/useUsageStore';
import { Button } from '../Button';
import { ProviderSelect, type Provider } from '../ProviderSelect';
import { TextField } from '../TextField';
import { Toggle } from '../Toggle';
import { ModelSelect, Row, SpendChart } from './PlaytimeParts';
import { VoicePanel } from './VoicePanel';
import styles from '../../screens/PlaytimeScreen.module.css';

const KEY_BULLETS = 16;
const NO_CHATGPT: readonly Provider[] = ['chatgpt'];

/** Splits a translated sentence around one placeholder, so a control can sit in it. */
export function splitAround(sentence: string, marker: string): [string, string] {
  const i = sentence.indexOf(marker);
  return i < 0 ? [sentence, ''] : [sentence.slice(0, i), sentence.slice(i + marker.length)];
}

export interface MyKeysTabProps {
  active: boolean;
  cfg: UserConfig | null;
  persist: (fn: (c: UserConfig) => UserConfig) => Promise<boolean>;
  signedIn: boolean;
  onSwitch: () => void;
}

export function MyKeysTab({ active, cfg, persist, signedIn, onSwitch }: MyKeysTabProps): React.ReactElement {
  const t = useT();
  if (!active) {
    return (
      <div className={styles.invite} data-testid="mykeys-invite">
        <p className={styles.inviteLine}>{t('Use your own API key or a model on your computer.')}</p>
        <Button kind="primary" size="md" onClick={onSwitch}>
          {t('Switch to my keys')}
        </Button>
      </div>
    );
  }
  if (!cfg) return <></>;
  return (
    <>
      <BrainSection cfg={cfg} persist={persist} />
      <SpendSection cfg={cfg} persist={persist} />
      <VoicePanel mode="mykeys" cfg={cfg} persist={persist} signedIn={signedIn} />
    </>
  );
}

function BrainSection({
  cfg,
  persist,
}: {
  cfg: UserConfig;
  persist: MyKeysTabProps['persist'];
}): React.ReactElement {
  const t = useT();
  const provider = (cfg.provider ?? 'anthropic') as Provider;
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const keyless = provider === 'ollama';

  useEffect(() => {
    let alive = true;
    void sei.hasApiKey().then(
      (b) => {
        if (alive) setHasKey(b);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const stored = (() => {
    const entry = (cfg.provider_config as Record<string, unknown> | undefined)?.[provider];
    const m = entry && typeof entry === 'object' ? (entry as { model?: unknown }).model : undefined;
    return typeof m === 'string' && m.trim() ? m.trim() : undefined;
  })();
  const model = stored ?? DEFAULT_MODELS[provider];

  const onPickModel = (id: string): void => {
    void persist((c) => {
      const pc = { ...((c.provider_config as Record<string, unknown> | undefined) ?? {}) };
      const prev = pc[provider];
      pc[provider] = { ...(prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}), model: id };
      return { ...c, provider_config: pc };
    });
  };

  // A different vendor: the saved key belongs to the old one (it would 401
  // against the new endpoint), so it is cleared and the editor opens (the
  // Settings rule since ui-A1). Ollama needs no key.
  const onChangeProvider = async (next: Provider): Promise<void> => {
    if (next === provider || next === 'chatgpt') return;
    const ok = await persist((c) => ({ ...c, provider: next, provider_config: c.provider_config ?? {} }));
    if (!ok) return;
    try {
      await sei.saveApiKey('');
      setHasKey(false);
    } catch {
      /* best-effort */
    }
    setEditing(next !== 'ollama');
    setDraft('');
    setError(null);
  };

  const onSaveKey = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError(t('API key cannot be empty.'));
      return;
    }
    try {
      await sei.saveApiKey(trimmed);
      setHasKey(await sei.hasApiKey());
      setDraft('');
      setEditing(false);
      setError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Playtime] saveApiKey failed', err);
      setError(t('Failed to save key. Try again.'));
    }
  };

  return (
    <section className={styles.section} aria-label={t('Brain')}>
      <h3 className={styles.sectionTitle}>{t('Brain')}</h3>
      <div className={styles.panel}>
        <Row
          testId="mykeys-brain"
          label={<ProviderSelect value={provider} onChange={(p) => void onChangeProvider(p)} compact exclude={NO_CHATGPT} />}
        >
          {editing ? (
            <span className={styles.editor}>
              <TextField
                value={draft}
                onChange={setDraft}
                type="password"
                placeholder="sk-…"
                autoFocus
                onEnter={() => void onSaveKey()}
                aria-label={t('API key')}
              />
              <Button kind="primary" size="sm" onClick={() => void onSaveKey()}>
                {t('Save')}
              </Button>
              <Button
                kind="quiet"
                size="sm"
                onClick={() => {
                  setDraft('');
                  setEditing(false);
                  setError(null);
                }}
              >
                {t('Cancel')}
              </Button>
            </span>
          ) : (
            <>
              <ModelSelect
                provider={provider}
                value={model}
                enabled={hasKey || keyless}
                onPick={onPickModel}
                onError={setListError}
              />
              {keyless ? (
                <span className={styles.mono}>{t('No key needed')}</span>
              ) : (
                <>
                  <span className={hasKey ? styles.mono : `${styles.mono} ${styles.warn}`}>
                    {hasKey ? '•'.repeat(KEY_BULLETS) : t('Not set')}
                  </span>
                  <Button kind="ghost" size="sm" onClick={() => setEditing(true)}>
                    {hasKey ? t('Change key') : t('Add key')}
                  </Button>
                </>
              )}
            </>
          )}
        </Row>
      </div>
      {error ? (
        <p className={`${styles.note} ${styles.noteError}`} role="alert">
          {error}
        </p>
      ) : listError && !editing ? (
        <p className={`${styles.note} ${styles.noteError}`} role="alert">
          {listError}
        </p>
      ) : null}
    </section>
  );
}

function SpendSection({
  cfg,
  persist,
}: {
  cfg: UserConfig;
  persist: MyKeysTabProps['persist'];
}): React.ReactElement {
  const t = useT();
  const summary = useUsageStore((s) => s.summary) ?? summarizeUsage(EMPTY_LEDGER, new Date());
  const enabled = cfg.spend_alert_enabled === true;
  const amount = cfg.spend_alert_usd ?? DEFAULT_SPEND_ALERT_USD;
  const amounts: number[] = (SPEND_ALERT_AMOUNTS as readonly number[]).includes(amount)
    ? [...SPEND_ALERT_AMOUNTS]
    : [...SPEND_ALERT_AMOUNTS, amount].sort((a, b) => a - b);

  // A stat shows dollars when anything was priced, else the raw tokens of a
  // model with no price (never an invented figure).
  const stat = (usd: number, unpriced: number): { value: string; sub: string | null } => {
    if (usd > 0 || unpriced === 0) {
      return { value: formatUsd(usd), sub: unpriced > 0 ? t('+{n} tokens not priced', { n: formatTokens(unpriced) }) : null };
    }
    return { value: formatTokens(unpriced), sub: t('tokens') };
  };
  const week = stat(summary.spendWeekUsd ?? 0, summary.unpricedTokensWeek ?? 0);
  const month = stat(summary.spendMonthUsd ?? 0, summary.unpricedTokensMonth ?? 0);

  const setAlert = (nextEnabled: boolean, nextUsd: number): void => {
    void persist((c) => ({ ...c, spend_alert_enabled: nextEnabled, spend_alert_usd: nextUsd })).then((ok) => {
      if (ok) sei.track('spend_alert_toggled', { enabled: nextEnabled, limit_usd: nextUsd });
    });
  };

  const MARK = '\u0001';
  const [before, after] = splitAround(t('Alert me at {amount} a month', { amount: MARK }), MARK);

  return (
    <>
      <div className={styles.spendGrid}>
        <div className={styles.stats}>
          <div className={styles.stat} data-testid="spend-week">
            <span className={styles.statLabel}>{t('This week')}</span>
            <span className={styles.statValue}>{week.value}</span>
            {week.sub ? <span className={styles.statSub}>{week.sub}</span> : null}
          </div>
          <div className={styles.stat} data-testid="spend-month">
            <span className={styles.statLabel}>{t('This month')}</span>
            <span className={styles.statValue}>{month.value}</span>
            {month.sub ? <span className={styles.statSub}>{month.sub}</span> : null}
          </div>
        </div>
        <SpendChart days={summary.days} />
      </div>
      <div className={styles.panel}>
        <Row
          testId="spend-alert"
          label={
            <span>
              {before}
              <select
                className={`${styles.select} ${styles.selectSans}`}
                aria-label={t('Alert amount')}
                value={amount}
                onChange={(e) => setAlert(enabled, Number(e.target.value))}
              >
                {amounts.map((n) => (
                  <option key={n} value={n}>
                    {`$${n}`}
                  </option>
                ))}
              </select>
              {after}
            </span>
          }
        >
          <Toggle on={enabled} onChange={(v) => setAlert(v, amount)} aria-label={t('Spend alert')} />
        </Row>
      </div>
    </>
  );
}
