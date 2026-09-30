/**
 * DevCreditWallShot — dev-only screenshot harness for the credit wall
 * surfaces (260926), NOT part of the app UI. Mounted by DevDashShot for
 * `?dashshot=creditwall`, with `&part=`:
 *
 *     modal    the usage-limit popup (HardStopModal), depleted
 *     credits  the Credits screen at the wall, with the reset callout
 *     draw     the Draw! paused card on the credit wall
 *     banner   the "Your free play is back" strip
 *
 * Add `&lang=zh` for the Chinese copy. window.sei is stubbed by
 * devHarnessStubs.ts (creditsGet answers a free plan at the wall, reset 3
 * days out). Deliberately no real IPC.
 */
import React from 'react';
import type { DrawGameState } from '@shared/drawIpc';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useDrawStore } from '../lib/stores/useDrawStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useLangStore } from '../lib/i18n';
import { HardStopModal } from './HardStopModal';
import { Banner } from './Banner';
import { CreditsScreen } from '../screens/CreditsScreen';
import { DrawScreen } from './draw/DrawScreen';
import { useT } from '../lib/i18n';

const CHAR = 'creditwall-char';
const RESETS_AT = new Date(Date.now() + 3 * 86_400_000).toISOString();

function seed(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('lang') === 'zh') useLangStore.getState().setLang('zh');
  useCreditsStore.setState({
    plan: 'free',
    usage_pct: 100,
    over_limit: true,
    resets_at: RESETS_AT,
    ai_backend_kind: 'cloud-proxy',
    initialized: true,
    snapshotFailed: false,
    hardStopActive: params.get('part') === 'modal',
    hardStopReason: 'depleted',
  });
  useDataStore.setState((s) => ({
    characters: [
      ...s.characters,
      { id: CHAR, name: 'Sui', portrait_image: './img/onboard/sui-stand.png' } as unknown as (typeof s.characters)[number],
    ],
  }));
  const game: DrawGameState = {
    gameId: 'g1',
    characterId: CHAR,
    phase: 'drawing',
    rounds: 3,
    round: 2,
    drawer: 'ai',
    turnKey: 'k1',
    word: null,
    wordChoices: [],
    turnEndsAt: Date.now() + 40_000,
    paused: true,
    pausedRemainingMs: 42_000,
    pausedReason: 'depleted',
    strokes: [],
    clearSeq: 0,
    chat: [],
    scores: { player: 1, ai: 1 },
    gallery: [],
    playerName: 'You',
    aiName: 'Sui',
  };
  useDrawStore.setState((s) => ({ games: { ...s.games, [CHAR]: game } }));
}

seed();

function BannerPart(): React.ReactElement {
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Banner kind="info" message={t('Your free play is back. Your companions are ready when you are.')} onDismiss={() => {}} />
    </div>
  );
}

export function DevCreditWallShot(): React.ReactElement {
  const part = new URLSearchParams(window.location.search).get('part') ?? 'modal';
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--window)', overflow: 'auto' }}>
      {part === 'banner' ? <BannerPart /> : null}
      {part === 'credits' || part === 'modal' ? <CreditsScreen /> : null}
      {part === 'draw' ? <DrawScreen characterId={CHAR} /> : null}
      <HardStopModal />
    </div>
  );
}
