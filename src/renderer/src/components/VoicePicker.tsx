/**
 * VoicePicker (260705) — choose the companion's speaking voice during creation.
 *
 * "Auto" (default, recommended) leaves metadata.voiceId unset: the runtime
 * assigns a deterministic, roster-deduped pick from the same curated pool on
 * first use (src/main/voice/voiceAssign.ts). Picking a voice pins it.
 *
 * Previews synthesize one short canned line per voice (voice:preview) and are
 * cached for the component's lifetime, so re-listening is free. One clip plays
 * at a time.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import type { VoiceInfo } from '@shared/ipc';
import { PlayIcon, StopIcon } from './icons';
import styles from './VoicePicker.module.css';

export interface VoicePickerProps {
  /** Selected pool voice id, or null for Auto. */
  value: string | null;
  onChange: (voiceId: string | null) => void;
}

type GenderFilter = 'all' | 'female' | 'male' | 'neutral';

export function VoicePicker({ value, onChange }: VoicePickerProps): React.ReactElement {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [filter, setFilter] = useState<GenderFilter>('all');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function togglePreview(voiceId: string): Promise<void> {
    if (playingId === voiceId) {
      stopPlayback();
      return;
    }
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
    } catch {
      if (aliveRef.current) setError('Preview unavailable right now.');
    } finally {
      if (aliveRef.current) setLoadingId(null);
    }
  }

  const filtered = filter === 'all' ? voices : voices.filter((v) => v.gender === filter);

  return (
    <div className={styles.root}>
      {/* Auto — the recommended default. */}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className={`${styles.autoCard} ${value === null ? styles.selected : ''}`}
        onClick={() => onChange(null)}
      >
        <div className={styles.rowTitle}>Auto: let Sei pick</div>
        <div className={styles.rowVibe}>
          A voice that fits their personality, never one another companion already uses. Recommended.
        </div>
      </button>

      <div className={styles.filters} role="tablist" aria-label="Voice filter">
        {(['all', 'female', 'male', 'neutral'] as const).map((g) => (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={filter === g}
            className={`${styles.filterChip} ${filter === g ? styles.filterActive : ''}`}
            onClick={() => setFilter(g)}
          >
            {g === 'all' ? 'All' : g[0].toUpperCase() + g.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.list} role="radiogroup" aria-label="Voice">
        {filtered.map((v) => {
          const selected = value === v.id;
          return (
            <div key={v.id} className={`${styles.row} ${selected ? styles.selected : ''}`}>
              <button
                type="button"
                className={styles.playBtn}
                aria-label={playingId === v.id ? `Stop ${v.label} preview` : `Preview ${v.label}`}
                disabled={loadingId !== null && loadingId !== v.id}
                onClick={() => void togglePreview(v.id)}
              >
                {loadingId === v.id ? (
                  <span className={styles.loadingDot} aria-hidden="true" />
                ) : playingId === v.id ? (
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
                onClick={() => onChange(selected ? null : v.id)}
              >
                <div className={styles.rowTitle}>
                  {v.label}
                  <span className={styles.rowMeta}>
                    {v.age}
                    {v.gender === 'neutral' ? ' · neutral' : ''}
                  </span>
                </div>
                <div className={styles.rowVibe}>{v.vibe}</div>
              </button>
            </div>
          );
        })}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}
