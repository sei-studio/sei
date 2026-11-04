import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createLineReader, encodeLine, hostPipePath } from './protocol';

describe('seilink host wire protocol', () => {
  it('reassembles lines split across chunks and skips bad ones', () => {
    const got: unknown[] = [];
    const feed = createLineReader((m) => got.push(m));
    const a = encodeLine({ type: 'set-fps', fps: 30 });
    const b = encodeLine({ type: 'quit' });
    feed(a.slice(0, 5));
    feed(a.slice(5) + 'not json\n{"no":"type"}\n' + b.slice(0, 3));
    feed(b.slice(3));
    expect(got).toEqual([{ type: 'set-fps', fps: 30 }, { type: 'quit' }]);
  });

  it('drops a runaway line instead of growing forever', () => {
    const got: unknown[] = [];
    const feed = createLineReader((m) => got.push(m), 16);
    feed('x'.repeat(40));
    feed('\n' + encodeLine({ type: 'quit' }));
    expect(got).toEqual([{ type: 'quit' }]);
  });

  it('names a pipe per main process', () => {
    expect(hostPipePath('win32', 42, 'C:\\tmp', path.win32.join)).toBe('\\\\.\\pipe\\sei-seilink-42');
    expect(hostPipePath('darwin', 42, '/tmp', path.posix.join)).toBe('/tmp/sei-seilink-42.sock');
  });
});
