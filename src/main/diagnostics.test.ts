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
  bootPhaseProps,
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

describe('redact — provider keys and tokens (261031)', () => {
  // Fake keys in each provider's real shape and length.
  const KEYS: Array<[string, string]> = [
    ['OpenAI legacy', 'sk-' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(2) + 'kLmNoPqR'],
    ['OpenAI project', 'sk-proj-' + 'Ab12Cd34Ef56Gh78Ij90_Kl-Mn'.repeat(5)],
    ['Anthropic', 'sk-ant-api03-' + 'Zz9Yy8Xx7Ww6Vv5Uu4'.repeat(5) + '-AA'],
    ['Google', 'AIzaSyD' + '3fGhJkLmNoPqRsTuVwXyZ0123456789'],
    ['DeepSeek', 'sk-' + '0123456789abcdef0123456789abcdef'],
    ['OpenRouter', 'sk-or-v1-' + '0123456789abcdef'.repeat(4)],
    ['xAI', 'xai-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(2)],
    ['Groq', 'gsk_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ'.repeat(2)],
    ['ElevenLabs', 'sk_' + '0123456789abcdef'.repeat(3)],
  ];

  for (const [name, key] of KEYS) {
    it(`redacts a ${name} key inside a realistic error`, () => {
      const out = redact(
        `[sei/llm] request failed: 401 {"error":{"message":"Incorrect API key provided: ${key}. You can find your API key at https://platform.example.com/account/api-keys."}}`,
      );
      expect(out).not.toContain(key);
      expect(out).not.toContain(key.slice(-12));
      expect(out).toContain('Incorrect API key provided: [redacted]');
      expect(out).toContain('You can find your API key');
    });
  }

  it('redacts Bearer tokens that are not JWTs', () => {
    const out = redact('> GET /v1/models\n> Authorization: Bearer ollama-local-9f8e7d6c5b4a\n< 403 Forbidden');
    expect(out).toContain('Authorization: Bearer [redacted]');
    expect(out).not.toContain('9f8e7d6c5b4a');
  });

  it('redacts key=, api_key=, token= query and JSON values', () => {
    const out = redact(
      [
        'GET https://generativelanguage.googleapis.com/v1beta/models?key=abc123secretvalue&alt=sse failed',
        'POST /tts?api_key=el-legacy-0123456789abcdef0123456789abcdef&voice=x',
        'body: {"model":"x","api_key":"my local key","temperature":0.7}',
        "config: { token: 'tok_live_abcdef', retries: 3 }",
        'xi-api-key: 0123456789abcdef0123456789abcdef',
        'env OPENAI_API_KEY=whatever-it-is',
      ].join('\n'),
    );
    for (const secret of ['abc123secretvalue', 'el-legacy', 'my local key', 'tok_live_abcdef', '0123456789abcdef', 'whatever-it-is']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('?key=[redacted]&alt=sse failed');
    expect(out).toContain('"api_key":[redacted],"temperature":0.7');
    expect(out).toContain('retries: 3');
  });

  it('redacts a bare JWT (Supabase access token in a URL)', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhYmMiLCJlbWFpbCI6ImFAYi5jbyJ9.c2lnbmF0dXJlLXNpZw';
    const out = redact(`wss://api.sei.gg/realtime?access_token=${jwt}&vsn=1 closed 1006`);
    expect(out).not.toContain('eyJ');
    expect(out).toContain('closed 1006');
  });

  it('leaves our error sentinels readable', () => {
    const msg = 'LOCAL_NO_API_KEY: Local mode is on but no API key is saved. CHATGPT_TOKEN_TIMEOUT: main did not answer';
    expect(redact(msg)).toBe(msg);
  });

  it('leaves token counts and unrelated words alone', () => {
    const line = '[sei/llm] usage input_tokens=1234 output_tokens: 56 max_tokens=1024 tokens=99 monkey=3 task-queue-sk-1';
    expect(redact(line)).toBe(line);
  });
});

describe('redact — emails, IPs, usernames in paths (261031)', () => {
  it('redacts emails', () => {
    const out = redact('[sei/auth] refresh failed for shawn.test+sei@example.co.uk (session_rejected)');
    expect(out).toBe('[sei/auth] refresh failed for [email] (session_rejected)');
  });

  it('redacts LAN and public IPv4 addresses, keeps ports and loopback', () => {
    const out = redact(
      [
        '[sei] Connected to 192.168.1.23:52817 as Sui',
        'Error: connect ETIMEDOUT 10.0.0.5:25565',
        'Error: connect ECONNREFUSED 127.0.0.1:25565',
        'lan watcher: announce from /172.16.254.1 motd="New World"',
        'resolved api.sei.gg -> 203.0.113.77',
      ].join('\n'),
    );
    expect(out).toContain('Connected to [ip]:52817');
    expect(out).toContain('ETIMEDOUT [ip]:25565');
    expect(out).toContain('ECONNREFUSED 127.0.0.1:25565');
    expect(out).toContain('from /[ip] motd');
    expect(out).toContain('api.sei.gg -> [ip]');
    for (const ip of ['192.168.1.23', '10.0.0.5', '172.16.254.1', '203.0.113.77']) expect(out).not.toContain(ip);
  });

  it('redacts IPv6 addresses (link-local with zone, compressed, full), keeps ::1', () => {
    const out = redact(
      [
        'udp recv from fe80::1c2b:3d4e:5f60:7a8b%en0 port 4445',
        'connect EHOSTUNREACH [2001:db8::42]:25565',
        'peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 dropped',
        'bound [::1]:25565',
      ].join('\n'),
    );
    expect(out).toContain('udp recv from [ip] port 4445');
    expect(out).toContain('EHOSTUNREACH [[ip]]:25565');
    expect(out).toContain('peer [ip] dropped');
    expect(out).toContain('bound [::1]:25565');
    expect(out).not.toMatch(/fe80|2001:/);
  });

  it('redacts usernames in Windows and macOS paths, including JSON-escaped and forward-slash forms', () => {
    const out = redact(
      [
        'ENOENT: no such file, open \'C:\\Users\\Jane Doe\\AppData\\Roaming\\.minecraft\\logs\\latest.log\'',
        '{"path":"C:\\\\Users\\\\jdoe\\\\AppData\\\\Local\\\\Sei\\\\app.log"}',
        'at file:///C:/Users/jdoe/AppData/Local/Programs/Sei/resources/app.asar/out/main/index.js:10:5',
        'at /Users/jane.doe/Library/Application Support/minecraft/versions/1.21.1/1.21.1.json',
      ].join('\n'),
    );
    expect(out).not.toMatch(/jdoe|Jane|jane\.doe/);
    expect(out).toContain('~\\AppData\\Roaming\\.minecraft');
    expect(out).toContain('~\\\\AppData\\\\Local');
    expect(out).toContain('file:///~/AppData/Local/Programs/Sei');
    expect(out).toContain('~/Library/Application Support/minecraft/versions/1.21.1/1.21.1.json');
  });

  it("redacts this machine's account name outside a path", () => {
    const user = os.userInfo().username;
    if (user.length < 3) return;
    const out = redact(`spawn failed: EACCES (uid=501 user=${user})`);
    expect(out).toBe('spawn failed: EACCES (uid=501 user=[user])');
  });
});

describe('redact — Minecraft player names (261031)', () => {
  it('redacts names in vanilla server and chat log lines', () => {
    const out = redact(
      [
        '[12:01:02] [User Authenticator #1/INFO]: UUID of player Notch_2011 is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
        '[12:01:02] [Server thread/INFO]: Notch_2011[/192.168.1.40:51544] logged in with entity id 312 at (12.5, 64.0, -33.5)',
        '[12:01:02] [Server thread/INFO]: Notch_2011 joined the game',
        '[12:01:09] [Server thread/INFO]: <Notch_2011> come here',
        '[12:01:10] [Render thread/INFO]: [CHAT] <xX_Steve_Xx> lol',
        '[12:05:00] [Server thread/INFO]: Notch_2011 has made the advancement [Stone Age]',
        '[12:06:00] [Server thread/INFO]: xX_Steve_Xx lost connection: Disconnected',
        '[12:06:00] [Server thread/INFO]: xX_Steve_Xx left the game',
      ].join('\n'),
    );
    expect(out).not.toMatch(/Notch_2011|xX_Steve_Xx|069a79f4/);
    expect(out).toContain('UUID of player [player] is [uuid]');
    expect(out).toContain('[player][/[ip]:51544] logged in with entity id 312 at (12.5, 64.0, -33.5)');
    expect(out).toContain('[player] joined the game');
    expect(out).toContain('<[player]> come here');
    expect(out).toContain('[CHAT] <[player]> lol');
    expect(out).toContain('[player] has made the advancement [Stone Age]');
    expect(out).toContain('[player] lost connection: Disconnected');
    expect(out).toContain('[player] left the game');
  });

  it("redacts names in our bot's own key=value logs", () => {
    const out = redact(
      '[sei/session] start uuid=069a79f4-44e9-4726-a5be-fca90e38aaf5 username=Notch_2011 session_count=4 path=returning',
    );
    expect(out).toBe('[sei/session] start uuid=[uuid] username=[player] session_count=4 path=returning');
  });

  it("turns the bot's own name into [bot] and other names into [player]", () => {
    const out = redact(
      ['[sei] Connected to 192.168.1.23:52817 as Sui', '[Server thread/INFO]: Sui joined the game', '<Steve> hi Sui'].join('\n'),
      { botName: 'Sui' },
    );
    expect(out).toBe(['[sei] Connected to [ip]:52817 as [bot]', '[Server thread/INFO]: [bot] joined the game', '<[player]> hi [bot]'].join('\n'));
  });

  it('keeps stack-trace frames like <anonymous> intact', () => {
    const line = '    at Object.<anonymous> (~/x.js:1:1)\n    at new Promise (<anonymous>)';
    expect(redact(line)).toBe(line);
  });
});

describe('redact — negative cases and idempotence (261031)', () => {
  it('leaves versions, coordinates, timestamps and plumbing intact', () => {
    const text = [
      '[12:34:56.789] [act!] goto(x=-120, y=64, z=310.5) dist=12.25',
      'Minecraft 1.21.1 protocol 767, fabric-loader 0.16.5, node v20.18.1, electron 33.2.0',
      'version 1.20.4 detected; mineflayer@4.23.0 prismarine-chunk@1.36.0',
      '2026-10-31T12:34:56.789Z boot_spawn_ms=4512 exit code=1 signal=null',
      'chunk (12, -4) section 3 at 0x7ffd5e8c',
      'Error: Cannot find module \'./brain/fsm.js\' (node:internal/modules/cjs/loader:1228:15)',
    ].join('\n');
    expect(redact(text)).toBe(text);
  });

  it('is idempotent on an already-redacted tail', () => {
    const raw = [
      '<Steve> hi',
      'Steve joined the game',
      'UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
      'Authorization: Bearer abcdefghijkl',
      '{"api_key":"x y z"} key=abc',
      'from 192.168.0.2 and fe80::1 to a@b.io',
      'at C:\\Users\\bob\\x.js',
    ].join('\n');
    const once = redact(raw, { botName: 'Sui' });
    expect(redact(once)).toBe(once);
    expect(redact(once, { botName: 'Sui' })).toBe(once);
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

  it('caps error_message at ~2KB and tails at 2KB keeping the tail END', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({
        errorMessage: 'M'.repeat(5000),
        stderrTail: 'A'.repeat(10_000) + 'THE-CRASH-LINE',
        stdoutTail: 'B'.repeat(9_000) + 'LAST-STDOUT',
      }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect((diag.error_message as string).length).toBe(2048);
    expect((diag.stderr_tail as string).length).toBe(2048);
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

  it('scrubs names, IPs and keys from a realistic mid-session crash, keeps the crash line (261031)', () => {
    const stdout = [
      '[12:00:01.000] [log] [sei/session] start uuid=069a79f4-44e9-4726-a5be-fca90e38aaf5 username=Notch_2011 session_count=4',
      '[12:00:01.100] [log] [sei] Connected to 192.168.1.23:52817 as Lyra',
      '[12:00:05.000] [log] Notch_2011 joined the game',
      ...Array.from({ length: 60 }, (_, i) => `[12:00:${String(10 + (i % 50)).padStart(2, '0')}.000] [act!] goto(x=${i}, y=64, z=-${i})`),
      'TypeError: Cannot read properties of undefined (reading \'position\') at C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Sei\\bot.js:1:1',
    ].join('\n');
    const diag = buildSummonDiagnostic(
      baseInfo({
        phase: 'mid_session',
        botName: 'Lyra',
        errorMessage: 'Bot exited (code=1) groq said: invalid key gsk_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJ',
        stdoutTail: stdout,
      }),
      { lan: null, signedIn: false, packaged: true },
    );
    const tail = diag.stdout_tail as string;
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(tail).not.toMatch(/Notch_2011|Lyra|192\.168|Jane/);
    expect(tail).toMatch(/TypeError: Cannot read properties of undefined \(reading 'position'\) at ~\\AppData/);
    expect(diag.error_message).toBe('Bot exited (code=1) groq said: invalid key [redacted]');
  });

  it('defaults exit_code to null when absent', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({ exitCode: undefined }),
      { lan: null, signedIn: false, packaged: false },
    );
    expect(diag.exit_code).toBeNull();
  });
});

describe('buildSummonDiagnostic — reclassified_from (260929)', () => {
  it('ships reclassified_from only when the supervisor reclassified the failure', () => {
    const forgeLan: LanState = {
      kind: 'open',
      port: 55555,
      motd: 'Modded',
      lastSeenAt: 1,
      host: { client: 'forge', forgeModCount: 4 },
    };
    const diag = buildSummonDiagnostic(
      baseInfo({ phase: 'ready_timeout', errorClass: 'MODDED_HOST_REJECTED', reclassifiedFrom: 'BOT_START_TIMEOUT' }),
      { lan: forgeLan, signedIn: false, packaged: true },
    );
    expect(diag).toMatchObject({
      error_class: 'MODDED_HOST_REJECTED',
      summon_phase: 'ready_timeout',
      reclassified_from: 'BOT_START_TIMEOUT',
      host_client: 'forge',
      forge_mod_count: 4,
    });
    const plain = buildSummonDiagnostic(baseInfo(), { lan: null, signedIn: false, packaged: false });
    expect('reclassified_from' in plain).toBe(false);
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

// 260926: BOT_START_TIMEOUT breakdown. Flat per-phase props, ms since fork.
describe('bootPhaseProps', () => {
  const FORK = 1_000_000;

  it('flattens every stamped phase to ms since fork, plus fork setup and the last phase', () => {
    const props = bootPhaseProps({
      attemptStartMs: FORK - 250,
      forkAtMs: FORK,
      marks: {
        process_start: FORK + 400,
        modules_loaded: FORK + 6_000,
        init_received: FORK + 6_100,
        pack_loader_ready: FORK + 6_200,
        runtime_loaded: FORK + 21_000,
        booted: FORK + 21_300,
      },
    });
    expect(props).toEqual({
      boot_fork_ms: 250,
      boot_process_start_ms: 400,
      boot_modules_loaded_ms: 6_000,
      boot_init_received_ms: 6_100,
      boot_pack_loader_ready_ms: 6_200,
      boot_runtime_loaded_ms: 21_000,
      boot_booted_ms: 21_300,
      boot_last_phase: 'booted',
    });
  });

  it('picks the furthest phase by boot order, not by object key order', () => {
    const props = bootPhaseProps({
      attemptStartMs: FORK,
      forkAtMs: FORK,
      marks: { spawn: FORK + 30_000, process_start: FORK + 10, login: FORK + 29_000 },
    });
    expect(props.boot_last_phase).toBe('spawn');
  });

  it('reports a null last phase when the bot never stamped one', () => {
    const props = bootPhaseProps({ attemptStartMs: FORK, forkAtMs: FORK, marks: {} });
    expect(props).toEqual({ boot_fork_ms: 0, boot_last_phase: null });
  });

  it('drops malformed names and values, and clamps a pre-fork process_start to 0', () => {
    const props = bootPhaseProps({
      attemptStartMs: FORK,
      forkAtMs: FORK,
      marks: {
        process_start: FORK - 3,
        'Bad Name': FORK + 5,
        nan_value: Number.NaN,
        ['x'.repeat(40)]: FORK + 1,
      } as Record<string, number>,
    });
    expect(props).toEqual({ boot_fork_ms: 0, boot_process_start_ms: 0, boot_last_phase: 'process_start' });
  });

  it('buildSummonDiagnostic carries the breakdown and the boot_timeout phase', () => {
    const diag = buildSummonDiagnostic(
      baseInfo({
        phase: 'boot_timeout',
        errorClass: 'BOT_START_TIMEOUT',
        boot: {
          attemptStartMs: FORK,
          forkAtMs: FORK,
          marks: { process_start: FORK + 500, modules_loaded: FORK + 45_000 },
        },
      }),
      { lan: null, signedIn: true, packaged: true },
    );
    expect(diag).toMatchObject({
      summon_phase: 'boot_timeout',
      boot_process_start_ms: 500,
      boot_modules_loaded_ms: 45_000,
      boot_last_phase: 'modules_loaded',
    });
  });

  it('buildSummonDiagnostic adds no boot props when there is no boot info (pre-gate)', () => {
    const diag = buildSummonDiagnostic(baseInfo({ phase: 'pre_gate' }), { lan: null, signedIn: true, packaged: true });
    expect(Object.keys(diag).some((k) => k.startsWith('boot_'))).toBe(false);
  });
});
