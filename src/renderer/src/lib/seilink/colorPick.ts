/**
 * The room editor's custom colour picker (261105 colour pass, T333): colour
 * math, the "recent" row and the frame throttle for live preview. Pure
 * except the recent row's storage, which is a per-user editor preference in
 * localStorage (like the app's other UI prefs, e.g. gameLayoutPref), not part
 * of a room: recent colours follow her across rooms and characters.
 */
import { useEffect, useState } from 'react';

/** h 0..360, s and v 0..1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** '#rrggbb' from what she typed ('abc', '#ABC', 'a1b2c3', ' #a1b2c3 '), else null. */
export function parseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const d = m[1].toLowerCase();
  return `#${d.length === 3 ? [...d].map((c) => c + c).join('') : d}`;
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = clamp01(s);
  const vv = clamp01(v);
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = vv - c;
  return `#${[r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** HSV of a hex colour. A grey keeps `hue` (the hue it had), so the hue slider does not jump to red. */
export function hexToHsv(hex: string, hue = 0): Hsv {
  const p = parseHex(hex) ?? '#ffffff';
  const n = parseInt(p.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = hue;
  if (d > 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// ── recent colours ──────────────────────────────────────────────────────────

export const RECENT_MAX = 6;
const KEY = 'sei.seilinkRecentColors';

/** The recent row after picking `hex`: it moves to the front, no repeats, at most RECENT_MAX. */
export function pushRecent(list: readonly string[], hex: string): string[] {
  const v = parseHex(hex);
  if (!v) return [...list];
  return [v, ...list.filter((c) => c !== v)].slice(0, RECENT_MAX);
}

/** Stored recent colours, newest first ([] when absent, unreadable or blocked). */
export function readRecentColors(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const c of v) {
      const h = typeof c === 'string' ? parseHex(c) : null;
      if (h && !out.includes(h)) out.push(h);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

let recent: string[] | null = null;
const listeners = new Set<(list: string[]) => void>();

/** Remember a custom colour she picked (shared by every picker that is open). */
export function rememberRecentColor(hex: string): void {
  const next = pushRecent(recent ?? readRecentColors(), hex);
  recent = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a blocked store only loses the row */
  }
  for (const l of listeners) l(next);
}

/** The recent row, kept in step across pickers. */
export function useRecentColors(): string[] {
  const [list, setList] = useState<string[]>(() => (recent ??= readRecentColors()));
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

// ── live preview throttle ───────────────────────────────────────────────────

/**
 * Calls `fn` at most once per animation frame with the latest value, so a
 * pointer drag in the picker re-composites the room once per frame, not per
 * pointer event. `flush` sends a pending value now (pointer up).
 */
export function frameThrottle<T>(
  fn: (v: T) => void,
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): { push(v: T): void; flush(): void; cancel(): void } {
  let pending: { v: T } | null = null;
  let id: number | null = null;
  const run = (): void => {
    id = null;
    const p = pending;
    pending = null;
    if (p) fn(p.v);
  };
  return {
    push(v) {
      pending = { v };
      if (id === null) id = schedule(run);
    },
    flush() {
      if (id !== null) cancel(id);
      run();
    },
    cancel() {
      if (id !== null) cancel(id);
      id = null;
      pending = null;
    },
  };
}
