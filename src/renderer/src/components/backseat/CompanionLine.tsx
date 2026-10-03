/**
 * CompanionLine (261004): the companion saying one short line, with their
 * portrait beside a speech bubble. It fronts the backseat game flow (the
 * Roblox "what are we playing?" step and the "hop in, i'll be watching" wait
 * on the call), so those screens read as the companion talking to you rather
 * than as a form.
 *
 * The bubble borrows the tutorial's speech bubble and the handwritten face the
 * onboarding reserves for a companion's own words. Each new line types itself
 * out, the way Sui's onboarding lines do; with reduced motion it just appears.
 * The full line is always in the accessible text, so screen readers and tests
 * never see a half-typed string.
 */

import React, { useEffect, useState } from 'react';
import { PixelPortrait } from '../PixelPortrait';
import { pickPalette } from '../../lib/portraitPalettes';
import { resolvedScheme } from '../../lib/theme';
import styles from './CompanionLine.module.css';

export interface CompanionLineProps {
  /** The companion, when known. Missing = the procedural sprite for `name`. */
  character?: { id: string; name: string; portrait_image?: string | null } | null;
  name: string;
  line: string;
  /** Portrait edge in px (default 64). */
  size?: number;
  /** 'row' puts the bubble beside the portrait; 'stack' centers it above. */
  layout?: 'row' | 'stack';
  className?: string;
}

/** ms per character while a line types out. */
const TYPE_MS = 22;

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** The line as typed so far. Restarts whenever the line changes. */
function useTyped(text: string): string {
  const [n, setN] = useState(() => (prefersReducedMotion() ? text.length : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setN(text.length);
      return;
    }
    setN(0);
    // Array.from so an emoji or a CJK character counts as one step.
    const total = Array.from(text).length;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setN(i);
      if (i >= total) window.clearInterval(timer);
    }, TYPE_MS);
    return () => window.clearInterval(timer);
  }, [text]);
  return Array.from(text).slice(0, n).join('');
}

export function CompanionLine({
  character,
  name,
  line,
  size = 64,
  layout = 'row',
  className,
}: CompanionLineProps): React.ReactElement {
  const typed = useTyped(line);
  const seed = character ? character.id + character.name : name;
  const palette = pickPalette(seed, resolvedScheme());
  return (
    <div
      className={[styles.root, layout === 'stack' ? styles.stack : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.face} style={{ width: size, height: size }} title={name}>
        <PixelPortrait
          seed={seed}
          palette={palette}
          size={size}
          portraitImage={character?.portrait_image ?? null}
          style={{ width: '100%', height: '100%' }}
        />
      </span>
      <p key={line} className={styles.bubble} role="status" aria-live="polite">
        <span className={styles.srOnly}>{line}</span>
        {/* The typed copy is decoration over a reserved box: the invisible
            full line holds the bubble's final size, so it never grows while
            typing and the layout around it never jumps. */}
        <span className={styles.sizer} aria-hidden="true">
          {line}
        </span>
        <span className={styles.typed} aria-hidden="true">
          {typed}
        </span>
      </p>
    </div>
  );
}
