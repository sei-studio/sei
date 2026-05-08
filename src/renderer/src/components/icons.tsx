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

export const SettingsIcon: React.FC<IconProps> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx={12} cy={12} r={3} />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
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

export const SparkleIcon: React.FC<IconProps> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8L12 2z" />
    <path
      d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"
      opacity={0.7}
    />
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
