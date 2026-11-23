#!/usr/bin/env node
/**
 * Credit-wall test stub (261120). A local stand-in for the Sei proxy that
 * answers every LLM call with the proxy's real "allowance spent" reply
 * (402 {"error":"payment_required"}) and passes every other request through
 * to the real proxy unchanged, so a signed-in cloud account can see the wall
 * (HardStopModal, the OS notification, the bot leaving the world) without
 * spending anything or touching the account's data.
 *
 *   node scripts/cap-wall-stub.mjs            # listens on 127.0.0.1:8788
 *   SEI_PROXY_URL=http://127.0.0.1:8788 <Sei binary>
 *
 * macOS:   SEI_PROXY_URL=http://127.0.0.1:8788 /Applications/Sei.app/Contents/MacOS/Sei
 * Windows: set SEI_PROXY_URL=http://127.0.0.1:8788 && "%LOCALAPPDATA%\Programs\Sei\Sei.exe"
 *          (or the Velopack install path)
 *
 * Options (env): PORT (8788), UPSTREAM (https://api.sei.gg),
 * WALL_AFTER (0): let this many LLM calls through before the wall, to hit it
 * mid-session instead of on the first turn.
 * Logs method + path + status only, never headers or bodies (the requests
 * carry the account's access token).
 */
import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT) || 8788;
const UPSTREAM = new URL(process.env.UPSTREAM || 'https://api.sei.gg');
let passBeforeWall = Number(process.env.WALL_AFTER) || 0;

/** The routes that run a model turn (chat, call, games, bot, vision). */
function isLlmCall(method, path) {
  return method === 'POST' && /^\/(vision\/)?v1\/messages(\?|$)/.test(path);
}

const server = http.createServer((req, res) => {
  const path = req.url || '/';
  if (isLlmCall(req.method, path)) {
    if (passBeforeWall > 0) {
      passBeforeWall -= 1;
    } else {
      req.resume();
      const body = JSON.stringify({ error: 'payment_required' });
      res.writeHead(402, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      console.log(`${new Date().toISOString()} ${req.method} ${path} -> 402 (stub wall)`);
      return;
    }
  }
  const headers = { ...req.headers, host: UPSTREAM.host };
  const up = https.request(
    { protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, method: req.method, path, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${upRes.statusCode} (upstream)`);
    },
  );
  up.on('error', (err) => {
    console.log(`${new Date().toISOString()} ${req.method} ${path} -> upstream error ${err.code || err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cap-wall stub on http://127.0.0.1:${PORT} -> ${UPSTREAM.origin} (LLM calls answer 402 after ${passBeforeWall} pass)`);
});
