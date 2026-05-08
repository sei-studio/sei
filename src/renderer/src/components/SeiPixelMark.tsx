/**
 * SeiPixelMark — inline recolored Sei wordmark.
 *
 * Uses CSS mask-image so a single-color SVG can be tinted via background-color.
 * Used in OnboardingScreen step 0 ("Welcome to <SeiPixelMark/>.") and elsewhere
 * the brand mark should sit inline with text at baseline.
 *
 * Source: 04-07 Task 1 + plan 06's LoadingScreen (same mask-image pattern, D-35).
 */

import React from 'react';

export interface SeiPixelMarkProps {
  height?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
}

export function SeiPixelMark(props: SeiPixelMarkProps): React.ReactElement {
  const { height = 22, color = 'var(--accent)', className, ariaLabel = 'Sei' } = props;
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'inline-block',
        height,
        width: height * 5, // logo aspect ~5:1 (sei-logo-small.svg)
        backgroundColor: color,
        WebkitMaskImage: "url('/img/sei-logo-small.svg')",
        maskImage: "url('/img/sei-logo-small.svg')",
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        verticalAlign: 'baseline',
      }}
    />
  );
}
