import React from 'react';

const I: React.FC<{ size?: number; color?: string; children: React.ReactNode; viewBox?: string }> = ({
  size = 20,
  color = 'currentColor',
  children,
  viewBox = '0 0 24 24',
}) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill="none"
    stroke={color}
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block' }}
  >
    {children}
  </svg>
);

export const GridIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" />
    <rect x="13.5" y="3.5" width="7" height="7" />
    <rect x="3.5" y="13.5" width="7" height="7" />
    <rect x="13.5" y="13.5" width="7" height="7" />
  </I>
);

export const GlobeIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z" />
  </I>
);

export const PlusIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M12 5v14M5 12h14" />
  </I>
);

export const SparkleIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M12 3l1.8 6.2L20 12l-6.2 2.8L12 21l-1.8-6.2L4 12l6.2-2.8z" />
  </I>
);

export const SlidersIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M5 6h9M18 6h1M5 12h1M10 12h9M5 18h9M18 18h1" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </I>
);

export const ChevronLeftIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </I>
);

export const GamepadIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M7 8h10a4.5 4.5 0 0 1 4.4 5.4l-.8 3.6a2.6 2.6 0 0 1-4.6 1l-1.4-1.9H9.4L8 18a2.6 2.6 0 0 1-4.6-1l-.8-3.6A4.5 4.5 0 0 1 7 8z" />
    <path d="M8.5 11v3M7 12.5h3M15.5 11.4h.01M17.8 13.2h.01" />
  </I>
);

export const PhoneIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M5.5 4h3l1.7 4.3-2 1.6a13 13 0 0 0 5.9 5.9l1.6-2L20 15.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3.5 6.2 2 2 0 0 1 5.5 4z" />
  </I>
);

export const MicIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <rect x="9.5" y="3.5" width="5" height="10" rx="2.5" />
    <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
  </I>
);

export const HeadphonesIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M4.5 17v-4a7.5 7.5 0 0 1 15 0v4" />
    <rect x="3.5" y="14" width="4" height="6" rx="1.5" />
    <rect x="16.5" y="14" width="4" height="6" rx="1.5" />
  </I>
);

export const ScreenIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <rect x="3" y="5" width="18" height="12.5" rx="1.5" />
    <path d="M9 21h6M12 17.5V21" />
  </I>
);

export const HangUpIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <path d="M4 14.5c4.7-4.4 11.3-4.4 16 0l-1.7 2.6c-.5.7-1.4 1-2.2.6l-2.1-1a1.8 1.8 0 0 1-1-1.8v-1a11 11 0 0 0-2 0v1c0 .8-.4 1.5-1 1.8l-2.1 1c-.8.4-1.7.1-2.2-.6z" />
  </I>
);

export const PersonIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </I>
);

export const InfoIcon: React.FC<{ size?: number; color?: string }> = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 7.8h.01" />
  </I>
);
