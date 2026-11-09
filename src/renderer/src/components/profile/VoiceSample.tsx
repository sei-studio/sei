/**
 * VoiceSample (product call 261110): the play button that lets a player
 * hear a companion before inviting them (the profile Overview) or while
 * tuning their own (the owner's Voice row).
 *
 * Same playback path as the voice picker (VoicePicker / SharedVoiceChoice):
 *  1. A curated-pool voice plays its bundled clip
 *     (`./voice-previews/<id>-<lang>.mp3`): no network, no sign-in, no TTS
 *     spend, which keeps the free tier at zero cost per extra listen. Main
 *     says which pool voice a sample plays (CharacterOverviewInfo
 *     .sampleVoiceId: the assigned voice, the stand-in for someone else's
 *     own voice, or the deterministic fallback for Auto).
 *  2. Otherwise (your own ElevenLabs voice, Local voices, or a clip that
 *     failed to load) main synthesizes the sample line for the companion:
 *     `voicePreview({ characterId })`.
 * The clip goes through the pitch bus at the companion's pitch, so it sounds
 * like a call does.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useCreditsStore } from '../../lib/stores/useCreditsStore';
import { assetPathFor } from '../../lib/voicePicker';
import { attach as attachPitch, whenReady as pitchReady } from '../../lib/voice/pitchBus';
import type { Character } from '@shared/characterSchema';
import { voicePitchRate } from '@shared/voicePitch';
import { isPoolVoiceId } from '@shared/poolVoiceIds';
import { ownVoiceOf } from '@shared/voiceIds';
import { PlayIcon, StopIcon } from '../icons';
import styles from './ProfileOverview.module.css';

export type SampleSource = 'bundled' | 'synth';
export type SampleResult = { source: SampleSource; outcome: 'played' | 'failed' };

interface Playback {
  playing: boolean;
  loading: boolean;
  error: string | null;
  /** Start (resolves with how it went) or stop (resolves null). */
  toggle: () => Promise<SampleResult | null>;
}

export function useVoiceSample(character: Character, sampleVoiceId: string | null | undefined): Playback {
  const t = useT();
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const cfgRef = useRef<{ lang: string; localTts: boolean }>({ lang: 'en', localTts: false });

  useEffect(() => {
    let live = true;
    void sei
      .getConfig()
      .then((c) => {
        if (live) cfgRef.current = { lang: c.chat_language ?? 'en', localTts: c.tts_engine === 'local' };
      })
      .catch(() => {
        /* English clip, ElevenLabs path */
      });
    return () => {
      live = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another companion (or a new voice) makes a playing sample stale.
  useEffect(() => {
    stop();
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, sampleVoiceId]);

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

  function play(url: string, rate: number): Promise<boolean> {
    return new Promise((resolve) => {
      const el = new Audio(url);
      detachRef.current = attachPitch(el, rate);
      audioRef.current = el;
      el.addEventListener(
        'ended',
        () => {
          if (audioRef.current === el) stop();
        },
        { once: true },
      );
      el.addEventListener(
        'error',
        () => {
          if (audioRef.current === el) stop();
          resolve(false);
        },
        { once: true },
      );
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

  async function toggle(): Promise<SampleResult | null> {
    if (playing || loading) {
      stop();
      return null;
    }
    setError(null);
    const rate = voicePitchRate(character);
    if (rate !== 1) await pitchReady();
    // Local voices speak with a different engine than the bundled clips.
    const localTts = aiBackendKind === 'local' && cfgRef.current.localTts;
    // Before main has answered (undefined), a picked pool voice is still known.
    const metaVoice = character.metadata?.voiceId;
    const poolId =
      sampleVoiceId !== undefined
        ? sampleVoiceId
        : typeof metaVoice === 'string' && isPoolVoiceId(metaVoice) && !ownVoiceOf(character.metadata)
          ? metaVoice
          : null;
    if (poolId && !localTts) {
      if (await play(assetPathFor(poolId, cfgRef.current.lang), rate)) {
        return { source: 'bundled', outcome: 'played' };
      }
    }
    setLoading(true);
    try {
      const buf = await sei.voicePreview({ characterId: character.id });
      if (await play(URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' })), rate)) {
        return { source: 'synth', outcome: 'played' };
      }
      setError(t('Sample unavailable right now.'));
    } catch {
      setError(t('Sample unavailable right now.'));
    } finally {
      setLoading(false);
    }
    return { source: 'synth', outcome: 'failed' };
  }

  return { playing, loading, error, toggle };
}

/** The round play / stop button plus its label. */
export function VoiceSampleButton({
  character,
  sampleVoiceId,
  onResult,
  compact,
}: {
  character: Character;
  sampleVoiceId: string | null | undefined;
  onResult: (r: SampleResult) => void;
  /** Icon-only (the owner's Voice row). */
  compact?: boolean;
}): React.ReactElement {
  const t = useT();
  const sample = useVoiceSample(character, sampleVoiceId);
  const label = sample.playing ? t('Stop sample') : sample.loading ? t('Loading sample...') : t('Play voice sample');
  return (
    <span className={styles.sample}>
      <button
        type="button"
        className={`${styles.sampleBtn} ${sample.playing ? styles.sampleBtnOn : ''}`}
        aria-label={label}
        title={compact ? label : undefined}
        aria-busy={sample.loading}
        onClick={() => {
          void sample.toggle().then((r) => {
            if (r) onResult(r);
          });
        }}
      >
        {sample.playing ? <StopIcon size={13} /> : <PlayIcon size={13} />}
        {compact ? null : <span>{sample.loading ? t('Loading sample...') : t('Hear voice')}</span>}
      </button>
      {sample.error ? (
        <span className={styles.sampleErr} role="status">
          {sample.error}
        </span>
      ) : null}
    </span>
  );
}
