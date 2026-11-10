/**
 * Playtime > Voice (261110, product call 261110): where companions' voices
 * come from off the Sei cloud, moved here from Settings > Voice.
 *
 * - ChatGPT tab: On this device / ElevenLabs key. Sei voices (signed in
 *   only, with the "Free this week" meter) is built but stays hidden until
 *   SEI_VOICES_FOR_CHATGPT_ENABLED (shared/ttsEngine.ts) is turned on.
 * - My keys tab: On this device / ElevenLabs key / Fish Audio key.
 *
 * The on-device engine (Fast or Kokoro) is a small select inside the "On
 * this device" choice, not a row of its own (founder feedback 261110).
 * Picking Kokoro (or SenseVoice recognition) without its pack offers the
 * download first and saves once the pack is ready, as Settings did.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { UserConfig } from '@shared/characterSchema';
import type { SpeechPackStatePush } from '@shared/ipc';
import {
  SEI_VOICES_FOR_CHATGPT_ENABLED,
  localTtsModel,
  voiceSourceOf,
  type LocalTtsModel,
  type VoiceSource,
} from '@shared/ttsEngine';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useCreditsStore } from '../../lib/stores/useCreditsStore';
import { KOKORO_PACK_ID, localModelPickAction, showTtsPackRow } from '../../lib/localVoiceChoice';
import { Button } from '../Button';
import { DownloadConfirmModal } from '../DownloadConfirmModal';
import { FishAudioSettings } from '../settings/FishAudioSettings';
import { ElevenKeyRow } from './ElevenKeyRow';
import { Choice, Row } from './PlaytimeParts';
import styles from '../../screens/PlaytimeScreen.module.css';

/** Voice top-up tiles and the voice plan card: UI only until the products exist. */
export const VOICE_PLAN_UI_ENABLED = false;

/**
 * The local voice packs, in display order (ids match src/main/speech/packs.ts;
 * the renderer never imports main). Each language pack holds both speakers.
 */
const TTS_PACK_ROWS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'tts-kokoro', label: 'Kokoro voices' },
  { id: 'tts-en', label: 'English voices, female and male' },
  { id: 'tts-zh', label: 'Chinese voices, female and male' },
];

const SENSEVOICE_PACK_ID = 'stt-sensevoice';

type SttEngine = 'scribe' | 'whisper' | 'sensevoice';

export interface VoicePanelProps {
  mode: 'chatgpt' | 'mykeys';
  cfg: UserConfig;
  /** Read-modify-write of the whole config (PlaytimeScreen owns the copy). */
  persist: (fn: (c: UserConfig) => UserConfig) => Promise<boolean>;
  signedIn: boolean;
}

export function VoicePanel({ mode, cfg, persist, signedIn }: VoicePanelProps): React.ReactElement {
  const t = useT();
  const usagePct = useCreditsStore((s) => s.usage_pct);
  const creditsKnown = useCreditsStore((s) => s.initialized && !s.snapshotFailed);
  const [packStates, setPackStates] = useState<Record<string, SpeechPackStatePush>>({});
  const [pendingPack, setPendingPack] = useState<{
    id: string;
    name: string;
    thenSensevoice?: boolean;
    thenKokoro?: boolean;
  } | null>(null);
  const [packError, setPackError] = useState<string | null>(null);

  useEffect(() => {
    void sei
      .speechPackStatus()
      .then(({ packs }) => setPackStates(packs))
      .catch(() => {
        /* the pack rows show no state until the first push */
      });
    return sei.onSpeechPackState(({ packs }) => setPackStates(packs));
  }, []);

  const rawSource = voiceSourceOf(cfg);
  const localModel: LocalTtsModel = localTtsModel(cfg);
  // The ChatGPT tab offers no Fish choice: a Fish setup shows as "On this
  // device" with Fish Audio named in the engine select, so it stays honest.
  const source: VoiceSource = mode === 'chatgpt' && rawSource === 'fish' ? 'device' : rawSource;
  const sttEngine: SttEngine = cfg.stt_engine ?? 'scribe';

  const options: Array<{ value: VoiceSource; label: string }> =
    mode === 'chatgpt'
      ? [
          ...(SEI_VOICES_FOR_CHATGPT_ENABLED && (signedIn || source === 'sei')
            ? [{ value: 'sei' as const, label: t('Sei voices') }]
            : []),
          { value: 'device', label: t('On this device') },
          { value: 'elevenlabs', label: t('ElevenLabs key') },
        ]
      : [
          { value: 'device', label: t('On this device') },
          { value: 'elevenlabs', label: t('ElevenLabs key') },
          { value: 'fish', label: t('Fish Audio key') },
        ];

  const onPickSource = (next: VoiceSource): void => {
    void persist((c) => {
      if (next === 'sei') return SEI_VOICES_FOR_CHATGPT_ENABLED ? { ...c, tts_engine: 'sei' } : c;
      if (next === 'elevenlabs') return { ...c, tts_engine: 'elevenlabs' };
      if (next === 'fish') return { ...c, tts_engine: 'local', local_tts_model: 'fish' };
      return { ...c, tts_engine: 'local', local_tts_model: localTtsModel(c) === 'fish' ? 'fast' : localTtsModel(c) };
    });
  };

  // The latest config, for saves that land after a download.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const persistLocalModel = (next: LocalTtsModel): Promise<boolean> =>
    persistRef.current((c) => ({ ...c, tts_engine: 'local', local_tts_model: next }));
  const onPickEngine = (next: LocalTtsModel): void => {
    if (localModelPickAction(next, packStates[KOKORO_PACK_ID]?.state) === 'offer-download') {
      setPendingPack({ id: KOKORO_PACK_ID, name: t('Kokoro voices'), thenKokoro: true });
      return;
    }
    void persistLocalModel(next);
  };

  const persistStt = (next: SttEngine): Promise<boolean> => persistRef.current((c) => ({ ...c, stt_engine: next }));
  const onPickStt = (next: SttEngine): void => {
    if (next === sttEngine) return;
    if (next === 'sensevoice' && packStates[SENSEVOICE_PACK_ID]?.state !== 'ready') {
      setPendingPack({ id: SENSEVOICE_PACK_ID, name: t('SenseVoice'), thenSensevoice: true });
      return;
    }
    void persistStt(next);
  };

  const startPackDownload = async (packId: string, thenSensevoice: boolean, thenKokoro: boolean): Promise<void> => {
    setPendingPack(null);
    setPackError(null);
    try {
      await sei.speechPackDownload({ packId });
      if (thenSensevoice) await persistStt('sensevoice');
      if (thenKokoro) await persistLocalModel('kokoro');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Playtime] speechPackDownload failed', err);
      setPackError(t('Download failed. Check your connection and try again.'));
    }
  };
  const onRemovePack = async (packId: string): Promise<void> => {
    setPackError(null);
    try {
      await sei.speechPackRemove({ packId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Playtime] speechPackRemove failed', err);
      setPackError(t('Failed to uninstall. Try again.'));
    }
  };

  // "Free this week": what is left of the account's weekly allowance, which
  // Sei voices draw from. A percent, never a reset time.
  const freeLeftPct = Math.max(0, Math.min(100, Math.round(100 - usagePct)));
  const showTrial = SEI_VOICES_FOR_CHATGPT_ENABLED && source === 'sei' && signedIn && creditsKnown;
  const trialTracked = useRef(false);
  useEffect(() => {
    if (!showTrial || trialTracked.current) return;
    trialTracked.current = true;
    sei.track('voice_trial_state', { state: 'shown', left_pct: freeLeftPct });
  }, [showTrial, freeLeftPct]);

  const engineSelect =
    source === 'device' ? (
      <select
        className={`${styles.select} ${styles.selectSans}`}
        aria-label={t('Voice engine')}
        value={rawSource === 'fish' ? 'fish' : localModel}
        onChange={(e) => onPickEngine(e.target.value as LocalTtsModel)}
      >
        <option value="fast">{t('Fast')}</option>
        <option value="kokoro">Kokoro</option>
        {rawSource === 'fish' ? <option value="fish">{t('Fish Audio')}</option> : null}
      </select>
    ) : null;

  return (
    <section className={styles.section} aria-label={t('Voice')}>
      <h3 className={styles.sectionTitle}>{t('Voice')}</h3>
      <div className={styles.panel}>
        <Row label={t('Voice')} testId="voice-source">
          <span className={styles.inlineEngine}>
            <Choice aria-label={t('Voice')} value={source} options={options} onChange={onPickSource} />
            {engineSelect}
          </span>
        </Row>

        {showTrial ? (
          <Row label={t('Free this week')} testId="voice-trial">
            <span className={styles.meter} aria-hidden>
              <span className={styles.meterFill} style={{ width: `${freeLeftPct}%` }} />
            </span>
            <span className={styles.meterValue}>{t('{pct}% left', { pct: freeLeftPct })}</span>
          </Row>
        ) : null}

        {source === 'elevenlabs' ? <ElevenKeyRow mode="byok" /> : null}

        {source === 'device'
          ? TTS_PACK_ROWS.filter((row) =>
              showTtsPackRow(row.id, localModel, packStates[KOKORO_PACK_ID]?.state),
            ).map((row) => {
              const st = packStates[row.id];
              return (
                <Row key={row.id} label={<span className={styles.muted}>{t(row.label)}</span>}>
                  {st?.state === 'downloading' ? (
                    <span className={`${styles.mono} ${styles.warn}`} role="status">
                      {t('Downloading… {pct}%', { pct: st.pct ?? 0 })}
                    </span>
                  ) : st?.state === 'ready' ? (
                    <>
                      <span className={`${styles.mono} ${styles.ok}`}>{t('Ready')}</span>
                      <Button kind="quiet" size="sm" onClick={() => void onRemovePack(row.id)}>
                        {t('Uninstall')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      kind="secondary"
                      size="sm"
                      disabled={!st}
                      onClick={() => setPendingPack({ id: row.id, name: t(row.label) })}
                    >
                      {t('Download…')}
                    </Button>
                  )}
                </Row>
              );
            })
          : null}

        <Row label={t('Voice recognition')}>
          {packStates[SENSEVOICE_PACK_ID]?.state === 'downloading' ? (
            <span className={`${styles.mono} ${styles.warn}`} role="status">
              {t('Downloading… {pct}%', { pct: packStates[SENSEVOICE_PACK_ID]?.pct ?? 0 })}
            </span>
          ) : null}
          <select
            className={`${styles.select} ${styles.selectSans}`}
            aria-label={t('Voice recognition')}
            value={sttEngine}
            onChange={(e) => onPickStt(e.target.value as SttEngine)}
          >
            <option value="scribe">{t('ElevenLabs Scribe')}</option>
            <option value="whisper">{t('Local Whisper')}</option>
            <option value="sensevoice">{t('SenseVoice')}</option>
          </select>
        </Row>
      </div>

      {/* Fish Audio's own rows (key, test, privacy line) keep their component. */}
      {source === 'fish' ? (
        <div className={styles.panel}>
          <FishAudioSettings />
        </div>
      ) : null}

      {packError ? (
        <p className={`${styles.note} ${styles.noteError}`} role="alert">
          {packError}
        </p>
      ) : null}

      {VOICE_PLAN_UI_ENABLED && mode === 'chatgpt' && source === 'sei' ? (
        <div className={styles.tiles} data-testid="voice-plan-tiles">
          <div className={styles.tile}>
            <span className={styles.statLabel}>{t('Top up')}</span>
            <Button kind="soft" size="md" disabled>
              {t('Buy')}
            </Button>
          </div>
          <div className={styles.tile}>
            <span className={styles.statLabel}>{t('Top up')}</span>
            <Button kind="soft" size="md" disabled>
              {t('Buy')}
            </Button>
          </div>
          <div className={styles.tile}>
            <span className={styles.statLabel}>{t('Voice plan')}</span>
            <Button kind="primary" size="md" disabled>
              {t('Get voice plan')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Sizes come from the pack registry via the status push, never a literal. */}
      {pendingPack && packStates[pendingPack.id] ? (
        <DownloadConfirmModal
          name={pendingPack.name}
          bytes={packStates[pendingPack.id].bytes}
          onCancel={() => setPendingPack(null)}
          onConfirm={() =>
            void startPackDownload(pendingPack.id, pendingPack.thenSensevoice === true, pendingPack.thenKokoro === true)
          }
        />
      ) : null}
    </section>
  );
}
