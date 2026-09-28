/**
 * DevRobloxShot: dev-only screenshot harness for the backseat game tile
 * (260929), NOT part of the app UI. Mounted by DevDashShot for
 * `?dashshot=roblox`, with `&part=`:
 *
 *   picker  the games picker with the Roblox (Backseat) tile
 *   intro   the one-time intro popup (the pref is cleared first)
 *   pick    the "which Roblox game" step (the pref is set first)
 *   share   the share picker with the Roblox window preselected
 *
 * Add `&lang=zh` for the Chinese copy. window.sei is stubbed by
 * devHarnessStubs.ts; its backseat game lookups call through to
 * `window.__seiDevRoblox*` when a test driver exposed them (the screenshot
 * script backs them with the real main-side Roblox client), else fixtures.
 */
import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useLangStore } from '../../lib/i18n';
import { GamesPickerModal } from '../GamesPickerModal';
import { BackseatGameModal } from './BackseatGameModal';
import { ShareScreenModal } from './ShareScreenModal';

const CHAR = 'dashshot-roblox';
const INTRO_KEY = 'sei.backseatGameIntro.v1.roblox.local';

function seed(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('lang') === 'zh') useLangStore.getState().setLang('zh');
  useDataStore.setState((s) => ({
    characters: [
      ...s.characters,
      { id: CHAR, name: 'Sui', portrait_image: './img/onboard/sui-stand.png' } as unknown as (typeof s.characters)[number],
    ],
  }));
  // A vision-capable model, so the tile is not locked.
  useUiStore.setState({ llmVision: 'yes' } as never);
  try {
    if (params.get('part') === 'intro') localStorage.removeItem(INTRO_KEY);
    else localStorage.setItem(INTRO_KEY, '1');
  } catch {
    /* no storage: the intro shows, which is the intro part anyway */
  }
}

seed();

export function DevRobloxShot(): React.ReactElement {
  const part = new URLSearchParams(window.location.search).get('part') ?? 'picker';
  // The picker routes a Roblox click through the ui store's modal; mirror
  // App.tsx so clicking through works in the harness too.
  const modal = useUiStore((s) => s.modal);
  const [started] = React.useState(() => {
    if (part === 'picker') useUiStore.getState().openModal({ kind: 'games-picker', characterId: CHAR });
    if (part === 'intro' || part === 'pick') {
      useUiStore.getState().openModal({ kind: 'backseat-game', characterId: CHAR, gameId: 'roblox' });
    }
    if (part === 'share') {
      useUiStore.getState().openModal({
        kind: 'share-screen',
        characterId: CHAR,
        game: { gameId: 'roblox', universeId: 1686885941 },
      });
    }
    return true;
  });
  void started;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--window)' }}>
      {modal?.kind === 'games-picker' ? <GamesPickerModal characterId={modal.characterId} /> : null}
      {modal?.kind === 'backseat-game' ? (
        <BackseatGameModal characterId={modal.characterId} gameId={modal.gameId} />
      ) : null}
      {modal?.kind === 'share-screen' ? (
        <ShareScreenModal characterId={modal.characterId} game={modal.game} />
      ) : null}
    </div>
  );
}
