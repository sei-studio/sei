/**
 * Inline SVG icons. Ported verbatim from .planning/.../design/project/ui.jsx.
 *
 * No icon font dependency, no external SVG sprite — just typed React components
 * keyed by `size` (default 18) so callers can scale per-site (UI-SPEC sidebar
 * lists per-icon sizes — HomeIcon 30, MCBlock 34, PlusIcon 26, etc.).
 *
 * `currentColor` propagation lets parent CSS drive icon color via `color: var(--accent)`.
 */

import React from 'react';

interface IconProps {
  size?: number;
}

export const HomeIcon: React.FC<IconProps> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  </svg>
);

/**
 * RosterIcon — the mockup's "Summons / roster" nav glyph: a 2×2 grid of sharp
 * squares (ui.jsx `Icon.roster`). This is the square home/roster icon the rail
 * uses for the Home view; replaces the old rounded house so the rail matches
 * the reference terminal.
 */
export const RosterIcon: React.FC<IconProps> = ({ size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
  >
    <rect x={3} y={3} width={7} height={7} />
    <rect x={14} y={3} width={7} height={7} />
    <rect x={3} y={14} width={7} height={7} />
    <rect x={14} y={14} width={7} height={7} />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/**
 * PricingIcon — wallet/credit glyph whose inner rect fills bottom-up based on
 * `remainingPct` (0..100). Inherits theme color via `currentColor`.
 *
 * Used by IconRail.tsx as a conditional RailButton (only when
 * `aiBackendKind === 'cloud-proxy'` — defense-in-depth BYOK bypass per
 * PROXY-11; the icon is unmounted, NOT CSS-hidden).
 *
 * The inner fill rect carries a 200ms transition on `height` and `y` so
 * percentage changes animate smoothly (D-54 UI affordance).
 */
interface PricingIconProps extends IconProps {
  remainingPct?: number;
}
export const PricingIcon: React.FC<PricingIconProps> = ({
  size = 24,
  remainingPct = 0,
}) => {
  // Clamp to [0, 100] — defensive against transient out-of-range values from
  // the server / store before init() completes.
  const pct = Math.max(0, Math.min(100, remainingPct));
  // Inner wallet body spans y=6..y=20 (height 14) in the 24-unit viewBox.
  // The fill rect grows upward from the bottom (y=20) of that body.
  const fillHeight = (pct / 100) * 14;
  const fillY = 20 - fillHeight;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* Wallet flap (stroked top arc) */}
      <path
        d="M5 6V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V6"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Inner fill — clipped to the wallet body via stacking order (drawn
          BEFORE the outline stroke so the outline frames it cleanly). */}
      <rect
        x={5}
        y={fillY}
        width={14}
        height={fillHeight}
        fill="currentColor"
        opacity={0.4}
        style={{ transition: 'height 200ms ease, y 200ms ease' }}
      />
      {/* Outer rounded wallet body (drawn last so its stroke is on top). */}
      <rect
        x={3}
        y={6}
        width={18}
        height={14}
        rx={2}
        stroke="currentColor"
        strokeWidth={1.5}
        fill="none"
      />
    </svg>
  );
};

/**
 * SettingsIcon — the mockup's rail "settings" glyph: a two-track slider /
 * equalizer (ui.jsx `Icon.settings`). Knobs are punched out with the window
 * fill so the track reads through them. (The cog lives on as `GearIcon`, used
 * by the per-character options menu on the detail screen.)
 */
export const SettingsIcon: React.FC<IconProps> = ({ size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
  >
    <line x1={4} y1={7} x2={20} y2={7} />
    <circle cx={9} cy={7} r={2.4} fill="var(--bg)" />
    <line x1={4} y1={17} x2={20} y2={17} />
    <circle cx={15} cy={17} r={2.4} fill="var(--bg)" />
  </svg>
);

interface ArrowIconProps extends IconProps {
  dir?: 'right' | 'left' | 'up' | 'down';
}
export const ArrowIcon: React.FC<ArrowIconProps> = ({ size = 16, dir = 'right' }) => {
  const rot = ({ right: 0, left: 180, up: -90, down: 90 } as const)[dir];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rot}deg)` }}
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
};

export const GearIcon: React.FC<IconProps> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx={12} cy={12} r={3} />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

/**
 * Compact pencil for inline-edit affordances (name beside the title,
 * description add-when-empty, etc.). Stroke-only so it picks up the
 * surrounding text color via `currentColor`.
 */
export const PencilIcon: React.FC<IconProps> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

/**
 * Two-arrows-in-a-circle rotate / swap icon used to flip the persona ↔
 * description sub-panes on CharacterPage. Stroke-only so it picks up the
 * surrounding text color via `currentColor`.
 */
export const RotateIcon: React.FC<IconProps> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);

export const SparkleIcon: React.FC<IconProps> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8L12 2z" />
    <path
      d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
      opacity={0.7}
    />
  </svg>
);

/**
 * StarIcon — four-point sparkle star. The IconRail Playtime affordance
 * (260603): replaces the PricingIcon wallet/arc, which encoded remaining-percent
 * in the glyph itself. The rail no longer surfaces a percent in the icon; the
 * "~Xh left" estimate still shows in the button tooltip. Filled via currentColor
 * so it inherits the rail's active/idle color tokens.
 */
export const StarIcon: React.FC<IconProps> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {/* Mockup `Icon.spark` — a sharp four-point diamond star (Mana glyph). */}
    <path d="M12 2l1.6 7.4L21 11l-7.4 1.6L12 20l-1.6-7.4L3 11l7.4-1.6z" />
  </svg>
);

/**
 * RefreshIcon — circular-arrow reload glyph. Used for the manual playtime
 * refresh affordance on CreditsScreen (260606). Stroke-only so it inherits the
 * button's currentColor (quiet/muted → accent on hover).
 */
export const RefreshIcon: React.FC<IconProps> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

export const SunIcon: React.FC<IconProps> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx={12} cy={12} r={4} />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const MoonIcon: React.FC<IconProps> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const BackIcon: React.FC<IconProps> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

/**
 * CompassIcon — IconRail "World" affordance. Matches the mockup's `Icon.world`
 * globe (a circle crossed by an equator + two meridians) so the rail's World
 * nav reads identically to the reference terminal. (Name kept for call-site /
 * test stability; the glyph is the mockup globe.)
 */
export const CompassIcon: React.FC<IconProps> = ({ size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx={12} cy={12} r={9} />
    <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
  </svg>
);

/**
 * CloudIcon — B3 IconRail credits-cluster affordance for `ai_backend_kind ===
 * 'local'` users. Stroked cloud glyph using `currentColor`. Replaces the
 * PricingIcon arc for users who haven't opted into the cloud proxy yet.
 */
export const CloudIcon: React.FC<IconProps> = ({ size = 26 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 18a4 4 0 0 1-.6-7.95 5 5 0 0 1 9.9-.49A4 4 0 1 1 17 18H7z" />
  </svg>
);

/**
 * Generic pixel "block" icon — abstract grass-style cube.
 * NOT Minecraft branding (D-34): green grass top, brown dirt body, no logo.
 */
export const MCBlock: React.FC<IconProps> = ({ size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges">
    {/* dirt body */}
    <rect x={2} y={5} width={12} height={9} fill="#8B6A3D" />
    {/* grass top band */}
    <rect x={2} y={3} width={12} height={3} fill="#6FA858" />
    {/* grass speckles */}
    <rect x={3} y={2} width={2} height={1} fill="#6FA858" />
    <rect x={7} y={2} width={2} height={1} fill="#6FA858" />
    <rect x={11} y={2} width={2} height={1} fill="#6FA858" />
    <rect x={4} y={4} width={1} height={1} fill="#85C26B" />
    <rect x={9} y={4} width={1} height={1} fill="#85C26B" />
    {/* dirt speckles */}
    <rect x={4} y={7} width={1} height={1} fill="#6F542F" />
    <rect x={9} y={9} width={1} height={1} fill="#6F542F" />
    <rect x={11} y={11} width={1} height={1} fill="#6F542F" />
    <rect x={6} y={11} width={1} height={1} fill="#A37D4D" />
  </svg>
);
