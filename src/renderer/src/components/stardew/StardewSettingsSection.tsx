/**
 * StardewSettingsSection (game adapters M1): the Settings "Stardew Valley"
 * group. Install status (game found, SMAPI, the companion mod + version)
 * with a Run / Re-run setup button, and on Windows the Steam achievements
 * note (the launch option Sei cannot set) with a copy button.
 */
import React, { useEffect, useState } from 'react';
import { steamLaunchOption } from '@shared/stardewIpc';
import { useT } from '../../lib/i18n';
import { useStardewStore } from '../../lib/stores/useStardewStore';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import { progressLine, installErrorCopy } from './stardewCopy';
import styles from '../../screens/SettingsScreen.module.css';

export function StardewSettingsSection(_props: GameSettingsSectionProps): React.ReactElement {
  const t = useT();
  const state = useStardewStore((s) => s.state);
  const installing = useStardewStore((s) => s.installing);
  const installError = useStardewStore((s) => s.installError);
  const progress = useStardewStore((s) => s.progress);
  const init = useStardewStore((s) => s.init);
  const refresh = useStardewStore((s) => s.refresh);
  const runInstall = useStardewStore((s) => s.install);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const off = init();
    void refresh();
    return off;
  }, [init, refresh]);

  let status: string;
  if (!state) status = t('Checking...');
  else if (!state.gamePath) status = t('Game not found');
  else if (state.ready) status = state.modVersion ? t('Ready (mod {version})', { version: state.modVersion }) : t('Ready');
  else if (state.smapiInstalled) status = t('SMAPI installed, mod missing');
  else status = t('Not set up');
  const line = installing ? progressLine(progress) : null;
  const err = !installing ? installErrorCopy(installError) : null;

  const copyLaunchOption = async (): Promise<void> => {
    if (!state?.gamePath) return;
    try {
      await navigator.clipboard.writeText(steamLaunchOption(state.gamePath));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Companion mod')}
          <InfoTip
            label={t('About the companion mod')}
            text={t("Sei puts your companion into your farm through a small SMAPI mod. Setup installs SMAPI from its official release and copies the mod into your game's Mods folder.")}
          />
          <span className={styles.hint}> {line ? t(line.key, { pct: line.pct ?? 0 }) : err ? t(err.copy) : status}</span>
        </span>
        <Button kind="ghost" size="sm" disabled={installing || !state?.gamePath} onClick={() => void runInstall()}>
          {state?.ready ? t('Re-run setup') : t('Run setup')}
        </Button>
      </div>
      {state?.platform === 'win32' && state.gamePath ? (
        <div className={styles.row}>
          <span className={styles.label}>
            {t('Steam achievements')}
            <InfoTip
              label={t('About Steam achievements')}
              text={t('Launched from Sei, the game runs outside Steam and achievements do not unlock. Add this launch option to Stardew Valley in Steam (Properties, Launch Options) and start it from Steam instead: {option}', { option: steamLaunchOption(state.gamePath) })}
            />
          </span>
          <Button kind="ghost" size="sm" onClick={() => void copyLaunchOption()}>
            {copied ? t('Copied') : t('Copy launch option')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
