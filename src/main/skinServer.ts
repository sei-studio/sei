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
 * Port: 0 (OS-chosen ephemeral). The bound port is exposed via `.port` /
 * `.baseUrl` so the wizard's CustomSkinLoader-config writer can stamp it
 * into `customskinloader.json` at install time.
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
 * Start the loopback skin HTTP server. Resolves when the server is bound and
 * accepting connections. Rejects with a SKIN_SERVER_PORT_TAKEN-prefixed error
 * if bind fails (extremely rare with port=0; only fires if the system has
 * literally zero free ephemeral ports).
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

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      const e = new Error(`SKIN_SERVER_PORT_TAKEN: ${err.code ?? 'unknown'} ${err.message}`);
      reject(e);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 127.0.0.1 ONLY. Never widen to 0.0.0.0 — that would expose persona
    // skins to the LAN AND trigger firewall prompts the user doesn't need.
    server.listen(args.port ?? 0, '127.0.0.1');
  });

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
