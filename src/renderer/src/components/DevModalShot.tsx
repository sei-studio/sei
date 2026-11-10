/**
 * DevModalShot — dev-only screenshot harness for the dialogs DevScreenShot
 * does not cover (261110, the quiet restyle's second pass).
 *
 *   http://localhost:5173/?dashshot=screen&screen=modal&m=<modal>[&theme=light|dark][&lang=zh]
 *     m = knowledge | versions | dmca | migrate | tos | newpassword | oauth |
 *         summonconflict | offline | botcrash |
 *         update | forced | whatsnew
 *
 * Each dialog renders over the bare shell (the field and the rail) with a
 * small fixture behind the bridge calls it makes. `dashshot=screen` keeps
 * devHarnessStubs' forgiving Proxy bridge; this file only adds the few
 * answers a dialog needs to draw its content. Not part of the app UI.
 */
import React from 'react';
import { useLangStore } from '../lib/i18n';
import { applyTheme } from '../lib/theme';
import { isUiLanguage } from '@shared/uiLanguage';
import { MacosWindow } from './MacosWindow';
import { KnowledgeModal } from './KnowledgeModal';
import { PortraitVersionsModal } from './PortraitVersionsModal';
import { DmcaContactModal } from './DmcaContactModal';
import { MigrateLocalCharsModal } from './MigrateLocalCharsModal';
import { AcceptToSModal } from './AcceptToSModal';
import { SetNewPasswordModal } from './SetNewPasswordModal';
import { OAuthInterstitialModal } from './OAuthInterstitialModal';
import { SummonConflictModal } from './SummonConflictModal';
import { OfflineRetryModal } from './OfflineRetryModal';
import { BotCrashModal } from './BotCrashModal';
import { UpdatePopup, type UpdatePopupState } from './UpdatePopup';
import suiArt from '../../../../vendor/skin-gen/examples/sui-input.png';

const params = new URLSearchParams(window.location.search);
const which = params.get('m') ?? 'knowledge';
const SUI = '3f6c2a1e-9b7d-4c1a-8e2f-5a6b7c8d9e01';
const DAY = 86_400_000;
const now = Date.now();
const noop = (): void => undefined;

const CHANGELOG =
  "## What's new in 0.7.0\n- New: play Stardew Valley and Don't Starve Together together\n- Calls pick up where you left off\n- Fixes for the voice picker and the World tab";

function seed(): void {
  const theme = params.get('theme');
  applyTheme(theme === 'light' ? 'ice' : 'midnight');
  const lang = params.get('lang');
  if (lang && isUiLanguage(lang)) useLangStore.getState().setLang(lang);
  const bridge = (window as unknown as { sei: Record<string, unknown> }).sei;
  Object.assign(bridge, {
    knowledgeList: async () => [
      { id: 'k1', title: 'Our lake house build notes', bytes: 4_812, added: new Date(now - 3 * DAY).toISOString(), source: 'upload' },
      { id: 'k2', title: 'Favourite Stardew crops', bytes: 1_204, added: new Date(now - DAY).toISOString(), source: 'text' },
      { id: 'k3', title: 'Chat history summary', bytes: 9_960, added: new Date(now - 9 * DAY).toISOString(), source: 'compacted' },
    ],
    charsPortraitVersions: async () => ({
      versions: [
        { file: `${SUI}-v1.png`, created_at: new Date(now - 9 * DAY).toISOString(), source: 'original' },
        { file: `${SUI}-v2.png`, created_at: new Date(now - DAY).toISOString(), source: 'regen' },
      ],
      active: `${SUI}-v2.png`,
      regenCount: 1,
      regenLimit: 3,
    }),
    getCharacter: async () => ({ id: SUI, name: 'Sui', portrait_image: suiArt }),
    // The OAuth interstitial waits on the browser round trip; keep it pending.
    signInGoogle: () => new Promise(() => undefined),
    cancelGoogle: async () => ({ ok: true }),
    migrationListLocal: async () => ({
      characters: [
        { id: 'a', name: 'Sui', slug: 'sui', created: new Date(now - 30 * DAY).toISOString() },
        { id: 'b', name: 'Lyra', slug: 'lyra', created: new Date(now - 20 * DAY).toISOString() },
        { id: 'c', name: 'Marv', slug: null, created: new Date(now - 2 * DAY).toISOString() },
      ],
      cloudListOk: true,
    }),
  });
}

seed();

const POPUP: Record<string, UpdatePopupState> = {
  update: { kind: 'available-optional', currentVersion: '0.6.12', latestVersion: '0.7.0', changelog: CHANGELOG },
  forced: { kind: 'forced' },
  whatsnew: { kind: 'whats-new', version: '0.7.0', changelog: CHANGELOG },
};

function Dialog(): React.ReactElement | null {
  switch (which) {
    case 'knowledge':
      return <KnowledgeModal characterId={SUI} characterName="Sui" onClose={noop} />;
    case 'versions':
      return <PortraitVersionsModal characterId={SUI} characterName="Sui" onClose={noop} />;
    case 'dmca':
      return <DmcaContactModal onClose={noop} />;
    case 'migrate':
      return <MigrateLocalCharsModal onClose={noop} />;
    case 'tos':
      return <AcceptToSModal onAccepted={noop} />;
    case 'newpassword':
      return <SetNewPasswordModal onClose={noop} />;
    case 'oauth':
      return <OAuthInterstitialModal onResult={noop} onCancel={noop} />;
    case 'summonconflict':
      return <SummonConflictModal attemptedName="Lyra" conflictName="Sui" username="Sui" />;
    case 'offline':
      return <OfflineRetryModal onDismiss={noop} />;
    case 'botcrash':
      return <BotCrashModal characterId={SUI} />;
    default:
      return POPUP[which] ? <UpdatePopup state={POPUP[which]} platform="win32" onDismiss={noop} onUpdateNow={noop} /> : null;
  }
}

export function DevModalShot(): React.ReactElement {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <MacosWindow railHidden>
        <div style={{ flex: 1 }} />
      </MacosWindow>
      <Dialog />
    </div>
  );
}
