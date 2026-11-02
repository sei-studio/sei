/**
 * Settings > Voice > Local voice > Fish Audio (261103): the user's own Fish
 * Audio key (write-only, like the ElevenLabs key: only its presence comes
 * back), where to get a free one, a Test button that speaks one line, and
 * the plain privacy line. Rendered only while Fish Audio is the chosen local
 * voice, which itself only shows in local (BYOK) mode.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FISH_API_KEYS_URL } from '@shared/fishVoices';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { fishReasonText } from '../../lib/fishVoice';
import { Button } from '../Button';
import { TextField } from '../TextField';
import styles from '../../screens/SettingsScreen.module.css';

/** Bullets standing in for a stored key (same count as the other key rows). */
const KEY_BULLETS = 24;

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; text: string };

export function FishAudioSettings(): React.ReactElement {
  const t = useT();
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    void sei
      .voiceFishKeyStatus()
      .then(({ present }) => {
        if (alive) setHasKey(present);
      })
      .catch(() => {
        /* non-fatal: the row shows "Not set" */
      });
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, []);

  const onSave = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setKeyError(t('Key cannot be empty.'));
      return;
    }
    try {
      await sei.voiceFishKeySet({ key: trimmed });
      const { present } = await sei.voiceFishKeyStatus();
      setHasKey(present);
      setDraft('');
      setEditing(false);
      setKeyError(null);
      setTest({ kind: 'idle' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[FishAudioSettings] voiceFishKeySet failed', err);
      setKeyError(t('Failed to save key. Try again.'));
    }
  };

  const onRemove = async (): Promise<void> => {
    try {
      await sei.voiceFishKeySet({ key: null });
      setHasKey(false);
      setKeyError(null);
      setTest({ kind: 'idle' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[FishAudioSettings] voiceFishKeySet (clear) failed', err);
      setKeyError(t('Failed to remove key. Try again.'));
    }
  };

  const onTest = async (): Promise<void> => {
    audioRef.current?.pause();
    setTest({ kind: 'testing' });
    try {
      const res = await sei.voiceFishTest();
      if (!res.ok) {
        setTest({ kind: 'error', text: fishReasonText(res.reason, t) });
        return;
      }
      const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/mpeg' }));
      const el = new Audio(url);
      audioRef.current = el;
      const release = (): void => URL.revokeObjectURL(url);
      el.addEventListener('ended', release, { once: true });
      el.addEventListener('error', release, { once: true });
      await el.play().catch(() => undefined);
      setTest({ kind: 'ok' });
    } catch {
      setTest({ kind: 'error', text: fishReasonText('failed', t) });
    }
  };

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>{t('Fish Audio key')}</span>
        {editing ? (
          <span className={styles.editor}>
            <TextField
              value={draft}
              onChange={setDraft}
              type="password"
              placeholder={t('Your Fish Audio key')}
              autoFocus
              onEnter={() => void onSave()}
              aria-label={t('Fish Audio key')}
            />
            <Button kind="primary" size="sm" onClick={() => void onSave()}>
              {t('Save')}
            </Button>
            <Button
              kind="quiet"
              size="sm"
              onClick={() => {
                setDraft('');
                setEditing(false);
                setKeyError(null);
              }}
            >
              {t('Cancel')}
            </Button>
          </span>
        ) : (
          <>
            <span className={hasKey ? styles.monoValue : `${styles.monoValue} ${styles.statusWarn}`}>
              {hasKey ? '•'.repeat(KEY_BULLETS) : t('Not set')}
            </span>
            <Button kind="ghost" size="sm" onClick={() => setEditing(true)}>
              {hasKey ? t('Update') : t('Set')}
            </Button>
            {hasKey ? (
              <>
                <Button kind="ghost" size="sm" disabled={test.kind === 'testing'} onClick={() => void onTest()}>
                  {test.kind === 'testing' ? t('Testing…') : t('Test')}
                </Button>
                <Button kind="quiet" size="sm" onClick={() => void onRemove()}>
                  {t('Remove')}
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
      {keyError ? <div className={styles.errorRow}>{keyError}</div> : null}
      {test.kind === 'error' ? (
        <div className={styles.errorRow} role="alert">
          {test.text}
        </div>
      ) : null}
      {test.kind === 'ok' ? (
        <p className={`${styles.helper} ${styles.statusOk}`} role="status">
          {t('Fish Audio works.')}
        </p>
      ) : null}
      <p className={styles.helper}>
        {t("Fish Audio is an online service. Sei uses its free model and sends your companions' lines to Fish Audio to be spoken.")}{' '}
        <button type="button" className={styles.creditLink} onClick={() => void sei.openExternal(FISH_API_KEYS_URL)}>
          {t('Get a free key')}
        </button>
      </p>
    </>
  );
}
