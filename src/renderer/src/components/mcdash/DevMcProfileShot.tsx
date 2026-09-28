/**
 * DevMcProfileShot — dev-only screenshot harness for the Sei profile /
 * Start Minecraft surfaces (260929), NOT part of the app UI. Mounted by
 * DevDashShot for `?dashshot=mcprofile`, with `&part=`:
 *
 *     lan          LanNotOpenModal (a summon found no open world)
 *     unsupported  UnsupportedVersionModal (world on 26.4)
 *     forge        the Forge block (LanHostWarningModal, warning=forge)
 *     setup        McSetupModal on the "Connecting to world" tab
 *     done         the setup wizard's done step
 *
 * `&ready=1` has a Sei profile (Start Minecraft), without it the surfaces
 * offer Set up Sei profile. `&platform=win32` shows the Windows firewall
 * line, `&lang=zh` the Chinese copy, `&nolauncher=1` makes Start Minecraft
 * answer "could not open the launcher". window.sei is stubbed by
 * devHarnessStubs.ts. Deliberately no real IPC.
 */
import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useWizardStore } from '../../lib/stores/useWizardStore';
import { useLangStore } from '../../lib/i18n';
import { LanNotOpenModal } from '../LanNotOpenModal';
import { UnsupportedVersionModal } from '../UnsupportedVersionModal';
import { LanHostWarningModal } from '../LanHostWarningModal';
import { McSetupModal } from '../McSetupModal';
import { SetupWizardModal } from '../SetupWizardModal';

const CHAR = 'mcprofile-char';

function seed(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('lang') === 'zh') useLangStore.getState().setLang('zh');
  useDataStore.setState((s) => ({
    characters: [
      ...s.characters,
      { id: CHAR, name: 'Sui', portrait_image: './img/onboard/sui-stand.png' } as unknown as (typeof s.characters)[number],
    ],
  }));
  if (params.get('part') === 'done') {
    useWizardStore.setState({
      open: true,
      step: 'done',
      isReentry: false,
      installs: [
        {
          id: 'v1', kind: 'vanilla', label: 'Vanilla Launcher', path: '/Users/you/Library/Application Support/minecraft',
          mc_version: '26.1', loader: 'fabric', loader_version: '0.19.5', fabric_mc_versions: ['26.1'],
          csl_installed: true, csl_version: '14.28', sei_enabled: true, compatibility: 'full',
        },
      ],
      selectedIds: new Set(['v1']),
      results: [{ installId: 'v1', ok: true, installedFabricVersion: '0.19.5', installedMcVersion: '26.1' }],
      error: null,
    });
  }
}

seed();

export function DevMcProfileShot(): React.ReactElement {
  const part = new URLSearchParams(window.location.search).get('part') ?? 'lan';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--desktop)' }}>
      {part === 'lan' ? <LanNotOpenModal characterId={CHAR} /> : null}
      {part === 'unsupported' ? (
        <UnsupportedVersionModal characterId={CHAR} message="This world is running Minecraft 26.4, which Sei can't join yet." />
      ) : null}
      {part === 'forge' ? (
        <LanHostWarningModal characterId={CHAR} warning="forge" host={{ client: 'forge', forgeModCount: 12 }} fromChat={false} />
      ) : null}
      {part === 'setup' ? <McSetupModal tab="world" searching /> : null}
      {part === 'done' ? <SetupWizardModal /> : null}
    </div>
  );
}
