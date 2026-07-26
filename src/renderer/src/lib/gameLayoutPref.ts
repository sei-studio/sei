/**
 * gameLayoutPref — the user's preferred size for the game area in ChatScreen
 * (260725).
 *
 * The game/chat split has two knobs: GameSurface's expand "V" (game covers the
 * chat entirely) and the drag handle on the game/chat boundary (a percentage
 * of the main column). Both used to be plain component state, so leaving the
 * chat view for a profile page and coming back dropped the user's sizing back
 * to the default half-screen split.
 *
 * This is a PREFERENCE, not per-character session state: one sizing follows
 * the user across characters and games, and it is persisted to localStorage so
 * it also survives an app restart. Reads are defensive (any malformed or
 * absent value falls back to the default split) and writes are coalesced, so
 * a drag does not hammer localStorage on every pointermove.
 */

const KEY = 'sei.gameLayout';
/** Trailing coalesce window for writes during a drag. */
const WRITE_DEBOUNCE_MS = 250;

export interface GameLayout {
  /** Game area expanded over the chat. */
  expanded: boolean;
  /** Dragged split as a percentage of the main column; null = default CSS split. */
  split: number | null;
}

export const DEFAULT_GAME_LAYOUT: GameLayout = { expanded: false, split: null };

/** Stored layout, or the default when absent / unreadable / malformed. */
export function readGameLayout(): GameLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_GAME_LAYOUT;
    const v = JSON.parse(raw) as Partial<GameLayout> | null;
    if (!v || typeof v !== 'object') return DEFAULT_GAME_LAYOUT;
    const split =
      typeof v.split === 'number' && Number.isFinite(v.split) && v.split > 0 && v.split < 100
        ? v.split
        : null;
    return { expanded: v.expanded === true, split };
  } catch {
    return DEFAULT_GAME_LAYOUT;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the layout (trailing-debounced; best effort). */
export function writeGameLayout(layout: GameLayout): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      /* private mode / quota — the layout just won't outlive the session */
    }
  }, WRITE_DEBOUNCE_MS);
}
