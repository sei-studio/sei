/**
 * Playtime > Sei > Voice > Advanced (261120, product call 261120): one
 * collapsed line on the cloud tab. Opened, it holds the ElevenLabs key
 * (the user's own ElevenLabs voices), who speaks (Sei voices,
 * the default, or Fish Audio on the user's own key) and the Fish Audio key.
 *
 * Fish speaks a cloud line ONLY when picked here (config cloud_tts_provider,
 * read by main's fishOnCloud): a key alone, or a BYOK Fish setup carried
 * over, never sends text to Fish. Fish needs a saved key first; removing the
 * key while Fish is picked goes back to Sei voices. Usage runs on the user's
 * Fish account, never on Sei's bill.
 */
import React, { useEffect, useId, useState } from 'react';
import type { UserConfig } from '@shared/characterSchema';
import { cloudVoiceProvider, type CloudVoiceProvider } from '@shared/ttsEngine';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { FishAudioSettings } from '../settings/FishAudioSettings';
import { Choice, Row } from './PlaytimeParts';
import { ElevenKeyRow } from './ElevenKeyRow';
import styles from '../../screens/PlaytimeScreen.module.css';

export function CloudVoiceAdvanced(props: {
  cfg: UserConfig;
  persist: (fn: (c: UserConfig) => UserConfig) => Promise<boolean>;
}): React.ReactElement {
  const { cfg, persist } = props;
  const t = useT();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [hasFishKey, setHasFishKey] = useState<boolean | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const provider = cloudVoiceProvider(cfg);

  useEffect(() => {
    let alive = true;
    void sei
      .voiceFishKeyStatus()
      .then(({ present }) => {
        if (alive) setHasFishKey(present);
      })
      .catch(() => {
        if (alive) setHasFishKey(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setProvider = async (next: CloudVoiceProvider, via: 'choice' | 'key_removed'): Promise<void> => {
    const ok = await persist((c) => ({ ...c, cloud_tts_provider: next }));
    if (ok) sei.track('playtime_cloud_voice_provider_switched', { to: next, via });
  };

  const onPick = (next: CloudVoiceProvider): void => {
    if (next === 'fish' && hasFishKey !== true) {
      // Fish needs the user's own key: nothing is switched until one is saved.
      setNeedKey(true);
      sei.track('playtime_cloud_voice_provider_blocked', { reason: 'no_key' });
      return;
    }
    setNeedKey(false);
    void setProvider(next, 'choice');
  };

  const onFishKeyChange = (present: boolean): void => {
    setHasFishKey(present);
    if (present) setNeedKey(false);
    // No key, no Fish: back to Sei voices.
    if (!present && provider === 'fish') void setProvider('sei', 'key_removed');
  };

  return (
    <>
      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="cloud-voice-advanced"
        onClick={() => {
          if (!open) sei.track('playtime_voice_advanced_opened', { provider });
          setOpen(!open);
        }}
      >
        <span className={styles.rowLabel}>{t('Advanced')}</span>
        {!open && provider === 'fish' ? <span className={styles.muted}>Fish Audio</span> : null}
        <svg
          className={open ? `${styles.advancedChevron} ${styles.advancedChevronOpen}` : styles.advancedChevron}
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div id={bodyId} className={styles.panel}>
          <ElevenKeyRow mode="cloud-optional" />
          <Row label={t('Voice provider')}>
            <Choice<CloudVoiceProvider>
              aria-label={t('Voice provider')}
              value={provider}
              options={[
                { value: 'sei', label: t('Sei voices') },
                { value: 'fish', label: 'Fish Audio' },
              ]}
              onChange={onPick}
            />
          </Row>
          {needKey ? (
            <p className={styles.note} role="status">
              {t('Add your Fish Audio key first.')}
            </p>
          ) : null}
          <FishAudioSettings surface="cloud" onKeyChange={onFishKeyChange} />
        </div>
      ) : null}
    </>
  );
}
