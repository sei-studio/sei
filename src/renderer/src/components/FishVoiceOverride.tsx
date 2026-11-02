/**
 * A companion's own Fish Audio voice (261103), in Edit companion > Voice
 * while Fish Audio is the chosen local voice. The user pastes a fish.audio
 * voice link or id; main checks it with their key and stores it (main-owned
 * `fish_voice_overrides`, saved at once, not on Done). A picked voice plays
 * without the pitch setting; "Automatic" goes back to the voice Sei picks
 * from the companion's ElevenLabs voice and language.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { fishReasonText } from '../lib/fishVoice';
import { Button } from './Button';
import { TextField } from './TextField';
import styles from './FishVoiceOverride.module.css';

export interface FishVoicePick {
  id: string;
  name: string;
}

export function FishVoiceOverride({
  characterId,
  value,
  onChange,
}: {
  characterId: string;
  value: FishVoicePick | null;
  onChange: (next: FishVoicePick | null) => void;
}): React.ReactElement {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'checking' | 'preview' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      audioRef.current?.pause();
    };
  }, []);

  const onUse = async (): Promise<void> => {
    if (!draft.trim()) return;
    setBusy('checking');
    setError(null);
    try {
      const res = await sei.voiceFishOverrideSet({ characterId, input: draft });
      if (!alive.current) return;
      if (res.ok) {
        onChange(res.voice);
        setDraft('');
      } else {
        setError(fishReasonText(res.reason, t));
      }
    } catch {
      if (alive.current) setError(fishReasonText('failed', t));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const onReset = async (): Promise<void> => {
    setError(null);
    try {
      const res = await sei.voiceFishOverrideSet({ characterId, input: null });
      if (alive.current && res.ok) onChange(null);
    } catch {
      if (alive.current) setError(t('Failed to save. Try again.'));
    }
  };

  const onPreview = async (): Promise<void> => {
    if (!value) return;
    audioRef.current?.pause();
    setBusy('preview');
    setError(null);
    try {
      const res = await sei.voiceFishVoicePreview({ voiceId: value.id });
      if (!alive.current) return;
      if (!res.ok) {
        setError(fishReasonText(res.reason, t));
        return;
      }
      const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/mpeg' }));
      const el = new Audio(url);
      audioRef.current = el;
      const release = (): void => URL.revokeObjectURL(url);
      el.addEventListener('ended', release, { once: true });
      el.addEventListener('error', release, { once: true });
      await el.play().catch(() => undefined);
    } catch {
      if (alive.current) setError(fishReasonText('failed', t));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  return (
    <section className={styles.root} aria-label={t('Fish Audio voice')}>
      <div className={styles.head}>
        <span className={styles.title}>{t('Fish Audio voice')}</span>
        <span className={styles.current}>{value ? value.name : t('Automatic')}</span>
        {value ? (
          <>
            <Button kind="ghost" size="sm" disabled={busy !== null} onClick={() => void onPreview()}>
              {busy === 'preview' ? t('Loading…') : t('Preview')}
            </Button>
            <Button kind="quiet" size="sm" disabled={busy !== null} onClick={() => void onReset()}>
              {t('Use automatic')}
            </Button>
          </>
        ) : null}
      </div>
      <div className={styles.entry}>
        <TextField
          value={draft}
          onChange={setDraft}
          placeholder={t('Paste a fish.audio voice link')}
          onEnter={() => void onUse()}
          disabled={busy !== null}
          aria-label={t('Fish Audio voice link')}
        />
        <Button kind="primary" size="sm" disabled={busy !== null || !draft.trim()} onClick={() => void onUse()}>
          {busy === 'checking' ? t('Checking…') : t('Use voice')}
        </Button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <p className={styles.hint}>
        {value
          ? t('This voice plays without the pitch setting. It is saved right away.')
          : t('Sei picks a Fish Audio voice that matches this companion. Paste a voice link to choose your own.')}
      </p>
    </section>
  );
}
