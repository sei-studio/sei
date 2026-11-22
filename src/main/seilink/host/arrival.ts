/**
 * Her arrival on the desktop, one per host session (261119, product call
 * (261119); the rules are shared/seilinkEntrance.ts `arrivalMode`).
 *
 * Main owns it, so a host restart neither replays her entrance nor forgets
 * that she is still waiting. Inputs: the trigger (from startSeilinkHost),
 * her look (the anima status, re-read on every anima push and every
 * LOOK_POLL_MS while she waits), the app stepping aside (`revealed`, from
 * stageFlow, or REVEAL_WAIT_MS after the start), a click on the waiting line
 * (`skip`) and the page saying she is in (`pageArrived`). Output: the
 * `arrival` message to the page whenever the mode changes, and one
 * seilink_entrance event (when she is in, or when the session ends first).
 *
 * No electron here: seilinkHost.ts wires it, arrival.test.ts drives it.
 */
import {
  LINK_TIMEOUT_MS,
  REVEAL_WAIT_MS,
  SEILINK_ENTRANCE_EVENT,
  arrivalMode,
  type ArrivalMode,
  type EntranceLook,
  type EntranceTrigger,
  type SeilinkArrival,
} from '../../../shared/seilinkEntrance';
import type { AnimaShownKind } from '../../../shared/anima';

/** While she waits, her look is re-read this often (a push can be missed: the cut-out landing sends none when it fails). */
export const LOOK_POLL_MS = 2_000;

export interface LookNow {
  /** Her look is still on its way. */
  pending: boolean;
  /** Its class once it is not (settledLook); ignored while pending. */
  look: EntranceLook;
}

export interface ArrivalDeps {
  /** Her look now; null while it cannot be told yet (the imported-model check still running). */
  look(): LookNow | null;
  send(arrival: SeilinkArrival): void;
  capture(event: string, props: Record<string, unknown>): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export class Arrival {
  private revealedAt: number | null = null;
  private skipped = false;
  private waitStart: number | null = null;
  private waitMs = 0;
  private timedOut = false;
  private settled: EntranceLook | null = null;
  private arrived = false;
  private done = false;
  private last: SeilinkArrival | null = null;
  private timers: unknown[] = [];
  private pollTimer: unknown = null;
  private waiters: Array<(ok: boolean) => void> = [];
  private sawCovered = false;

  constructor(
    readonly characterId: string,
    readonly trigger: EntranceTrigger,
    private readonly d: ArrivalDeps,
  ) {
    if (trigger === 'move_in' || trigger === 'switch') {
      // The app steps aside after the start; if it never does (a refused stage, the app left up), she comes in anyway.
      this.timers.push(d.setTimeout(() => this.revealed(), REVEAL_WAIT_MS));
    }
  }

  /** The mode the page should be in now (null: not decided yet, the page holds her). */
  current(): SeilinkArrival | null {
    return this.last;
  }

  /** She is waiting for her look (the line is up): a click on it is a skip, her lines wait. */
  waiting(): boolean {
    return this.last?.mode === 'wait';
  }

  /** She is there or coming in now (her lines can show). */
  present(): boolean {
    return this.arrived || this.last?.mode === 'enter' || this.last?.mode === 'show';
  }

  /** Re-read everything and tell the page when the mode changed. */
  update(): void {
    if (this.done) return;
    // enter and show are final: the page is bringing her in or has her; a re-check of her look must not pull her back out.
    if (this.last && (this.last.mode === 'enter' || this.last.mode === 'show')) return;
    const look = this.d.look();
    if (!look) return;
    const now = this.d.now();
    if (look.pending && !this.skipped) {
      if (this.waitStart === null) {
        this.waitStart = now;
        this.timers.push(this.d.setTimeout(() => this.onTimeout(), LINK_TIMEOUT_MS));
      }
      this.settled = null;
    } else if (this.settled === null) {
      if (this.waitStart !== null) this.waitMs = now - this.waitStart;
      this.settled = look.pending ? 'skipped' : this.waitStart !== null && look.look === 'ready' ? 'arrived' : look.look;
    }
    const mode = arrivalMode({
      trigger: this.trigger,
      arrived: this.arrived,
      pending: look.pending,
      skipped: this.skipped,
      revealed: this.revealedAt !== null,
      waited: this.waitStart !== null,
    });
    this.poll(mode === 'wait');
    const next: SeilinkArrival = mode === 'wait' && this.timedOut ? { mode, trigger: this.trigger, quiet: true } : { mode, trigger: this.trigger };
    if (this.last && this.last.mode === next.mode && this.last.quiet === next.quiet) return;
    this.last = next;
    this.d.send(next);
  }

  /** The page (re)connected (a host restart too, after she came in: then `show`): it gets the current mode again. */
  resend(): void {
    if (this.last) this.d.send(this.last);
    else this.update();
  }

  /** The app stepped aside (the desktop shows). */
  revealed(): void {
    if (this.revealedAt !== null) return;
    this.revealedAt = this.d.now();
    this.update();
  }

  /**
   * The host's coverage report: the desktop was covered (by the app or other windows) and now
   * shows (a Win+D, the app minimized by hand): that counts as the app stepping aside.
   */
  coverage(covered: boolean): void {
    if (covered) this.sawCovered = true;
    else if (this.sawCovered) this.revealed();
  }

  /** A click while the waiting line is up: she comes in now with the look she has. True when it was taken as a skip. */
  skip(): boolean {
    if (this.done || !this.waiting()) return false;
    this.skipped = true;
    // A skip is the user asking for her: no need to wait for the app to step aside.
    this.revealedAt ??= this.d.now();
    this.update();
    return true;
  }

  /** The page says she is in (her entrance played, or she was shown as she is). */
  pageArrived(r: { played: boolean; reduced: boolean; kind: AnimaShownKind | null }): void {
    if (this.done || this.arrived) return;
    const mode = this.last?.mode;
    if (mode !== 'enter' && mode !== 'show') return;
    this.arrived = true;
    this.last = { mode: 'show', trigger: this.trigger };
    this.report(r.played ? 'played' : 'still', { kind: r.kind, reduced: r.reduced });
    this.finish(true);
  }

  /** The session ended. Before she came in, that is an `ended` event. */
  end(): void {
    if (this.done) return;
    if (!this.arrived) this.report('ended', null);
    this.finish(false);
  }

  /** Resolves true once she is in, false when the session ends first (the decorate offer waits on it). */
  whenArrived(): Promise<boolean> {
    if (this.arrived) return Promise.resolve(true);
    if (this.done) return Promise.resolve(false);
    return new Promise((r) => this.waiters.push(r));
  }

  private onTimeout(): void {
    if (this.done || this.settled !== null) return;
    this.timedOut = true;
    this.update();
  }

  private poll(on: boolean): void {
    if (on && this.pollTimer === null) {
      const tick = (): void => {
        this.pollTimer = null;
        if (this.done) return;
        this.update();
      };
      this.pollTimer = this.d.setTimeout(tick, LOOK_POLL_MS);
    } else if (!on && this.pollTimer !== null) {
      this.d.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private report(action: 'played' | 'still' | 'ended', page: { kind: AnimaShownKind | null; reduced: boolean } | null): void {
    const waited = this.waitStart !== null;
    const waitMs = waited ? (this.settled !== null ? this.waitMs : this.d.now() - (this.waitStart ?? 0)) : 0;
    const props: Record<string, unknown> = {
      character_id: this.characterId,
      trigger: this.trigger,
      action,
      look: action === 'ended' && this.settled === null ? (waited ? 'waiting' : 'ready') : (this.settled ?? 'ready'),
      waited,
      wait_ms: Math.max(0, Math.round(waitMs)),
      timed_out: this.timedOut,
      skipped: this.skipped,
    };
    if (page?.kind) props.avatar_kind = page.kind;
    if (page) props.reduced_motion = page.reduced;
    try {
      this.d.capture(SEILINK_ENTRANCE_EVENT, props);
    } catch {
      /* analytics must never disrupt her arrival */
    }
  }

  private finish(ok: boolean): void {
    this.done = true;
    for (const t of this.timers) this.d.clearTimeout(t);
    this.timers = [];
    this.poll(false);
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r(ok);
  }
}

export type { ArrivalMode };




