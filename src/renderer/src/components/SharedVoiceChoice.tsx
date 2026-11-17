/**
 * SharedVoiceChoice (261019) — "Others will hear" for a character whose voice
 * is the author's own ElevenLabs voice.
 *
 * An own voice only plays in the author's ElevenLabs account, so anyone else
 * who invites the character hears a Sei pool voice. This is the one line and
 * one control that make that visible and choosable: a select of Sei's voices
 * whose first option is the close match main rolls for adopters (the
 * default, stored as an ABSENT metadata.voiceShared), plus a sample button.
 * Used in the publish confirm (CharacterPage), the creation flow's visibility
 * step, and Edit companion > Voice. `SharedVoiceLabel` is the read-only
 * "Voice for others: <name>" line on the character page.
 *
 * Samples play the bundled pool clip (instant, offline, no spend) at the
 * character's pitch, falling back to a live preview when the clip fails.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import type { VoiceInfo } from '@shared/ipc';
import { assetPathFor } from '../lib/voicePicker';
import {
  effectiveSharedVoice,
  poolVoiceLabel,
  sharedVoiceForChange,
  sharedVoiceGroups,
  validSharedVoice,
} from '../lib/sharedVoice';
import { attach as attachPitch } from '../lib/voice/pitchBus';
import { PlayIcon, StopIcon } from './icons';
import styles from './SharedVoiceChoice.module.css';
import { userChatLanguage } from '@shared/chatLanguage';
import { applyOutputSink } from '../lib/voice/audioDevices';

/** The pool + the default close match for one character. `ownGender` stands
 * in for the stored own-voice gender while an own pick is still unsaved. */
export function useSharedVoiceInfo(
  characterId: string | null,
  ownGender: string | undefined,
): { pool: VoiceInfo[]; defaultId: string | null } {
  const [pool, setPool] = useState<VoiceInfo[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void sei
      .voiceListVoices()
      .then((v) => {
        if (alive) setPool(v);
      })
      .catch(() => {
        /* no pool: the chooser shows only the default */
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!characterId) return;
    let alive = true;
    setDefaultId(null);
    try {
      void sei
        .voiceSharedDefault({ characterId, ...(ownGender ? { ownGender } : {}) })
        .then((r) => {
          if (alive) setDefaultId(r.voiceId);
        })
        .catch(() => {
          /* leave the default unnamed */
        });
    } catch {
      /* stale preload without the channel */
    }
    return () => {
      alive = false;
    };
  }, [characterId, ownGender]);
  return { pool, defaultId };
}

export interface SharedVoiceChoiceProps {
  characterId: string;
  /** Gender of the own voice picked right now (unsaved picks included). */
  ownGender?: string;
  /** Stored metadata.voiceShared (null / junk = the default close match). */
  value: string | null;
  /** null = the default close match; else a pool voice id. */
  onChange: (voiceId: string | null) => void;
  /** Playback pitch (metadata.voicePitch): others hear the voice at it too. */
  pitch?: number;
  disabled?: boolean;
}

export function SharedVoiceChoice({
  characterId,
  ownGender,
  value,
  onChange,
  pitch = 1,
  disabled = false,
}: SharedVoiceChoiceProps): React.ReactElement {
  const t = useT();
  const { pool, defaultId } = useSharedVoiceInfo(characterId, ownGender);
  const chosen = validSharedVoice(value, pool);
  const effective = effectiveSharedVoice(value, defaultId, pool);
  const defaultLabel = poolVoiceLabel(defaultId, pool);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const langRef = useRef('en');

  useEffect(() => {
    void sei
      .getConfig()
      .then((c) => {
        langRef.current = userChatLanguage(c);
      })
      .catch(() => {
        /* keep 'en' */
      });
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A different voice makes the playing sample stale.
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective]);

  function stop(): void {
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
      } catch {
        /* already torn down */
      }
    }
    detachRef.current?.();
    detachRef.current = null;
    audioRef.current = null;
    setPlaying(false);
  }

  function play(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const el = new Audio(url);
      void applyOutputSink(el); // 261118: the speaker picked in Settings
      detachRef.current = attachPitch(el, pitch);
      audioRef.current = el;
      el.addEventListener('ended', () => {
        if (audioRef.current === el) stop();
      }, { once: true });
      el.addEventListener('error', () => {
        if (audioRef.current === el) stop();
        resolve(false);
      }, { once: true });
      setPlaying(true);
      void el.play().then(
        () => resolve(true),
        () => {
          if (audioRef.current === el) stop();
          resolve(false);
        },
      );
    });
  }

  async function toggleSample(): Promise<void> {
    if (playing) {
      stop();
      return;
    }
    if (!effective) return;
    setError(null);
    if (await play(assetPathFor(effective, langRef.current))) return;
    setLoading(true);
    try {
      const buf = await sei.voicePreview({ voiceId: effective });
      if (!(await play(URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))))) {
        setError(t('Sample unavailable right now.'));
      }
    } catch {
      setError(t('Sample unavailable right now.'));
    } finally {
      setLoading(false);
    }
  }

  const effectiveLabel = poolVoiceLabel(effective, pool) ?? t('Sei voice');
  const groups = sharedVoiceGroups(pool);

  return (
    <div className={styles.root}>
      <p className={styles.line}>
        {t("Your voice is from your ElevenLabs account, so others can't play it. Others will hear:")}
      </p>
      <div className={styles.controls}>
        <select
          className={styles.select}
          value={chosen && chosen !== defaultId ? chosen : ''}
          disabled={disabled}
          aria-label={t('Voice others will hear')}
          onChange={(e) => onChange(sharedVoiceForChange(e.target.value, defaultId, pool))}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <option value="">
            {defaultLabel
              ? t('Closest Sei voice ({name})', { name: defaultLabel })
              : t('Closest Sei voice')}
          </option>
          {groups.map((g) => (
            <optgroup key={g.key} label={t(g.title)}>
              {g.voices
                .filter((v) => v.id !== defaultId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className={styles.playBtn}
          aria-label={
            playing
              ? t('Stop {name} sample', { name: effectiveLabel })
              : t('Play {name} sample', { name: effectiveLabel })
          }
          title={
            playing
              ? t('Stop {name} sample', { name: effectiveLabel })
              : t('Play {name} sample', { name: effectiveLabel })
          }
          disabled={!effective || loading}
          onClick={() => void toggleSample()}
        >
          {loading ? (
            <span className={styles.loadingDot} aria-hidden="true" />
          ) : playing ? (
            <StopIcon size={14} />
          ) : (
            <PlayIcon size={14} />
          )}
        </button>
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}

/** Read-only "Voice for others: <name>" (character page, author only). */
export function SharedVoiceLabel({
  characterId,
  value,
  onChange,
}: {
  characterId: string;
  value: string | null;
  /** Opens the editor at Voice; omitted when the author cannot edit. */
  onChange?: () => void;
}): React.ReactElement {
  const t = useT();
  const { pool, defaultId } = useSharedVoiceInfo(characterId, undefined);
  const label = poolVoiceLabel(effectiveSharedVoice(value, defaultId, pool), pool);
  return (
    <div className={styles.labelRow}>
      <span>{label ? t('Voice for others: {name}', { name: label }) : t('Voice for others: a Sei voice')}</span>
      {onChange ? (
        <button type="button" className={styles.linkBtn} onClick={onChange}>
          {t('Change')}
        </button>
      ) : null}
    </div>
  );
}
