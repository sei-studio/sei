/**
 * 260925 backseat act: main-side client for the sei-mac-input helper
 * (native/mac-input), spawned the way audioTap.ts spawns the audio tap.
 *
 * JSON lines both ways; every request carries an id and gets exactly one
 * reply. Unsolicited events: `ready` once, `user_input` while the watcher is
 * armed. The helper releases every held key and button on stdin EOF, so a
 * crash of main cannot leave a key stuck down.
 *
 * Abort discipline: `act()` sends `cancel` the moment its signal fires and
 * rejects without waiting, so a stop never queues behind a drag or a held key.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AbortError, abortable } from './abortable';
import type { HelperCommand } from './actions';
import type { AppInfo, AxNode, DisplayInfo, OcrBox, Permissions, Rect, WindowInfo } from './types';

export const READY_TIMEOUT_MS = 5000;
export const QUERY_TIMEOUT_MS = 4000;
export const SCREENSHOT_TIMEOUT_MS = 10000;
/** Generous: a hold can legitimately run 10 s, and a long type on a slow Mac longer. */
export const ACT_TIMEOUT_MS = 30000;

export interface HelperShot {
  data: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
  rect: Rect;
  displayId: number;
  timing?: Record<string, number>;
  thumb?: string;
  ocr?: OcrBox[];
}

export interface ScreenshotRequest {
  displayId?: number;
  rect?: Rect;
  width: number;
  height: number;
  excludePids?: number[];
  cursor?: boolean;
  quality?: number;
  /** 32x18 grayscale hex thumbnail for change detection. */
  thumb?: boolean;
  /** On-device OCR boxes (global points). */
  ocr?: boolean;
  ocrAccurate?: boolean;
}

export interface UserInputEvent {
  kind: 'mouse' | 'key';
  source: string;
  ago: number;
}

/** What the act loop needs from an executor. The mac helper is one; tests use fakes. */
export interface InputExecutor {
  act(command: HelperCommand, signal?: AbortSignal): Promise<{ ms: number }>;
  cancel(): Promise<void>;
  releaseAll(): Promise<void>;
  screenshot(req: ScreenshotRequest, signal?: AbortSignal): Promise<HelperShot>;
  windows(): Promise<WindowInfo[]>;
  displays(): Promise<DisplayInfo[]>;
  frontmost(): Promise<AppInfo>;
  app(pid: number): Promise<AppInfo | null>;
  permissions(prompt?: boolean): Promise<Permissions>;
  /** Accessibility elements of an app's windows, breadth first. */
  axDump(pid: number, opts?: { maxNodes?: number; maxDepth?: number }, signal?: AbortSignal): Promise<AxNode[]>;
  /** The element with keyboard focus, system wide. */
  axFocused(signal?: AbortSignal): Promise<AxNode | null>;
  watch(enabled: boolean): Promise<void>;
  onUserInput(cb: (e: UserInputEvent) => void): () => void;
  dispose(): void;
}

type Reply = { id: number; ok: boolean; error?: string } & Record<string, unknown>;
type Pending = { resolve: (r: Reply) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };

export type SpawnFn = (bin: string) => Pick<ChildProcess, 'stdin' | 'stdout' | 'stderr' | 'on' | 'kill' | 'pid'>;

export function helperPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged
    ? path.join(resourcesPath, 'mac-input', 'sei-mac-input')
    : path.join(appPath, 'resources', 'mac-input', 'sei-mac-input');
}

export class MacInputHelper implements InputExecutor {
  private child: ReturnType<SpawnFn> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private events = new EventEmitter();
  private exited = false;
  private actTimeoutMs = ACT_TIMEOUT_MS;
  ready: Record<string, unknown> | null = null;

  private constructor(private log: (m: string) => void) {}

  /** Spawn and wait for the ready event. Throws on a missing binary or no ready in time. */
  static async start(
    bin: string,
    opts: { log?: (m: string) => void; spawn?: SpawnFn; readyTimeoutMs?: number; actTimeoutMs?: number } = {},
  ): Promise<MacInputHelper> {
    const h = new MacInputHelper(opts.log ?? (() => {}));
    if (opts.actTimeoutMs !== undefined) h.actTimeoutMs = opts.actTimeoutMs;
    const spawnFn: SpawnFn = opts.spawn ?? ((b) => nodeSpawn(b, [], { stdio: ['pipe', 'pipe', 'pipe'] }));
    const child = spawnFn(bin);
    h.child = child;
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mac-input helper did not start')), opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      h.events.once('ready', (m) => {
        clearTimeout(t);
        resolve(m);
      });
      h.events.once('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`mac-input helper exited early (${code})`));
      });
    });
    child.stdout!.on('data', (d: Buffer) => h.onData(d));
    child.stderr!.on('data', (d: Buffer) => h.log(`[mac-input] ${d.toString('utf8').trimEnd()}`));
    child.on('error', (e: Error) => h.onExit(`error ${e.message}`));
    child.on('exit', (code: number | null) => h.onExit(String(code)));
    h.ready = await ready;
    return h;
  }

  private onData(d: Buffer): void {
    this.buf += d.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`[mac-input] bad line ${line.slice(0, 120)}`);
        continue;
      }
      if (typeof msg.event === 'string') {
        this.events.emit(msg.event, msg);
        continue;
      }
      const id = msg.id as number;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg as Reply);
    }
  }

  private onExit(why: string): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', why);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`mac-input helper exited (${why})`));
    }
    this.pending.clear();
  }

  get alive(): boolean {
    return !this.exited && !!this.child;
  }

  /** One request, one reply. Rejects on `ok:false`, timeout or exit. */
  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = QUERY_TIMEOUT_MS): Promise<Reply> {
    if (!this.alive) return Promise.reject(new Error('mac-input helper is not running'));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`mac-input ${cmd} timed out`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (r) => (r.ok ? resolve(r) : reject(new Error(r.error ?? `${cmd} failed`))),
        reject,
        timer,
      });
      this.child!.stdin!.write(JSON.stringify({ ...args, id, cmd }) + '\n');
    });
  }

  async act(command: HelperCommand, signal?: AbortSignal): Promise<{ ms: number }> {
    if (signal?.aborted) throw new AbortError(signal.reason);
    const { cmd, ...args } = command;
    // A timed-out action is still running in the helper (a long type keeps
    // typing), so a timeout cancels it before the loop moves on; otherwise the
    // next step's action would queue behind it and the keys would keep landing.
    const p = this.request(cmd, args, this.actTimeoutMs).catch((e: Error) => {
      if (/timed out/.test(e.message)) void this.cancel().catch(() => {});
      throw e;
    });
    if (!signal) return p.then((r) => ({ ms: Number(r.ms ?? 0) }));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        p.catch(() => {});
        void this.cancel().catch(() => {});
        reject(new AbortError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve({ ms: Number(r.ms ?? 0) });
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  async cancel(): Promise<void> {
    if (!this.alive) return;
    await this.request('cancel', {}, 3000);
  }

  async releaseAll(): Promise<void> {
    if (!this.alive) return;
    await this.request('release_all', {}, 3000);
  }

  async screenshot(req: ScreenshotRequest, signal?: AbortSignal): Promise<HelperShot> {
    const p = this.request('screenshot', { ...req }, SCREENSHOT_TIMEOUT_MS);
    const r = await abortable(p, signal);
    return {
      data: String(r.data),
      mime: 'image/jpeg',
      width: Number(r.width),
      height: Number(r.height),
      rect: r.rect as Rect,
      displayId: Number(r.displayId),
      timing: r.timing as Record<string, number> | undefined,
      ...(typeof r.thumb === 'string' ? { thumb: r.thumb } : {}),
      ...(Array.isArray(r.ocr) ? { ocr: r.ocr as OcrBox[] } : {}),
    };
  }

  async axDump(pid: number, opts: { maxNodes?: number; maxDepth?: number } = {}, signal?: AbortSignal): Promise<AxNode[]> {
    const r = await abortable(this.request('ax_dump', { pid, ...opts }, QUERY_TIMEOUT_MS), signal);
    return (r.nodes as AxNode[]) ?? [];
  }

  async axFocused(signal?: AbortSignal): Promise<AxNode | null> {
    const r = await abortable(this.request('ax_focused', {}, QUERY_TIMEOUT_MS), signal);
    const el = r.element as AxNode | undefined;
    return el && el.role ? el : null;
  }

  async windows(): Promise<WindowInfo[]> {
    return ((await this.request('windows')).windows as WindowInfo[]) ?? [];
  }

  async displays(): Promise<DisplayInfo[]> {
    return ((await this.request('displays')).displays as DisplayInfo[]) ?? [];
  }

  async frontmost(): Promise<AppInfo> {
    const { id: _id, ok: _ok, ...rest } = await this.request('frontmost');
    return rest as AppInfo;
  }

  async app(pid: number): Promise<AppInfo | null> {
    return ((await this.request('app', { pid })).app as AppInfo | null) ?? null;
  }

  async permissions(prompt = false): Promise<Permissions> {
    const r = await this.request('permissions', { prompt });
    return {
      axTrusted: !!r.axTrusted,
      postEventAccess: !!r.postEventAccess,
      screenCaptureAccess: !!r.screenCaptureAccess,
    };
  }

  async watch(enabled: boolean): Promise<void> {
    await this.request('watch', { enabled });
  }

  onUserInput(cb: (e: UserInputEvent) => void): () => void {
    const h = (m: Record<string, unknown>) =>
      cb({ kind: m.kind === 'key' ? 'key' : 'mouse', source: String(m.source ?? ''), ago: Number(m.ago ?? 0) });
    this.events.on('user_input', h);
    return () => this.events.off('user_input', h);
  }

  /** Close stdin (the helper releases everything and exits), then kill after 500 ms. */
  dispose(): void {
    const c = this.child;
    if (!c) return;
    this.child = null;
    try {
      c.stdin?.end();
    } catch {
      /* already closed */
    }
    const t = setTimeout(() => {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }, 500);
    t.unref?.();
    this.onExit('disposed');
  }
}
