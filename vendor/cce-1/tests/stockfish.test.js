/**
 * The bundled emscripten glue, under Node, installs a fake XMLHttpRequest and
 * nulls the GLOBAL fetch so its own wasm loader takes the XHR/fs path. Both
 * leaks broke the host app once (every API client constructed after a chess
 * game started got fetch=null and failed with opaque connection errors), so
 * the loader snapshots and restores them. This test pins that behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('engine init does not clobber global fetch or leak XMLHttpRequest', async () => {
  const fetchBefore = globalThis.fetch;
  const hadXhr = 'XMLHttpRequest' in globalThis;
  assert.equal(typeof fetchBefore, 'function', 'test precondition: node exposes global fetch');

  const { StockfishEngine } = await import('../src/stockfish.js');
  const sf = await StockfishEngine.create();
  try {
    assert.equal(typeof globalThis.fetch, 'function', 'global fetch survives engine init');
    if (!hadXhr) {
      assert.equal('XMLHttpRequest' in globalThis, false, 'no leaked XMLHttpRequest shim');
    }
    // The engine still works after the globals are restored.
    const lines = await sf.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
      multipv: 1,
      depth: 4,
    });
    assert.ok(lines.length >= 1 && lines[0].uci.length >= 4);
  } finally {
    sf.dispose();
  }
});
