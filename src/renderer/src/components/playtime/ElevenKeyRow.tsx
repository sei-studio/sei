/**
 * The ElevenLabs key row (Playtime, 261110; moved from Settings > Voice).
 * Write-only: the raw key never comes back to the renderer, only whether one
 * is saved. 'byok' (an off-cloud setup speaking through the key) warns when
 * it is missing; 'cloud-optional' (Sei tab: voices from the user's own
 * ElevenLabs account, 261020 T158) treats "Not set" as a plain state.
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import { TextField } from '../TextField';
import { Row } from './PlaytimeParts';
import styles from '../../screens/PlaytimeScreen.module.css';

const KEY_BULLETS = 16;

export function ElevenKeyRow({ mode }: { mode: 'byok' | 'cloud-optional' }): React.ReactElement {
  const t = useT();
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void sei
      .voiceElevenKeyStatus()
      .then(({ present }) => {
        if (alive) setHasKey(present);
      })
      .catch(() => {
        /* the row shows "Not set" */
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError(t('Key cannot be empty.'));
      return;
    }
    try {
      await sei.voiceElevenKeySet({ key: trimmed });
      const { present } = await sei.voiceElevenKeyStatus();
      setHasKey(present);
      setDraft('');
      setEditing(false);
      setError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Playtime] voiceElevenKeySet failed', err);
      setError(t('Failed to save key. Try again.'));
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await sei.voiceElevenKeySet({ key: null });
      setHasKey(false);
      setError(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Playtime] voiceElevenKeySet (clear) failed', err);
      setError(t('Failed to remove key. Try again.'));
    }
  };

  return (
    <>
      <Row
        testId="eleven-key-row"
        label={
          <>
            {t('ElevenLabs key')}
            {mode === 'cloud-optional' ? (
              <InfoTip
                label={t('About the ElevenLabs key')}
                text={t(
                  "Only for voices in your own ElevenLabs account. Sei's voices and voice recognition keep running on Sei Cloud and never use this key.",
                )}
              />
            ) : null}
          </>
        }
      >
        {editing ? (
          <span className={styles.editor}>
            <TextField
              value={draft}
              onChange={setDraft}
              type="password"
              placeholder={t('Your ElevenLabs key')}
              autoFocus
              onEnter={() => void save()}
              aria-label={t('ElevenLabs key')}
            />
            <Button kind="primary" size="sm" onClick={() => void save()}>
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
            <span className={hasKey || mode === 'cloud-optional' ? styles.mono : `${styles.mono} ${styles.warn}`}>
              {hasKey ? '•'.repeat(KEY_BULLETS) : t('Not set')}
            </span>
            {hasKey ? (
              <Button kind="quiet" size="sm" onClick={() => void remove()}>
                {t('Remove')}
              </Button>
            ) : null}
            <Button kind="secondary" size="sm" onClick={() => setEditing(true)}>
              {hasKey ? t('Change key') : t('Set')}
            </Button>
          </>
        )}
      </Row>
      {error ? (
        <p className={`${styles.note} ${styles.noteError}`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
