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
 * profile). Only where SeiLink can run (gate.ts: a supported install, or the
 * dev flag). There is no on/off setting since 261105 (the Labs toggle is gone).
 *
 * Analytics (shape only): seilink_started on the first attach of a session,
 * seilink_ended {duration_ms, character_id, reason, ...} at the single end
 * choke point (endSession), seilink_attach_failed {failure_class} once per
 * class per session. seilink_ended is deliberately NOT a playtime event
 * (a wallpaper runs for hours; see docs/agents/seilink-host.md).
 * M4: seilink_moved_in {character_id, swapped, preset, first_room, blank_room (261106)} when the
 * user moves someone in (not on a restore), seilink_moved_out
 * {character_id, via} when the user moves her out from the app or the dock.
 */
import { app, nativeTheme } from 'electron';
import { isBlankRoom, isPlainRoom } from '../../../shared/seilinkRoom';
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
  isSeilinkDockAction,
  isSeilinkHostAvatarMethod,
  isSeilinkHostFailure,
  type SeilinkEndReason,
  type SeilinkDockAction,
  type SeilinkDockOffer,
  type SeilinkHostFailure,
  type SeilinkHostStatus,
} from '../../../shared/seilinkHost';
import { loadPack } from '../packs';
import { seilinkEnabled, setSeilinkResident } from '../gate';
import { BusyTracker, onSeilinkAvatarChanged, onSeilinkChatTurn } from './hostSignals';
import { answerHostAvatarCall, hostPortrait, type HostAvatarStores } from './hostAvatarCalls';
import { getCharacter } from '../../characterStore';
import { paths } from '../../paths';
import { anima } from '../../anima/animaRuntime';
import { facepackIdForCharacter, packFilePath, readPackManifest } from '../../facepack/facepackStore';
import { getRoomPayload, isRoomCharacterId, onRoomChange } from '../roomStore';
import { loadConfig, updateConfig } from '../../configStore';
import { loadAnalytics } from '../../lazyAnalytics';
import { desktopLineFace, isFaceWord } from '../../../shared/seilinkExpression';
import {
  Counters,
  HEALTH_INTERVAL_MS,
  HealthSampler,
  REATTACH_EVENTS_PER_CAUSE,
  SHOWN_DEADLINE_MS,
  ShownWatchdog,
  gpuState,
  reattachCause,
  resolutionBucket,
  scaleBucket,
  verifyReasonList,
  type ReattachDetail,
  type WatchdogEmit,
} from './hostTelemetry';
import { beginSessionStart } from '../../profile/scopeBarrier';

export interface SeilinkHostDeps {
  /** Status to the main window. */
  pushStatus(status: SeilinkHostStatus): void;
  /**
   * She was clicked: open (or focus) her chat in Sei. 261105: returns how (analytics):
   * 'focused' (the window was there), 'reopened' / 'deferred' (mac: no window, one is made).
   */
  openChat(characterId: string): SeilinkChatOpen | void;
  /** Double click on her (M4: a poke, answered by desktopLines.ts). */
  onDoubleClick?(characterId: string): void;
  /** M4: the dock's "edit room": her room editor (261106: on the desktop, desktopStage.ts). */
  openRoomEditor?(characterId: string): void;
  /** 261106: an answer to the decorate-together offer on the dock (decorateOffer.ts). */
  onOfferAnswer?(characterId: string, answer: 'decorate' | 'later'): void;
  /** M4: the profile changed (SeilinkAvailability to the main window). */
  pushAvailability?(): void;
}

export type SeilinkChatOpen = 'focused' | 'reopened' | 'deferred';

/** Display and GPU facts the host reported (analytics only). */
interface HostFacts {
  displays: number;
  scale: number | null;
  resolution: string;
  gpu: 'on' | 'off' | 'unknown';
  hwAccel: boolean;
}

/** Everything the host says, plus 'status' — the CI self-test (selfTest.ts) listens here. */
export const seilinkHostEvents = new EventEmitter();

/** 261106: the plain background's colour follows the OS theme (the host page draws it from prefers-color-scheme). */
function osPlainTone(): 'dark' | 'light' | 'unknown' {
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch {
    return 'unknown';
  }
}

const QUIT_GRACE_MS = 1500;
const HELLO_WINDOW_MS = 5000;
const BATTERY_FPS = 15;
/** After her reply, she stays seated this long (the player is reading or typing). */
const CHAT_BUSY_HOLD_MS = 60_000;

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
  /** Drops the room, chat and avatar listeners. */
  unsub: () => void;
  /** The player is chatting with her (RoomAvatar holds her seated). */
  busy: BusyTracker;
  ending: boolean;
  // 261105 analytics (hostTelemetry.ts)
  openedAt: number;
  watchdog: ShownWatchdog;
  health: HealthSampler;
  counters: Counters;
  /** Counter values at the last seilink_health (its window is the difference). */
  healthSnap: Map<string, number>;
  facts: HostFacts | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** Why the live host went away, for the next attach (a host_restart re-attach). */
  restartDetail: ReattachDetail | null;
  /** seilink_verify_failed sent for these reason sets. */
  verifySeen: Set<string>;
  notShownReason: string | null;
  /** M4: her idle lines muted (config seilink_deafened), as last sent to the host. */
  deafened: boolean;
  /** 261106: the decorate-together offer on the dock. */
  offer: SeilinkDockOffer;
}

let deps: SeilinkHostDeps | null = null;
let session: Session | null = null;
let status: SeilinkHostStatus = { ...SEILINK_HOST_OFF };
let lastPushed = '';
let fpsCap = SEILINK_HOST_FPS;
let powerHooked = false;
/** Sessions opened by this main process: each gets its own pipe path. */
let sessionSeq = 0;
/** seilink_unavailable reasons already sent this app run. */
const unavailableSent = new Set<string>();
/** The tail of the start / stop / restore queue (see serial). */
let opChain: Promise<unknown> = Promise.resolve();

/**
 * Start, stop and restore run one at a time, in call order. Without this a
 * double click on "Move onto desktop", or a move-in during the startup
 * restore, ran two starts at once: two sessions, one leaking its pipe server
 * (and on Windows an EADDRINUSE that opened the move-in sheet by mistake).
 * The *Now functions below assume the queue is held and never re-enter it.
 */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

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
  seilinkHostEvents.emit('analytics', event, props);
  void loadAnalytics()
    .then((a) => a.capture(event, props))
    .catch(() => {
      /* analytics is optional */
    });
}

function factProps(f: HostFacts | null): Record<string, unknown> {
  if (!f) return {};
  return { display_count: f.displays, scale_factor: f.scale, resolution: f.resolution, gpu: f.gpu, hw_accel: f.hwAccel };
}

/** A ShownWatchdog verdict, with the session's facts. */
function emitWatchdog(s: Session, e: WatchdogEmit | null): void {
  if (!e) return;
  if (e.event === 'seilink_not_shown') s.notShownReason = String(e.props.reason);
  capture(e.event, {
    character_id: s.characterId,
    restored: s.restored,
    restarts: s.restarts,
    ...(s.lastFailure && e.event === 'seilink_not_shown' && !('failure_class' in e.props) ? { last_failure: s.lastFailure } : {}),
    ...e.props,
    ...factProps(s.facts),
  });
}

/** 261105: count something on the live session (desktopLines, power, clicks). No session: dropped. */
export function noteSeilinkCount(key: string, n = 1): void {
  if (session && !session.ending) session.counters.add(key, n);
}

/** The periodic health event: the window since the last one. */
function emitHealth(s: Session): void {
  const now = Date.now();
  const window = s.health.takeWindow(now);
  const counts = s.counters.diff(s.healthSnap);
  s.healthSnap = s.counters.snapshot();
  capture('seilink_health', {
    character_id: s.characterId,
    session_ms: now - s.openedAt,
    shown: s.watchdog.shown,
    ...window,
    ...counts,
    ...factProps(s.facts),
  });
}

// ── Start / stop ────────────────────────────────────────────────────────────

/**
 * She moves in. Throws SEILINK_DISABLED (flag off), SEILINK_BAD_ID, ACCOUNT_SWITCHING.
 * An unsupported install returns the unsupported status instead of throwing.
 */
export function startSeilinkHost(
  characterId: string,
  opts?: { restored?: boolean; /** The move-in sheet set up her first room. */ firstRoom?: boolean },
): Promise<SeilinkHostStatus> {
  return serial(() => startNow(characterId, opts));
}

async function startNow(
  characterId: string,
  opts?: { restored?: boolean; firstRoom?: boolean },
): Promise<SeilinkHostStatus> {
  if (!seilinkEnabled()) throw new Error('SEILINK_DISABLED');
  if (!isRoomCharacterId(characterId)) throw new Error('SEILINK_BAD_ID');
  const a = availability();
  if (!a.ok) {
    setStatus({ ...SEILINK_HOST_OFF, state: 'unsupported', failure: a.failure });
    // 261105: a move-in (or restore) that cannot run here, by reason, once per reason per app run.
    if (!unavailableSent.has(a.failure)) {
      unavailableSent.add(a.failure);
      capture('seilink_unavailable', { reason: a.failure, restored: opts?.restored === true, character_id: characterId });
    }
    return status;
  }
  if (session?.characterId === characterId && !session.ending) return status;
  const guard = beginSessionStart();
  const swapped = session !== null;
  if (session) await endSession('replaced');
  if (!guard.stillValid()) throw new Error('ACCOUNT_SWITCHING');
  if (!opts?.restored) {
    await updateConfig((c) => ({ ...c, seilink_moved_in: { character_id: characterId, moved_in_at: Date.now() } }));
    const room = await getRoomPayload(characterId).catch(() => null);
    capture('seilink_moved_in', {
      character_id: characterId,
      swapped,
      preset: room?.state.preset ?? null,
      first_room: opts?.firstRoom === true,
      // 261106: her first room starts blank, to decorate together (decorateOffer.ts).
      blank_room: opts?.firstRoom === true && room !== null && isBlankRoom(room.state),
      // 261106 (first-link v3): she spawns on a plain background, black or white with the OS theme.
      ...(room !== null && isPlainRoom(room.state) ? { plain_room: true, plain_tone: osPlainTone() } : {}),
    });
  }
  if (!guard.stillValid()) throw new Error('ACCOUNT_SWITCHING');
  await openSession(characterId, opts?.restored === true);
  // 261105: her face set, baked/downloaded in the background (a no-op once it is on disk).
  void anima.prepare(characterId, opts?.restored ? 'host_restore' : 'host_start');
  return status;
}

/** She moves out (the user's stop). Clears the saved move-in. */
export function stopSeilinkHost(reason: SeilinkEndReason = 'user_stop', via: 'app' | 'dock' = 'app'): Promise<SeilinkHostStatus> {
  return serial(() => stopNow(reason, via));
}

async function stopNow(reason: SeilinkEndReason, via: 'app' | 'dock'): Promise<SeilinkHostStatus> {
  if (reason === 'user_stop') {
    const id = session?.characterId ?? (await loadConfig().catch(() => null))?.seilink_moved_in?.character_id ?? null;
    if (id) capture('seilink_moved_out', { character_id: id, via });
  }
  if (session) await endSession(reason);
  if (reason === 'user_stop' || reason === 'disabled' || reason === 'character_removed' || reason === 'link_failed') {
    await updateConfig((c) => (c.seilink_moved_in ? { ...c, seilink_moved_in: null } : c)).catch((err) =>
      log(`clear moved-in failed: ${(err as Error).message}`),
    );
  }
  return status;
}

/** Account switch: end the session but keep the old profile's move-in (restored when it comes back). */
export function stopSeilinkHostForAccountSwitch(): Promise<void> {
  // 261105: her face-set polls stop too; the next account asks for itself.
  anima.reset();
  return serial(() => (session ? endSession('account_switch') : Promise.resolve()));
}

/** App quit: synchronous enough for before-quit (the host also exits when the pipe closes). */
export function stopSeilinkHostForQuit(): void {
  if (session) void endSession('app_quit');
}

/** App start and after an account switch: bring back whoever moved in on this profile. */
export function restoreSeilinkHost(): Promise<void> {
  return serial(restoreNow);
}

async function restoreNow(): Promise<void> {
  try {
    const cfg = await loadConfig();
    // 261105: no on/off setting any more (the Labs toggle is gone); only support decides.
    pushAvailability();
    if (!seilinkEnabled()) {
      if (session) await endSession('disabled');
      return;
    }
    const id = cfg.seilink_moved_in?.character_id;
    if (!id) {
      if (session) await endSession('replaced');
      return;
    }
    // She may have been deleted since (another device, a hand-cleaned profile, a removal while
    // the app was closed). Gone = forget the move-in and start nothing. An unreadable file is
    // not "gone": keep the move-in.
    const exists = await getCharacter(id).then(
      (c) => c !== null,
      () => true,
    );
    if (!exists) {
      log(`restore: ${id} no longer exists, clearing the move-in`);
      if (session) await endSession('character_removed');
      await updateConfig((c) => (c.seilink_moved_in?.character_id === id ? { ...c, seilink_moved_in: null } : c));
      return;
    }
    await startNow(id, { restored: true });
  } catch (err) {
    log(`restore failed: ${(err as Error).message}`);
  }
}

function pushAvailability(): void {
  try {
    deps?.pushAvailability?.();
  } catch (err) {
    log(`availability push failed: ${(err as Error).message}`);
  }
}

/**
 * M4: a companion was deleted or removed from the library. If she is the one
 * who moved in, she moves out and the move-in is cleared (also when the host
 * is not running, e.g. it failed or SeiLink is off right now).
 */
export function onSeilinkCharacterRemoved(characterId: string): Promise<void> {
  return serial(async () => {
    try {
      if (session?.characterId === characterId) {
        await stopNow('character_removed', 'app');
        return;
      }
      await updateConfig((c) => (c.seilink_moved_in?.character_id === characterId ? { ...c, seilink_moved_in: null } : c));
    } catch (err) {
      log(`character removed cleanup failed: ${(err as Error).message}`);
    }
  });
}

// ── Session ─────────────────────────────────────────────────────────────────

async function openSession(characterId: string, restored: boolean): Promise<void> {
  const token = randomBytes(16).toString('hex');
  const pipe = hostPipePath(process.platform, process.pid, os.tmpdir(), path.join, ++sessionSeq);
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
    // Answered by the host's main process from the pipe read (supervisor.ts: App Nap).
    ping: (pid, seq) => {
      if (s.connPid === pid) sendTo(s, { type: 'ping', seq });
    },
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
    unsub: () => undefined,
    busy: new BusyTracker(CHAT_BUSY_HOLD_MS, (busy) => {
      if (session === s) sendTo(s, { type: 'busy', busy });
    }),
    ending: false,
    openedAt: Date.now(),
    watchdog: new ShownWatchdog(Date.now()),
    health: new HealthSampler(Date.now()),
    counters: new Counters(),
    healthSnap: new Map(),
    facts: null,
    timers: [],
    restartDetail: null,
    verifySeen: new Set(),
    notShownReason: null,
    deafened: false,
    offer: 'none',
  };
  s.timers.push(
    setTimeout(() => {
      if (session === s) emitWatchdog(s, s.watchdog.tick(Date.now()));
    }, SHOWN_DEADLINE_MS + 50),
    setInterval(() => {
      if (session === s) emitHealth(s);
    }, HEALTH_INTERVAL_MS),
  );
  for (const t of s.timers) (t as { unref?: () => void }).unref?.();
  const offs = [
    onRoomChange((id) => {
      if (session === s && id === s.characterId) void sendRoom(s);
    }),
    onSeilinkChatTurn((id, active) => {
      if (session !== s || id !== s.characterId) return;
      if (active) s.busy.begin();
      else s.busy.end();
    }),
    onSeilinkAvatarChanged((id, manifest) => {
      if (session === s && id === s.characterId) sendTo(s, { type: 'avatar-manifest', characterId: id, manifest });
    }),
  ];
  s.unsub = () => {
    for (const off of offs) off();
    s.busy.dispose();
  };
  session = s;
  setSeilinkResident(characterId);
  supervisor.on('message', (m: FromHost) => onHostMessage(s, m));
  supervisor.on('restart', (e: { reason: string }) => {
    s.restarts++;
    s.restartDetail ??= 'host_crash';
    s.health.hostGone();
    s.watchdog.detached();
    if (session === s) patchStatus({ state: 'restarting' });
    seilinkHostEvents.emit('restart', e);
  });
  supervisor.on('hung', (e) => {
    s.restartDetail = 'host_hung';
    s.counters.add('host_hangs');
    noteFailure(s, 'host_hung', false);
    seilinkHostEvents.emit('hung', e);
  });
  supervisor.on('spawn-failed', () => noteFailure(s, 'spawn_failed', false));
  supervisor.on('spawn', (e) => seilinkHostEvents.emit('spawn', e));
  supervisor.on('exit', (e) => seilinkHostEvents.emit('exit', e));
  supervisor.on('gave-up', () => {
    if (session !== s) return;
    // The class of what kept going wrong since the last good attach (a hang, an attach
    // failure), or crash_loop for a host that just kept exiting. The status goes to failed
    // (the UI shows it), seilink_ended carries failure_class, and nothing restarts it until
    // the user moves her in again or the app restarts.
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
        s.watchdog.hello(Date.now());
        if (s.conn && s.conn !== sock) s.conn.destroy();
        s.conn = sock;
        s.connPid = pid;
        sendTo(s, { type: 'set-fps', fps: fpsCap });
        sendTo(s, { type: 'busy', busy: s.busy.busy });
        void sendRoom(s);
        void loadConfig().then(
          (c) => {
            if (session !== s) return;
            s.deafened = c.seilink_deafened === true;
            sendDockState(s);
          },
          () => {},
        );
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
    const room = await getRoomPayload(s.characterId);
    const files: Array<[string, string]> = [];
    if (room.pack) {
      const pack = await loadPack(room.pack.id);
      if (pack) for (const [rel, real] of pack.files) files.push([rel, real]);
    }
    const character = await getCharacter(s.characterId).catch(() => null);
    const portrait = await hostPortrait(character?.portrait_image ?? null, paths.portraitPath);
    // M4: the dock and bubble speak the app's language.
    const uiLanguage = (await loadConfig().catch(() => null))?.ui_language ?? null;
    const payload = { ...room, portrait: portrait.url, name: character?.name ?? '', uiLanguage };
    if (session === s) sendTo(s, { type: 'room', payload, files, portraitFile: portrait.file });
  } catch (err) {
    log(`room for host failed: ${(err as Error).message}`);
  }
}

function onHostMessage(s: Session, m: FromHost): void {
  if (session !== s) return;
  seilinkHostEvents.emit('message', m);
  switch (m.type) {
    case 'attached':
      s.lastFailure = null;
      patchStatus({ state: 'running', failure: undefined });
      s.watchdog.attached(Date.now(), m.layout, m.attachMs);
      if (s.startedAt !== null || m.reattach) noteReattach(s, m);
      s.restartDetail = null;
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
      s.watchdog.attachFailed(failure);
      noteFailure(s, failure, true);
      break;
    }
    case 'first-frame': {
      const reasons = verifyReasonList(m.reasons);
      // An older host build sends no verification: its frame counts as verified (it did attach).
      const verified = m.verified !== false;
      if (!verified) s.counters.add('unverified_frames');
      emitWatchdog(
        s,
        s.watchdog.onFrame(Date.now(), { verified, hidden: m.hidden === true, covered: m.covered === true, paused: m.paused === true, reasons }),
      );
      break;
    }
    case 'facts':
      s.facts = {
        displays: Math.max(0, Math.round(Number(m.displays) || 0)),
        scale: scaleBucket(m.scale),
        resolution: resolutionBucket(m.widthPx, m.heightPx),
        gpu: gpuState(m.gpu),
        hwAccel: m.hwAccel === true,
      };
      break;
    case 'verify-failed': {
      const reasons = verifyReasonList(m.reasons);
      for (const r of reasons) s.counters.add(`verify_fail_${r}`);
      const key = reasons.join('+');
      if (key && !s.verifySeen.has(key)) {
        s.verifySeen.add(key);
        capture('seilink_verify_failed', { character_id: s.characterId, reasons: key, trigger: verifyTrigger(m.trigger), shown: s.watchdog.shown });
      }
      break;
    }
    case 'activity':
      patchStatus({ covered: m.covered, paused: m.paused, fps: m.fps === 0 ? 0 : status.fps });
      emitWatchdog(s, s.watchdog.onActivity(Date.now(), { covered: m.covered === true, paused: m.paused === true }));
      break;
    case 'heartbeat':
      patchStatus({ covered: m.covered, paused: m.paused, fps: Math.max(0, Math.round(m.effectiveFps)) });
      s.health.heartbeat(Date.now(), m);
      emitWatchdog(s, s.watchdog.onActivity(Date.now(), { covered: m.covered === true, paused: m.paused === true }));
      break;
    case 'click':
      if (m.kind === 'click') {
        s.counters.add('clicks');
        const how = deps?.openChat(s.characterId);
        s.counters.add(how ? `chat_open_${how}` : 'chat_open_unknown');
      } else if (m.kind === 'dblclick') {
        s.counters.add('double_clicks');
        deps?.onDoubleClick?.(s.characterId);
      }
      break;
    case 'dock':
      if (isSeilinkDockAction(m.action)) void onDockAction(s, m.action);
      break;
    case 'log':
      log(`host: ${m.msg}`);
      break;
    case 'call':
      void answerCall(s, m);
      break;
  }
}

/**
 * M4: a dock button (the host routed the press, the page confirmed move out).
 * seilink_dock_action {action, character_id, deafened?} (shape only).
 */
async function onDockAction(s: Session, action: SeilinkDockAction): Promise<void> {
  if (session !== s) return;
  const characterId = s.characterId;
  if (action === 'edit') {
    capture('seilink_dock_action', { action, character_id: characterId });
    deps?.openRoomEditor?.(characterId);
    return;
  }
  if (action === 'decorate' || action === 'later') {
    // Only while the offer is up (a stale press after it closed does nothing). seilink_decorate_offer has it.
    if (s.offer === 'none') return;
    s.offer = 'none';
    sendDockState(s);
    deps?.onOfferAnswer?.(characterId, action);
    return;
  }
  if (action === 'deafen') {
    let next = false;
    try {
      await updateConfig((c) => {
        next = c.seilink_deafened !== true;
        return { ...c, seilink_deafened: next };
      });
    } catch (err) {
      log(`deafen failed: ${(err as Error).message}`);
      return;
    }
    if (session === s) {
      s.deafened = next;
      sendDockState(s);
    }
    capture('seilink_dock_action', { action, character_id: characterId, deafened: next });
    return;
  }
  capture('seilink_dock_action', { action, character_id: characterId });
  await stopSeilinkHost('user_stop', 'dock');
}

/**
 * M4: show a line she says as a bubble by her on the desktop. Null when she
 * is not the one on the desktop or the host is not connected.
 * 261105: the line carries her face (`tag`: the face tag it led with, else
 * the lexicon over its words, seilinkExpression.ts); counted as
 * `expressions` on the session, and the result says where it came from
 * (seilink_line_shown `expression`).
 */
export function sendSeilinkLine(
  characterId: string,
  text: string,
  kind: 'idle' | 'poke',
  tag: string | null = null,
): { expression: 'tag' | 'lexicon' | 'none' } | null {
  const s = session;
  if (!s || s.ending || s.characterId !== characterId || !s.conn) return null;
  const look = desktopLineFace(text, tag);
  const expression = !look.face && !look.emotion ? 'none' : isFaceWord(tag) ? 'tag' : 'lexicon';
  sendTo(s, { type: 'line', text, kind, emotion: look.emotion, face: look.face });
  if (expression !== 'none') s.counters.add('expressions');
  return { expression };
}

/** M4: who is on the desktop right now (attached and drawing), for desktopLines.ts. */
function sendDockState(s: Session): void {
  sendTo(s, { type: 'dock-state', deafened: s.deafened, offer: s.offer });
}

/**
 * 261106: show or clear the decorate-together offer on her dock. False when
 * she is not the one on the desktop (or the host is not connected yet).
 */
export function setSeilinkDockOffer(characterId: string, offer: SeilinkDockOffer): boolean {
  const s = session;
  if (!s || s.ending || s.characterId !== characterId) return false;
  s.offer = offer;
  // Not connected yet: the hello sends it.
  sendDockState(s);
  return true;
}

/** 261106: the offer on the dock now ('none' when nobody lives on the desktop). */
export function seilinkDockOffer(characterId: string): SeilinkDockOffer {
  const s = session;
  return s && !s.ending && s.characterId === characterId ? s.offer : 'none';
}

export function seilinkLiveCharacter(): string | null {
  const s = session;
  if (!s || s.ending || !s.conn || status.state !== 'running') return null;
  return s.characterId;
}

/** M4: the player is chatting with her (or just clicked her): no idle line now. */
export function seilinkHostBusy(): boolean {
  return session?.busy.busy === true;
}

const avatarStores: HostAvatarStores = {
  avatarManifest: async (id) => (await import('../../avatar/avatarStore')).getAvatarManifest(id),
  avatarFiles: async (id) => (await import('../../avatar/avatarStore')).listAvatarModelFiles(id),
  facepackFor: async (id) => {
    const c = await getCharacter(id).catch(() => null);
    return c ? facepackIdForCharacter(id, c.name) : null;
  },
  facepackManifest: (id) => readPackManifest(id),
  facepackFilePath: (id, rel) => packFilePath(id, rel),
  noteShown: (id, kind) => anima.noteShown(id, kind, 'desktop'),
};

/** An avatar bridge call from the host page (RoomAvatar's views), answered for her only. */
async function answerCall(s: Session, m: Extract<FromHost, { type: 'call' }>): Promise<void> {
  const id = Number(m.id);
  if (!Number.isInteger(id)) return;
  try {
    if (!isSeilinkHostAvatarMethod(m.method)) throw new Error('unknown method');
    const value = await answerHostAvatarCall(s.characterId, m.method, Array.isArray(m.args) ? m.args : [], avatarStores);
    if (session === s) sendTo(s, { type: 'call-result', id, ok: true, value });
  } catch (err) {
    if (session === s) sendTo(s, { type: 'call-result', id, ok: false, error: (err as Error).message.slice(0, 200) });
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
  // The host cannot get onto the desktop: recycle it (a fresh process, with backoff). The
  // supervisor gives up after HOST_MAX_RESTARTS restarts within HOST_RESTART_WINDOW_MS.
  if (fromHost) {
    s.restartDetail = 'host_recycled';
    s.supervisor.recycle(failure);
  }
}

const VERIFY_TRIGGERS = new Set(['timer', 'session', 'taskbarCreated', 'displayChange', 'settingChange', 'display', 'resume']);

function verifyTrigger(t: unknown): string {
  const v = String(t ?? '');
  return VERIFY_TRIGGERS.has(v) ? v : 'other';
}

/**
 * A re-attach: the same host re-attached (Explorer restart, display change, WorkerW lost...)
 * or a new host attached after a restart. Counted per cause; seilink_reattached for the
 * first REATTACH_EVENTS_PER_CAUSE of each cause in a session (a re-attach loop is counts only).
 */
function noteReattach(s: Session, m: Extract<FromHost, { type: 'attached' }>): void {
  const c = m.reattach ? reattachCause(m.reason) : { cause: 'host_restart' as const, detail: s.restartDetail ?? 'other' };
  const key = `reattach_${c.cause}`;
  s.counters.add('reattaches');
  s.counters.add(key);
  if (s.counters.get(key) > REATTACH_EVENTS_PER_CAUSE) return;
  capture('seilink_reattached', {
    character_id: s.characterId,
    cause: c.cause,
    detail: c.detail,
    attach_ms: Math.round(Number(m.attachMs) || 0),
    shown: s.watchdog.shown,
    session_ms: Date.now() - s.openedAt,
  });
}

/** The single end choke point: every stop path (user, replace, quit, account switch, failure) lands here. */
async function endSession(reason: SeilinkEndReason, failure?: SeilinkHostFailure): Promise<void> {
  const s = session;
  if (!s || s.ending) return;
  s.ending = true;
  session = null;
  setSeilinkResident(null);
  s.unsub();
  for (const t of s.timers) clearTimeout(t);
  const live = s.supervisor.stop({ kill: false });
  sendTo(s, { type: 'quit' });
  const now = Date.now();
  capture('seilink_ended', {
    character_id: s.characterId,
    reason,
    duration_ms: s.startedAt === null ? 0 : now - s.startedAt,
    attached: s.startedAt !== null,
    restarts: s.restarts,
    ...(failure ? { failure_class: failure } : {}),
    // 261105: did it show, and how it ran (hostTelemetry.ts).
    session_ms: now - s.openedAt,
    shown: s.watchdog.shown,
    first_frame_ms: s.watchdog.firstFrameMs,
    ...(s.notShownReason ? { not_shown_reason: s.notShownReason } : {}),
    ...s.health.sessionProps(now),
    ...s.counters.props(),
    ...factProps(s.facts),
  });
  log(`host ended (${reason}${failure ? `, ${failure}` : ''})`);
  // A failure keeps who it was for, so her page can say her room stopped.
  setStatus(failure ? { ...SEILINK_HOST_OFF, state: 'failed', characterId: s.characterId, failure } : baseStatus());
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
      // Sleep: the time asleep is not a hang. Nothing is judged while suspended, and resume or
      // unlock gives the host a grace period to beat again (supervisor.ts).
      // 261105: counted per session (seilink_health / seilink_ended), and a sleep is no heartbeat miss.
      powerMonitor.on('suspend', () => {
        session?.supervisor.noteSuspend();
        session?.health.suspend();
        noteSeilinkCount('sleeps');
      });
      powerMonitor.on('resume', () => {
        session?.supervisor.noteResume('resume');
        session?.health.resume();
        noteSeilinkCount('resumes');
      });
      powerMonitor.on('lock-screen', () => noteSeilinkCount('locks'));
      powerMonitor.on('unlock-screen', () => {
        session?.supervisor.noteResume('unlock-screen');
        noteSeilinkCount('unlocks');
      });
    })
    .catch(() => {
      /* vitest stub */
    });
}
