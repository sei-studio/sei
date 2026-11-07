/**
 * A launch by "Open Sei when I log in" (261107, openAtLogin.ts).
 *
 * Such a launch is for her desktop room only:
 *  - no splash, and the main window is made but never shown (the renderer
 *    loads hidden, so opening Sei later is instant). The room, the Dock
 *    (macOS), a second launch of Sei (the Start menu, a taskbar pin) or a
 *    click on her shows it.
 *  - the launch-time background work that is not WorldLink's waits for that
 *    first show (`afterReveal`): the player-end "next time" LLM check for
 *    sessions the last quit ended, and the Velopack migration (it restarts
 *    Sei into a window). A pending Windows update is not applied at login
 *    either (no update screen at login); it applies on the next quit or the
 *    next launch the user starts. So a login launch costs no LLM call beyond
 *    what her room already does (idle lines need a paid plan or the user's
 *    own AI, desktopLines.ts budgetAllows).
 *  - nothing to show (signed out with no move-in on that profile, nobody
 *    moved in, WorldLink not available here, or her room failed to start) =
 *    Sei quits quietly, before anything was shown. Staying resident and
 *    invisible would be a background process with no way to reach it on
 *    Windows (there is no tray), and a Dock icon with no window on macOS.
 *  - her room ending later while Sei is still hidden (moved out from the
 *    dock, a crash loop) quits the same way.
 *
 * Telling a login launch apart: Windows, the marker arg the Run value passes
 * (`--seilink-login`); macOS has no launch args for login items, so
 * `app.getLoginItemSettings().wasOpenedAtLogin`, and only while Sei's own
 * setting is on (a login item the user added by hand keeps opening the
 * window as before).
 */
import { LOGIN_ARG } from './openAtLogin';
import { LOGIN_LAUNCH_EVENT, LOGIN_LAUNCH_OPENED_EVENT } from '../../shared/openAtLogin';

export function isLoginLaunch(i: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  /** Sei's own setting is on (openAtLogin.ts). */
  wanted: boolean;
  /** macOS only, read lazily: app.getLoginItemSettings().wasOpenedAtLogin. */
  macWasOpenedAtLogin: () => boolean;
}): boolean {
  if (i.platform === 'win32') return i.argv.includes(LOGIN_ARG);
  if (i.platform === 'darwin') {
    if (!i.wanted) return false;
    try {
      return i.macWasOpenedAtLogin() === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** A second launch that is itself a login launch (Sei was already running) changes nothing. */
export function isLoginLaunchArgv(argv: readonly string[]): boolean {
  return argv.includes(LOGIN_ARG);
}

export type LoginLaunchQuitReason = 'nothing_to_show' | 'room_ended';

export interface LoginLaunchDeps {
  quit: (reason: LoginLaunchQuitReason) => void;
  capture: (event: string, props: Record<string, unknown>) => void;
  log: (msg: string) => void;
  now?: () => number;
}

/**
 * The hidden state of one login launch. Pure: index.ts feeds it the window's
 * first show and the room's state.
 */
export class LoginLaunch {
  readonly login: boolean;
  private hidden: boolean;
  private settled = false;
  private ended = false;
  private queued: Array<() => void> = [];
  private readonly startedAt: number;

  constructor(
    login: boolean,
    private readonly deps: LoginLaunchDeps,
  ) {
    this.login = login;
    this.hidden = login;
    this.startedAt = (deps.now ?? Date.now)();
  }

  /** Still a login launch nobody has opened yet. */
  isHidden(): boolean {
    return this.hidden;
  }

  /** Run `fn` now, or once the window is first shown when this launch is still hidden. */
  afterReveal(fn: () => void): void {
    if (!this.hidden) {
      fn();
      return;
    }
    if (!this.ended) this.queued.push(fn);
  }

  /** The main window was shown (any way). */
  revealed(via: 'room' | 'dock' | 'second_launch' | 'other'): void {
    if (!this.hidden || this.ended) return;
    this.hidden = false;
    this.deps.log(`login launch opened (${via})`);
    try {
      this.deps.capture(LOGIN_LAUNCH_OPENED_EVENT, {
        via,
        after_ms: Math.max(0, (this.deps.now ?? Date.now)() - this.startedAt),
      });
    } catch {
      /* ignore */
    }
    const q = this.queued;
    this.queued = [];
    for (const fn of q) {
      try {
        fn();
      } catch (err) {
        this.deps.log(`deferred start work failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The startup restore is done (bootstrap finished, the room's queue idle).
   * `room` = her host session is up (starting, running or restarting).
   */
  startupSettled(room: boolean): void {
    if (!this.login || this.settled) return;
    this.settled = true;
    try {
      this.deps.capture(LOGIN_LAUNCH_EVENT, { outcome: room ? 'room' : 'nothing_to_show', opened: !this.hidden });
    } catch {
      /* ignore */
    }
    if (!room) this.end('nothing_to_show');
  }

  /** Her room ended (moved out, failed). Only matters while still hidden. */
  roomEnded(): void {
    if (!this.settled) return;
    this.end('room_ended');
  }

  private end(reason: LoginLaunchQuitReason): void {
    if (!this.hidden || this.ended) return;
    this.ended = true;
    this.queued = [];
    this.deps.log(`login launch: ${reason}, quitting quietly`);
    this.deps.quit(reason);
  }
}

/**
 * Windows only: may Sei keep running when its last window closes? Yes while
 * her room is on the desktop and the user asked for Sei at login (or this run
 * is a login launch). Otherwise closing the window quits, as before.
 * macOS always stays (it did before this).
 */
export function keepRunningWithoutWindows(i: {
  platform: NodeJS.Platform;
  roomUp: boolean;
  wanted: boolean;
  loginLaunch: boolean;
}): boolean {
  if (i.platform !== 'win32') return false;
  return i.roomUp && (i.wanted || i.loginLaunch);
}
