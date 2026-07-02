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
        // Match the box to the wordmark's true aspect ratio (sei-text.png is
        // 928×300 ≈ 3.09:1). mask-size:contain + center keep the glyph centered
        // in the box on the (centered) auth screen.
        width: height * (928 / 300),
        backgroundColor: color,
        // RASTER source, not the old sei-logo-small.svg. That SVG was a Inkscape
        // <text> element (live font, not outlined paths); used as a CSS
        // mask-image it rendered EMPTY whenever the font wasn't resolvable —
        // which is exactly what happened on the auth/login screen (the wordmark
        // was invisible). A transparent-background PNG carries the glyph in its
        // alpha channel, so it has no font dependency and always renders; the
        // backgroundColor below (var(--accent) → #7fb0ff on the dark theme)
        // tints it through the mask. The asset lives in the renderer's public/
        // dir; we prefix it with import.meta.env.BASE_URL ('/' in dev, './' in
        // the packaged build) so the url() resolves under both the dev server
        // and the file:// protocol — a bare absolute `/img/…` resolves to the
        // filesystem root under file:// and renders empty (the v0.3.0 bug).
        WebkitMaskImage: `url('${import.meta.env.BASE_URL}img/sei-text.png')`,
        maskImage: `url('${import.meta.env.BASE_URL}img/sei-text.png')`,
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
