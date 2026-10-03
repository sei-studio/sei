/**
 * LineTyper (261004): types a companion line out, one character at a time,
 * and never cuts a line off.
 *
 * Shawn caught the pick step leaving on "Ooh, Brookhaven 🏡RP! Le": the
 * hand-over ran on a fixed beat that was shorter than the line. So the rules
 * here are:
 *
 *   - A line that is still typing is never replaced. A newer line waits until
 *     it has finished, then stays up for HOLD_MS so it can be read, and only
 *     the newest waiting line is kept (a line that was superseded while it
 *     waited is dropped whole, never shown half-typed).
 *   - Progress is measured in elapsed time, not in timer ticks, so a busy
 *     frame does not stretch the line and its end is predictable.
 *   - `onTyped(line)` fires when a line is fully on screen. Anything that
 *     leaves after a line (the pick hand-over) waits for that.
 *
 * Framework-free so it can be tested without a DOM; CompanionLine wraps it.
 */

/** ms per character while a line types out. */
export const TYPE_MS = 22;

/** A finished line stays up at least this long before a waiting one replaces it. */
export const HOLD_MS = 300;

/** How long a line takes to type, counting an emoji or a CJK character as one. */
export function typingMs(line: string): number {
  return Array.from(line).length * TYPE_MS;
}

export interface TyperFrame {
  line: string;
  /** Characters typed so far (Array.from units). */
  n: number;
}

export interface LineTyperOptions {
  /** Reduced motion: every line appears whole. */
  reduced: boolean;
  onFrame: (frame: TyperFrame) => void;
  onTyped?: (line: string) => void;
}

export class LineTyper {
  private line: string | null = null;
  private total = 0;
  private n = 0;
  private doneAt: number | null = null;
  private pending: string | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private wait: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: LineTyperOptions) {}

  /** Say a line: now if nothing is typing, else after the current one. */
  say(line: string): void {
    if (this.line === null) {
      this.start(line);
      return;
    }
    if (line === this.line) {
      // Back to what is already showing: nothing waits any more.
      this.pending = null;
      this.clearWait();
      return;
    }
    this.pending = line;
    if (this.doneAt !== null) this.scheduleNext();
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick);
    this.clearWait();
    this.tick = null;
    this.pending = null;
  }

  private start(line: string): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.line = line;
    this.total = Array.from(line).length;
    this.doneAt = null;
    if (this.opts.reduced || this.total === 0) {
      this.n = this.total;
      this.opts.onFrame({ line, n: this.n });
      this.finish();
      return;
    }
    this.n = 0;
    this.opts.onFrame({ line, n: 0 });
    const t0 = Date.now();
    this.tick = setInterval(() => {
      const n = Math.min(this.total, Math.floor((Date.now() - t0) / TYPE_MS));
      if (n !== this.n) {
        this.n = n;
        this.opts.onFrame({ line, n });
      }
      if (n >= this.total) {
        if (this.tick) clearInterval(this.tick);
        this.tick = null;
        this.finish();
      }
    }, TYPE_MS);
  }

  private finish(): void {
    this.doneAt = Date.now();
    const line = this.line;
    if (line !== null) this.opts.onTyped?.(line);
    if (this.pending !== null) this.scheduleNext();
  }

  /** Start the waiting line once the finished one has been up for HOLD_MS. */
  private scheduleNext(): void {
    if (this.wait || this.doneAt === null) return;
    const delay = HOLD_MS - (Date.now() - this.doneAt);
    if (delay <= 0) {
      this.next();
      return;
    }
    this.wait = setTimeout(() => {
      this.wait = null;
      this.next();
    }, delay);
  }

  private next(): void {
    const next = this.pending;
    this.pending = null;
    if (next !== null && next !== this.line) this.start(next);
  }

  private clearWait(): void {
    if (this.wait) clearTimeout(this.wait);
    this.wait = null;
  }
}
