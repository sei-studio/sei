/**
 * WallTrayPrompt — the one-time offer on the credit wall (261005).
 *
 * "Want a heads-up when free play is back? Keep Sei in your menu bar." One
 * click turns the menu bar / tray setting on, which is what lets the
 * companion post a notification when the allowance resets. Shown at most
 * once per install: main records it as seen the moment it renders, whatever
 * the player does with it. Hidden when the platform has no tray support, when
 * the setting is already on, and once seen.
 *
 * Analytics (renderer sei.track, shape only): wall_tray_prompt_shown,
 * wall_tray_prompt_accepted, wall_tray_prompt_dismissed. The setting change
 * itself is captured by main as tray_setting_changed {source: 'wall_prompt'}.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { sei } from '../lib/ipcClient';
import { loadTraySettings, markWallPromptSeen, saveTraySettings, shouldOfferWallPrompt } from '../lib/traySettings';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { Button } from './Button';
import styles from './WallTrayPrompt.module.css';

type PromptState = 'loading' | 'hidden' | 'offer' | 'saving' | 'accepted' | 'failed';

function track(event: string, props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics is never load-bearing */
  }
}

export function WallTrayPrompt(): React.ReactElement | null {
  const t = useT();
  const plan = useCreditsStore((s) => s.plan);
  const [state, setState] = useState<PromptState>('loading');
  const shownRef = useRef(false);
  const isMac = sei.platform === 'darwin';

  useEffect(() => {
    let live = true;
    void loadTraySettings().then((v) => {
      if (!live) return;
      const offer = shouldOfferWallPrompt(v);
      setState(offer ? 'offer' : 'hidden');
      if (offer && !shownRef.current) {
        shownRef.current = true;
        void markWallPromptSeen();
        track('wall_tray_prompt_shown', { plan });
      }
    });
    return () => {
      live = false;
    };
    // Decided once per mount: the offer must not vanish because it was just
    // marked seen, and a plan refresh must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'loading' || state === 'hidden') return null;

  const free = plan === 'free';

  const accept = async (): Promise<void> => {
    setState('saving');
    const next = await saveTraySettings({ enabled: true, source: 'wall_prompt' });
    if (next?.enabled) {
      setState('accepted');
      track('wall_tray_prompt_accepted', { plan });
    } else {
      setState('failed');
    }
  };

  const dismiss = (): void => {
    setState('hidden');
    track('wall_tray_prompt_dismissed', { plan });
  };

  if (state === 'accepted') {
    return (
      <div className={styles.card} role="status">
        <p className={styles.text}>
          {isMac
            ? free
              ? t("You're set. Sei will stay in your menu bar and let you know when free play is back.")
              : t("You're set. Sei will stay in your menu bar and let you know when your allowance is back.")
            : free
              ? t("You're set. Sei will stay in your system tray and let you know when free play is back.")
              : t("You're set. Sei will stay in your system tray and let you know when your allowance is back.")}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <p className={styles.text}>
        {isMac
          ? free
            ? t('Want a heads-up when free play is back? Keep Sei in your menu bar.')
            : t('Want a heads-up when your allowance is back? Keep Sei in your menu bar.')
          : free
            ? t('Want a heads-up when free play is back? Keep Sei in your system tray.')
            : t('Want a heads-up when your allowance is back? Keep Sei in your system tray.')}
      </p>
      {state === 'failed' ? (
        <p className={styles.error}>{t("That didn't work. You can turn it on in Settings.")}</p>
      ) : null}
      <div className={styles.actions}>
        <Button kind="quiet" size="sm" onClick={dismiss}>
          {t('No thanks')}
        </Button>
        <Button kind="ghost" size="sm" disabled={state === 'saving'} onClick={() => void accept()}>
          {t('Turn it on')}
        </Button>
      </div>
    </div>
  );
}
