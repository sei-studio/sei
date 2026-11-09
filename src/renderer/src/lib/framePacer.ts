/**
 * An even frame cadence under a frame cap (261110). Used by the room's idle
 * motion (RoomAvatar) and by the face-set view (FacepackView), whose loops
 * draw on requestAnimationFrame but at most `cap` times a second.
 */
/**
 * Decides which requestAnimationFrame callbacks draw, for an even cadence.
 *
 * The old check (`t - last >= 1000/cap - 1`) skipped a whole vsync whenever a
 * frame came in a hair early, so 30 fps on 60 Hz came out as an uneven 2,2,3,2
 * frame rhythm, and on 75 or 144 Hz as a mix of gaps. FramePacer measures the
 * display's frame interval from the rAF deltas, draws every n-th vsync (n =
 * the nearest whole number of vsyncs per capped frame, held steady), counting
 * vsyncs since the last drawn frame by rounding, so jitter cannot add a
 * skipped vsync. Pure: the caller passes the rAF timestamp.
 */
export class FramePacer {
  private vsync = 1000 / 60;
  private lastRaf = -1;
  private lastDraw = -1;
  private n = 1;
  private cap = 0;

  /** The current estimate of the display's frame interval, in ms. */
  get vsyncMs(): number {
    return this.vsync;
  }

  /** True when the frame at `t` (ms) should draw at `capFps`. */
  due(t: number, capFps: number): boolean {
    if (this.lastRaf >= 0) {
      const d = t - this.lastRaf;
      // Ignore stalls and doubled callbacks; settle slowly so one late frame does not swing it.
      if (d > 3 && d < 50) this.vsync += (d - this.vsync) * 0.1;
    }
    this.lastRaf = t;
    if (!(capFps > 0)) {
      this.lastDraw = -1;
      return false;
    }
    // Whole vsyncs per frame, with hysteresis: at 75 Hz a 30 fps cap is 2.5 vsyncs, and a
    // plain round() would flip between 2 and 3 on estimate noise.
    const ratio = 1000 / capFps / this.vsync;
    if (capFps !== this.cap || Math.abs(ratio - this.n) > 0.6) this.n = Math.max(1, Math.round(ratio));
    this.cap = capFps;
    // Counted in vsyncs (rounded), so timing jitter never turns 2 into 3 and nothing drifts.
    if (this.lastDraw >= 0 && Math.round((t - this.lastDraw) / this.vsync) < this.n) return false;
    this.lastDraw = t;
    return true;
  }

  /** Forget the rhythm (the loop stopped). The vsync estimate is kept. */
  reset(): void {
    this.lastRaf = -1;
    this.lastDraw = -1;
    this.cap = 0;
  }
}
