/**
 * The desktop hint (product call (261116)): one brief line at the bottom of
 * the app after WorldLink opened or updated the desktop, with "Hide windows"
 * (other apps' windows minimized on Windows, hidden on macOS, then Sei steps
 * aside: seilink:stage minimize_others with `reveal`; nothing is closed or
 * quit). It hides itself after DESKTOP_HINT_MS (hover keeps it), or when the
 * window goes away first. lib/seilink/desktopHint.ts decides when it shows.
 *
 * seilink_desktop_hint {action: shown|hide_windows|expired|hidden, kind, os}
 * (shape only); main adds seilink_minimize_windows {surface: desktop_hint}.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SEILINK_DESKTOP_HINT_EVENT, type DesktopHintAction, type DesktopHintKind, type SetupOs } from '@shared/seilinkSetupTelemetry';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { DESKTOP_HINT_MS, HINT_STALE_MS, type DesktopHint as DesktopHintData } from '../../lib/seilink/desktopHint';
import { liveHintOs } from '../../lib/seilink/liveHintPref';
import styles from './DesktopHint.module.css';

export interface DesktopHintViewProps {
  leaving: boolean;
  busy: boolean;
  onHide?: () => void;
  onHover?: (over: boolean) => void;
}

export function DesktopHintView(p: DesktopHintViewProps): React.ReactElement {
  const t = useT();
  return (
    <div className={styles.wrap} data-desktop-hint="">
      <div
        className={p.leaving ? `${styles.hint} ${styles.leaving}` : styles.hint}
        role="status"
        onMouseEnter={() => p.onHover?.(true)}
        onMouseLeave={() => p.onHover?.(false)}
      >
        <p className={styles.text}>{t('Your desktop was updated.')}</p>
        {p.onHide ? (
          <button type="button" className={styles.action} disabled={p.busy} onClick={p.onHide}>
            {t('Hide windows')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function track(hint: DesktopHintData, action: DesktopHintAction, os: SetupOs): void {
  try {
    sei.track(SEILINK_DESKTOP_HINT_EVENT, { character_id: hint.characterId, action, kind: hint.kind satisfies DesktopHintKind, os });
  } catch {
    /* analytics must never disrupt WorldLink */
  }
}

/** The fade out before it unmounts. */
const LEAVE_MS = 220;

export function DesktopHint({ hint, onDone }: { hint: DesktopHintData; onDone(): void }): React.ReactElement | null {
  const os = liveHintOs(sei.platform);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const done = useRef(false);
  const cb = useRef(onDone);
  cb.current = onDone;
  // Nobody would see it (the window is hidden or minimized right now), or it waited too long behind a sheet.
  const [visible] = useState(() => document.visibilityState === 'visible' && Date.now() - hint.at <= HINT_STALE_MS);

  const finish = (action: DesktopHintAction): void => {
    if (done.current) return;
    done.current = true;
    track(hint, action, os);
    setLeaving(true);
    window.setTimeout(() => cb.current(), LEAVE_MS);
  };

  useEffect(() => {
    if (!visible) {
      cb.current();
      return;
    }
    track(hint, 'shown', os);
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') finish('hidden');
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // Once per hint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible || over || busy) return;
    const id = window.setTimeout(() => finish('expired'), DESKTOP_HINT_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over, busy, visible]);

  if (!visible) return null;
  const canHide = os !== 'linux' && Boolean(sei.seilinkStage);
  const hide = (): void => {
    if (busy || done.current) return;
    setBusy(true);
    track(hint, 'hide_windows', os);
    done.current = true;
    void (sei.seilinkStage?.({ action: 'minimize_others', surface: 'desktop_hint', reveal: true }) ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => {
        setLeaving(true);
        window.setTimeout(() => cb.current(), LEAVE_MS);
      });
  };
  return <DesktopHintView leaving={leaving} busy={busy} onHide={canHide ? hide : undefined} onHover={setOver} />;
}




