/**
 * MinecraftSettingsSection — the body of the Settings "Minecraft" group
 * (moved verbatim out of SettingsScreen.tsx by game adapters M0, 260908, so
 * a per-game group can be added by registration; see
 * lib/gameSettingsSections.ts). Content unchanged: the skin-setup row and the
 * Looking (vision) mode selector.
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { Seg } from '../Seg';
import { InfoTip } from '../InfoTip';
import { SkinSetupRow } from './SkinSetupRow';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import styles from '../../screens/SettingsScreen.module.css';

export function MinecraftSettingsSection({ config, writeConfig }: GameSettingsSectionProps): React.ReactElement {
  const t = useT();
  const visionMode = config?.vision_mode ?? 'on-demand';
  const onSelectVisionMode = (mode: 'off' | 'on-demand' | 'continuous'): void => {
    if (mode === (config?.vision_mode ?? 'on-demand')) return;
    void writeConfig({ vision_mode: mode });
  };
  return (
    <>
      <SkinSetupRow />
      {/* Looking (vision): Off / On-demand / Continuous. Every move writes
          straight through. Continuous uses more of the weekly allowance;
          that shows up on the plan screen's usage bar, never as a number
          here. The mode explanation lives behind the (i) tip. */}
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Visual gameplay')}
          <InfoTip
            label={t('About visual gameplay')}
            text={t(
              "Companions usually play from lightweight snapshots of the world, but can pull a full render of what's around them when they need to see it, for example when building or navigating.",
            )}
          />
        </span>
        <Seg
          aria-label={t('Visual gameplay mode')}
          value={visionMode}
          options={[
            { value: 'off', label: t('Off') },
            { value: 'on-demand', label: t('On-demand') },
            { value: 'continuous', label: t('Continuous') },
          ]}
          onChange={onSelectVisionMode}
        />
      </div>
    </>
  );
}
