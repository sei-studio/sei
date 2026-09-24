/**
 * 260925 backseat act: abort helpers. The stop-button lesson (260617) is that
 * a stop must interrupt every await, not just the one that happens to honor a
 * signal, so the act loop wraps each await in `abortable`, which rejects the
 * moment the signal fires even when the underlying promise keeps running.
 */

export class AbortError extends Error {
  constructor(public readonly reason: unknown = 'aborted') {
    super(typeof reason === 'string' ? reason : 'aborted');
    this.name = 'AbortError';
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError' || /aborted/i.test(e.message)))
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError(signal.reason);
}

/** Race a promise against a signal. The loser's rejection is swallowed. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(new AbortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(new AbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** setTimeout as a promise that rejects on abort (no un-abortable sleeps). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError(signal.reason));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError(signal!.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** AbortSignal.any with a fallback for runtimes that lack it. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
