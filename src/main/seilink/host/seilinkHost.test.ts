/**
 * seilinkHost.ts start / stop / restore ordering, with the real pipe server
 * and a fake host process that connects to it, says hello and quits when
 * told to. Everything else (config, rooms, characters, the addon) is stubbed.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'seilink-host-test-'));
const SUI = '0b9e7a62-3c1f-4d7e-9a55-2f4c8d1e6b10';
const LYRA = '1c8f6b73-4d2e-4e8f-8b66-3e5d9f2a7c21';

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  characters: new Set<string>(),
  hosts: [] as Array<{ pid: number; pipe: string; alive: boolean }>,
  resident: null as string | null,
  /** Lines a fake host sends after its hello (261105 analytics test). */
  script: [] as Array<Record<string, unknown>>,
  events: [] as Array<[string, Record<string, unknown>]>,
  /** Every message the fake hosts got from main (261105 face test). */
  received: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmp,
    getAppPath: () => tmp,
    commandLine: { hasSwitch: () => false },
  },
}));

let nextPid = 9_000_001;
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: vi.fn(),
    spawn: vi.fn((_exe: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null };
      child.pid = nextPid++;
      child.exitCode = null;
      const pipe = argv.find((a) => a.startsWith('--seilink-ipc='))!.slice('--seilink-ipc='.length);
      const rec = { pid: child.pid, pipe, alive: true };
      state.hosts.push(rec);
      const exit = (): void => {
        if (!rec.alive) return;
        rec.alive = false;
        child.exitCode = 0;
        child.emit('exit', 0, null);
      };
      setImmediate(() => {
        const sock = net.connect(pipe);
        sock.on('error', () => exit());
        sock.setEncoding('utf8');
        sock.write(JSON.stringify({ type: 'hello', pid: child.pid, token: opts.env.SEI_SEILINK_TOKEN }) + '\n');
        for (const m of state.script) sock.write(JSON.stringify(m) + '\n');
        sock.on('data', (chunk: string) => {
          for (const line of chunk.split('\n').filter(Boolean)) {
            const m = JSON.parse(line) as { type: string; seq?: number };
            state.received.push(m);
            if (m.type === 'quit') {
              sock.end();
              setImmediate(exit);
            } else if (m.type === 'ping') sock.write(JSON.stringify({ type: 'pong', seq: m.seq }) + '\n');
          }
        });
        sock.on('close', () => setImmediate(exit));
      });
      return child;
    }),
  };
});

vi.mock('./native', () => ({ addonAvailability: () => ({ ok: true }) }));
vi.mock('../gate', () => ({
  seilinkEnabled: () => true,
  seilinkAvailability: () => ({ supported: true, setting: true, enabled: true, dev: false }),
  setSeilinkSetting: () => {},
  setSeilinkResident: (id: string | null) => {
    state.resident = id;
  },
}));
vi.mock('../packs', () => ({ loadPack: async () => null }));
vi.mock('../../characterStore', () => ({
  getCharacter: async (id: string) => (state.characters.has(id) ? { id, name: 'Her', portrait_image: null } : null),
}));
vi.mock('../../paths', () => ({ paths: { portraitPath: (u: string) => path.join(tmp, `${u}.png`) } }));
vi.mock('../../facepack/facepackDev', () => ({ facesEnabled: () => false }));
vi.mock('../../facepack/facepackStore', () => ({
  packFilePath: () => null,
  packIdForCharacterName: () => null,
  readPackManifest: async () => null,
}));
vi.mock('../roomStore', () => ({
  getRoomPayload: async (id: string) => ({ characterId: id, state: { preset: 'cozy' }, pack: null, saved: true }),
  isRoomCharacterId: (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id),
  onRoomChange: () => () => {},
}));
vi.mock('../../configStore', () => ({
  loadConfig: async () => ({ ...state.config }),
  updateConfig: async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    // A config write takes a moment (the window a double click raced through).
    await new Promise((r) => setTimeout(r, 5));
    state.config = fn({ ...state.config });
    return state.config;
  },
}));
vi.mock('../../lazyAnalytics', () => ({
  loadAnalytics: async () => ({ capture: (e: string, p: Record<string, unknown>) => state.events.push([e, p]) }),
}));
vi.mock('../../profile/scopeBarrier', () => ({ beginSessionStart: () => ({ stillValid: () => true }) }));

const host = await import('./seilinkHost');

const live = (): Array<{ pid: number; pipe: string }> => state.hosts.filter((h) => h.alive);

async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('seilink host start / stop / restore', () => {
  beforeEach(() => {
    state.config = { seilink_enabled: true };
    state.characters = new Set([SUI, LYRA]);
    state.hosts = [];
    state.script = [];
    state.events = [];
    state.received = [];
    host.initSeilinkHost({ pushStatus: () => {}, openChat: () => {} });
  });
  afterEach(async () => {
    await host.stopSeilinkHost('user_stop');
    await settle(20);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('a double click starts one host, not two', async () => {
    const [a, b] = await Promise.all([host.startSeilinkHost(SUI), host.startSeilinkHost(SUI)]);
    await settle();
    expect(state.hosts).toHaveLength(1);
    expect(a.characterId).toBe(SUI);
    expect(b.characterId).toBe(SUI);
    expect(host.seilinkHostStatus().state).not.toBe('failed');
  });

  it('a move-in during the startup restore runs after it, ending the restored session cleanly', async () => {
    state.config = { seilink_enabled: true, seilink_moved_in: { character_id: SUI, moved_in_at: 1 } };
    const restore = host.restoreSeilinkHost();
    const start = host.startSeilinkHost(LYRA);
    await Promise.all([restore, start]);
    await settle();
    expect(state.hosts).toHaveLength(2);
    // Sui's host was told to quit, and her pipe is gone; Lyra's is the only one left.
    expect(live()).toHaveLength(1);
    const [first, second] = state.hosts;
    expect(first.pipe).not.toBe(second.pipe);
    expect(live()[0].pid).toBe(second.pid);
    if (process.platform !== 'win32') {
      expect(existsSync(first.pipe)).toBe(false);
      expect(existsSync(second.pipe)).toBe(true);
    }
    expect(host.seilinkHostStatus().characterId).toBe(LYRA);
    // Only Lyra lives in the room now (the room line and look() follow this).
    expect(state.resident).toBe(LYRA);
    expect((state.config.seilink_moved_in as { character_id: string }).character_id).toBe(LYRA);
  });

  it('start then stop in quick succession ends with her moved out', async () => {
    await Promise.all([host.startSeilinkHost(SUI), host.stopSeilinkHost('user_stop')]);
    await settle();
    expect(live()).toHaveLength(0);
    expect(host.seilinkHostStatus().state).toBe('off');
    expect(state.resident).toBeNull();
    expect(state.config.seilink_moved_in ?? null).toBeNull();
  });

  it('restore checks she still exists: gone = move-in cleared, nothing started', async () => {
    state.config = { seilink_enabled: true, seilink_moved_in: { character_id: SUI, moved_in_at: 1 } };
    state.characters.delete(SUI);
    await host.restoreSeilinkHost();
    await settle();
    expect(state.hosts).toHaveLength(0);
    expect(state.config.seilink_moved_in).toBeNull();
    expect(host.seilinkHostStatus().state).toBe('off');
  });

  it('restore brings back a companion who still exists', async () => {
    state.config = { seilink_enabled: true, seilink_moved_in: { character_id: SUI, moved_in_at: 1 } };
    await host.restoreSeilinkHost();
    await settle();
    expect(live()).toHaveLength(1);
    expect(host.seilinkHostStatus().characterId).toBe(SUI);
  });

  it('261105: seilink_shown at the first verified frame, and the end event carries health and counts', async () => {
    const hb = { type: 'heartbeat', fps: 30, frames: 0, effectiveFps: 30, covered: false, paused: false, attached: true, cpu: 1, ramMB: 210 };
    state.script = [
      { type: 'facts', displays: 2, scale: 1.5, widthPx: 2560, heightPx: 1440, gpu: 'enabled', hwAccel: true },
      { type: 'attached', reattach: false, reason: 'initial', layout: 'raised', method: 'm', attachMs: 42 },
      { type: 'first-frame', sinceStartMs: 900, verified: true, hidden: false, covered: false, paused: false, reasons: [] },
      hb,
      { type: 'attached', reattach: true, reason: 'validate:taskbarCreated:no-workerw', layout: 'raised', attachMs: 7 },
      { type: 'click', kind: 'click' },
      { type: 'verify-failed', reasons: ['hidden'], trigger: 'timer' },
    ];
    const opened: string[] = [];
    host.initSeilinkHost({ pushStatus: () => {}, openChat: (id) => (opened.push(id), 'focused') });
    await host.startSeilinkHost(SUI);
    await settle();
    await host.stopSeilinkHost('user_stop');
    await settle(20);
    const by = (name: string): Record<string, unknown> | undefined => state.events.find(([e]) => e === name)?.[1];
    expect(by('seilink_shown')).toMatchObject({
      character_id: SUI,
      attach_mode: 'progman',
      attach_ms: 42,
      late: false,
      display_count: 2,
      scale_factor: 1.5,
      resolution: '1440p',
      gpu: 'on',
      hw_accel: true,
    });
    expect(by('seilink_reattached')).toMatchObject({ cause: 'explorer_restart', detail: 'workerw_lost', shown: true });
    expect(by('seilink_verify_failed')).toMatchObject({ reasons: 'hidden', trigger: 'timer' });
    expect(opened).toEqual([SUI]);
    const ended = by('seilink_ended');
    expect(ended).toMatchObject({ shown: true, clicks: 1, chat_open_focused: 1, reattaches: 1, reattach_explorer_restart: 1, verify_fail_hidden: 1, resolution: '1440p' });
    expect(typeof ended?.first_frame_ms).toBe('number');
    expect(by('seilink_not_shown')).toBeUndefined();
  });

  it('261105: a desktop line carries her face (tag first, else its words), counted as expressions', async () => {
    state.script = [{ type: 'attached', reattach: false, reason: 'initial', layout: 'raised', attachMs: 5 }];
    await host.startSeilinkHost(SUI);
    await settle();
    expect(host.sendSeilinkLine(LYRA, 'haha hi', 'poke')).toBeNull();
    expect(host.sendSeilinkLine(SUI, 'haha you found me', 'poke')).toEqual({ expression: 'lexicon' });
    expect(host.sendSeilinkLine(SUI, 'i moved the lamp', 'idle', 'smug')).toEqual({ expression: 'tag' });
    expect(host.sendSeilinkLine(SUI, 'i moved the lamp', 'idle')).toEqual({ expression: 'none' });
    await settle(50);
    const lines = state.received.filter((m) => m.type === 'line');
    expect(lines).toEqual([
      { type: 'line', text: 'haha you found me', kind: 'poke', emotion: 'happy', face: 'happy' },
      { type: 'line', text: 'i moved the lamp', kind: 'idle', emotion: 'happy', face: 'smug' },
      { type: 'line', text: 'i moved the lamp', kind: 'idle', emotion: null, face: null },
    ]);
    await host.stopSeilinkHost('user_stop');
    await settle(20);
    expect(state.events.find(([e]) => e === 'seilink_ended')?.[1]).toMatchObject({ expressions: 2 });
  });
});
