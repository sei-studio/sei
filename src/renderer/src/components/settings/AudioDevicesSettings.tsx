/**
 * Settings > Microphone and speakers (261118, feat/mic-picker).
 *
 * Three rows, the minimum that lets a player fix "she talks but never hears
 * me" without leaving the app:
 *   Microphone  the input picker, and under it a live level meter ("Speak to
 *               test") reading the same capture constraints the call uses, so
 *               a bar that moves here is a mic the call will hear. "Record and
 *               play back" records 3 s and plays it through the chosen
 *               speaker, which checks both devices at once.
 *   Speakers    the output picker and "Play test sound" (a short bundled Sui
 *               line, played to the chosen speaker).
 *
 * The meter opens the mic while this page is mounted and stops every track
 * when it unmounts. On macOS it only starts by itself once access is already
 * granted; otherwise it waits for "Test mic", so opening Settings never raises
 * the system permission prompt on its own.
 *
 * Analytics, shape only: mic_test_used {mode: 'meter' | 'playback', heard},
 * speaker_test_used {is_default}. Device changes are tracked by the store.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { AudioDeviceSelect } from '../audio/AudioDeviceSelect';
import { refreshAudioDevices } from '../audio/useAudioDevices';
import { useAudioDeviceStore, resetMissingInput } from '../../lib/stores/useAudioDeviceStore';
import { applyOutputSink, openMic } from '../../lib/voice/audioDevices';
import { CALL_MIC_CONSTRAINTS, INPUT_SIGNAL_RMS } from '../../lib/voice/dictation';
import styles from '../../screens/SettingsScreen.module.css';
import own from '../audio/AudioDevices.module.css';

/** The bundled line "Play test sound" plays (public/voice/onboard). */
const TEST_SOUND_URL = './voice/onboard/hey.en.mp3';
const RECORD_MS = 3_000;
/** A meter that ran at least this long reports mic_test_used {mode: 'meter'}. */
const METER_REPORT_MS = 3_000;

/** RMS to a 0..1 bar over a -60..0 dBFS scale. */
export function meterFraction(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function track(event: string, props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics is never load-bearing */
  }
}

type RecordState = 'idle' | 'recording' | 'playing';

export function AudioDevicesSettings(): React.ReactElement {
  const t = useT();
  const inputId = useAudioDeviceStore((s) => s.inputId);
  const outputId = useAudioDeviceStore((s) => s.outputId);

  // Auto-start everywhere but macOS-without-a-grant (see the file header).
  const [armed, setArmed] = useState<boolean>(sei.platform !== 'darwin');
  useEffect(() => {
    if (sei.platform !== 'darwin') return;
    let alive = true;
    void sei
      .permissionsStatus('mic')
      .then((st) => {
        if (alive && st === 'granted') setArmed(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const fillRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [meterError, setMeterError] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const heardRef = useRef(false);
  /** Signal during the current record-and-play-back take. */
  const takeHeardRef = useRef(false);
  const meterStartedAt = useRef<number | null>(null);

  // The live meter: open the chosen mic, read its RMS every frame, stop all
  // tracks on unmount or when the device changes.
  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    setMeterError(false);
    void (async () => {
      try {
        stream = (
          await openMic(CALL_MIC_CONSTRAINTS, inputId, {
            getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
            onDeviceGone: resetMissingInput,
          })
        ).stream;
      } catch {
        if (!cancelled) setMeterError(true);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      // Access is granted now, so the device labels can be read.
      refreshAudioDevices();
      try {
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        // Fast attack, slow release, so a word stays readable on the bar
        // instead of flickering between frames.
        let shown = 0;
        if (meterStartedAt.current === null) meterStartedAt.current = performance.now();
        const tick = (): void => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const live = rms >= INPUT_SIGNAL_RMS;
          if (live) {
            heardRef.current = true;
            takeHeardRef.current = true;
          }
          shown = Math.max(meterFraction(rms), shown * 0.92);
          const el = fillRef.current;
          if (el) {
            el.style.width = `${Math.round(shown * 100)}%`;
            el.classList.toggle(own.meterFillLive, live);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setMeterError(true);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (ctx) void ctx.close().catch(() => {});
      stream?.getTracks().forEach((tr) => tr.stop());
      if (streamRef.current === stream) streamRef.current = null;
      if (fillRef.current) fillRef.current.style.width = '0%';
    };
  }, [armed, inputId]);

  // One meter report per visit to the page, when it ran long enough to mean
  // something: did Sei hear anything at all on the chosen mic?
  useEffect(
    () => () => {
      const started = meterStartedAt.current;
      if (started !== null && performance.now() - started >= METER_REPORT_MS) {
        track('mic_test_used', { mode: 'meter', heard: heardRef.current });
      }
    },
    [],
  );

  // Players started by the tests, stopped on unmount.
  const playersRef = useRef<Set<HTMLAudioElement>>(new Set());
  useEffect(() => {
    const players = playersRef.current;
    return () => {
      for (const el of players) {
        el.pause();
        el.removeAttribute('src');
      }
      players.clear();
    };
  }, []);

  const play = async (url: string, onEnd?: () => void): Promise<void> => {
    const el = new Audio(url);
    playersRef.current.add(el);
    await applyOutputSink(el, outputId);
    const done = (): void => {
      playersRef.current.delete(el);
      onEnd?.();
    };
    el.onended = done;
    el.onerror = done;
    await el.play().catch(done);
  };

  const recordAndPlay = (): void => {
    const stream = streamRef.current;
    if (!stream || recordState !== 'idle' || typeof MediaRecorder === 'undefined') return;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      return;
    }
    const chunks: Blob[] = [];
    takeHeardRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      track('mic_test_used', { mode: 'playback', heard: takeHeardRef.current });
      if (!chunks.length) {
        setRecordState('idle');
        return;
      }
      const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      setRecordState('playing');
      void play(url, () => {
        URL.revokeObjectURL(url);
        setRecordState('idle');
      });
    };
    setRecordState('recording');
    rec.start();
    window.setTimeout(() => {
      if (rec.state === 'recording') rec.stop();
    }, RECORD_MS);
  };

  const playTestSound = (): void => {
    track('speaker_test_used', { is_default: outputId === null });
    void play(TEST_SOUND_URL);
  };

  const recordLabel =
    recordState === 'recording' ? t('Recording…') : recordState === 'playing' ? t('Playing back…') : t('Record and play back');

  return (
    <>
      <div className={`${styles.row} ${styles.rowOpen}`}>
        <span className={styles.label}>{t('Microphone')}</span>
        <AudioDeviceSelect
          kind="audioinput"
          source="settings"
          className={styles.langSelect}
          ariaLabel={t('Microphone')}
        />
      </div>
      <div className={own.meterRow} data-testid="mic-meter">
        {!armed ? (
          <>
            <span className={own.meterError}>{t('Check that Sei hears you.')}</span>
            <Button kind="secondary" size="sm" onClick={() => setArmed(true)}>
              {t('Test mic')}
            </Button>
          </>
        ) : meterError ? (
          <span className={own.meterError}>{t('Sei could not open this microphone.')}</span>
        ) : (
          <>
            <div className={own.meterTrack} role="meter" aria-label={t('Microphone level')} aria-valuemin={0} aria-valuemax={100}>
              <div ref={fillRef} className={own.meterFill} />
            </div>
            <span className={own.meterHint}>{t('Speak to test')}</span>
            <Button kind="secondary" size="sm" onClick={recordAndPlay} disabled={recordState !== 'idle'}>
              {recordLabel}
            </Button>
          </>
        )}
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('Speakers')}</span>
        <AudioDeviceSelect
          kind="audiooutput"
          source="settings"
          className={styles.langSelect}
          ariaLabel={t('Speakers')}
        />
        <Button kind="secondary" size="sm" onClick={playTestSound}>
          {t('Play test sound')}
        </Button>
      </div>
    </>
  );
}
