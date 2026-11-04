/**
 * SeilinkLabsRow — Settings → Labs "Desktop room" (261104, SeiLink M4).
 *
 * Off by default (config `seilink_enabled`, per profile). On: the companion
 * page offers "Move onto desktop", which puts her room on the wallpaper.
 * Turning it off moves her out (main, applySeilinkSetting).
 *
 * Only macOS and Windows with the desktop-host addon can run it; elsewhere
 * the toggle is disabled with one short reason under the row. The dev flag
 * (unpackaged + SEI_SEILINK_PACKS) keeps SeiLink on regardless.
 */
import React from 'react';
import type { SeilinkAvailability } from '@shared/seilinkHost';
import type { UserConfig } from '@shared/characterSchema';
import { InfoTip } from '../InfoTip';
import { Toggle } from '../Toggle';
import { useT } from '../../lib/i18n';
import { useSeilinkStore } from '../../lib/stores/useSeilinkStore';
import styles from '../../screens/SettingsScreen.module.css';

export function seilinkUnsupportedReason(a: SeilinkAvailability | null): string | null {
  if (!a || a.supported) return null;
  return a.reason === 'addon' ? 'Not available in this build of Sei.' : 'Needs macOS or Windows.';
}

export function SeilinkLabsRowView({
  on,
  availability,
  onToggle,
}: {
  on: boolean;
  availability: SeilinkAvailability | null;
  onToggle: (next: boolean) => void;
}): React.ReactElement {
  const t = useT();
  const reason = seilinkUnsupportedReason(availability);
  return (
    <>
      <div className={[styles.row, reason ? styles.rowOpen : ''].filter(Boolean).join(' ')}>
        <span className={styles.label}>
          {t('Desktop room')}
          <InfoTip
            label={t('About the desktop room')}
            text={t(
              'Your companion moves onto your desktop wallpaper, in a room you can decorate. Turn it on, then pick who moves in from their page.',
            )}
          />
        </span>
        <Toggle aria-label={t('Desktop room')} on={on && !reason} disabled={reason !== null || availability === null} onChange={onToggle} />
      </div>
      {reason ? <p className={styles.helper}>{t(reason)}</p> : null}
    </>
  );
}

export function SeilinkLabsRow({
  config,
  saveConfig,
}: {
  config: UserConfig | null;
  saveConfig: (next: UserConfig) => Promise<void>;
}): React.ReactElement {
  const availability = useSeilinkStore((s) => s.availability);
  const on = config?.seilink_enabled === true;
  return (
    <SeilinkLabsRowView
      on={on}
      availability={availability}
      onToggle={(next) => {
        if (!config) return;
        void saveConfig({ ...config, seilink_enabled: next }).then(() => useSeilinkStore.getState().refresh());
      }}
    />
  );
}
