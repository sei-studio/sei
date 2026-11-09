/**
 * HoverTip (261107, profile v0.7): a hover / keyboard-focus tooltip for the
 * profile rows' explanations (they used to be a subtext line under the label)
 * and the Locked marker.
 *
 * It wears the app's [data-tip] tooltip look (global.css: surface-2 card,
 * strong hairline, mono type, ~300ms hover delay) but is drawn in a portal
 * with fixed positioning. The CSS [data-tip] pseudo-element cannot be used
 * here: each profile section scrolls inside its own area, which clips a
 * pseudo-element hanging below a row (and the sentences here wrap, unlike the
 * one-word button tips). Focus shows it at once (keyboard), Escape hides it.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Profile.module.css';

const HOVER_DELAY_MS = 300;
const GAP = 6;
const MARGIN = 8;

export interface HoverTipProps {
  tip: string;
  /** Called once each time the tooltip opens (the page dedupes for analytics). */
  onOpen?: () => void;
  /** Which edge of the trigger the tooltip lines up with. */
  align?: 'start' | 'end';
  className?: string;
  /** Accessible name of the trigger, when its visible text is not enough. */
  'aria-label'?: string;
  children: React.ReactNode;
}

export function HoverTip({ tip, onOpen, align = 'start', className, children, ...rest }: HoverTipProps): React.ReactElement {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = useCallback(
    (delay: number): void => {
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setOpen(true);
        onOpen?.();
      }, delay);
    },
    [onOpen],
  );
  const hide = (): void => {
    clear();
    setOpen(false);
  };
  useEffect(() => clear, []);

  // Place it under the trigger (above when there is no room), inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const el = tipRef.current;
    if (!trigger || !el) return;
    const r = trigger.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    let top = r.bottom + GAP;
    if (top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, r.top - GAP - h);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = 'visible';
  }, [open, align, tip]);

  // A scroll under it would leave it floating in the wrong place.
  useEffect(() => {
    if (!open) return;
    const onScroll = (): void => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        className={`${styles.tipTrigger} ${className ?? ''}`}
        tabIndex={0}
        aria-label={rest['aria-label']}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => show(HOVER_DELAY_MS)}
        onMouseLeave={hide}
        onFocus={() => show(0)}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            hide();
          }
        }}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div ref={tipRef} id={id} role="tooltip" className={styles.tip} style={{ visibility: 'hidden' }}>
              {tip}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
