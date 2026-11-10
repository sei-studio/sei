/**
 * DevPlaytimeShot — dev-only screenshot harness for the Playtime page
 * (261110), NOT part of the app UI. Mounted by DevDashShot for
 * `?dashshot=playtime`, with:
 *
 *     &setup=cloud|chatgpt|mykeys       the setup in use (default cloud)
 *     &tab=sei|chatgpt|mykeys           open a tab other than the setup's
 *     &gpt=connected|none|limited       the ChatGPT sign-in
 *     &voice=sei|device|elevenlabs|fish the voice choice; &engine=kokoro
 *     &key=1                            an ElevenLabs key is saved
 *     &alert=1                          the monthly spend alert is on
 *     &part=settings                    the Settings screen instead
 *     &banner=1                         the spend alert line above the page
 *     &signedout=1                      no Sei account
 *     &lang=zh                          the Chinese copy
 *
 * window.sei is stubbed by devHarnessStubs.ts. Deliberately no real IPC.
 */
import React, { useEffect } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useChatgptStore } from '../lib/stores/useChatgptStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useLangStore } from '../lib/i18n';
import { isUiLanguage } from '@shared/uiLanguage';
import { PlaytimeScreen } from '../screens/PlaytimeScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SpendAlertBanner } from './playtime/SpendAlertBanner';

const params = new URLSearchParams(window.location.search);

function seed(): void {
  const shotLang = params.get('lang');
  if (isUiLanguage(shotLang)) useLangStore.getState().setLang(shotLang);
  const setup = params.get('setup');
  useCreditsStore.setState({
    plan: params.get('plan') === 'quest' || params.get('plan') === 'party' ? (params.get('plan') as 'quest' | 'party') : 'free',
    usage_pct: 35,
    over_limit: false,
    resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    ai_backend_kind: setup === 'chatgpt' || setup === 'mykeys' ? 'local' : 'cloud-proxy',
    initialized: true,
    snapshotFailed: false,
  });
  if (!params.has('signedout')) {
    useAuthStore.getState()._setState({
      kind: 'signed_in',
      user: { id: 'dev-user', email: 'robin@example.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
    });
  }
  const tab = params.get('tab');
  useUiStore.setState({
    view:
      tab === 'sei' || tab === 'chatgpt' || tab === 'mykeys' ? { kind: 'credits', tab } : { kind: 'credits' },
  });
}

// DevDashShot imports every harness eagerly: seed only for our own mode.
if (params.get('dashshot') === 'playtime') seed();

export function DevPlaytimeShot(): React.ReactElement {
  useEffect(() => {
    void useChatgptStore.getState().load();
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--window)' }}>
      <SpendAlertBanner />
      {params.get('part') === 'settings' ? <SettingsScreen /> : <PlaytimeScreen />}
    </div>
  );
}
