/**
 * SeiLink room activity (261104): should the room draw, and at what rate?
 *
 * The room is wallpaper, so it is only worth drawing while someone can see
 * it. Inputs, all from the host process:
 *
 * - Windows: the native watcher's coverage verdict (a maximized or
 *   monitor-sized window on the primary display, or a D3D fullscreen app).
 * - macOS: window occlusion. A zoomed or fullscreen window never occludes
 *   the whole room window (the menu bar and Dock strips stay visible), so
 *   "covered" means her hit panel (only over her box) is occluded, or the
 *   whole room is (spike round 2).
 * - Both: screen locked, machine asleep (powerMonitor; Windows also gets
 *   WM_WTSSESSION_CHANGE), and a pause from main.
 *
 * Output: covered / paused / the frame cap (0 = a still picture).
 */

export interface ActivityInputs {
  /** Windows watcher verdict. */
  winCovered: boolean;
  /** macOS: the room window is at least partly visible. */
  roomVisible: boolean;
  /** macOS: her hit panel exists... */
  hasPanel: boolean;
  /** ...and is at least partly visible. */
  panelVisible: boolean;
  locked: boolean;
  suspended: boolean;
  /** Main asked for a still room. */
  held: boolean;
}

export interface Activity {
  covered: boolean;
  paused: boolean;
  fps: number;
  reason: string;
}

export const INITIAL_INPUTS: ActivityInputs = {
  winCovered: false,
  roomVisible: true,
  hasPanel: false,
  panelVisible: true,
  locked: false,
  suspended: false,
  held: false,
};

export function computeActivity(i: ActivityInputs, capFps: number): Activity {
  const covered = i.winCovered || !i.roomVisible || (i.hasPanel && !i.panelVisible);
  const paused = i.locked || i.suspended || i.held;
  const reasons: string[] = [];
  if (i.winCovered) reasons.push('window');
  if (!i.roomVisible) reasons.push('room-occluded');
  if (i.hasPanel && !i.panelVisible) reasons.push('box-occluded');
  if (i.locked) reasons.push('locked');
  if (i.suspended) reasons.push('asleep');
  if (i.held) reasons.push('held');
  return { covered, paused, fps: covered || paused ? 0 : Math.max(0, capFps), reason: reasons.join('+') || 'visible' };
}

/** Holds the inputs; `onChange` fires only when covered/paused/fps actually change. */
export class RoomActivity {
  private inputs: ActivityInputs = { ...INITIAL_INPUTS };
  private last: Activity;

  constructor(
    private capFps: number,
    private readonly onChange: (a: Activity) => void,
  ) {
    this.last = computeActivity(this.inputs, capFps);
  }

  get current(): Activity {
    return this.last;
  }

  set(patch: Partial<ActivityInputs>): void {
    this.inputs = { ...this.inputs, ...patch };
    this.emitIfChanged();
  }

  setCap(fps: number): void {
    this.capFps = Math.max(0, Math.min(240, Number.isFinite(fps) ? fps : 0));
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const next = computeActivity(this.inputs, this.capFps);
    const prev = this.last;
    this.last = next;
    if (next.covered !== prev.covered || next.paused !== prev.paused || next.fps !== prev.fps) this.onChange(next);
  }
}

/** Windows WM_WTSSESSION_CHANGE codes that matter here. */
export const WTS_SESSION_LOCK = 7;
export const WTS_SESSION_UNLOCK = 8;
