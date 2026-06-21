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
        // Match the box to the SVG's true aspect ratio (viewBox 81.83×26.46 ≈
        // 3.09:1). The old `height * 5` over-wide box left ~84px of dead space
        // on the right, and with mask-size:contain + the default left
        // mask-position the glyph rendered pinned to the LEFT of the box —
        // making it look ~42px off-center on the (centered) auth screen.
        width: height * (81.825691 / 26.458338),
        backgroundColor: color,
        // Absolute root path (mirrors fonts.css `url('/fonts/…')`). The prior
        // relative `./img/…` resolved against the document URL, which is fine in
        // the dev server but breaks in the packaged renderer (the mark silently
        // vanished on the auth/landing screen). `/img/…` resolves to the
        // renderer root in both dev and the packaged build.
        WebkitMaskImage: "url('/img/sei-logo-small.svg')",
        maskImage: "url('/img/sei-logo-small.svg')",
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        // Belt-and-suspenders: center any sub-pixel residual so the glyph can
        // never drift left of its box.
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        verticalAlign: 'baseline',
      }}
    />
  );
}
