/**
 * SearchSettingsSection â€” the web search rows in Settings (260909), shown as
 * the "Web search" tab of the "Games & search" group since 261023.
 *
 * Optional. Companions can look things up on the web through the search /
 * visit tools on every surface. The default is a free keyless chain that
 * needs no setup, so a normal user never opens this tab; it exists for the
 * user whose network gets challenged by the scrapers and who wants to plug in
 * their own key.
 *
 * 'auto' is the free keyless chain; the three keyed providers need a key from
 * the user's own account. Switching provider keeps any stored key (a user
 * toggling back to Auto to compare and then returning should not have to
 * paste it again). The key is the same masked-editor pattern as the AI key
 * row and lives in config.json (web_search_*), never in the keychain, because
 * these keys are low-value and provider-scoped.
 *
 * Saves go through SettingsScreen's persistConfig (save first, then adopt),
 * exactly as when these rows lived in their own group.
 */
import React, { useState } from 'react';
import type { UserConfig } from '@shared/characterSchema';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import { Seg } from '../Seg';
import { TextField } from '../TextField';
import styles from '../../screens/SettingsScreen.module.css';

type SearchProvider = 'auto' | 'brave' | 'tavily' | 'serper';

/** Same bullet run as the AI key row. */
const KEY_BULLET_LEN = 24;

export function SearchSettingsSection({
  config,
  saveConfig,
}: {
  config: UserConfig | null;
  /** Persist a whole config (SettingsScreen's persistConfig). */
  saveConfig: (next: UserConfig) => Promise<void>;
}): React.ReactElement {
  const t = useT();
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [keyDraft, setKeyDraft] = useState<string>('');

  const provider: SearchProvider = ((): SearchProvider => {
    const v = config?.web_search_provider;
    return v === 'brave' || v === 'tavily' || v === 'serper' ? v : 'auto';
  })();
  const hasKey = Boolean(config?.web_search_api_key);

  const onChangeProvider = async (next: SearchProvider): Promise<void> => {
    if (!config || next === provider) return;
    await saveConfig({ ...config, web_search_provider: next });
  };
  const onSaveKey = async (): Promise<void> => {
    const key = keyDraft.trim();
    if (!config || !key) return;
    await saveConfig({ ...config, web_search_api_key: key });
    setEditingKey(false);
    setKeyDraft('');
  };
  const onClearKey = async (): Promise<void> => {
    if (!config) return;
    await saveConfig({ ...config, web_search_api_key: '' });
    setEditingKey(false);
    setKeyDraft('');
  };
  const onCancelKey = (): void => {
    setEditingKey(false);
    setKeyDraft('');
  };

  return (
    <>
      <p className={styles.helper}>
        {t(
          'Companions can look things up on the web while you chat or play. This works out of the box for free. Add your own search API key only if lookups keep failing.',
        )}
      </p>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Search provider')}
          <InfoTip
            label={t('About search providers')}
            text={t(
              'Auto uses free public search with no account. Brave, Tavily and Serper need an API key from their website; each has a free tier.',
            )}
          />
        </span>
        <Seg<SearchProvider>
          aria-label={t('Search provider')}
          value={provider}
          onChange={(v) => void onChangeProvider(v)}
          options={[
            { value: 'auto', label: t('Auto (free)') },
            { value: 'brave', label: 'Brave' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'serper', label: 'Serper' },
          ]}
        />
      </div>
      {provider !== 'auto' ? (
        <div className={styles.row}>
          <span className={styles.label}>{t('Search API key')}</span>
          {editingKey ? (
            <span className={styles.editor}>
              <TextField
                value={keyDraft}
                onChange={setKeyDraft}
                type="password"
                placeholder={t('Paste your key')}
                autoFocus
                onEnter={() => void onSaveKey()}
                aria-label={t('Search API key')}
              />
              <Button kind="primary" size="sm" onClick={() => void onSaveKey()}>
                {t('Save')}
              </Button>
              <Button kind="quiet" size="sm" onClick={onCancelKey}>
                {t('Cancel')}
              </Button>
            </span>
          ) : (
            <>
              <span className={hasKey ? styles.monoValue : `${styles.monoValue} ${styles.statusWarn}`}>
                {hasKey ? 'â€¢'.repeat(KEY_BULLET_LEN) : t('Not set')}
              </span>
              <Button kind="ghost" size="sm" onClick={() => setEditingKey(true)}>
                {hasKey ? t('Update') : t('Set')}
              </Button>
              {hasKey ? (
                <Button kind="quiet" size="sm" onClick={() => void onClearKey()}>
                  {t('Clear')}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {provider !== 'auto' && !hasKey ? (
        <p className={styles.helper}>{t('Without a key, search falls back to the free providers.')}</p>
      ) : null}
    </>
  );
}




