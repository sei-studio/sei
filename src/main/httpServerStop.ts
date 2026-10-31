/**
 * Bounded close of a node http server (261031, T278). `server.close()` only
 * resolves once every open connection has ended, and a keep-alive socket (the
 * game's skin fetcher, a browser tab on the auth callback) can hold it open
 * indefinitely, which hung the before-quit teardown with the session marker
 * left 'closing'. Idle keep-alive sockets are closed at once; anything still
 * open after `timeoutMs` is destroyed and the promise resolves anyway.
 * Never rejects.
 */
import type http from 'node:http';

export const SERVER_STOP_TIMEOUT_MS = 3000;

export function stopHttpServer(server: http.Server, timeoutMs: number = SERVER_STOP_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
    try {
      server.close(() => finish());
    } catch {
      finish();
      return;
    }
    try {
      server.closeIdleConnections?.();
    } catch {
      /* ignore */
    }
  });
}
