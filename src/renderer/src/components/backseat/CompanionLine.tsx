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

import React, { useEffect, useRef, useState } from 'react';
import { PixelPortrait } from '../PixelPortrait';
import { pickPalette } from '../../lib/portraitPalettes';
import { resolvedScheme } from '../../lib/theme';
import { LineTyper, type TyperFrame } from './lineTyper';
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
  /** Called with each line once it is fully on screen. */
  onTyped?: (line: string) => void;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** The line on screen and how much of it has typed. See LineTyper for the
 *  rules (a typing line is never replaced; onTyped fires once it is whole). */
function useTypedLine(line: string, onTyped?: (line: string) => void): TyperFrame {
  const [frame, setFrame] = useState<TyperFrame>(() => ({
    line,
    n: prefersReducedMotion() ? Array.from(line).length : 0,
  }));
  const onTypedRef = useRef(onTyped);
  useEffect(() => {
    onTypedRef.current = onTyped;
  }, [onTyped]);
  const typer = useRef<LineTyper | null>(null);
  useEffect(() => {
    const ty = new LineTyper({
      reduced: prefersReducedMotion(),
      onFrame: setFrame,
      onTyped: (l) => onTypedRef.current?.(l),
    });
    typer.current = ty;
    return () => {
      ty.dispose();
      typer.current = null;
    };
  }, []);
  useEffect(() => {
    typer.current?.say(line);
  }, [line]);
  return frame;
}

export function CompanionLine({
  character,
  name,
  line,
  size = 64,
  layout = 'row',
  className,
  onTyped,
}: CompanionLineProps): React.ReactElement {
  const frame = useTypedLine(line, onTyped);
  const chars = Array.from(frame.line);
  const typed = chars.slice(0, frame.n).join('');
  const untyped = chars.slice(frame.n).join('');
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
      <p key={frame.line} className={styles.bubble} role="status" aria-live="polite">
        <span className={styles.srOnly}>{frame.line}</span>
        {/* The whole line is laid out from the first frame, the part not yet
            typed just invisible, so the bubble holds its final size and a word
            never jumps to the next line halfway through typing. */}
        <span aria-hidden="true">
          {typed}
          <span className={styles.untyped}>{untyped}</span>
        </span>
      </p>
    </div>
  );
}
