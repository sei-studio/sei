/**
 * SeiLink room host: the avatar bridge relay (261104). The host page's
 * RoomAvatar reads her imported model and her face set through a few
 * `window.sei` calls (SEILINK_HOST_AVATAR_METHODS). The host process has no
 * app state, so it forwards each call to main over the pipe and waits for
 * the answer. Main answers for the moved-in character only.
 *
 * File bytes do not travel over the pipe (a Live2D model is tens of MB and
 * the pipe is newline JSON): main names the files and the host reads them
 * here, with the same size limits main's own handlers use.
 */
import type { SeilinkHostAvatarMethod } from '../../../shared/seilinkHost';
import { isSeilinkHostAvatarMethod } from '../../../shared/seilinkHost';
import type { FromHost, ToHost } from './protocol';

/** One facepack file (facepackStore.readPackFile's limit). */
export const RELAY_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** A whole model bundle (avatarStore's extracted limit). */
export const RELAY_MODEL_MAX_BYTES = 256 * 1024 * 1024;
export const RELAY_TIMEOUT_MS = 20_000;

export interface FileReader {
  size(file: string): Promise<number>;
  read(file: string): Promise<Uint8Array>;
}

type CallResult = Extract<ToHost, { type: 'call-result' }>;

export class AvatarRelay {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (m: Extract<FromHost, { type: 'call' }>) => void,
    private readonly files: FileReader,
    private readonly timeoutMs = RELAY_TIMEOUT_MS,
  ) {}

  /** A call from the page. Unknown methods and bad args are refused here, before main sees them. */
  async call(method: unknown, args: unknown): Promise<unknown> {
    if (!isSeilinkHostAvatarMethod(method)) throw new Error('unknown method');
    const list = Array.isArray(args) ? args.slice(0, 2) : [];
    if (!list.every((a) => typeof a === 'string' && a.length <= 512)) throw new Error('bad arguments');
    const value = await this.ask(method, list as string[]);
    return this.materialize(method, value);
  }

  /** main's answer. */
  onResult(m: CallResult): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value ?? null);
    else p.reject(new Error(m.error || 'call failed'));
  }

  /** The pipe closed: nothing will answer. */
  rejectAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('host is closing'));
      this.pending.delete(id);
    }
  }

  get inFlight(): number {
    return this.pending.size;
  }

  private ask(method: SeilinkHostAvatarMethod, args: string[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'call', id, method, args });
    });
  }

  /** Turn main's file names into bytes. */
  private async materialize(method: SeilinkHostAvatarMethod, value: unknown): Promise<unknown> {
    if (method === 'facepackFile') {
      const file = (value as { file?: unknown } | null)?.file;
      if (typeof file !== 'string') return null;
      try {
        if ((await this.files.size(file)) > RELAY_FILE_MAX_BYTES) return null;
        return await this.files.read(file);
      } catch {
        return null;
      }
    }
    if (method === 'avatarModelFiles') {
      if (!Array.isArray(value)) return [];
      const out: Array<{ path: string; bytes: Uint8Array }> = [];
      let total = 0;
      for (const f of value as Array<{ path?: unknown; file?: unknown }>) {
        if (typeof f?.path !== 'string' || typeof f?.file !== 'string') continue;
        try {
          total += await this.files.size(f.file);
          if (total > RELAY_MODEL_MAX_BYTES) return [];
          out.push({ path: f.path, bytes: await this.files.read(f.file) });
        } catch {
          // A file that vanished mid-read: the model loader reports what is missing.
        }
      }
      return out;
    }
    return value ?? null;
  }
}
