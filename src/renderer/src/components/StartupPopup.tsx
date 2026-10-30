/**
 * StartupPopup — the operator's one-page popup (261027, replaced the notices
 * inbox).
 *
 * Main tells us which popup this install still owes (push + race-proof pull).
 * Once the screen is calm (`isCalm`, the same "nothing else going on" test the
 * boot import offer uses) the page loads in a HIDDEN sandboxed iframe; only
 * when main confirms the frame committed a 2xx page does the overlay appear,
 * and main records the id as shown at that moment. So a page that is offline,
 * 404s or never loads shows nothing, and is tried again next launch.
 *
 * Never in a first-run session (261029, lib/firstRunSession.ts): a session
 * that shows the onboarding scene, the tour or the first moment, or that boots
 * with an unfinished tour saved in config, holds the popup until the next
 * launch. The config read happens before the first look.
 *
 * The frame: `sandbox="allow-popups"` and nothing else, so the page runs no
 * scripts, gets an opaque origin (no cookies, no storage, no access to this
 * window), cannot submit forms or navigate the app. Links still work: main's
 * popupFrameGuards send every link and target=_blank to the default browser,
 * except an action link (https://sei.gg/popup/_action/<name>, 261029), which
 * main turns into `onStartupPopupAction`: the popup closes and the named
 * in-app action runs (lib/popupActions.ts). Actions are only taken while the
 * popup is shown, and not in its first POPUP_ACTION_ARM_MS: a page can reach
 * an action URL without a click through a meta refresh or a Refresh header.
 *
 * Closing: the X (always visible, layered over the page's top-right corner on
 * a translucent dark disc so it reads on any picture), Esc (relayed by main
 * when focus is inside the page), or a click anywhere outside the page. Esc
 * is left alone while another dialog is open on top.
 *
 * z 1000 (ModalShell's base tier, 261029; was 1100): it only ever opens over
 * a calm screen, so nothing modal is under it, and App.tsx mounts it BEFORE
 * every other dialog (the modal group, the setup wizard, ToS, import offer,
 * migrate, hard stop, update, recovery), so a dialog that appears after it
 * sits at the same tier later in the DOM, or stacked above, and lands ON TOP
 * of the popup rather than hidden under it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { StartupPopupInfo } from '@shared/ipc';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { isFirstRunSession, markFirstRunSession } from '../lib/firstRunSession';
import { runPopupAction } from '../lib/popupActions';
import {
  armShownPopup,
  POPUP_FIRST_LOOK_MS,
  POPUP_LOAD_TIMEOUT_MS,
  POPUP_POLL_MS,
  popupCardSize,
} from '../lib/startupPopup';
import { CloseIcon } from './icons';
import styles from './StartupPopup.module.css';

interface StartupPopupProps {
  /** True when nothing else is on screen (no modal, tour, game, call, share). */
  isCalm: () => boolean;
}

type Phase = 'loading' | 'shown';

/** Whether a dialog other than `self` is open (it sits above the popup). */
function otherModalOpen(self: Element | null): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== self);
}

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

export function StartupPopup({ isCalm }: StartupPopupProps): React.ReactElement | null {
  const t = useT();
  const vp = useViewport();
  /** What main says this install still owes. */
  const [owed, setOwed] = useState<StartupPopupInfo | null>(null);
  /** The popup being loaded or shown, and how far it got. */
  const [active, setActive] = useState<{ popup: StartupPopupInfo; phase: Phase } | null>(null);
  /** Ids tried this app session (shown, failed or timed out): never retried until relaunch. */
  const tried = useRef(new Set<string>());
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const isCalmRef = useRef(isCalm);
  isCalmRef.current = isCalm;
  /** The saved-tour check has run (it must before the first look). */
  const [bootChecked, setBootChecked] = useState(false);
  /** Never show in a first-run session, whatever the screen looks like. */
  const mayShow = useCallback(() => !isFirstRunSession() && isCalmRef.current(), []);

  // Subscribe + race-proof pull.
  useEffect(() => {
    const unsub = sei.onStartupPopup((p) => setOwed(p));
    void sei
      .getStartupPopup()
      .then((p) => setOwed((cur) => cur ?? p))
      .catch(() => undefined);
    return unsub;
  }, []);

  // A popup taken down (or replaced) before it appeared stops loading.
  useEffect(() => {
    if (active && active.phase === 'loading' && owed?.id !== active.popup.id) setActive(null);
  }, [owed, active]);

  // A tour saved mid-way is resumed by boot routing, which can put Home up
  // before it re-arms the tour: read the config first so that session counts
  // as first-run before the popup's first look.
  useEffect(() => {
    if (!owed || bootChecked) return;
    let live = true;
    void sei
      .getConfig()
      .then((cfg) => {
        if (cfg.tutorial_state) markFirstRunSession();
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setBootChecked(true);
      });
    return () => {
      live = false;
    };
  }, [owed, bootChecked]);

  // Wait for a calm screen, then start loading the owed popup. In a first-run
  // session it never starts: the popup stays owed for the next launch.
  useEffect(() => {
    if (!owed || !bootChecked || active || tried.current.has(owed.id)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = (): void => {
      if (mayShow()) {
        tried.current.add(owed.id);
        setActive({ popup: owed, phase: 'loading' });
        return;
      }
      timer = setTimeout(look, POPUP_POLL_MS);
    };
    timer = setTimeout(look, POPUP_FIRST_LOOK_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [owed, bootChecked, active, mayShow]);

  // A page that never loads is dropped silently.
  useEffect(() => {
    if (!active || active.phase !== 'loading') return;
    const timer = setTimeout(() => setActive(null), POPUP_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active]);

  const onFrameLoad = useCallback(() => {
    if (!active || active.phase !== 'loading') return;
    const { popup } = active;
    // The screen may have got busy (or a tour started) while the page
    // loaded: then this popup is not shown (and not recorded), and the next
    // launch tries again.
    if (!mayShow()) {
      setActive(null);
      return;
    }
    void sei
      .startupPopupLoaded(popup.id)
      .then((ok) => {
        setActive((cur) => {
          if (!cur || cur.popup.id !== popup.id) return cur;
          return ok ? { popup, phase: 'shown' } : null;
        });
      })
      .catch(() => setActive(null));
  }, [active, mayShow]);

  const close = useCallback(() => setActive(null), []);

  const shown = active?.phase === 'shown';

  useEffect(() => {
    if (!shown) return;
    // Focus the dialog itself (not the X, which would draw a focus ring on
    // open), so Esc works at once and Tab reaches the X.
    scrimRef.current?.focus();
    // Esc (in the app, or relayed by main when focus is inside the page)
    // closes it unless a dialog raised over it owns Esc. An action link on
    // the page closes it, then runs the in-app action: main already checked
    // it came from the popup frame and is allow-listed, runPopupAction checks
    // the name again, and one that lands right after the reveal (a refresh,
    // not a click) is ignored.
    return armShownPopup({
      close,
      runAction: (name) => void runPopupAction(name),
      covered: () => otherModalOpen(scrimRef.current),
      keys: window,
      onEscape: (cb) => sei.onStartupPopupEscape(cb),
      onAction: (cb) => sei.onStartupPopupAction(cb),
    });
  }, [shown, close]);

  if (!active) return null;
  const size = popupCardSize(vp.w, vp.h, active.popup.width, active.popup.height);

  return (
    <div
      ref={scrimRef}
      tabIndex={-1}
      className={shown ? `${styles.scrim} ${styles.shown}` : styles.scrim}
      role={shown ? 'dialog' : undefined}
      aria-modal={shown ? 'true' : undefined}
      aria-label={shown ? t('Announcement') : undefined}
      aria-hidden={shown ? undefined : true}
      data-startup-popup={active.phase}
      onMouseDown={(e) => {
        if (shown && e.target === e.currentTarget) close();
      }}
    >
      <div className={styles.card} style={{ width: size.width, height: size.height }}>
        <iframe
          className={styles.frame}
          src={active.popup.url}
          title={t('Announcement')}
          sandbox="allow-popups"
          referrerPolicy="no-referrer"
          tabIndex={shown ? 0 : -1}
          onLoad={onFrameLoad}
        />
        <button
          type="button"
          className={styles.close}
          onClick={close}
          aria-label={t('Close')}
          tabIndex={shown ? 0 : -1}
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </div>
  );
}
