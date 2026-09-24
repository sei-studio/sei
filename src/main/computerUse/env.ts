/**
 * 260925 backseat act: the capture and scope functions the loop runs on,
 * built over an InputExecutor. No Electron here, so tests drive them with a
 * fake executor.
 */
import type { ActionTouch } from './actions';
import { planCapture } from './geometry';
import type { InputExecutor } from './inputHelper';
import { checkScope, targetRect, topWindowAt, type ScopeResult } from './scope';
import { perceive, type Perception } from './perception';
import type { ActTarget, Frame, ImageBudget, Rect } from './types';

/** desktopCapturer source id -> act target. `window:<CGWindowID>:0`, `screen:<CGDirectDisplayID>:0`. */
export function targetFromSourceId(sourceId: string, label?: string): ActTarget | null {
  const m = /^(window|screen):(\d+):/.exec(sourceId);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isFinite(id) || id <= 0) return null;
  return m[1] === 'window' ? { kind: 'window', windowId: id, label } : { kind: 'screen', displayId: id, label };
}

export function makeCapture(o: {
  executor: InputExecutor;
  target: ActTarget;
  budget: ImageBudget;
  excludePids?: number[];
  quality?: number;
  now?: () => number;
}): (withOcr: boolean, signal: AbortSignal) => Promise<Frame> {
  return async (withOcr, signal) => {
    const [windows, displays] = await Promise.all([o.executor.windows(), o.executor.displays()]);
    const base = targetRect({ target: o.target, windows, displays });
    if (!base) throw new Error('the shared window is no longer on screen');
    const plan = planCapture(base, displays, o.budget);
    if (!plan) throw new Error('the shared window is off every display');
    const shot = await o.executor.screenshot(
      {
        displayId: plan.displayId,
        rect: plan.rect,
        width: plan.width,
        height: plan.height,
        excludePids: o.excludePids,
        cursor: true,
        quality: o.quality ?? 0.8,
        thumb: true,
        ocr: withOcr,
      },
      signal,
    );
    return {
      data: shot.data,
      mime: shot.mime,
      width: shot.width,
      height: shot.height,
      rect: shot.rect,
      displayId: shot.displayId,
      capturedAt: (o.now ?? Date.now)(),
      timing: shot.timing,
      ...(shot.thumb ? { thumb: shot.thumb } : {}),
      ...(shot.ocr ? { ocr: shot.ocr } : {}),
    };
  };
}

/**
 * AX tree of the app under the target + the frame's OCR -> options. Window
 * share: the shared window's app. Screen share: the frontmost app (its
 * windows are what the player is looking at), unless it is Sei or denied.
 */
export function makePerceive(o: {
  executor: InputExecutor;
  target: ActTarget;
  seiPids: () => Set<number>;
  maxNodes?: number;
  log?: (m: string) => void;
}): (frame: Frame, signal: AbortSignal) => Promise<Perception | null> {
  return async (frame, signal) => {
    const [windows, displays, frontmost] = await Promise.all([
      o.executor.windows(),
      o.executor.displays(),
      o.executor.frontmost(),
    ]);
    const rect = targetRect({ target: o.target, windows, displays }) ?? frame.rect;
    let pid: number | undefined;
    let appName: string | undefined;
    let windowTitle: string | undefined;
    if (o.target.kind === 'window') {
      const t = o.target;
      const w = windows.find((x) => x.id === t.windowId);
      pid = w?.pid ?? t.pid;
      appName = w?.owner;
      windowTitle = w?.title;
    } else {
      pid = frontmost.pid ?? frontmost.topWindowPid;
      appName = frontmost.name;
      if (pid !== undefined && o.seiPids().has(pid)) pid = undefined;
    }
    const [ax, focused] = await Promise.all([
      pid !== undefined
        ? o.executor.axDump(pid, { maxNodes: o.maxNodes ?? 600 }, signal).catch((e) => {
            o.log?.(`ax_dump failed: ${String(e)}`);
            return [];
          })
        : Promise.resolve([]),
      o.executor.axFocused(signal).catch(() => null),
    ]);
    return perceive({ frame, targetRect: rect, ax, ocr: frame.ocr, focused, appName, windowTitle });
  };
}

export function makeScope(o: {
  executor: InputExecutor;
  target: ActTarget;
  seiPids: () => Set<number>;
  passThroughWindowIds?: () => Set<number>;
  seiRects?: () => Rect[];
}): (touch: ActionTouch, signal: AbortSignal) => Promise<ScopeResult> {
  const bundleCache = new Map<number, string | undefined>();
  return async (touch) => {
    const [windows, displays, frontmost] = await Promise.all([
      o.executor.windows(),
      o.executor.displays(),
      touch.keyboard ? o.executor.frontmost() : Promise.resolve({}),
    ]);
    const passThroughWindowIds = o.passThroughWindowIds?.();
    // Bundle ids for the windows the points land on (screen share deny list).
    if (o.target.kind === 'screen') {
      for (const p of touch.points) {
        const w = topWindowAt({ windows, passThroughWindowIds }, p);
        if (w && !bundleCache.has(w.pid)) {
          const app = await o.executor.app(w.pid).catch(() => null);
          bundleCache.set(w.pid, app?.bundleId);
        }
      }
    }
    return checkScope(
      {
        target: o.target,
        windows,
        displays,
        frontmost,
        seiPids: o.seiPids(),
        passThroughWindowIds,
        seiRects: o.seiRects?.(),
        bundleIdOf: (pid) => bundleCache.get(pid),
      },
      touch,
    );
  };
}

