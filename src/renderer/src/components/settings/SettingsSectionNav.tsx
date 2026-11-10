/**
 * SettingsSectionNav — the left section menu on Settings (quiet register,
 * product call 261110).
 *
 * It does not keep its own list of sections. It reads the group titles that
 * are actually on the page (`h3[data-settings-section]` inside the column), so
 * a group that is hidden (Account when signed out) or moved to another screen
 * simply drops out of the menu. A click scrolls that group to the top; the
 * active entry follows the scroll (the last title above the fold line).
 * Selection is the 2px accent bar, as on the rail.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../../lib/i18n';
import styles from './SettingsSectionNav.module.css';

interface Section {
  key: string;
  label: string;
  el: HTMLElement;
}

export interface SettingsSectionNavProps {
  /** The scrolling element (Settings' root). */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** The column that holds the groups. */
  columnRef: React.RefObject<HTMLElement | null>;
}

/** How far below the scroller's top a title counts as "reached". */
const FOLD_PX = 96;

/** The element that actually scrolls: `el` itself, else its nearest scrolling ancestor. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el; n; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
  }
  return null;
}

export function SettingsSectionNav({ scrollRef, columnRef }: SettingsSectionNavProps): React.ReactElement {
  const t = useT();
  const [sections, setSections] = useState<Section[]>([]);
  const [active, setActive] = useState(0);

  const scan = useCallback((): void => {
    const col = columnRef.current;
    if (!col) return;
    const els = Array.from(col.querySelectorAll<HTMLElement>('h3[data-settings-section]'));
    setSections((prev) => {
      const next = els.map((el, i) => ({ key: `${i}:${el.textContent ?? ''}`, label: el.textContent ?? '', el }));
      if (prev.length === next.length && prev.every((p, i) => p.key === next[i].key && p.el === next[i].el)) {
        return prev;
      }
      return next;
    });
  }, [columnRef]);

  // Rescan when the column's content changes (groups appear with auth state,
  // the language switch renames them). A passive effect, so the column (a
  // later sibling) has its ref attached by the time this runs.
  useEffect(() => {
    scan();
    const col = columnRef.current;
    if (!col) return;
    const mo = new MutationObserver(() => scan());
    mo.observe(col, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [scan, columnRef]);

  // Active section follows the scroll. The scroller is normally Settings'
  // root, but in a host that lets the root grow (a dev harness) it is an
  // ancestor, so listen to every scroll (capture) and measure the real one.
  useEffect(() => {
    const update = (): void => {
      const box = scrollerOf(scrollRef.current);
      const top = (box ? box.getBoundingClientRect().top : 0) + FOLD_PX;
      let idx = 0;
      sections.forEach((s, i) => {
        if (s.el.getBoundingClientRect().top <= top) idx = i;
      });
      // At the very bottom the last group may never reach the fold line.
      if (box && box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
        idx = sections.length - 1;
      }
      setActive(Math.max(0, idx));
    };
    update();
    document.addEventListener('scroll', update, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', update, { capture: true });
  }, [sections, scrollRef]);

  const go = (i: number): void => {
    const el = sections[i]?.el;
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setActive(i);
  };

  return (
    <nav className={styles.nav} aria-label={t('Settings sections')}>
      <h2 className={styles.title}>{t('Settings')}</h2>
      <ul className={styles.list}>
        {sections.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              className={i === active ? `${styles.item} ${styles.itemOn}` : styles.item}
              aria-current={i === active ? 'true' : undefined}
              onClick={() => go(i)}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
