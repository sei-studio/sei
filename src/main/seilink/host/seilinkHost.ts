/**
 * SeiLink desktop host service (261104, milestone 3), main side.
 *
 *   startSeilinkHost(characterId)  she moves in: her room becomes the live wallpaper
 *   stopSeilinkHost()              she moves out
 *   seilinkHostStatus()            SeilinkHostStatus (also pushed on every change)
 *
 * One companion at a time. The host is a separate process (hostEntry.ts),
 * spawned and restarted by HostSupervisor over a pipe this module serves.
 * Who moved in is saved as `seilink_moved_in` (main-owned UserConfig key)
 * and restored at app start and after an account switch (config.json is per
 * profile). Dev flag only for now (seilinkDevEnabled(): unpackaged with
 * SEI_SEILINK_PACKS); the dock and first-run milestone flips that.
 *
 * Analytics (shape only): seilink_started on the first attach of a session,
 * seilink_ended {duration_ms, character_id, reason, ...} at the single end
 * choke point (endSession), seilink_attach_failed {failure_class} once per
 * class per session. seilink_ended is deliberately NOT a playtime event
 * (a wallpaper runs for hours; see docs/agents/seilink-host.md).
 */
import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, rmSync, statSync, truncateSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HostSupervisor, type HostChild } from './supervisor';
import { createLineReader, encodeLine, hostPipePath, type FromHost, type ToHost } from './protocol';
import { seilinkHostArgv } from './hostArgs';
import { addonAvailability } from './native';
import {
  SEILINK_HOST_FPS,
  SEILINK_HOST_OFF,
  isSeilinkHostFailure,
  type SeilinkEndReason,
  type SeilinkHostFailure,
  type SeilinkHostStatus,
} from '../../../shared/seilinkHost';
import { loadPack, seilinkDevEnabled } from '../packs';
import { getRoomPayload, isRoomCharacterId, onRoomChange } from '../roomStore';
import { loadConfig, updateConfig } from '../../configStore';
import { loadAnalytics } from '../../lazyAnalytics';
import { beginSessionStart } from '../../profile/scopeBarrier';

export interface SeilinkHostDeps {
  /** Status to the main window. */
  pushStatus(status: SeilinkHostStatus): void;
  /** She was clicked: open (or focus) her chat in Sei. */
  openChat(characterId: string): void;
  /** Double click on her: reserved (the dock milestone). */
  onDoubleClick?(characterId: string): void;
}

/** Everything the host says, plus 'status' — the CI self-test (selfTest.ts) listens here. */
export const seilinkHostEvents = new EventEmitter();

const QUIT_GRACE_MS = 1500;
const HELLO_WINDOW_MS = 5000;
const BATTERY_FPS = 15;

interface Session {
  characterId: string;
  token: string;
  pipe: string;
  server: net.Server;
  supervisor: HostSupervisor;
  children: Map<number, ChildProcess>;
  conn: net.Socket | null;
  connPid: number | null;
  /** When she first attached (analytics duration), null before. */
  startedAt: number | null;
  restored: boolean;
  restarts: number;
  failuresSeen: Set<SeilinkHostFailure>;
  lastFailure: SeilinkHostFailure | null;
  unsubRoom: () => void;
  ending: boolean;
}

let deps: SeilinkHostDeps | null = null;
let session: Session | null = null;
let status: SeilinkHostStatus = { ...SEILINK_HOST_OFF };
let lastPushed = '';
let fpsCap = SEILINK_HOST_FPS;
let powerHooked = false;

function log(line: string): void {
  console.log(`[seilink] ${line}`);
}

export function initSeilinkHost(d: SeilinkHostDeps): void {
  deps = d;
  hookPower();
  // A packaged build without the flag, or an install without the addon, reports why up front.
  status = baseStatus();
}

export function seilinkHostStatus(): SeilinkHostStatus {
  return status;
}

function baseStatus(): SeilinkHostStatus {
  const a = availability();
  if (!a.ok) return { ...SEILINK_HOST_OFF, state: 'unsupported', failure: a.failure };
  return { ...SEILINK_HOST_OFF };
}

function availability(): ReturnType<typeof addonAvailability> {
  return addonAvailability({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
}

function setStatus(next: SeilinkHostStatus): void {
  status = next;
  const key = JSON.stringify(next);
  if (key === lastPushed) return;
  lastPushed = key;
  seilinkHostEvents.emit('status', next);
  try {
    deps?.pushStatus(next);
  } catch (err) {
    log(`status push failed: ${(err as Error).message}`);
  }
}

function patchStatus(p: Partial<SeilinkHostStatus>): void {
  setStatus({ ...status, ...p });
}

/** CI self-test hosts honour test-only commands; unpackaged only. */
function testMode(): boolean {
  return !app.isPackaged && !!process.env.SEI_SEILINK_SELFTEST;
}

function capture(event: string, props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((a) => a.capture(event, props))
    .catch(() => {
      /* analytics is optional */
    });
}

// ── Start / stop ────────────────────────────────────────────────────────────

/**
 * She moves in. Throws SEILINK_DISABLED (flag off), SEILINK_BAD_ID, ACCOUNT_SWITCHING.
 * An unsupported install returns the unsupported status instead of throwing.
 */
export async function startSeilinkHost(characterId: string, opts?: { restored?: boolean }): Promise<SeilinkHostStatus> {
  if (!seilinkDevEnabled()) throw new Error('SEILINK_DISABLED');
  if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
  const a = availability();
  if (!a.ok) {
    setStatus({ ...SEILINK_HOST_OFF, state: 'unsupported', failure: a.failure });
    return status;
  }
  if (session?.characterId === characterId && !session.ending) return status;
  const guard = beginSessionStart();
  if (session) await endSession('replaced');
  if (!guard.stillValid()) throw new Error('ACCOUNT_SWITCHING');
  if (!opts?.restored) {
    await updateConfig((c) => ({ ...c, seilink_moved_in: { character_id: characterId, moved_in_at: Date.now() } }));
  }
  if (!guard.stillValid()) throw new Error('ACCOUNT_SWITCHING');
  await openSession(characterId, opts?.restored === true);
  return status;
}

/** She moves out (the user's stop). Clears the saved move-in. */
export async function stopSeilinkHost(reason: SeilinkEndReason = 'user_stop'): Promise<SeilinkHostStatus> {
  if (session) await endSession(reason);
  if (reason === 'user_stop' || reason === 'disabled') {
    await updateConfig((c) => (c.seilink_moved_in ? { ...c, seilink_moved_in: null } : c)).catch((err) =>
      log(`clear moved-in failed: ${(err as Error).message}`),
    );
  }
  return status;
}

/** Account switch: end the session but keep the old profile's move-in (restored when it comes back). */
export function stopSeilinkHostForAccountSwitch(): Promise<void> {
  return session ? endSession('account_switch') : Promise.resolve();
}

/** App quit: synchronous enough for before-quit (the host also exits when the pipe closes). */
export function stopSeilinkHostForQuit(): void {
  if (session) void endSession('app_quit');
}

/** App start and after an account switch: bring back whoever moved in on this profile. */
export async function restoreSeilinkHost(): Promise<void> {
  if (!seilinkDevEnabled()) return;
  try {
    const cfg = await loadConfig();
    const id = cfg.seilink_moved_in?.character_id;
    if (!id) {
      if (session) await endSession('replaced');
      return;
    }
    await startSeilinkHost(id, { restored: true });
  } catch (err) {
    log(`restore failed: ${(err as Error).message}`);
  }
}

// ── Session ─────────────────────────────────────────────────────────────────

async function openSession(characterId: string, restored: boolean): Promise<void> {
  const token = randomBytes(16).toString('hex');
  const pipe = hostPipePath(process.platform, process.pid, os.tmpdir(), path.join);
  if (process.platform !== 'win32') rmSync(pipe, { force: true });
  const server = net.createServer((sock) => onConnection(s, sock));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const children = new Map<number, ChildProcess>();
  const supervisor = new HostSupervisor({
    spawn: (n) => spawnHost(s, n),
    kill: (pid) => killPid(pid),
    log,
  });
  const s: Session = {
    characterId,
    token,
    pipe,
    server,
    supervisor,
    children,
    conn: null,
    connPid: null,
    startedAt: null,
    restored,
    restarts: 0,
    failuresSeen: new Set(),
    lastFailure: null,
    unsubRoom: onRoomChange((id) => {
      if (session === s && id === s.characterId) void sendRoom(s);
    }),
    ending: false,
  };
  session = s;
  supervisor.on('message', (m: FromHost) => onHostMessage(s, m));
  supervisor.on('restart', (e: { reason: string }) => {
    s.restarts++;
    if (session === s) patchStatus({ state: 'restarting' });
    seilinkHostEvents.emit('restart', e);
  });
  supervisor.on('hung', (e) => {
    noteFailure(s, 'host_hung', false);
    seilinkHostEvents.emit('hung', e);
  });
  supervisor.on('spawn-failed', () => noteFailure(s, 'spawn_failed', false));
  supervisor.on('spawn', (e) => seilinkHostEvents.emit('spawn', e));
  supervisor.on('exit', (e) => seilinkHostEvents.emit('exit', e));
  supervisor.on('gave-up', () => {
    if (session !== s) return;
    const failure = s.lastFailure ?? 'crash_loop';
    void endSession('failed', failure);
  });
  setStatus({ state: 'starting', characterId, covered: false, paused: false, fps: 0 });
  log(`host starting for ${characterId}${restored ? ' (restored)' : ''}`);
  supervisor.start();
}

function spawnHost(s: Session, n: number): HostChild {
  const userData = path.join(app.getPath('userData'), 'SeiLinkHost');
  mkdirSync(userData, { recursive: true });
  const hostArgs = seilinkHostArgv({ ipc: s.pipe, userData, test: testMode() });
  // Packaged: the exe IS the app. Dev: electron + the app dir.
  const argv = app.isPackaged ? hostArgs : [app.getAppPath(), ...hostArgs];
  // Dev on Linux runs with --no-sandbox (no setuid chrome-sandbox); the host needs it too.
  if (!app.isPackaged && app.commandLine.hasSwitch('no-sandbox')) argv.push('--no-sandbox');
  const env: NodeJS.ProcessEnv = { ...process.env, SEI_SEILINK_TOKEN: s.token };
  delete env.ELECTRON_RUN_AS_NODE;
  const stdioFile = path.join(userData, 'stdio.log');
  try {
    if ((statSync(stdioFile, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) truncateSync(stdioFile, 0);
  } catch {
    /* ignore */
  }
  const fd = openSync(stdioFile, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, argv, { stdio: ['ignore', fd, fd], env, windowsHide: true });
  } finally {
    closeSync(fd);
  }
  if (!child.pid) {
    child.on('error', () => {});
    throw new Error('no pid');
  }
  const pid = child.pid;
  s.children.set(pid, child);
  return {
    pid,
    onExit: (cb) => {
      let done = false;
      const fire = (code: number | null, signal: string | null): void => {
        if (done) return;
        done = true;
        s.children.delete(pid);
        if (s.connPid === pid) {
          s.conn?.destroy();
          s.conn = null;
          s.connPid = null;
        }
        cb(code, signal);
      };
      child.once('exit', (code, signal) => fire(code, signal));
      child.once('error', () => fire(null, 'error'));
    },
  };
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    // /T: the host's GPU and renderer children too.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function onConnection(s: Session, sock: net.Socket): void {
  sock.setEncoding('utf8');
  let pid: number | null = null;
  const helloTimer = setTimeout(() => {
    if (pid === null) sock.destroy();
  }, HELLO_WINDOW_MS);
  sock.on(
    'data',
    createLineReader((raw) => {
      const m = raw as FromHost;
      if (pid === null) {
        if (m.type !== 'hello' || m.token !== s.token || session !== s || !s.supervisor.acceptHello(Number(m.pid))) {
          sock.destroy();
          return;
        }
        clearTimeout(helloTimer);
        pid = Number(m.pid);
        if (s.conn && s.conn !== sock) s.conn.destroy();
        s.conn = sock;
        s.connPid = pid;
        sendTo(s, { type: 'set-fps', fps: fpsCap });
        void sendRoom(s);
        return;
      }
      s.supervisor.onHostMessage(pid, m);
    }),
  );
  sock.on('close', () => {
    clearTimeout(helloTimer);
    if (s.conn === sock) {
      s.conn = null;
      s.connPid = null;
    }
  });
  sock.on('error', () => {});
}

function sendTo(s: Session, m: ToHost): void {
  if (s.conn && !s.conn.destroyed) s.conn.write(encodeLine(m));
}

/** For the CI self-test (selfTest.ts) only. */
export function sendToSeilinkHostForTest(m: ToHost): void {
  if (session) sendTo(session, m);
}

export function seilinkHostPidForTest(): number | null {
  return session?.supervisor.pid ?? null;
}

async function sendRoom(s: Session): Promise<void> {
  try {
    const payload = await getRoomPayload(s.characterId);
    const files: Array<[string, string]> = [];
    if (payload.pack) {
      const pack = await loadPack(payload.pack.id);
      if (pack) for (const [rel, real] of pack.files) files.push([rel, real]);
    }
    if (session === s) sendTo(s, { type: 'room', payload, files });
  } catch (err) {
    log(`room for host failed: ${(err as Error).message}`);
  }
}

function onHostMessage(s: Session, m: FromHost): void {
  if (session !== s) return;
  seilinkHostEvents.emit('message', m);
  switch (m.type) {
    case 'attached':
      patchStatus({ state: 'running', failure: undefined });
      if (s.startedAt === null) {
        s.startedAt = Date.now();
        capture('seilink_started', {
          character_id: s.characterId,
          layout: shapeLayout(m.layout),
          attach_ms: Math.round(Number(m.attachMs) || 0),
          restored: s.restored,
        });
      }
      break;
    case 'attach-failed': {
      const failure = isSeilinkHostFailure(m.failure) ? m.failure : 'attach_failed';
      noteFailure(s, failure, true);
      break;
    }
    case 'activity':
      patchStatus({ covered: m.covered, paused: m.paused, fps: m.fps === 0 ? 0 : status.fps });
      break;
    case 'heartbeat':
      patchStatus({ covered: m.covered, paused: m.paused, fps: Math.max(0, Math.round(m.effectiveFps)) });
      break;
    case 'click':
      if (m.kind === 'click') deps?.openChat(s.characterId);
      else if (m.kind === 'dblclick') deps?.onDoubleClick?.(s.characterId);
      break;
    case 'log':
      log(`host: ${m.msg}`);
      break;
  }
}

/** 'raised' | 'classic' | 'mac' | 'other' (never the OS build or window text). */
function shapeLayout(layout: unknown): string {
  const l = String(layout ?? '');
  if (l === 'raised' || l === 'classic') return l;
  if (l.startsWith('mac')) return 'mac';
  return 'other';
}

function noteFailure(s: Session, failure: SeilinkHostFailure, fromHost: boolean): void {
  if (session !== s) return;
  s.lastFailure = failure;
  if (!s.failuresSeen.has(failure)) {
    s.failuresSeen.add(failure);
    capture('seilink_attach_failed', {
      character_id: s.characterId,
      failure_class: failure,
      reattach: s.startedAt !== null,
      from_host: fromHost,
    });
  }
  // The host cannot get onto the desktop: recycle it (a fresh process, with backoff). A host
  // that keeps failing never attaches, so the supervisor gives up after HOST_MAX_FAILURES.
  if (fromHost) s.supervisor.recycle(failure);
}

/** The single end choke point: every stop path (user, replace, quit, account switch, failure) lands here. */
async function endSession(reason: SeilinkEndReason, failure?: SeilinkHostFailure): Promise<void> {
  const s = session;
  if (!s || s.ending) return;
  s.ending = true;
  session = null;
  s.unsubRoom();
  const live = s.supervisor.stop({ kill: false });
  sendTo(s, { type: 'quit' });
  capture('seilink_ended', {
    character_id: s.characterId,
    reason,
    duration_ms: s.startedAt === null ? 0 : Date.now() - s.startedAt,
    attached: s.startedAt !== null,
    restarts: s.restarts,
    ...(failure ? { failure_class: failure } : {}),
  });
  log(`host ended (${reason}${failure ? `, ${failure}` : ''})`);
  setStatus(failure ? { ...SEILINK_HOST_OFF, state: 'failed', failure } : baseStatus());
  if (live !== null) {
    const child = s.children.get(live);
    if (child && child.exitCode === null && reason !== 'app_quit') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          killPid(live);
          resolve();
        }, QUIT_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    } else if (reason === 'app_quit') {
      // Quit does not wait: the host also leaves when the pipe closes with main.
      setTimeout(() => killPid(live), QUIT_GRACE_MS).unref();
    }
  }
  s.conn?.destroy();
  s.server.close();
  if (process.platform !== 'win32') rmSync(s.pipe, { force: true });
}

// ── Power ───────────────────────────────────────────────────────────────────

function hookPower(): void {
  if (powerHooked) return;
  powerHooked = true;
  void import('electron')
    .then(({ powerMonitor }) => {
      const apply = (): void => {
        fpsCap = powerMonitor.isOnBatteryPower() ? BATTERY_FPS : SEILINK_HOST_FPS;
        if (session) sendTo(session, { type: 'set-fps', fps: fpsCap });
      };
      powerMonitor.on('on-battery', apply);
      powerMonitor.on('on-ac', apply);
      apply();
    })
    .catch(() => {
      /* vitest stub */
    });
}
