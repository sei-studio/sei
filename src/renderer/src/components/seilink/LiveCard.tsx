/**
 * "{name} lives on your desktop now" (261110, product call 261110). When the
 * room first goes live, one card says where she is and how to reach her:
 *  - she is part of the wallpaper, so open windows cover her;
 *  - the shortcut that shows the desktop (Win+D; F11 or fn+F11 on a Mac);
 *  - what a click and a double-click on her do (open the chat / a quick reply,
 *    the host's click classifier).
 * "Minimize other windows" (Windows) / "Hide other apps" (macOS) clears the
 * desktop in one go (main: seilink:stage minimize_others), "Got it" just goes
 * on. It stays until one of those, or until the desktop is shown some other
 * way (the window went hidden: Win+D while it was up), then never again on
 * this account (liveHintPref).
 *
 * Two places: `stage` over the first link's held last frame (the window still
 * covers the desktop, so the card sits on the very picture the wallpaper
 * shows), `app` as a dialog in the app after a move-in without the intro.
 * seilink_live_hint {action, surface, os} records it (shape only).
 */
import React, { useEffect, useRef, useState } from 'react';
import { SEILINK_LIVE_HINT_EVENT, type LiveHintAction, type LiveHintSurface, type SetupOs } from '@shared/seilinkSetupTelemetry';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { liveHintOs, markLiveHintDismissed } from '../../lib/seilink/liveHintPref';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import styles from './LiveCard.module.css';

export type LiveCardEnd = 'dismissed' | 'minimized' | 'show_desktop';

export interface LiveCardViewProps {
  name: string;
  os: SetupOs;
  placement: 'stage' | 'app';
  busy?: boolean;
  /** Absent where there is nothing to minimize (Linux). */
  onMinimize?: () => void;
  onDismiss: () => void;
}

function DesktopIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  );
}

function PointerIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5l12 7.2-5.3 1.3 3.2 6.1-2.4 1.3-3.2-6.1L6 17.5z" />
    </svg>
  );
}

export function LiveCardView(p: LiveCardViewProps): React.ReactElement {
  const t = useT();
  const title = t('{name} lives on your desktop now', { name: p.name });
  const keys =
    p.os === 'windows'
      ? t('Press Win+D to show your desktop any time.')
      : p.os === 'mac'
        ? t('Press F11 to show your desktop any time. On a laptop keyboard, press fn+F11.')
        : t('Minimize your windows to show your desktop.');
  const body = (
    <>
      <p className={styles.lead}>{t('{name} is part of your wallpaper, so open windows cover the room.', { name: p.name })}</p>
      <div className={styles.rows}>
        <div className={styles.row} data-live-row="keys">
          <span className={styles.icon}>
            <DesktopIcon />
          </span>
          <p className={styles.rowText}>{keys}</p>
        </div>
        <div className={styles.row} data-live-row="tap">
          <span className={styles.icon}>
            <PointerIcon />
          </span>
          <p className={styles.rowText}>{t('Click {name} to open your chat. Double-click for a quick reply.', { name: p.name })}</p>
        </div>
      </div>
    </>
  );
  const actions = (
    <>
      {p.onMinimize ? (
        <Button kind="quiet" size="md" disabled={p.busy} onClick={p.onMinimize}>
          {p.os === 'mac' ? t('Hide other apps') : t('Minimize other windows')}
        </Button>
      ) : null}
      <Button kind="primary" size="md" disabled={p.busy} onClick={p.onDismiss}>
        {t('Got it')}
      </Button>
    </>
  );
  if (p.placement === 'app') {
    return (
      <ModalShell title={title} width={480} escClose={false}>
        <div className={styles.appBody} data-live-card="app">
          {body}
        </div>
        <ModalFooter>{actions}</ModalFooter>
      </ModalShell>
    );
  }
  return (
    <div className={styles.stage} data-live-card="stage">
      <div className={styles.card} role="dialog" aria-modal="true" aria-labelledby="seilink-live-title">
        <h2 id="seilink-live-title" className={styles.title}>
          {title}
        </h2>
        {body}
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}

export interface LiveCardProps {
  characterId: string;
  name: string;
  surface: LiveHintSurface;
  /** Called once, after the card is dismissed (and other windows are minimized, when asked). */
  onDone(end: LiveCardEnd): void;
}

function track(characterId: string, action: LiveHintAction, surface: LiveHintSurface, os: SetupOs): void {
  try {
    sei.track(SEILINK_LIVE_HINT_EVENT, {
      character_id: characterId,
      action,
      surface,
      os,
    });
  } catch {
    /* analytics must never disrupt WorldLink */
  }
}

export function LiveCard({ characterId, name, surface, onDone }: LiveCardProps): React.ReactElement {
  const os = liveHintOs(sei.platform);
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(false);
  const cb = useRef(onDone);
  cb.current = onDone;

  const finish = (end: LiveCardEnd): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    markLiveHintDismissed();
    track(characterId, end, surface, os);
    cb.current(end);
  };

  useEffect(() => {
    track(characterId, 'shown', surface, os);
    // The desktop was shown some other way (Win+D minimized this window too): that was the point.
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') finish('show_desktop');
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // Once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minimize = (): void => {
    if (busy || doneRef.current) return;
    setBusy(true);
    // Main records seilink_minimize_windows; the card goes on whatever it answered.
    void (sei.seilinkStage?.({ action: 'minimize_others', surface: 'live_card' }) ?? Promise.resolve(null)).catch(() => null).then(() => finish('minimized'));
  };

  const canMinimize = os !== 'linux' && Boolean(sei.seilinkStage);
  return <LiveCardView name={name} os={os} placement={surface === 'intro_end' ? 'stage' : 'app'} busy={busy} onMinimize={canMinimize ? minimize : undefined} onDismiss={() => finish('dismissed')} />;
}
