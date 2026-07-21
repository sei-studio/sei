/**
 * In-process Stockfish (WASM, lite single-threaded) with a small typed API.
 *
 * The engine build under ../engines/ is stockfish.js 18 lite-single
 * (GPL-3.0, see engines/Copying.txt); this loader is modeled on the
 * MIT-licensed loader that ships with the stockfish npm package.
 * Analyses run sequentially through an internal queue — one engine, one
 * search at a time, which is all CCE needs.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ENGINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines');
const ENGINE_JS = path.join(ENGINE_DIR, 'stockfish-18-lite-single.js');
const ENGINE_WASM = path.join(ENGINE_DIR, 'stockfish-18-lite-single.wasm');

export class StockfishEngine {
  constructor(engine) {
    this._engine = engine;
    this._queue = Promise.resolve();
    this._listener = null;
    engine.listener = (line) => this._listener?.(line);
  }

  static async create() {
    const INIT_ENGINE = require(ENGINE_JS);
    const engine = {
      locateFile: (p) => (p.endsWith('.wasm') ? ENGINE_WASM : path.join(ENGINE_DIR, p)),
    };
    // The emscripten glue, when it detects Node, installs a fake global
    // XMLHttpRequest and then assigns `fetch = null` so ITS wasm loader takes
    // the XHR/fs path. Both assignments leak PROCESS-WIDE and the null fetch
    // silently breaks every later fetch consumer in the host app (API SDKs,
    // auth clients report generic connection errors). Snapshot the globals and
    // put them back once the engine is up; the wasm is loaded exactly once,
    // during init, so the glue never needs its shims again.
    const realFetch = globalThis.fetch;
    const hadXhr = 'XMLHttpRequest' in globalThis;
    try {
      await INIT_ENGINE()(engine);
      // The wasm runtime signals readiness via _isReady on some builds.
      while (engine._isReady && !engine._isReady()) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      if (typeof realFetch === 'function' && globalThis.fetch == null) {
        globalThis.fetch = realFetch;
      }
      if (!hadXhr && 'XMLHttpRequest' in globalThis) {
        delete globalThis.XMLHttpRequest;
      }
    }
    const sf = new StockfishEngine(engine);
    await sf._command('uci', (line) => line === 'uciok');
    return sf;
  }

  _send(cmd) {
    this._engine.ccall('command', null, ['string'], [cmd], {
      async: /^go\b/.test(cmd),
    });
  }

  /** Send a command and collect lines until `done(line)` returns true. */
  _command(cmd, done) {
    const run = () =>
      new Promise((resolve) => {
        const lines = [];
        this._listener = (line) => {
          lines.push(line);
          if (done(line)) {
            this._listener = null;
            resolve(lines);
          }
        };
        this._send(cmd);
      });
    const result = this._queue.then(run);
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Queue a command that produces NO output (setoption, position). Waiting
   * for a reply line would deadlock the queue, so this only sends in order.
   */
  _post(cmd) {
    const result = this._queue.then(() => {
      this._send(cmd);
    });
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async setOption(name, value) {
    await this._post(`setoption name ${name} value ${value}`);
    // readyok fence so the option is applied before the next search.
    await this._command('isready', (l) => l === 'readyok');
  }

  /**
   * Analyze a position.
   * @param {string} fen
   * @param {object} opts
   * @param {number} [opts.multipv] number of principal variations (default 4)
   * @param {number} [opts.depth] search depth (default 12)
   * @returns {Promise<Array<{uci: string, cp: number|null, mate: number|null, pv: string[]}>>}
   *   best lines for the side to move, multipv order (best first). cp/mate
   *   are from the side to move's point of view, as UCI reports them.
   */
  async analyze(fen, { multipv = 4, depth = 12 } = {}) {
    await this.setOption('MultiPV', multipv);
    await this._post(`position fen ${fen}`);
    const lines = await this._command(`go depth ${depth}`, (l) => l.startsWith('bestmove'));

    /** @type {Map<number, {uci: string, cp: number|null, mate: number|null, pv: string[]}>} */
    const byPv = new Map();
    for (const line of lines) {
      const m = line.match(
        /^info .*\bmultipv (\d+) score (cp|mate) (-?\d+)\b.* pv (.+)$/,
      );
      if (!m) continue;
      const pv = m[4].split(' ');
      byPv.set(Number(m[1]), {
        uci: pv[0],
        cp: m[2] === 'cp' ? Number(m[3]) : null,
        mate: m[2] === 'mate' ? Number(m[3]) : null,
        pv,
      });
    }
    return [...byPv.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  /** Best move at a UCI_Elo-limited strength (calibration anchors). */
  async bestMoveAtElo(fen, elo, { movetimeMs = 100 } = {}) {
    await this.setOption('UCI_LimitStrength', 'true');
    await this.setOption('UCI_Elo', Math.max(1320, Math.min(3190, elo)));
    await this._post(`position fen ${fen}`);
    const lines = await this._command(`go movetime ${movetimeMs}`, (l) => l.startsWith('bestmove'));
    const best = lines.at(-1).split(' ')[1];
    await this.setOption('UCI_LimitStrength', 'false');
    return best;
  }

  /**
   * Best-effort teardown. The Emscripten runtime keeps the event loop
   * referenced even after `quit`, so a short-lived process (tests, scripts)
   * should exit explicitly (node --test --test-force-exit / process.exit)
   * rather than wait for the loop to drain. Long-lived hosts don't care.
   */
  dispose() {
    try {
      this._send('quit');
    } catch {
      /* engine already gone */
    }
  }
}
