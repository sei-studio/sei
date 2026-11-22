/**
 * Launch timing, renderer side (261123). `app_window_shown` (main) times
 * process start to the first show of the window; this times the rest of the
 * wait: the first real view after the boot splash. Sent once per renderer
 * load as `app_first_view`; main stamps `ms_since_process_start` on arrival
 * (ipc.ts) and adds its own phase marks. Shape only.
 *
 *   view_kind        the first view (home, onboard, signin, skin-setup, ...)
 *   waited_auth_ms   how long the boot routing waited on main's auth snapshot
 *   renderer_ms      renderer navigation start to the first view
 */
import { sei } from './ipcClient';

export const FIRST_VIEW_EVENT = 'app_first_view';

let authWaitStart: number | null = null;
let authWaitMs: number | null = null;
let reported = false;

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

/** Time `wait` as the boot routing's auth wait (the first call only). */
export async function timeAuthWait<T>(wait: () => Promise<T>): Promise<T> {
  if (authWaitStart !== null) return wait();
  authWaitStart = nowMs();
  try {
    return await wait();
  } finally {
    authWaitMs = Math.max(0, Math.round(nowMs() - authWaitStart));
  }
}

/** The first non-loading view, with the auth wait. Once per renderer load; never throws. */
export function reportFirstView(viewKind: string, opts: { signin?: boolean } = {}): void {
  if (reported) return;
  reported = true;
  try {
    const kind = viewKind === 'onboard' && opts.signin ? 'signin' : viewKind;
    sei.track(FIRST_VIEW_EVENT, {
      view_kind: kind,
      waited_auth_ms: authWaitMs ?? 0,
      renderer_ms: Math.max(0, Math.round(nowMs())),
    });
  } catch {
    /* analytics never breaks the boot */
  }
}

/** Tests only. */
export function resetFirstViewForTest(): void {
  authWaitStart = null;
  authWaitMs = null;
  reported = false;
}
