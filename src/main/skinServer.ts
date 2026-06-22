/**
 * Loopback-only HTTP server that CustomSkinLoader (running inside the host's
 * Minecraft client) fetches persona skins from.
 *
 * Bind: 127.0.0.1 ONLY. NEVER bind 0.0.0.0 — that would expose persona skins
 * to the LAN AND trigger macOS / Windows firewall prompts the user doesn't
 * need to see. The literal '127.0.0.1' in `server.listen` is asserted by an
 * acceptance regex-anchored grep so a future edit can't accidentally widen
 * the bind.
 *
 * Port: a FIXED loopback port (SKIN_SERVER_PREFERRED_PORT) so the
 * CustomSkinLoader config URL stays stable across restarts. The host MC
 * client reads that config ONCE at its own launch; a stable port means it
 * never goes stale regardless of launch order (this is the whole fix for the
 * "skin shows as Steve after a Sei restart" class of bug). If the fixed port
 * is already taken we fall back to an OS-chosen ephemeral port (0) and rely
 * on the boot-time CSL config rewrite (index.ts port-drift block) to re-stamp
 * it. The bound port is exposed via `.port` / `.baseUrl` so the config writer
 * can stamp it into `customskinloader.json`.
 *
 * URL contract: GET `/skins/<username>.png` ONLY. The regex
 *   `^/skins/([A-Za-z0-9_]{1,16})\.png(\?.*)?$`
 * matches Minecraft's username constraints exactly and rejects any URL
 * containing `..`, `/`, or non-username characters — path-traversal cannot
 * resolve because the username goes through an in-memory persona lookup
 * (NEVER filesystem path concatenation).
 *
 * 404 strategy: returns a pre-baked transparent 1×1 PNG (with status 404 +
 * content-type image/png) for unknown usernames. Some CustomSkinLoader builds
 * retry on text/plain 404 bodies; a parseable empty PNG short-circuits the
 * retry loop.
 *
 * Sources:
 *   - CONTEXT.md §decisions "Skin serving: local HTTP, loopback only by default"
 *   - threat model: path traversal via /skins/... — mitigated by regex
 */
import http from 'node:http';
import { readSkinPng } from './skinStore';
import { listCharacters } from './characterStore';

/**
 * Preferred FIXED loopback port for the skin server. Mirrors the auth
 * loopback's fixed-port approach (54321) so the CustomSkinLoader config URL
 * is stable across restarts and the host MC client never reads a stale port.
 * 54322 sits adjacent to the auth port and clear of common dev-server ports
 * (3000/5173/8080). If it's already taken, createSkinServer falls back to an
 * OS-chosen ephemeral port (0).
 */
export const SKIN_SERVER_PREFERRED_PORT = 54322;

/**
 * Preferred FIXED loopback port for the DEV build (electron-vite, !app.isPackaged).
 * The dev and packaged builds run from separate userData dirs ("Sei Launcher Dev"
 * vs "Sei Launcher") but otherwise share this machine. If both tried to bind the
 * same SKIN_SERVER_PREFERRED_PORT, whichever launched second would lose the fixed
 * port and fall back to an unstable ephemeral one — and since both write the CSL
 * config of the SAME player MC install, their ports clobber each other and the
 * config goes stale (the bot renders as Steve). Giving dev its own adjacent fixed
 * port keeps the dev skin URL stable across restarts and isolated from a
 * concurrently-running packaged build. Falls back to ephemeral exactly like the
 * packaged port if 54323 is itself taken.
 */
export const SKIN_SERVER_DEV_PORT = 54323;

export interface SkinServer {
  /** Loopback base URL, e.g. 'http://127.0.0.1:54321'. Hand this to CustomSkinLoader's config. */
  baseUrl: string;
  /** OS-assigned bound port. */
  port: number;
  /** Graceful shutdown — wait for in-flight requests to drain. */
  stop: () => Promise<void>;
}

/**
 * Pre-baked 1×1 fully-transparent PNG. Returned (with status 404) for unknown
 * usernames so CustomSkinLoader retries don't spam the server.
 *
 * Validated at runtime via Task 2's acceptance criterion:
 *   b.slice(0,8).toString('hex') === '89504e470d0a1a0a'
 *
 * 70 bytes total (8 magic + IHDR + IDAT + IEND).
 */
const NOT_FOUND_PNG_TRANSPARENT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Bind `server` to `port` on 127.0.0.1. Resolves once listening; rejects with
 * the raw bind error (e.g. EADDRINUSE) so the caller can decide whether to
 * retry on a different port. After an 'error' the server stays closed and can
 * be re-`listen`ed, which is what the fixed→ephemeral fallback relies on.
 */
function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 127.0.0.1 ONLY. Never widen to 0.0.0.0 — that would expose persona
    // skins to the LAN AND trigger firewall prompts the user doesn't need.
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the loopback skin HTTP server. Resolves when the server is bound and
 * accepting connections.
 *
 * Bind strategy: try the FIXED preferred port first (stable URL → CSL config
 * never goes stale). If it's already in use, fall back to an OS-chosen
 * ephemeral port (0). Only rejects with a SKIN_SERVER_PORT_TAKEN-prefixed
 * error if BOTH the preferred port fails for a non-EADDRINUSE reason or the
 * ephemeral fallback can't bind either (extremely rare — only if the system
 * has literally zero free ephemeral ports).
 *
 * `args.port`, when provided, overrides the preferred port (tests / callers
 * that want an explicit port); the ephemeral fallback still applies.
 */
export async function createSkinServer(args: { port?: number } = {}): Promise<SkinServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '';
      // Strict URL shape. Anything else 404s with text/plain (no PNG body —
      // path-traversal attempts shouldn't get a valid image content-type back).
      const m = url.match(/^\/skins\/([A-Za-z0-9_]{1,16})\.png(\?.*)?$/);
      // CORS: the renderer (file://app:// origin) fetches these PNGs via
      // skinview3d's three.js texture loader. Without ACAO=* the canvas
      // texture upload taints / fails silently and the 3D preview shows a
      // blank model. CSL (Java side) ignores CORS — opening this header up
      // costs nothing on a loopback-only listener.
      const corsHeaders = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
      };
      if (req.method !== 'GET' || !m) {
        res.writeHead(404, { ...corsHeaders, 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const username = m[1];
      const png = await readSkinPng({ username, listCharacters });
      if (!png) {
        res.writeHead(404, { ...corsHeaders, 'content-type': 'image/png' });
        res.end(NOT_FOUND_PNG_TRANSPARENT);
        return;
      }
      res.writeHead(200, {
        ...corsHeaders,
        'content-type': 'image/png',
        'content-length': String(png.length),
        'cache-control': 'no-store',
      });
      res.end(png);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sei] skinServer request handler error:', err);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  const preferredPort = args.port ?? SKIN_SERVER_PREFERRED_PORT;
  try {
    await listenOn(server, preferredPort);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only fall back for "port already in use". Any other bind failure
    // (e.g. EACCES) is surfaced — retrying on a random port wouldn't help.
    if (code === 'EADDRINUSE' && preferredPort !== 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sei] skinServer: preferred port ${preferredPort} in use; ` +
          `falling back to an ephemeral port (CSL config will be re-stamped at boot)`,
      );
      try {
        await listenOn(server, 0);
      } catch (fallbackErr) {
        const fe = fallbackErr as NodeJS.ErrnoException;
        throw new Error(`SKIN_SERVER_PORT_TAKEN: ${fe.code ?? 'unknown'} ${fe.message}`);
      }
    } else {
      const e = err as NodeJS.ErrnoException;
      throw new Error(`SKIN_SERVER_PORT_TAKEN: ${e.code ?? 'unknown'} ${e.message}`);
    }
  }

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('SKIN_SERVER_PORT_TAKEN: server.address() returned unexpected shape');
  }
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
