/**
 * Settings > Microphone (261127, in-app feedback: "no microphone settings,
 * mic settings would be AMAZING").
 *
 * Three rows, in the same row style as every other group:
 *   Input device  the system default, or a specific input (micPrefs.ts).
 *   Input level   a live meter, opened only on Test, so visiting Settings
 *                 never lights the OS mic indicator or asks for permission.
 *                 The tick marks where speech starts at the current
 *                 sensitivity, measured the way the call measures it (the
 *                 room's noise floor times the open factor).
 *   Sensitivity   one slider over the call VAD's speech-open threshold, with
 *                 a Reset that only shows off the default.
 *
 * Device labels are empty until the app has mic permission, so unlabeled
 * inputs read "Microphone 1, 2, ..." and the list is read again once Test
 * opens the mic. A refusal (macOS privacy, the Windows switch) is one line
 * with a link to the OS page.
 *
 * Analytics (shape only): mic_settings_changed {setting, value bucket},
 * mic_test {result}, mic_device_fallback {surface: 'settings'}.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import {
  MIC_SENSITIVITY_DEFAULT,
  listMicDevices,
  micDeviceIdOf,
  micGateScale,
  micSensitivityBucket,
  micSensitivityOf,
  openMicStream,
  type MicDevice,
} from '../../lib/voice/micPrefs';
import { openThresholdOf } from '../../lib/voice/dictation';
import { applyMicSensitivityToCall } from '../../lib/stores/useVoiceStore';
import {
  isPermissionRefusal,
  micPreflight,
  openPermissionSettings,
} from '../../lib/permissions/permissionFlow';
import styles from '../../screens/SettingsScreen.module.css';
import mic from './MicSettingsGroup.module.css';

export interface MicSettingsGroupProps {
  deviceId: string | undefined;
  sensitivity: number | undefined;
  onSave: (patch: { mic_device_id?: string; mic_sensitivity?: number }) => void;
}

type Hint = 'denied' | 'fallback' | 'missing' | 'error' | null;

/** A test stops itself after this long, so the mic is never left open. */
const TEST_MAX_MS = 60_000;
/** The meter's range, in dBFS. */
const METER_FLOOR_DB = -60;

function track(event: string, props: Record<string, string>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics is never load-bearing */
  }
}

/** Meter position (0..100) of an RMS level. */
export function meterPct(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
}

async function readDevices(): Promise<MicDevice[]> {
  try {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return [];
    return listMicDevices(await md.enumerateDevices());
  } catch {
    return [];
  }
}

export function MicSettingsGroup({ deviceId, sensitivity, onSave }: MicSettingsGroupProps): React.ReactElement {
  const t = useT();
  const savedId = micDeviceIdOf(deviceId);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [listed, setListed] = useState(false);
  const [sens, setSens] = useState(micSensitivityOf(sensitivity));
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [bar, setBar] = useState(0);
  const [hint, setHint] = useState<Hint>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const sensRef = useRef(sens);
  sensRef.current = sens;

  useEffect(() => setSens(micSensitivityOf(sensitivity)), [sensitivity]);

  const refresh = useCallback(async () => {
    setDevices(await readDevices());
    setListed(true);
  }, []);

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return undefined;
    const onChange = (): void => void refresh();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refresh]);

  const stopTest = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  useEffect(() => stopTest, [stopTest]);

  const startTest = useCallback(
    async (id: string | undefined) => {
      stopTest();
      setHint(null);
      if ((await micPreflight()) !== 'ok') {
        setHint('denied');
        track('mic_test', { result: 'denied' });
        return;
      }
      let stream: MediaStream;
      let fellBack = false;
      try {
        const opened = await openMicStream(id);
        stream = opened.stream;
        fellBack = opened.fellBack;
      } catch (err) {
        const denied = isPermissionRefusal(err);
        setHint(denied ? 'denied' : 'error');
        track('mic_test', { result: denied ? 'denied' : 'error' });
        return;
      }
      track('mic_test', { result: 'ok' });
      if (fellBack) {
        setHint('fallback');
        track('mic_device_fallback', { surface: 'settings' });
      }
      // Labels appear once the mic is open.
      void refresh();
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      // The call's noise floor, tracked the same way (dictation.ts): an EMA
      // over the frames that do not open speech.
      let floor = 0.008;
      let raf = 0;
      const tick = (): void => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const open = openThresholdOf(floor, micGateScale(sensRef.current));
        if (rms < open) floor = floor * 0.98 + rms * 0.02;
        setLevel(rms);
        setBar(open);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const timer = window.setTimeout(() => stopTest(), TEST_MAX_MS);
      stopRef.current = () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(timer);
        stream.getTracks().forEach((tr) => tr.stop());
        void ctx.close().catch(() => {});
      };
      setTesting(true);
    },
    [refresh, stopTest],
  );

  const pickDevice = (next: string): void => {
    const id = micDeviceIdOf(next);
    onSave({ mic_device_id: id ?? '' });
    setHint(null);
    track('mic_settings_changed', { setting: 'device', value: id ? 'specific' : 'default' });
    if (testing) void startTest(id);
  };

  const commitSens = (next: number): void => {
    const v = micSensitivityOf(next);
    if (v === micSensitivityOf(sensitivity)) return;
    onSave({ mic_sensitivity: v });
    applyMicSensitivityToCall(v);
    track('mic_settings_changed', { setting: 'sensitivity', value: micSensitivityBucket(v) });
  };

  const resetSens = (): void => {
    setSens(MIC_SENSITIVITY_DEFAULT);
    onSave({ mic_sensitivity: MIC_SENSITIVITY_DEFAULT });
    applyMicSensitivityToCall(MIC_SENSITIVITY_DEFAULT);
    track('mic_settings_changed', { setting: 'sensitivity_reset', value: 'default' });
  };

  // A saved device that is not in the list (unplugged). Only judged once the
  // list has real ids; with no devices at all there is nothing to compare.
  const savedMissing = listed && !!savedId && devices.length > 0 && !devices.some((d) => d.deviceId === savedId);
  const shownHint: Hint = hint ?? (savedMissing ? 'missing' : null);
  const selectValue = savedId && !savedMissing ? savedId : '';

  return (
    <div className={styles.group} data-testid="settings-microphone">
      <h3 className={styles.groupTitle}>{t('Microphone') /* >Microphone< */}</h3>
      <div className={styles.row}>
        <span className={styles.label}>{t('Input device')}</span>
        <select
          className={`${styles.langSelect} ${mic.deviceSelect}`}
          aria-label={t('Input device')}
          value={selectValue}
          onChange={(e) => pickDevice(e.target.value)}
        >
          <option value="">{t('System default')}</option>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t('Microphone {n}', { n: i + 1 })}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('Input level')}</span>
        <div
          className={mic.meter}
          role="meter"
          aria-label={t('Input level')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(meterPct(level))}
          data-active={testing ? 'true' : 'false'}
        >
          <div
            className={level >= bar && testing ? `${mic.meterFill} ${mic.meterFillOn}` : mic.meterFill}
            style={{ width: `${meterPct(level)}%` }}
          />
          {testing ? <div className={mic.meterMark} style={{ left: `${meterPct(bar)}%` }} /> : null}
        </div>
        <Button kind="secondary" size="sm" onClick={() => (testing ? stopTest() : void startTest(savedId))}>
          {testing ? t('Stop') : t('Test')}
        </Button>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Sensitivity')}
          <InfoTip
            label={t('About microphone sensitivity')}
            text={t(
              'How easily sound counts as you talking on a call. Turn it down if breathing, typing or background noise gets picked up. Turn it up if your companion misses quiet speech.',
            )}
          />
        </span>
        {sens !== MIC_SENSITIVITY_DEFAULT ? (
          <Button kind="quiet" size="sm" onClick={resetSens}>
            {t('Reset')}
          </Button>
        ) : null}
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={100}
          step={1}
          value={sens}
          aria-label={t('Sensitivity')}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSens(v);
            applyMicSensitivityToCall(v);
          }}
          onMouseUp={() => commitSens(sensRef.current)}
          onTouchEnd={() => commitSens(sensRef.current)}
          onKeyUp={() => commitSens(sensRef.current)}
          onBlur={() => commitSens(sensRef.current)}
        />
        <span className={`${styles.monoValue} ${mic.sensValue}`}>{sens}</span>
      </div>
      {shownHint ? (
        <p className={`${styles.helper} ${shownHint === 'denied' || shownHint === 'error' ? styles.helperError : ''}`} role="status">
          {shownHint === 'denied' ? (
            <>
              {t('Sei is not allowed to use your microphone.')}{' '}
              <button type="button" className={styles.creditLink} onClick={() => void openPermissionSettings('mic')}>
                {t('Open Settings')}
              </button>
            </>
          ) : shownHint === 'error' ? (
            t('Could not open the microphone. Another app may be using it.')
          ) : (
            t('The microphone you picked is not connected, so calls use the default one.')
          )}
        </p>
      ) : null}
    </div>
  );
}
