/**
 * DevVoiceKeyShot — dev-only screenshot harness for the ElevenLabs key
 * surfaces (261020, T158), NOT part of the app UI. Mounted by DevDashShot
 * for `?dashshot=voicekey`, with:
 *
 *     &part=settings|picker   the Settings screen, or the voice picker
 *     &backend=cloud|local    the AI backend (default cloud)
 *     &key=1                  an ElevenLabs key is saved (default: none)
 *     &chatgpt=1              on the ChatGPT plan, signed in (use with backend=local)
 *     &lang=zh                the Chinese copy
 *
 * window.sei is stubbed by devHarnessStubs.ts (key presence, a small pool,
 * two own voices when a key is saved). Deliberately no real IPC.
 */
import React, { useEffect, useState } from 'react';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useChatgptStore } from '../lib/stores/useChatgptStore';
import { useLangStore } from '../lib/i18n';
import { SettingsScreen } from '../screens/SettingsScreen';
import { VoicePicker } from './VoicePicker';
import type { VoiceParams } from '../lib/voicePicker';
import { isUiLanguage } from '@shared/uiLanguage';

const params = new URLSearchParams(window.location.search);

function seed(): void {
  const shotLang = params.get('lang');
  if (isUiLanguage(shotLang)) useLangStore.getState().setLang(shotLang);
  useCreditsStore.setState({
    plan: 'free',
    ai_backend_kind: params.get('backend') === 'local' ? 'local' : 'cloud-proxy',
    initialized: true,
  });
  useAuthStore
    .getState()
    ._setState({
      kind: 'signed_in',
      user: { id: 'dev-user', email: 'dev@example.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
    });
}

// DevDashShot imports every harness eagerly, so this module also loads for
// the other ?dashshot= modes: seed only for our own, or it would sign every
// harness in as dev-user and force the Cloud backend on them.
if (params.get('dashshot') === 'voicekey') seed();

export function DevVoiceKeyShot(): React.ReactElement {
  const [value, setValue] = useState<string | null>(null);
  const [voiceParams, setVoiceParams] = useState<VoiceParams>({});
  // App.tsx loads the ChatGPT status at boot; the harness has no App.
  useEffect(() => {
    void useChatgptStore.getState().load();
  }, []);
  if (params.get('part') === 'picker') {
    return (
      <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--window)', padding: 24 }}>
        <div style={{ maxWidth: 560 }}>
          <VoicePicker value={value} onChange={(v) => setValue(v)} params={voiceParams} onParamsChange={setVoiceParams} />
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--window)' }}>
      <SettingsScreen />
    </div>
  );
}
