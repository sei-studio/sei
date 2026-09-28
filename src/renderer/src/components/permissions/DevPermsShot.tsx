/**
 * DevPermsShot: dev-only screenshot harness for the OS permission cards
 * (260929), NOT part of the app UI. Mounted by DevDashShot for
 * `?dashshot=perms`, with `&part=`:
 *
 *     mic             the microphone card (macOS copy)
 *     mic-win         the microphone card (Windows copy)
 *     mic-restricted  macOS, managed by Screen Time / MDM
 *     mic-restart     macOS says granted but the mic still refuses
 *     screen          the share picker's Screen Recording step
 *     screen-waiting  after Open Settings
 *     screen-restart  20 s after "I turned it on" with no access
 *
 * Add `&lang=zh` for the Chinese copy and `&theme=ice|midnight|acorn|mint`
 * for a theme (default: follow the system). window.sei is stubbed by
 * devHarnessStubs.ts (every permission reads denied, the probe never
 * succeeds), so the cards sit still for the camera.
 */
import React from 'react';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useLangStore } from '../../lib/i18n';
import { applyTheme, clampThemeMode } from '../../lib/theme';
import { MicAccessCardBody } from './MicAccessCard';
import { ShareScreenModal } from '../backseat/ShareScreenModal';

const CHAR = 'perms-char';

function seed(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('lang') === 'zh') useLangStore.getState().setLang('zh');
  applyTheme(clampThemeMode(params.get('theme') ?? 'system'));
  useDataStore.setState((s) => ({
    characters: [
      ...s.characters,
      { id: CHAR, name: 'Sui', portrait_image: './img/onboard/sui-stand.png' } as unknown as (typeof s.characters)[number],
    ],
  }));
}
seed();

export function DevPermsShot(): React.ReactElement {
  const part = new URLSearchParams(window.location.search).get('part') ?? 'mic';
  const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'var(--window)' };
  if (part.startsWith('screen')) {
    const initialAccess =
      part === 'screen-restart' ? 'blocked-restart' : part === 'screen-waiting' ? 'blocked-waiting' : 'blocked-ask';
    return (
      <div style={backdrop}>
        <ShareScreenModal characterId={CHAR} initialAccess={initialAccess} />
      </div>
    );
  }
  return (
    <div style={backdrop}>
      <MicAccessCardBody
        characterId={CHAR}
        platform={part === 'mic-win' ? 'win32' : 'darwin'}
        restricted={part === 'mic-restricted'}
        needsRestart={part === 'mic-restart'}
      />
    </div>
  );
}
