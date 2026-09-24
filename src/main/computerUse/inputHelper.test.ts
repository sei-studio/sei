import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isAbortError } from './abortable';
import { helperPath, MacInputHelper, type SpawnFn } from './inputHelper';

/** A fake helper process: records requests and lets the test reply. */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();
  const sent: Array<Record<string, unknown>> = [];
  let buf = '';
  stdin.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      sent.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 1,
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      ee.on(ev, cb);
      return child;
    },
    kill: () => {
      ee.emit('exit', null);
      return true;
    },
  };
  const send = (m: unknown) => stdout.write(JSON.stringify(m) + '\n');
  return { child, sent, send, exit: (code: number) => ee.emit('exit', code) };
}

async function started() {
  const f = fakeChild();
  const p = MacInputHelper.start('bin', { spawn: (() => f.child) as unknown as SpawnFn, readyTimeoutMs: 1000 });
  f.send({ event: 'ready', version: 1, pid: 42 });
  const h = await p;
  return { h, ...f };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('MacInputHelper protocol', () => {
  it('waits for ready and matches replies by id', async () => {
    const { h, sent, send } = await started();
    expect(h.ready).toMatchObject({ version: 1 });
    const a = h.displays();
    const b = h.frontmost();
    await tick();
    expect(sent.map((m) => m.cmd)).toEqual(['displays', 'frontmost']);
    send({ id: sent[1]!.id, ok: true, pid: 7, name: 'Safari' });
    send({ id: sent[0]!.id, ok: true, displays: [{ id: 1 }] });
    expect(await a).toEqual([{ id: 1 }]);
    expect(await b).toEqual({ pid: 7, name: 'Safari' });
  });

  it('rejects ok:false with the helper error', async () => {
    const { h, sent, send } = await started();
    const p = h.app(5);
    await tick();
    send({ id: sent[0]!.id, ok: false, error: 'no such pid' });
    await expect(p).rejects.toThrow('no such pid');
  });

  it('sends cancel and rejects at once when an act is aborted', async () => {
    const { h, sent } = await started();
    const ctrl = new AbortController();
    const p = h.act({ cmd: 'hold', key: 'w', ms: 5000 }, ctrl.signal);
    await tick();
    ctrl.abort('stop');
    const err = await p.catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    await tick();
    expect(sent.map((m) => m.cmd)).toEqual(['hold', 'cancel']);
  });

  it('passes ax_dump / ax_focused / screenshot extras through', async () => {
    const { h, sent, send } = await started();
    const d = h.axDump(99, { maxNodes: 50 });
    const f = h.axFocused();
    const s = h.screenshot({ width: 10, height: 10, thumb: true, ocr: true });
    await tick();
    expect(sent[0]).toMatchObject({ cmd: 'ax_dump', pid: 99, maxNodes: 50 });
    expect(sent[2]).toMatchObject({ cmd: 'screenshot', thumb: true, ocr: true });
    send({ id: sent[0]!.id, ok: true, nodes: [{ depth: 0, parent: -1, role: 'AXWindow' }], ms: 3 });
    send({ id: sent[1]!.id, ok: true, element: {} });
    send({ id: sent[2]!.id, ok: true, data: 'x', width: 10, height: 10, rect: { x: 0, y: 0, w: 10, h: 10 }, displayId: 1, thumb: 'ab', ocr: [{ text: 'hi', confidence: 1, x: 0, y: 0, w: 1, h: 1 }] });
    expect(await d).toHaveLength(1);
    expect(await f).toBeNull();
    expect(await s).toMatchObject({ thumb: 'ab', ocr: [{ text: 'hi' }] });
  });

  it('delivers user_input events and rejects pending requests on exit', async () => {
    const { h, send, exit } = await started();
    const got: string[] = [];
    h.onUserInput((e) => got.push(e.kind));
    send({ event: 'user_input', kind: 'key', source: 'keyboard', ago: 0.01 });
    await tick();
    expect(got).toEqual(['key']);
    const p = h.windows();
    exit(1);
    await expect(p).rejects.toThrow(/exited/);
    expect(h.alive).toBe(false);
  });

  it('cancels an action that timed out, so it stops before the next one runs', async () => {
    const f = fakeChild();
    const p = MacInputHelper.start('bin', { spawn: (() => f.child) as unknown as SpawnFn, readyTimeoutMs: 1000, actTimeoutMs: 20 });
    f.send({ event: 'ready', version: 1, pid: 42 });
    const h = await p;
    const a = h.act({ cmd: 'type', text: 'a long line' }, new AbortController().signal);
    await expect(a).rejects.toThrow(/timed out/);
    await tick();
    expect(f.sent.map((m) => m.cmd)).toEqual(['type', 'cancel']);
  });

  it('resolves the packaged and dev paths', () => {
    expect(helperPath(true, '/R', '/A')).toBe('/R/mac-input/sei-mac-input');
    expect(helperPath(false, '/R', '/A')).toBe('/A/resources/mac-input/sei-mac-input');
  });
});
