/**
 * 261017 (issue #46): loopback callback listener for "Continue with ChatGPT".
 *
 * SIWC rules: the redirect is http://127.0.0.1:<port>/auth/callback, the
 * listener is up BEFORE the browser opens, `localhost` is never substituted,
 * and only the port may vary between sign-ins. 1455 is the documented
 * example port and is tried first; when it is taken (another SIWC app, or a
 * second Sei attempt) an OS-chosen port is used.
 *
 * Binds 127.0.0.1 only, never all interfaces (same rule as
 * src/main/auth/loopbackPkce.ts). One-shot: the first /auth/callback hit
 * that carries THIS attempt's state is the answer; later hits (prefetch,
 * back/forward) get a plain page. A hit with any other state (a stale tab
 * from an earlier attempt, or a local page probing 127.0.0.1) gets a 400 and
 * is ignored, so it can neither end nor lock out the real sign-in.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CHATGPT_CALLBACK_PATH, CHATGPT_PREFERRED_PORT } from '../../shared/chatgptPlan';
import { callbackUri } from './oauth';

export interface CallbackListener {
  port: number;
  redirectUri: string;
  /** Resolves with the callback's query. Rejects 'timeout' / 'aborted'. */
  wait(timeoutMs: number, signal: AbortSignal): Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Sei</title></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:2em;text-align:center;background:#111;color:#eee">` +
  `<h2>${title}</h2><p>${body}</p><script>setTimeout(function(){window.close()},400)</script></body></html>`;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const addr = server.address();
      if (!addr || typeof addr === 'string') reject(new Error('unexpected server address'));
      else resolve(addr.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function sameState(got: string | null, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startCallbackListener(
  expectedState: string,
  preferredPort: number = CHATGPT_PREFERRED_PORT,
): Promise<CallbackListener> {
  if (!expectedState) throw new Error('expected state required');
  let server = createServer();
  let port: number;
  try {
    port = await listen(server, preferredPort);
  } catch {
    server.close();
    server = createServer();
    port = await listen(server, 0); // throws to the caller: no port at all
  }

  let settle: ((q: URLSearchParams) => void) | null = null;
  let received: URLSearchParams | null = null;
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== CHATGPT_CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    if (!sameState(url.searchParams.get('state'), expectedState)) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE('This sign-in link is out of date.', 'Return to Sei and use the newest sign-in window.'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (received) {
      res.end(PAGE('You can close this tab.', 'Sei already has this sign-in.'));
      return;
    }
    received = url.searchParams;
    const denied = url.searchParams.has('error');
    res.end(
      denied
        ? PAGE('Sign-in cancelled.', 'You can close this tab and return to Sei.')
        : PAGE('You can close this tab.', 'Returning to Sei.'),
    );
    settle?.(url.searchParams);
  });

  return {
    port,
    redirectUri: callbackUri(port),
    wait(timeoutMs, signal) {
      return new Promise<URLSearchParams>((resolve, reject) => {
        if (received) return resolve(received);
        if (signal.aborted) return reject(new Error('aborted'));
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('timeout'));
        }, timeoutMs);
        const onAbort = (): void => {
          cleanup();
          reject(new Error('aborted'));
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          settle = null;
        };
        signal.addEventListener('abort', onAbort, { once: true });
        settle = (q) => {
          cleanup();
          resolve(q);
        };
      });
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}




