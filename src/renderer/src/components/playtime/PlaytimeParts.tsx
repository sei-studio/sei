/**
 * Small pieces the Playtime tabs share (261110, product call 261110): the
 * borderless choice control, the panel row, the 7-day mini bars, the spend
 * chart, the model select and the copy for a typed model-list error.
 * Styling: screens/PlaytimeScreen.module.css (tokens only).
 */
import React, { useEffect, useState } from 'react';
import { PROVIDER_REGION_COPY, PROVIDER_REGION_FALLBACK_NAME, PROVIDER_REGION_TOKEN, regionProviderLabel } from '@shared/providerRegion';
import { formatTokens, formatUsd, type UsageDayPoint } from '@shared/llmUsage';
import type { LlmListModelsResult } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { uiLocale, useT } from '../../lib/i18n';
import type { Provider } from '../ProviderSelect';
import styles from '../../screens/PlaytimeScreen.module.css';

type Translate = (en: string, params?: Record<string, string | number>) => string;

/** A borderless segmented choice (the shared Seg draws a border). */
export function Choice<V extends string>(props: {
  value: V;
  options: ReadonlyArray<{ value: V; label: string; disabled?: boolean }>;
  onChange: (v: V) => void;
  'aria-label': string;
}): React.ReactElement {
  return (
    <div className={styles.choice} role="radiogroup" aria-label={props['aria-label']}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            className={on ? `${styles.choiceOpt} ${styles.choiceOptOn}` : styles.choiceOpt}
            onClick={() => {
              if (!on) props.onChange(o.value);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A panel row: label left, everything else right. */
export function Row(props: { label: React.ReactNode; children?: React.ReactNode; testId?: string }): React.ReactElement {
  return (
    <div className={styles.row} data-testid={props.testId}>
      <span className={styles.rowLabel}>{props.label}</span>
      {props.children ? <span className={styles.rowEnd}>{props.children}</span> : null}
    </div>
  );
}

/** Short weekday name for a local YYYY-MM-DD day key, in the UI language. */
export function weekdayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(uiLocale(), { weekday: 'short' }).format(new Date(y, m - 1, d));
  } catch {
    return dayKey.slice(5);
  }
}

/** Seven tiny bars, oldest first, today last (ChatGPT replies per day). */
export function MiniBars(props: { values: number[]; label: string }): React.ReactElement {
  const max = Math.max(1, ...props.values);
  return (
    <span className={styles.miniBars} role="img" aria-label={props.label}>
      {props.values.map((v, i) => (
        <span
          key={i}
          className={i === props.values.length - 1 ? `${styles.miniBar} ${styles.miniBarToday}` : styles.miniBar}
          style={{ height: `${Math.max(10, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </span>
  );
}

/**
 * Spend per day for the last seven days. A day with tokens on a model we
 * have no price for shows its tokens instead (never a made-up dollar figure).
 * The tallest day carries its value label, like the mock.
 */
export function SpendChart(props: { days: UsageDayPoint[] }): React.ReactElement {
  const t = useT();
  const priced = props.days.some((d) => d.spendUsd > 0);
  const valueOf = (d: UsageDayPoint): number => (priced ? d.spendUsd : d.unpricedTokens);
  const max = Math.max(0, ...props.days.map(valueOf));
  const peak = max > 0 ? props.days.findIndex((d) => valueOf(d) === max) : -1;
  const last = props.days.length - 1;
  return (
    <div className={styles.chart} data-testid="spend-chart">
      <span className={styles.chartTitle}>{priced || max === 0 ? t('Spend per day') : t('Tokens per day')}</span>
      <div className={styles.chartBars}>
        {props.days.map((d, i) => {
          const v = valueOf(d);
          const pct = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 2;
          return (
            <div key={d.day} className={styles.chartCol}>
              <span className={styles.chartValue} aria-hidden={i !== peak}>
                {i === peak ? (priced ? formatUsd(v) : formatTokens(v)) : ' '}
              </span>
              <span className={styles.chartBarTrack}>
                <span
                  className={i === last ? `${styles.chartBar} ${styles.chartBarToday}` : styles.chartBar}
                  style={{ height: `${pct}%` }}
                />
              </span>
              <span className={i === last ? `${styles.chartDay} ${styles.chartDayToday}` : styles.chartDay}>
                {weekdayLabel(d.day)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Human line for a typed llm error token (moved from Settings, 261110). */
export function llmErrorText(token: string, provider: Provider, t: Translate): string {
  if (token === 'no_api_key') return t('Add your API key first.');
  if (token === PROVIDER_REGION_TOKEN) {
    const name = regionProviderLabel(provider);
    return t(PROVIDER_REGION_COPY, { provider: name === PROVIDER_REGION_FALLBACK_NAME ? t(name) : name });
  }
  if (token === 'unauthorized') return t('The provider rejected your key. Check that it is correct and active.');
  if (token === 'timeout') return t('Timed out. Check your connection and try again.');
  if (token === 'network') return t('Could not reach the provider. Check your connection.');
  if (token === 'chatgpt_signed_out') return t('Sign in with ChatGPT first.');
  if (token === 'chatgpt_plan_disabled') return t('Turn on ChatGPT plan use first.');
  if (token === 'chatgpt_usage_limit') return t("You've reached your ChatGPT plan's usage limit.");
  if (token === 'chatgpt_not_eligible' || token === 'chatgpt_forbidden')
    return t("This ChatGPT account can't use its plan in Sei.");
  if (token.startsWith('http_')) return t('The provider returned an error (HTTP {status}).', { status: token.slice(5) });
  return t('Something went wrong. Try again.');
}

/**
 * The model select: the provider's live list (llm:list-models), the stored
 * model (or the default) selected. Writes provider_config[provider].model
 * through onPick. Models that cannot see images are marked in the option.
 */
export function ModelSelect(props: {
  provider: Provider;
  value: string;
  /** False until the provider can list (no key yet): shows the value only. */
  enabled: boolean;
  onPick: (modelId: string) => void;
  onError?: (line: string | null) => void;
}): React.ReactElement {
  const t = useT();
  const { provider, enabled, onError } = props;
  const [list, setList] = useState<LlmListModelsResult | null>(null);
  useEffect(() => {
    setList(null);
    onError?.(null);
    if (!enabled) return;
    let alive = true;
    sei.llmListModels(provider).then(
      (r) => {
        if (!alive) return;
        setList(r);
        onError?.(r.error ? llmErrorText(r.error, provider, t) : null);
      },
      () => {
        if (alive) setList({ models: [], error: 'unknown' });
      },
    );
    return () => {
      alive = false;
    };
    // t and onError are stable enough; re-listing on every render would spam the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, enabled]);
  const models = list?.models ?? [];
  const options = models.some((m) => m.id === props.value)
    ? models
    : [{ id: props.value, label: props.value, vision: 'unknown' as const }, ...models];
  return (
    <select
      className={styles.select}
      aria-label={t('Model')}
      value={props.value}
      disabled={!enabled || models.length === 0}
      onChange={(e) => props.onPick(e.target.value)}
    >
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {(m.label ?? m.id) + (m.vision === 'no' ? ` (${t('no vision')})` : '')}
        </option>
      ))}
    </select>
  );
}
