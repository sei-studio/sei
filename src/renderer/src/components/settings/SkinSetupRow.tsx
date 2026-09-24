/**
 * SkinSetupRow — Minecraft skin setup wizard status row (moved verbatim out
 * of SettingsScreen.tsx by game adapters M0, 260908).
 *
 * "Run setup" / "Re-run setup" opens SetupWizardModal in re-entry mode. The
 * pill state (enabled-install count) refreshes whenever the wizard closes.
 */
import React, { useEffect, useState } from 'react';
import type { WizardState } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useWizardStore } from '../../lib/stores/useWizardStore';
import { Button } from '../Button';
import { InfoTip } from '../InfoTip';
import styles from '../../screens/SettingsScreen.module.css';

export function SkinSetupRow(): React.ReactElement {
  const t = useT();
  const openWizard = useWizardStore((s) => s.openWizard);
  // Re-read the persisted wizard state whenever the wizard CLOSES so a
  // completed "Re-run setup" flips the label without reopening Settings.
  const wizardOpen = useWizardStore((s) => s.open);
  const [state, setState] = useState<WizardState | null>(null);

  useEffect(() => {
    // Skip while the wizard is open — the fetch would race its in-flight
    // install. The effect re-runs when wizardOpen flips back to false.
    if (wizardOpen) return;
    let cancelled = false;
    void sei.getWizardState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [wizardOpen]);

  const enabledCount = state?.enabledInstallIds.length ?? 0;

  return (
    <div className={styles.row}>
      <span className={styles.label}>
        {t('Custom skins')}
        <InfoTip
          label={t('About custom skins')}
          text={t(
            'Give your companion a Minecraft skin so it looks right in your world. This runs a quick one-time setup for your Minecraft install.',
          )}
        />
      </span>
      <Button kind="ghost" size="sm" onClick={() => openWizard(true)}>
        {enabledCount > 0 ? t('Re-run setup') : t('Run setup')}
      </Button>
    </div>
  );
}
