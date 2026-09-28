/**
 * MicAccessCard (260929): a call is waiting on microphone access.
 *
 * Replaces the old dead end ("Microphone access was blocked. Allow it and try
 * again.") with the why, a button that opens the exact Settings page, and a
 * poll: while the card is up, access is checked about once a second and the
 * call dials again by itself the moment it is on.
 *
 * Raised by useVoiceStore (micBlocked) from two places: the Call-press
 * preflight (macOS denied / restricted) and a getUserMedia refusal while the
 * call was coming up (on Windows the only signal: the "Let desktop apps access
 * your microphone" switch is not what the status call reports). If macOS reports access
 * as granted and the mic still refuses, the grant has not reached this process
 * and the card offers "Restart Sei and call" instead (resume flag, see
 * usePermissionResume).
 *
 * Restricted (macOS only: Screen Time or an MDM profile locks the mic) is a
 * different card: the player cannot turn it on in Settings, so it shows one
 * line saying the mic is locked and a Close button. No Settings button, no
 * poll, no "the call starts on its own".
 *
 * Mounted by CallMiniBar, which lives on every view, at the 'stacked' tier.
 */
import React, { useCallback, useEffect } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { micAccessOk, openPermissionSettings, trackPermission } from '../../lib/permissions/permissionFlow';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import { useAccessPoll } from './useAccessPoll';
import styles from './PermissionCard.module.css';

export function MicAccessCard(): React.ReactElement | null {
  const blocked = useVoiceStore((s) => s.micBlocked);
  if (!blocked) return null;
  // Keyed so a second block (say, restart needed after a grant) starts fresh.
  return (
    <MicAccessCardBody
      key={`${blocked.characterId}:${blocked.needsRestart}:${blocked.restricted}`}
      characterId={blocked.characterId}
      restricted={blocked.restricted}
      needsRestart={blocked.needsRestart}
      platform={sei.platform}
    />
  );
}

export function MicAccessCardBody({
  characterId,
  restricted,
  needsRestart,
  platform,
}: {
  characterId: string;
  restricted: boolean;
  needsRestart: boolean;
  platform: string;
}): React.ReactElement {
  const t = useT();
  const dismiss = useVoiceStore((s) => s.dismissMicBlocked);
  const name = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name) ?? t('Your companion');
  const isMac = platform === 'darwin';

  useEffect(() => {
    trackPermission('permission_prompt_shown', 'mic');
  }, []);

  const onGranted = useCallback(() => {
    trackPermission('permission_granted', 'mic');
    const voice = useVoiceStore.getState();
    voice.dismissMicBlocked();
    void voice.startCall(characterId);
  }, [characterId]);

  // No poll while a restart is the only way forward: the status already says
  // granted, so polling would "succeed" and redial into the same refusal.
  // Restricted: nothing the player can do here will change the answer.
  useAccessPoll(!needsRestart && !restricted, () => micAccessOk(platform), onGranted, false);

  const restart = (): void => {
    void sei.permissionsRelaunch({ kind: 'call', characterId }).catch(() => {});
  };

  if (restricted) {
    return (
      <ModalShell title={t('Microphone unavailable')} width={420} tier="stacked" onClose={dismiss}>
        <div className={styles.body}>
          <p className={styles.why}>{t('Your microphone is locked by Screen Time or a device policy on this Mac.')}</p>
        </div>
        <ModalFooter>
          <Button size="md" onClick={dismiss}>
            {t('Close')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={needsRestart ? t('Restart Sei to use your microphone') : t('Turn on your microphone')}
      width={420}
      tier="stacked"
      onClose={dismiss}
    >
      <div className={styles.body}>
        {needsRestart ? (
          <p className={styles.why}>{t('Microphone access is on, but Sei needs a restart to use it.')}</p>
        ) : (
          <>
            <p className={styles.why}>{t('Sei needs your microphone so {name} can hear you.', { name })}</p>
            <p className={styles.how}>
              {isMac
                ? t('In System Settings, open Privacy & Security > Microphone and turn on Sei.')
                : t('In Settings, turn on Microphone access and Let desktop apps access your microphone.')}
            </p>
            <p className={styles.waiting}>
              <span className={styles.dot} aria-hidden="true" />
              {t('The call starts on its own once access is on.')}
            </p>
          </>
        )}
      </div>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={dismiss}>
          {t('Not now')}
        </Button>
        {needsRestart ? (
          <Button size="md" onClick={restart}>
            {t('Restart Sei and call')}
          </Button>
        ) : (
          <Button size="md" onClick={() => void openPermissionSettings('mic')}>
            {t('Open Settings')}
          </Button>
        )}
      </ModalFooter>
    </ModalShell>
  );
}
