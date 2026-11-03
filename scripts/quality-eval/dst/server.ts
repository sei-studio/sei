// DST quality eval: the headless dedicated server (scripts/quality-eval/dst/).
//
// Starts ONE Master shard of the SeiTest cluster (single shard, offline,
// pause_when_empty=false; see native/dst-mod/sei/README.md) with the console
// on a pipe, so the driver types Lua into stdin and reads tagged print()
// lines back from stdout. The server is this process's child and is stopped
// by PID (SIGTERM, then SIGKILL), never by pattern.
//
// The mod under test is whatever ~/dst-server/mods/sei points at; the caller
// repoints that link before start (mods are indexed once, at server start).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DST_BIN = path.join(os.homedir(), 'dst-server', 'bin64');
const MOD_LINK = path.join(os.homedir(), 'dst-server', 'mods', 'sei');

export function pointModAt(modDir: string): string | null {
  let prev: string | null = null;
  try { if (lstatSync(MOD_LINK).isSymbolicLink()) prev = readlinkSync(MOD_LINK); } catch {}
  if (!existsSync(path.join(modDir, 'modinfo.lua'))) throw new Error(`no modinfo.lua in ${modDir}`);
  try { unlinkSync(MOD_LINK); } catch {}
  symlinkSync(modDir, MOD_LINK);
  return prev;
}

export interface DstServer {
  pid: number;
  /** Run one line of Lua in the server console. */
  con(lua: string): void;
  /** Resolve with the parsed JSON of the next `[tag] {...}` line (or null on timeout). */
  waitTagged(tag: string, ms: number, pred?: (o: any) => boolean): Promise<any | null>;
  onTagged(tag: string, fn: (o: any) => void): () => void;
  stop(): Promise<void>;
}

export async function startServer(opts: { cluster?: string; logPath: string; log?: (m: string) => void }): Promise<DstServer> {
  const log = opts.log ?? (() => {});
  const child: ChildProcess = spawn('./dontstarve_dedicated_server_nullrenderer_x64',
    ['-console', '-cluster', opts.cluster ?? 'SeiTest', '-shard', 'Master'],
    { cwd: DST_BIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const logOut = createWriteStream(opts.logPath, { flags: 'a' });
  const listeners = new Set<{ tag: string; fn: (o: any) => void }>();
  let buf = '';
  const onData = (chunk: Buffer) => {
    logOut.write(chunk);
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /\[(qe[\w-]*)\] (\{.*\})\s*$/.exec(ln);
      if (!m) continue;
      let o: any;
      try { o = JSON.parse(m[2]); } catch { continue; }
      for (const l of [...listeners]) if (l.tag === m[1]) { try { l.fn(o); } catch {} }
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', (c: Buffer) => logOut.write(c));
  let exited = false;
  child.on('exit', (code, sig) => { exited = true; log(`server exited code=${code} sig=${sig}`); });

  const srv: DstServer = {
    pid: child.pid!,
    con(lua) {
      if (exited) throw new Error('DST server is not running');
      child.stdin!.write(lua.replace(/\s*\n\s*/g, ' ') + '\n');
    },
    onTagged(tag, fn) {
      const l = { tag, fn };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    waitTagged(tag, ms, pred) {
      return new Promise((resolve) => {
        const off = srv.onTagged(tag, (o) => { if (!pred || pred(o)) { off(); clearTimeout(t); resolve(o); } });
        const t = setTimeout(() => { off(); resolve(null); }, ms);
      });
    },
    async stop() {
      if (exited) return;
      try { child.stdin!.write('c_shutdown(false)\n'); } catch {}
      const t0 = Date.now();
      while (!exited && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 250));
      if (!exited) { try { process.kill(child.pid!, 'SIGTERM'); } catch {} }
      const t1 = Date.now();
      while (!exited && Date.now() - t1 < 5_000) await new Promise((r) => setTimeout(r, 250));
      if (!exited) { try { process.kill(child.pid!, 'SIGKILL'); } catch {} }
      logOut.end();
    },
  };

  // Ready = the console answers.
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    if (exited) throw new Error('DST server exited during boot');
    try { srv.con('print("[qe-ready] {\\"ok\\":true}")'); } catch {}
    const r = await srv.waitTagged('qe-ready', 3000);
    if (r) { log(`server ready in ${((Date.now() - t0) / 1000).toFixed(0)}s (pid ${child.pid})`); return srv; }
  }
  await srv.stop();
  throw new Error('DST server did not become ready in 240 s');
}
