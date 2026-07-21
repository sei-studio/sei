/**
 * VoicePicker (260705, reworked 260720) — choose the companion's speaking
 * voice during creation and in Edit companion.
 *
 * Three selection states (see lib/voicePicker.ts):
 *   - Auto (default): metadata.voiceId stays unset; the runtime assigns a
 *     deterministic, roster-deduped pick from the curated pool on first use.
 *   - No voice: metadata.voiceId = 'none'; the companion is silent on calls.
 *   - A pinned pool voice, chosen from sections grouped by gender.
 *
 * Samples: each voice row plays the canned sample line through the normal TTS
 * path; main caches the audio on disk (userData, keyed by voiceId + text
 * hash) so repeat plays are free, and this component keeps a session Map so
 * repeats never even cross IPC. One sample plays at a time; starting a second
 * stops the first. When TTS is unavailable (signed out, no dev key) the play
 * controls disable with a quiet hint and selection keeps working.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import type { VoiceInfo } from '@shared/ipc';
import { groupVoices, reduceSelection, isUnlistedVoice, NO_VOICE_ID } from '../lib/voicePicker';
import { PlayIcon, StopIcon } from './icons';
import styles from './VoicePicker.module.css';

export interface VoicePickerProps {
  /** Selected pool voice id, NO_VOICE_ID ('none') for silent, or null for Auto. */
  value: string | null;
  onChange: (voiceId: string | null) => void;
}

export function VoicePicker({ value, onChange }: VoicePickerProps): React.ReactElement {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = probing; false disables sample playback with the quiet hint. */
  const [samplesAvailable, setSamplesAvailable] = useState<boolean | null>(null);

  // Non-reactive playback internals.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const aliveRef = useRef(true);

  useEffect(() => {
    // Re-arm on every (re)mount — StrictMode dev runs mount → cleanup → mount
    // on the SAME instance, and the ref keeps its false from the first cleanup.
    aliveRef.current = true;
    void sei
      .voiceListVoices()
      .then((v) => {
        if (aliveRef.current) setVoices(v);
      })
      .catch(() => {
        if (aliveRef.current) setError('Could not load the voice list.');
      });
    // Probe sample availability; a failed or missing probe leaves samples
    // enabled and the first play surfaces the real state reactively.
    try {
      void sei
        .voicePreviewAvailable()
        .then((ok) => {
          if (aliveRef.current) setSamplesAvailable(ok);
        })
        .catch(() => {
          if (aliveRef.current) setSamplesAvailable(true);
        });
    } catch {
      setSamplesAvailable(true); // stale preload without the probe — stay permissive
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopPlayback(): void {
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        URL.revokeObjectURL(el.src);
      } catch {
        /* already torn down */
      }
      audioRef.current = null;
    }
    setPlayingId(null);
  }

  async function toggleSample(voiceId: string): Promise<void> {
    if (playingId === voiceId) {
      stopPlayback();
      return;
    }
    // One sample at a time: starting a new one stops whatever is playing.
    stopPlayback();
    setError(null);
    try {
      let buf = cacheRef.current.get(voiceId);
      if (!buf) {
        setLoadingId(voiceId);
        buf = await sei.voicePreview({ voiceId });
        cacheRef.current.set(voiceId, buf);
      }
      if (!aliveRef.current) return;
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      const el = new Audio(url);
      audioRef.current = el;
      el.addEventListener(
        'ended',
        () => {
          if (audioRef.current === el) stopPlayback();
        },
        { once: true },
      );
      setPlayingId(voiceId);
      void el.play().catch(() => stopPlayback());
    } catch (err) {
      if (!aliveRef.current) return;
      if (/VOICE_NO_SESSION/.test(String((err as Error)?.message ?? ''))) {
        setSamplesAvailable(false);
      } else {
        setError('Sample unavailable right now.');
      }
    } finally {
      if (aliveRef.current) setLoadingId(null);
    }
  }

  const samplesOff = samplesAvailable === false;

  function renderRow(id: string, title: React.ReactNode, vibe: string, label: string): React.ReactElement {
    const selected = value === id;
    return (
      <div key={id} className={`${styles.row} ${selected ? styles.selected : ''}`}>
        <button
          type="button"
          className={styles.playBtn}
          aria-label={playingId === id ? `Stop ${label} sample` : `Play ${label} sample`}
          disabled={samplesOff || (loadingId !== null && loadingId !== id)}
          onClick={() => void toggleSample(id)}
        >
          {loadingId === id ? (
            <span className={styles.loadingDot} aria-hidden="true" />
          ) : playingId === id ? (
            <StopIcon size={14} />
          ) : (
            <PlayIcon size={14} />
          )}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          className={styles.rowBody}
          onClick={() => onChange(reduceSelection(value, id))}
        >
          <div className={styles.rowTitle}>{title}</div>
          <div className={styles.rowVibe}>{vibe}</div>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.root} role="radiogroup" aria-label="Voice">
      {/* Auto — the recommended default. */}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className={`${styles.optionCard} ${value === null ? styles.selected : ''}`}
        onClick={() => onChange(null)}
      >
        <div className={styles.rowTitle}>Auto: let Sei pick</div>
        <div className={styles.rowVibe}>
          A voice that fits their personality, never one another companion already uses. Recommended.
        </div>
      </button>

      {/* No voice — a silent companion. */}
      <button
        type="button"
        role="radio"
        aria-checked={value === NO_VOICE_ID}
        className={`${styles.optionCard} ${value === NO_VOICE_ID ? styles.selected : ''}`}
        onClick={() => onChange(reduceSelection(value, NO_VOICE_ID))}
      >
        <div className={styles.rowTitle}>No voice</div>
        <div className={styles.rowVibe}>
          A silent companion. They chat by text and stay quiet on voice calls.
        </div>
      </button>

      {samplesOff ? (
        <div className={styles.hint}>Sign in to play voice samples. Picking a voice still works.</div>
      ) : null}

      <div className={styles.list}>
        {/* A voice assigned before the current pool curation: keep it visible
            and selected instead of silently dropping it (Edit companion). */}
        {isUnlistedVoice(value, voices) && value ? (
          <section className={styles.group}>
            <h3 className={styles.groupTitle}>Current voice</h3>
            {renderRow(value, 'Current voice', 'Assigned from an earlier voice pool.', 'current voice')}
          </section>
        ) : null}

        {groupVoices(voices).map((g) => (
          <section key={g.key} className={styles.group}>
            <h3 className={styles.groupTitle}>{g.title}</h3>
            {g.voices.map((v) =>
              renderRow(
                v.id,
                <>
                  {v.label}
                  <span className={styles.rowMeta}>{v.age}</span>
                </>,
                v.vibe,
                v.label,
              ),
            )}
          </section>
        ))}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}
