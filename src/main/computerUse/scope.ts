/**
 * 260925 backseat act: the scope check that runs before EVERY input action.
 *
 * The act loop may only touch what the player shared. The check is done in
 * global points against a fresh window list (CGWindowList, front to back), so
 * it reflects the screen at the moment of the action, not at the screenshot:
 *
 *   - Pointer actions: every point must be inside the target (the shared
 *     window's current bounds, or the shared display), must not be on one of
 *     Sei's own interactive surfaces (the driving indicator), and the topmost
 *     visible window under it must belong to the shared app (window share) or
 *     to any app that is not Sei and not on the deny list (screen share).
 *   - Keyboard actions: the frontmost app must be the shared app (window
 *     share), or not Sei and not on the deny list (screen share). Keystrokes
 *     go to whoever has focus, whatever the pointer is over.
 *
 * The deny list is the set of places where a stray click or keystroke does
 * real damage and that no task in a shared app needs: system settings and
 * auth prompts, password managers, terminals. It is checked by bundle id and,
 * for the system agents that have no useful bundle id in CGWindowList, by
 * owner name.
 */
import { rectContains } from './geometry';
import type { ActionTouch } from './actions';
import type { ActTarget, AppInfo, DisplayInfo, Point, Rect, WindowInfo } from './types';

export const DENY_BUNDLE_IDS = new Set([
  'com.apple.systempreferences',
  'com.apple.Settings',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.apple.loginwindow',
  'com.apple.SecurityAgent',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.ScreenContinuity',
]);

export const DENY_OWNER_NAMES = new Set([
  'SecurityAgent',
  'coreautha',
  'loginwindow',
  'System Settings',
  'System Preferences',
  'Keychain Access',
  'Passwords',
  'Terminal',
  'iTerm2',
  '1Password',
]);

export interface ScopeContext {
  target: ActTarget;
  /** Fresh on-screen windows, front to back. */
  windows: WindowInfo[];
  displays: DisplayInfo[];
  frontmost: AppInfo;
  /** Sei's own process ids (main, and helpers that own windows). */
  seiPids: Set<number>;
  /** Sei windows that are click-through and may be ignored in hit tests (avatar overlay, captions). */
  passThroughWindowIds?: Set<number>;
  /** Global rects where Sei draws interactive UI during an act (the Stop pill). */
  seiRects?: Rect[];
  /** bundleId lookup for a pid (the helper's `app` query), cached by the caller. */
  bundleIdOf?: (pid: number) => string | undefined;
}

export type ScopeResult = { ok: true } | { ok: false; reason: string };

/** The global rect the target covers right now, or null when it is gone. */
export function targetRect(ctx: Pick<ScopeContext, 'target' | 'windows' | 'displays'>): Rect | null {
  const t = ctx.target;
  if (t.kind === 'window') {
    const w = ctx.windows.find((x) => x.id === t.windowId);
    return w ? w.bounds : null;
  }
  const d = ctx.displays.find((x) => x.id === t.displayId);
  return d ? d.bounds : null;
}

/** Owner pid of the shared window, from the live list (falls back to the target's recorded pid). */
export function targetPid(ctx: Pick<ScopeContext, 'target' | 'windows'>): number | undefined {
  const t = ctx.target;
  if (t.kind !== 'window') return undefined;
  return ctx.windows.find((x) => x.id === t.windowId)?.pid ?? t.pid;
}

/** Topmost visible window under a point, skipping pass-through Sei windows. */
export function topWindowAt(ctx: Pick<ScopeContext, 'windows' | 'passThroughWindowIds'>, p: Point): WindowInfo | undefined {
  return ctx.windows.find(
    (w) => w.alpha > 0.01 && rectContains(w.bounds, p) && !ctx.passThroughWindowIds?.has(w.id),
  );
}

function denied(ctx: ScopeContext, pid: number | undefined, owner?: string, bundleId?: string): string | null {
  if (pid !== undefined && ctx.seiPids.has(pid)) return "Sei's own window";
  const b = bundleId ?? (pid !== undefined ? ctx.bundleIdOf?.(pid) : undefined);
  if (b && DENY_BUNDLE_IDS.has(b)) return `a protected app (${b})`;
  if (owner && DENY_OWNER_NAMES.has(owner)) return `a protected app (${owner})`;
  return null;
}

export function checkScope(ctx: ScopeContext, touch: ActionTouch): ScopeResult {
  const rect = targetRect(ctx);
  if (!rect) return { ok: false, reason: 'the shared window is no longer on screen' };
  const pid = targetPid(ctx);

  for (const p of touch.points) {
    if (!rectContains(rect, p)) return { ok: false, reason: 'that point is outside what the player shared' };
    if (ctx.seiRects?.some((r) => rectContains(r, p))) return { ok: false, reason: "that point is on Sei's own controls" };
    const top = topWindowAt(ctx, p);
    if (!top) return { ok: false, reason: 'there is no window under that point' };
    if (ctx.target.kind === 'window') {
      if (top.pid !== pid) {
        return { ok: false, reason: `another window (${top.owner ?? 'unknown'}) is covering the shared window there` };
      }
    } else {
      const why = denied(ctx, top.pid, top.owner);
      if (why) return { ok: false, reason: `that point is on ${why}` };
    }
  }

  if (touch.keyboard) {
    const f = ctx.frontmost;
    const fpid = f.pid ?? f.topWindowPid;
    if (fpid === undefined) return { ok: false, reason: 'cannot tell which app has keyboard focus' };
    if (ctx.target.kind === 'window') {
      if (fpid !== pid) {
        return { ok: false, reason: `keyboard focus is on ${f.name ?? 'another app'}, not the shared window. Click inside it first` };
      }
    } else {
      const why = denied(ctx, fpid, f.name, f.bundleId);
      if (why) return { ok: false, reason: `keyboard focus is on ${why}` };
    }
  }
  return { ok: true };
}
