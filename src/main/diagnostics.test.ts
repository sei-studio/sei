/**
 * 260720 P0 failed-summon diagnostics — redaction, assembly, and log pruning.
 *
 * redact() is the load-bearing privacy gate for everything that leaves a user
 * machine through captureDiagnostic, so it is tested against the real leak
 * shapes: home paths inside stack traces, keys mid-line, JWT-shaped tokens,
 * and multi-line stdout tails carrying chat/prompt log blocks (including
 * blocks truncated at either edge of the rolling tail buffer).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, utimes, readdir, mkdir } from 'node:fs/promises';
import {
  redact,
  buildSummonDiagnostic,
  pruneLogsDir,
  type SummonFailureInfo,
} from './diagnostics';
import type { LanState } from '../shared/ipc';

const HOME = os.homedir();

function baseInfo(over: Partial<SummonFailureInfo> = {}): SummonFailureInfo {
  return {
    characterId: 'char-1',
    phase: 'fork',
    errorClass: 'BOT_CRASH',
    errorMessage: 'boom',
    exitCode: 1,
    stderrTail: '',
    stdoutTail: '',
    durationMs: 1234,
    backend: 'local',
    ...over,
  };
}

describe('redact — paths', () => {
  it('replaces the real home directory with ~ (including inside stack traces)', () => {
    const trace = [
      'Error: Cannot find module',
      `    at Object.<anonymous> (${HOME}/Library/Application Support/Sei/app.asar.unpacked/src/bot/index.js:12:3)`,
      `    at Module._load (node:internal/modules/cjs/loader:1000:12)`,
    ].join('\n');
    const out = redact(trace);
    expect(out).not.toContain(HOME);
    expect(out).toContain('~/Library/Application Support/Sei');
    expect(out).toContain('node:internal/modules'); // untouched
  });

  it('replaces other machines\' per-user roots (macOS, Linux, Windows)', () => {
    const out = redact(
      [
        'at /Users/alice/proj/x.js:1:1',
        'at /home/bob/.local/share/sei/y.js:2:2',
        'at C:\\Users\\carol\\AppData\\Roaming\\Sei\\z.js:3:3',
      ].join('\n'),
    );
    expect(out).not.toContain('alice');
    expect(out).not.toContain('bob');
    expect(out).not.toContain('carol');
    expect(out).toContain('~/proj/x.js');
    expect(out).toContain('~/.local/share/sei/y.js');
    expect(out).toContain('~\\AppData\\Roaming\\Sei\\z.js');
  });
});

describe('redact — secrets', () => {
  it('redacts sk-ant keys mid-line', () => {
    const out = redact('401 unauthorized: key sk-ant-api03-AbCdEf123456-XYZ was rejected upstream');
    expect(out).not.toContain('sk-ant');
    expect(out).toContain('key [redacted] was rejected');
  });

  it('redacts JWT-shaped eyJx.y.z tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redact(`Authorization: Bearer ${jwt} expired`);
    expect(out).not.toContain('eyJ');
    expect(out).toContain('Bearer [redacted] expired');
  });

  it('redacts a key embedded in a path segment', () => {
    const out = redact(`/Users/dave/.config/sk-ant-secret123`);
    expect(out).not.toContain('sk-ant-secret123');
    expect(out).not.toContain('dave');
  });
});

describe('redact — chat/prompt content stripping', () => {
  const block = (tag: string, body: string[]): string =>
    [`[12:34:56.789] [${tag}] begin`, ...body, `[12:34:56.789] [${tag}] end`].join('\n');

  it('strips a complete chat block, keeps surrounding plumbing lines', () => {
    const text = [
      '[12:34:56.789] [log] session start',
      block('chat<-', ['  from: Player', '  message: my secret plans']),
      'Error: connect ECONNREFUSED 127.0.0.1:55555',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('my secret plans');
    expect(out).toContain('[chat/prompt content stripped]');
    expect(out).toContain('session start');
    expect(out).toContain('ECONNREFUSED');
  });

  it('strips prompt/response blocks ([haiku?] / [haiku!]) but keeps [act!] blocks', () => {
    const text = [
      block('haiku?', ['  system: You are Sui, a cheerful companion', '  user: the whole prompt']),
      block('haiku!', ['  text: private scratchpad reasoning']),
      block('act!', ['  name: goto', '  args: {"x":1,"y":2}']),
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('cheerful companion');
    expect(out).not.toContain('scratchpad reasoning');
    expect(out).toContain('name: goto');
    expect(out).toContain('[act!]');
  });

  it('strips a block truncated at the END of the tail (begin, no end)', () => {
    const text = [
      'Error: something broke',
      '[12:34:56.789] [chat->] begin',
      '  message: half a reply that got cut o',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('half a reply');
    expect(out).toContain('something broke');
  });

  it('strips leading lines before an orphan content end (tail cut mid-block)', () => {
    const text = [
      '  message continuation carrying chat text',
      '[12:34:56.789] [chat<-] end',
      'Error: real crash after the chat',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('chat text');
    expect(out).toContain('real crash after the chat');
  });

  it('strips single say/chat-tagged lines outside blocks', () => {
    const out = redact('[12:34:56.789] [say] hello player, secret stuff\nnormal line');
    expect(out).not.toContain('secret stuff');
    expect(out).toContain('normal line');
  });

  it('empty input is safe', () => {
    expect(redact('')).toBe('');
  });
});

describe('buildSummonDiagnostic', () => {
  const openLan: LanState = {
    kind: 'open',
    port: 55555,
    motd: 'My World',
    lastSeenAt: 1,
    host: { client: 'fabric', forgeModCount: null },
    versionName: '1.21.4',
    protocol: 769,
  };

  it('assembles the full payload with MC context from an open LAN state', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({ phase: 'connect', errorClass: 'BOT_CRASH', errorMessage: 'nope' }),
      { lan: openLan, signedIn: true, packaged: true },
    );
    expect(diag).toMatchObject({
      error_class: 'BOT_CRASH',
      error_message: 'nope',
      summon_phase: 'connect',
      exit_code: 1,
      duration_ms: 1234,
      backend: 'local',
      signed_in: true,
      mc_version: '1.21.4',
      mc_protocol: 769,
      host_client: 'fabric',
      forge_mod_count: null,
      packaged: true,
    });
    expect(diag.node_version).toBe(process.versions.node);
  });

  it('nulls MC context when no world is detected', () => {
    const diag = buildSummonDiagnostic(baseInfo(), { lan: { kind: 'closed' }, signedIn: false, packaged: false });
    expect(diag.mc_version).toBeNull();
    expect(diag.mc_protocol).toBeNull();
    expect(diag.host_client).toBeNull();
    expect(diag.forge_mod_count).toBeNull();
    const diag2 = buildSummonDiagnostic(baseInfo(), { lan: null, signedIn: false, packaged: false });
    expect(diag2.mc_version).toBeNull();
  });

  it('caps error_message at ~2KB and tails at 8KB keeping the tail END', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({
        errorMessage: 'M'.repeat(5000),
        stderrTail: 'A'.repeat(10_000) + 'THE-CRASH-LINE',
        stdoutTail: 'B'.repeat(9_000) + 'LAST-STDOUT',
      }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect((diag.error_message as string).length).toBe(2048);
    expect((diag.stderr_tail as string).length).toBe(8192);
    expect(diag.stderr_tail as string).toMatch(/THE-CRASH-LINE$/);
    expect(diag.stdout_tail as string).toMatch(/LAST-STDOUT$/);
  });

  it('redacts message and tails (keys, home paths) before capping', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({
        errorMessage: `invalid key sk-ant-oops at ${HOME}/x.js`,
        stderrTail: `crash in ${HOME}/y.js with sk-ant-tail-key`,
      }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect(diag.error_message as string).not.toContain('sk-ant');
    expect(diag.error_message as string).not.toContain(HOME);
    expect(diag.stderr_tail as string).not.toContain('sk-ant');
    expect(diag.stderr_tail as string).not.toContain(HOME);
    expect(diag.exit_code).toBe(1);
  });

  it('defaults exit_code to null when absent', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({ exitCode: undefined }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect(diag.exit_code).toBeNull();
  });
});

describe('buildSummonDiagnostic — phase-aware user-environment slimming', () => {
  const openLan: LanState = {
    kind: 'open',
    port: 55555,
    motd: 'My World',
    lastSeenAt: 1,
    host: { client: 'vanilla', forgeModCount: null },
    versionName: '1.22.1',
    protocol: 900,
  };

  const heavyInfo = (over: Partial<SummonFailureInfo>): SummonFailureInfo =>
    baseInfo({
      errorMessage: 'heavy human-readable text',
      stderrTail: 'stderr noise from the child process',
      stdoutTail: 'stdout noise from the child process',
      ...over,
    });

  const expectSlim = (diag: Record<string, unknown>): void => {
    // Heavy text payload absent entirely (not just empty).
    expect('error_message' in diag).toBe(false);
    expect('stderr_tail' in diag).toBe(false);
    expect('stdout_tail' in diag).toBe(false);
  };

  const expectFull = (diag: Record<string, unknown>): void => {
    expect(diag.error_message).toBe('heavy human-readable text');
    expect(diag.stderr_tail).toBe('stderr noise from the child process');
    expect(diag.stdout_tail).toBe('stdout noise from the child process');
  };

  it('LAN_NOT_OPEN at pre_gate (no world detected) is slim, cheap context intact', () => {
    const diag = buildSummonDiagnostic(
      heavyInfo({ phase: 'pre_gate', errorClass: 'LAN_NOT_OPEN' }),
      { lan: { kind: 'closed' }, signedIn: true, packaged: true },
    );
    expectSlim(diag);
    // Cheap context intact for funnel counting.
    expect(diag).toMatchObject({
      error_class: 'LAN_NOT_OPEN',
      summon_phase: 'pre_gate',
      duration_ms: 1234,
      backend: 'local',
      packaged: true,
    });
    expect(diag.node_version).toBe(process.versions.node);
  });

  it('LAN_NOT_OPEN at connect (world announced but unjoinable) ships the full payload', () => {
    const diag = buildSummonDiagnostic(
      heavyInfo({ phase: 'connect', errorClass: 'LAN_NOT_OPEN' }),
      { lan: openLan, signedIn: true, packaged: true },
    );
    expectFull(diag);
    expect(diag.mc_version).toBe('1.22.1');
  });

  it('LAN_NOT_OPEN at mid_session ships the full payload', () => {
    const diag = buildSummonDiagnostic(
      heavyInfo({ phase: 'mid_session', errorClass: 'LAN_NOT_OPEN' }),
      { lan: openLan, signedIn: true, packaged: true },
    );
    expectFull(diag);
  });

  for (const phase of ['fork', 'ready_timeout'] as const) {
    it(`LAN_NOT_OPEN at ${phase} ships the full payload`, () => {
      const diag = buildSummonDiagnostic(
        heavyInfo({ phase, errorClass: 'LAN_NOT_OPEN' }),
        { lan: openLan, signedIn: true, packaged: true },
      );
      expectFull(diag);
    });
  }

  it('UNSUPPORTED_MC_VERSION at connect stays slim (slim at every phase)', () => {
    const diag = buildSummonDiagnostic(
      heavyInfo({ phase: 'connect', errorClass: 'UNSUPPORTED_MC_VERSION' }),
      { lan: openLan, signedIn: true, packaged: true },
    );
    expectSlim(diag);
    expect(diag).toMatchObject({
      error_class: 'UNSUPPORTED_MC_VERSION',
      summon_phase: 'connect',
      mc_version: '1.22.1',
      mc_protocol: 900,
      host_client: 'vanilla',
    });
  });

  it('UNSUPPORTED_MC_VERSION at pre_gate stays slim', () => {
    const diag = buildSummonDiagnostic(
      heavyInfo({ phase: 'pre_gate', errorClass: 'UNSUPPORTED_MC_VERSION' }),
      { lan: openLan, signedIn: false, packaged: false },
    );
    expectSlim(diag);
  });

  it('BOT_CRASH ships error_message and both tails', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({
        errorClass: 'BOT_CRASH',
        errorMessage: 'crash detail',
        stderrTail: 'stderr crash line',
        stdoutTail: 'stdout crash line',
      }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect(diag.error_message).toBe('crash detail');
    expect(diag.stderr_tail).toBe('stderr crash line');
    expect(diag.stdout_tail).toBe('stdout crash line');
  });
});

describe('pruneLogsDir', () => {
  async function mkLogs(dir: string, count: number, size = 10): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `char-${String(i).padStart(2, '0')}.log`;
      await writeFile(path.join(dir, name), 'x'.repeat(size));
      // Strictly increasing mtimes: file i is OLDER than file i+1.
      const t = new Date(Date.now() - (count - i) * 60_000);
      await utimes(path.join(dir, name), t, t);
      names.push(name);
    }
    return names;
  }

  it('keeps the newest maxFiles files and deletes the rest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sei-prune-'));
    await mkLogs(dir, 25);
    const { deleted } = await pruneLogsDir(dir, { maxFiles: 20 });
    expect(deleted).toBe(5);
    const left = (await readdir(dir)).sort();
    expect(left).toHaveLength(20);
    // The 5 OLDEST (00..04) are gone; newest survive.
    expect(left[0]).toBe('char-05.log');
    expect(left).toContain('char-24.log');
  });

  it('enforces the cumulative byte budget, newest kept first', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sei-prune-'));
    await mkLogs(dir, 5, 100); // 500 bytes total
    const { deleted } = await pruneLogsDir(dir, { maxFiles: 100, maxBytes: 250 });
    expect(deleted).toBe(3); // newest two fit in 250
    const left = (await readdir(dir)).sort();
    expect(left).toEqual(['char-03.log', 'char-04.log']);
  });

  it('always keeps the newest file even when it alone busts the budget', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sei-prune-'));
    await mkLogs(dir, 2, 1000);
    const { deleted } = await pruneLogsDir(dir, { maxFiles: 100, maxBytes: 500 });
    expect(deleted).toBe(1);
    const left = await readdir(dir);
    expect(left).toEqual(['char-01.log']);
  });

  it('ignores non-.log files and subdirectories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sei-prune-'));
    await mkLogs(dir, 3);
    await writeFile(path.join(dir, 'notes.txt'), 'keep me');
    await mkdir(path.join(dir, 'nested.log')); // dir with .log name — stat-guarded
    const { deleted } = await pruneLogsDir(dir, { maxFiles: 1 });
    expect(deleted).toBe(2);
    const left = (await readdir(dir)).sort();
    expect(left).toContain('notes.txt');
    expect(left).toContain('nested.log');
  });

  it('is a silent no-op on a missing directory', async () => {
    const { deleted } = await pruneLogsDir(path.join(os.tmpdir(), 'sei-prune-does-not-exist-xyz'));
    expect(deleted).toBe(0);
  });
});
