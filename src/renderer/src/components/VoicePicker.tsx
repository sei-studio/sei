/**
 * VoicePicker (260705, reworked 260720, tabs + playground 260725) — choose the
 * companion's speaking voice during creation and in Edit companion.
 *
 * Three selection states (see lib/voicePicker.ts):
 *   - Auto (default): metadata.voiceId stays unset; the runtime assigns a
 *     deterministic, roster-deduped pick from the curated pool on first use.
 *   - No voice: metadata.voiceId = 'none'; the companion is silent on calls.
 *   - A pinned pool voice, chosen from gender tabs (Feminine / Masculine /
 *     Neutral). Only the active tab's voices render; the Auto / No-voice cards
 *     and the legacy "Current voice" row sit above the tabs so they stay
 *     visible from any tab.
 *
 * Samples (260720, bundled-first): every curated-pool voice ships a
 * pre-generated sample mp3 per conversation language in the renderer's public
 * assets (voice-previews/), so pool rows play instantly, offline, with no
 * sign-in. The live TTS path (main-side disk cache + session Map here) is the
 * fallback for voice ids without a bundled file (the legacy "Current voice"
 * row), for a bundled asset that fails to load, and for a non-default CALMNESS
 * (the bundled clips are recorded at engine defaults). One sample plays at a
 * time; starting a second stops the first. When TTS is unavailable (signed out,
 * no dev key) bundled samples keep playing.
 *
 * Playground (260725): a "Tune the voice" panel with Pitch and Calmness
 * (ElevenLabs stability) sliders.
 *
 * 260731: pitch is applied locally at playback (lib/voice/pitchBus.ts) and no
 * longer reaches synthesis, so it no longer forces a live TTS fetch — a
 * pitch-only tune previews from the BUNDLED clip through the shifter: instant,
 * offline, no sign-in, no spend. Only calmness still changes the bytes.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import type { VoiceInfo } from '@shared/ipc';
import {
  groupVoices,
  reduceSelection,
  isUnlistedVoice,
  assetPathFor,
  normalizeVoiceParams,
  PITCH_DEFAULT,
  CALMNESS_DEFAULT,
  NO_VOICE_ID,
  type VoiceGroup,
  type VoiceParams,
} from '../lib/voicePicker';
import { attach as attachPitch, warm as warmPitchBus, whenReady as pitchReady } from '../lib/voice/pitchBus';
import { useT } from '../lib/i18n';
import { PlayIcon, StopIcon } from './icons';
import styles from './VoicePicker.module.css';

export interface VoicePickerProps {
  /** Selected pool voice id, NO_VOICE_ID ('none') for silent, or null for Auto. */
  value: string | null;
  onChange: (voiceId: string | null) => void;
  /** Playground params; absent key = engine default (see lib/voicePicker.ts). */
  params: VoiceParams;
  /** Receives NORMALIZED params (default-valued keys already dropped). */
  onParamsChange: (params: VoiceParams) => void;
}

export function VoicePicker({
  value,
  onChange,
  params,
  onParamsChange,
}: VoicePickerProps): React.ReactElement {
  const t = useT();
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = probing; false disables sample playback with the quiet hint. */
  const [samplesAvailable, setSamplesAvailable] = useState<boolean | null>(null);
  /** User-chosen tab; null = derive from the selection (else Feminine). */
  const [chosenTab, setChosenTab] = useState<VoiceGroup['key'] | null>(null);

  // Non-reactive playback internals.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Tears the playing clip out of the pitch bus (null when unshifted). */
  const detachRef = useRef<(() => void) | null>(null);
  const cacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const aliveRef = useRef(true);
  /** Conversation language for bundled samples; 'en' until the config loads. */
  const langRef = useRef('en');
  const sliderIdBase = useId();

  useEffect(() => {
    // Re-arm on every (re)mount — StrictMode dev runs mount → cleanup → mount
    // on the SAME instance, and the ref keeps its false from the first cleanup.
    aliveRef.current = true;
    // Build the pitch shifter while the player is still reading the voice list,
    // so the first sample they play is already shifted (see toggleSample).
    warmPitchBus();
    void sei
      .voiceListVoices()
      .then((v) => {
        if (aliveRef.current) setVoices(v);
      })
      .catch(() => {
        if (aliveRef.current) setError(t('Could not load the voice list.'));
      });
    // Conversation language, for picking the bundled sample file. Best-effort:
    // a failed read leaves English, which always exists.
    void sei
      .getConfig()
      .then((c) => {
        langRef.current = c.chat_language ?? 'en';
      })
      .catch(() => {
        /* keep 'en' */
      });
    // Probe sample availability (live-TTS fallback rows only); a failed or
    // missing probe leaves samples enabled and the first play surfaces the
    // real state reactively.
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
      detachRef.current?.();
      detachRef.current = null;
      audioRef.current = null;
    }
    setPlayingId(null);
  }

  // ── Playground params (effective values; absent key = engine default) ────
  const pitch = params.pitch ?? PITCH_DEFAULT;
  const calmness = params.calmness ?? CALMNESS_DEFAULT;
  /** Whether the SYNTHESIS differs from the bundled clips. Pitch is not part of
   * this any more (260731): it is a playback effect, so a pitch-only tune can
   * still preview from the bundled asset. */
  const tuned = calmness !== CALMNESS_DEFAULT;
  /** The playground needs a concrete voice — Auto / No voice can't preview. */
  const tunable = value !== null && value !== NO_VOICE_ID;

  /**
   * Start playback of `url` shifted to `rate` (1 = as recorded), through the
   * same pitch bus live calls use, so the sample is exactly what the player
   * will hear. Resolves true once playback starts, false when the source fails
   * to load or play, so callers can fall back.
   */
  function startAudio(url: string, voiceId: string, rate: number): Promise<boolean> {
    return new Promise((resolve) => {
      const el = new Audio(url);
      const detachPitch = attachPitch(el, rate);
      audioRef.current = el;
      detachRef.current = detachPitch;
      el.addEventListener(
        'ended',
        () => {
          if (audioRef.current === el) stopPlayback();
        },
        { once: true },
      );
      el.addEventListener(
        'error',
        () => {
          if (audioRef.current === el) stopPlayback();
          resolve(false);
        },
        { once: true },
      );
      setPlayingId(voiceId);
      void el.play().then(
        () => resolve(true),
        () => {
          if (audioRef.current === el) stopPlayback();
          resolve(false);
        },
      );
    });
  }

  /** Live TTS preview with the current params, session-cached per combo. Pitch
   * is not part of the key: it does not change the bytes any more, only how
   * they are played back. */
  async function playTts(voiceId: string): Promise<void> {
    const key = `${voiceId}|${calmness}`;
    let buf = cacheRef.current.get(key);
    if (!buf) {
      setLoadingId(voiceId);
      buf = await sei.voicePreview({ voiceId, calmness });
      cacheRef.current.set(key, buf);
    }
    if (!aliveRef.current) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    await startAudio(url, voiceId, pitch);
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
      // Unlike a call, a sample CAN wait for the shifter: the whole point of
      // pressing play here is to hear the slider, so a sample that starts
      // 200ms later is better than one that ignores it. Bounded, and a false
      // just means the sample plays at its recorded pitch.
      if (pitch !== PITCH_DEFAULT) await pitchReady();
      if (!aliveRef.current) return;
      if (!tuned && voices.some((v) => v.id === voiceId)) {
        // Pool voice at default calmness: bundled sample asset — instant,
        // offline, no sign-in, shifted locally to the chosen pitch. A load/play
        // failure falls through to live TTS.
        const ok = await startAudio(assetPathFor(voiceId, langRef.current), voiceId, pitch);
        if (ok || !aliveRef.current) return;
      }
      await playTts(voiceId);
    } catch (err) {
      if (!aliveRef.current) return;
      if (/VOICE_NO_SESSION/.test(String((err as Error)?.message ?? ''))) {
        setSamplesAvailable(false);
      } else {
        setError(t('Sample unavailable right now.'));
      }
    } finally {
      if (aliveRef.current) setLoadingId(null);
    }
  }

  const samplesOff = samplesAvailable === false;

  function setPitchParam(next: number): void {
    onParamsChange(normalizeVoiceParams({ pitch: next, calmness: params.calmness }));
  }

  function setCalmnessParam(next: number): void {
    onParamsChange(normalizeVoiceParams({ pitch: params.pitch, calmness: next }));
  }

  function renderRow(
    id: string,
    title: React.ReactNode,
    vibe: string,
    label: string,
    bundled = true,
  ): React.ReactElement {
    const selected = value === id;
    // Tuned previews always need live TTS, even for bundled pool voices.
    const needsTts = !bundled || tuned;
    return (
      <div key={id} className={`${styles.row} ${selected ? styles.selected : ''}`}>
        <button
          type="button"
          className={styles.playBtn}
          aria-label={
            playingId === id
              ? t('Stop {name} sample', { name: label })
              : t('Play {name} sample', { name: label })
          }
          disabled={(samplesOff && needsTts) || (loadingId !== null && loadingId !== id)}
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

  // ── Tabs: only the active gender group's voices render. Default: the group
  //    containing the current selection, else the first group (Feminine when
  //    populated — GROUP_ORDER puts it first). Empty groups have no tab. ─────
  const groups = groupVoices(voices);
  const selectedGroupKey = groups.find((g) => g.voices.some((v) => v.id === value))?.key ?? null;
  const activeTab =
    chosenTab !== null && groups.some((g) => g.key === chosenTab)
      ? chosenTab
      : (selectedGroupKey ?? groups[0]?.key ?? null);
  const activeGroup = groups.find((g) => g.key === activeTab) ?? null;

  return (
    <div className={styles.root} role="radiogroup" aria-label={t('Voice')}>
      {/* Auto — the recommended default. */}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className={`${styles.optionCard} ${value === null ? styles.selected : ''}`}
        onClick={() => onChange(null)}
      >
        <div className={styles.rowTitle}>{t('Auto: let Sei pick')}</div>
        <div className={styles.rowVibe}>
          {t('A voice that fits their personality, never one another companion already uses. Recommended.')}
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
        <div className={styles.rowTitle}>{t('No voice')}</div>
        <div className={styles.rowVibe}>
          {t('A silent companion. They chat by text and stay quiet on voice calls.')}
        </div>
      </button>

      {samplesOff && isUnlistedVoice(value, voices) ? (
        <div className={styles.hint}>
          {t('Sign in to play the current voice sample. Picking a voice still works.')}
        </div>
      ) : null}

      {/* A voice assigned before the current pool curation: keep it visible
          and selected instead of silently dropping it (Edit companion).
          Rendered ABOVE the tabs so it shows from any tab. */}
      {isUnlistedVoice(value, voices) && value ? (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t('Current voice')}</h3>
          {renderRow(
            value,
            t('Current voice'),
            t('Assigned from an earlier voice pool.'),
            t('current voice'),
            false,
          )}
        </section>
      ) : null}

      {groups.length > 0 ? (
        <div className={styles.tabs} role="tablist" aria-label={t('Voice group')}>
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={g.key === activeTab}
              className={g.key === activeTab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setChosenTab(g.key)}
            >
              {t(g.title)}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.list}>
        {activeGroup ? (
          <section className={styles.group}>
            {activeGroup.voices.map((v) =>
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
        ) : null}
      </div>

      {/* ── Playground: pitch + calmness sliders (260725) ── */}
      <section className={styles.tuner} aria-label={t('Tune the voice')}>
        <h3 className={styles.groupTitle}>{t('Tune the voice')}</h3>
        {!tunable ? <div className={styles.hint}>{t('Pick a voice to tune it.')}</div> : null}
        {tunable && tuned && samplesOff ? (
          <div className={styles.hint}>{t('Sign in to hear tuned samples.')}</div>
        ) : null}

        <div className={styles.tunerRow}>
          <div className={styles.tunerHead}>
            <label className={styles.tunerLabel} htmlFor={`${sliderIdBase}-pitch`}>
              {t('Pitch')}
            </label>
            <span className={styles.tunerValue}>{pitch.toFixed(2)}</span>
            <button
              type="button"
              className={styles.tunerReset}
              onClick={() => setPitchParam(PITCH_DEFAULT)}
              disabled={!tunable || params.pitch === undefined}
            >
              {t('Reset')}
            </button>
          </div>
          <input
            id={`${sliderIdBase}-pitch`}
            className={styles.tunerSlider}
            type="range"
            min={0.85}
            max={1.4}
            step={0.01}
            value={pitch}
            disabled={!tunable}
            onChange={(e) => setPitchParam(Number(e.target.value))}
          />
          <div className={styles.tunerHint}>
            {t('Higher or lower voice. Speaking pace stays the same.')}
          </div>
        </div>

        <div className={styles.tunerRow}>
          <div className={styles.tunerHead}>
            <label className={styles.tunerLabel} htmlFor={`${sliderIdBase}-calmness`}>
              {t('Calmness')}
            </label>
            <span className={styles.tunerValue}>{calmness.toFixed(2)}</span>
            <button
              type="button"
              className={styles.tunerReset}
              onClick={() => setCalmnessParam(CALMNESS_DEFAULT)}
              disabled={!tunable || params.calmness === undefined}
            >
              {t('Reset')}
            </button>
          </div>
          <input
            id={`${sliderIdBase}-calmness`}
            className={styles.tunerSlider}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={calmness}
            disabled={!tunable}
            onChange={(e) => setCalmnessParam(Number(e.target.value))}
          />
          <div className={styles.tunerHint}>
            {t('Higher is steadier and more even. Lower is more dramatic.')}
          </div>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}
