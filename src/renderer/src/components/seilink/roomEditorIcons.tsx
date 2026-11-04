/**
 * Line icons for the room editor (261104). Same drawing rules as
 * components/icons.tsx (24 grid, currentColor, round caps), sized by `size`.
 */
import React from 'react';

interface P {
  size?: number;
}

const Svg = ({ size = 18, children, sw = 1.8 }: P & { children: React.ReactNode; sw?: number }): React.ReactElement => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const UndoIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const CloseIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const CheckIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

export const AutoIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const DayIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);

export const DuskIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M7 16a5 5 0 0 1 10 0" />
    <path d="M3 19.5h18M12 5v3M4.6 9.6l1.6 1.4M19.4 9.6l-1.6 1.4" />
  </Svg>
);

export const NightIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Svg>
);

export const FlipIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2 2.6" />
    <path d="M9 7L4 17h5zM15 7l5 10h-5z" />
  </Svg>
);

export const MinusIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M6 12h12" />
  </Svg>
);

export const PlusIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 6v12M6 12h12" />
  </Svg>
);

export const TrashIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
  </Svg>
);

export const UploadIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
    <path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
  </Svg>
);

export const NoneIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M6.5 17.5l11-11" />
  </Svg>
);

export const BagIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M5 8.5h14l-1.2 11a1.5 1.5 0 0 1-1.5 1.5H7.7a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
  </Svg>
);

export const PaletteIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.6 1.8-1.6h2.3a3.8 3.8 0 0 0 3.8-3.8C20.5 6.6 16.7 3.5 12 3.5z" />
    <circle cx="7.8" cy="11" r="1.1" />
    <circle cx="10.5" cy="7.4" r="1.1" />
    <circle cx="15" cy="7.6" r="1.1" />
  </Svg>
);

// ── SeiLink dock (M4) ──

/** Edit room: a paint brush. */
export const BrushIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M14.5 4.5l5 5L11 18l-5-5z" />
    <path d="M6 13c-2 .5-2.5 2.5-2.5 6.5 3.5 0 6-.5 6.5-2.5" />
  </Svg>
);

/** Her idle lines on: a speech bubble. */
export const BubbleIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7L7.5 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />
  </Svg>
);

/** Her idle lines muted: the bubble, struck through. */
export const BubbleOffIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M9 5.5h10a1.5 1.5 0 0 1 1.5 1.5v8c0 .5-.2.9-.6 1.2M16 16.5h-4L7.5 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7c0-.6.3-1 .8-1.3" />
    <path d="M3.5 3.5l17 17" />
  </Svg>
);

/** Move out: a door with an arrow leaving it. */
export const MoveOutIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M13 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H13" />
    <path d="M10 12h10M16.5 8.5L20 12l-3.5 3.5" />
  </Svg>
);

// ── Editor rail (261105): one line icon per slot, in place of image previews ──

/** Avatar: a person. */
export const PersonIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20.5a7 7 0 0 1 14 0" />
  </Svg>
);

/** Room type: a house. */
export const HouseIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M6 9.5v10h12v-10" />
    <path d="M10 19.5V15h4v4.5" />
  </Svg>
);

/** View: a window onto mountains. */
export const ViewIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
    <path d="M3.5 17l5-5 4 4 2.5-2.5 5.5 5" />
    <circle cx="15.5" cy="8.5" r="1.5" />
  </Svg>
);

/** Walls (and the Walls & fabrics rail group): a paint roller. */
export const RollerIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="14" height="5.5" rx="1.2" />
    <path d="M17.5 6.2h3v5.3H12v3" />
    <rect x="10.5" y="14.5" width="3" height="6" rx="1" />
  </Svg>
);

/** Rug: a bordered rug on the floor, seen in perspective. */
export const RugIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M6.5 7h11l3.5 10.5H3z" />
    <path d="M8.6 10h6.8l1.6 4.5H7z" />
  </Svg>
);

/** Curtains: two drapes on a rod, tied back. */
export const CurtainsIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 4h18" />
    <path d="M5 4v16.5h3.5c-.6-2.6-1.5-4.4-1.5-7 1.2-1.2 2.3-4.5 2.5-9.5" />
    <path d="M19 4v16.5h-3.5c.6-2.6 1.5-4.4 1.5-7-1.2-1.2-2.3-4.5-2.5-9.5" />
  </Svg>
);

/** Shelves: two shelves with books. */
export const ShelfIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 10.5h18M3 19.5h18" />
    <path d="M6 10.5v-5M8.5 10.5v-5M11 10.5l2-4.5" />
    <path d="M14.5 19.5v-5M17 19.5v-5" />
  </Svg>
);

/** Bed: headboard, pillow and mattress. */
export const BedIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 6v13.5M3 16h18M21 19.5V13a2 2 0 0 0-2-2h-8v5" />
    <rect x="5.5" y="11" width="3.5" height="2.5" rx="1" />
  </Svg>
);

/** Lamp: a floor lamp. */
export const LampIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M8.5 3.5h7l3 6.5h-13z" />
    <path d="M12 10v10M8.5 20.5h7" />
  </Svg>
);

/** Chair: an armchair (also the Furniture rail group). */
export const ChairIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M5.5 10.5V7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
    <path d="M3.5 12a1.5 1.5 0 0 1 3 0v2h11v-2a1.5 1.5 0 0 1 3 0v6h-17z" />
    <path d="M6 18v2M18 18v2" />
  </Svg>
);

/** Campfire: a flame over crossed logs. */
export const CampfireIcon = (p: P): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3.5c2.7 2.8 4 5 4 7.3a4 4 0 0 1-8 0c0-1.4.6-2.6 1.6-3.6.2 1.1.8 1.9 1.6 2.2-.3-2 .1-4 .8-5.9z" />
    <path d="M4.5 20.5l15-4M19.5 20.5l-15-4" />
  </Svg>
);
