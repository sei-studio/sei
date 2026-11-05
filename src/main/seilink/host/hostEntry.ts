/**
 * SeiLink room host process (261104, milestone 3). The companion's room as a
 * live wallpaper: one window behind the desktop icons on the primary
 * display, plus (macOS) a small hit panel over her.
 *
 * Main spawns the same Sei binary with --seilink-host (boot.ts sends such a
 * launch here before the app name, the single-instance lock, the boot guard
 * or the updater) and supervises it (supervisor.ts, seilinkHost.ts). This
 * process owns no app state: it gets her room over the pipe, draws it, keeps
 * itself attached, picks its frame rate from the coverage signal, and tells
 * main when she is clicked. Ported from the spike (exp/seilink-spike,
 * spikes/seilink/app/host.js); the numbers and the Windows recovery rules
 * are the spike's, measured on windows-2022/2025 and macos-15/26.
 *
 * Its page (renderer seilink-host.html) is sandboxed with its own preload
 * (src/preload/seilinkHost.ts) and its own session (userData by argv), and
 * it can load exactly the pack files main lists in the room message.
 *
 * Multi-display: everything goes through `primaryRect()`; attach() takes a
 * rect, so a window per display is a loop over screen.getAllDisplays() plus
 * per-window bookkeeping, not a native change.
 */
import { app, BrowserWindow, ipcMain, powerMonitor, protocol, screen, type Display } from 'electron';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { parseSeilinkHostArgs } from './hostArgs';
import { createLineReader, encodeLine, type FromHost, type ToHost } from './protocol';
import { clipRect, RoomActivity, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK } from './coverage';
import { ClickClassifier, type PressPoint } from './clicks';
import { FAKE_ADDON_FILE, addonPath, fakeDesktopEnabled, loadSeilinkAddon, type SeilinkAddon, type SeilinkMacAddon, type SeilinkWinAddon } from './native';
import { SEILINK_HOST_CHANNELS as CH } from '../../../shared/seilinkHostChannels';
import { SEILINK_ROOM_SCHEME } from '../../../shared/seilinkPack';
import { isAvatarEmotion, isFaceWord } from '../../../shared/seilinkExpression';
import {
  SEILINK_HOST_FPS,
  SEILINK_PORTRAIT_HOST,
  isSeilinkDockAction,
  isSeilinkDockOffer,
  isSeilinkHostFailure,
  type SeilinkBox,
  type SeilinkDockAction,
  type SeilinkDockButton,
  type SeilinkDockOffer,
  type SeilinkHostFailure,
  type SeilinkHostLayout,
  type SeilinkHostRoom,
  type SeilinkPokeKind,
} from '../../../shared/seilinkHost';
import { AvatarRelay } from './avatarRelay';
import { pressTarget, toPagePoint, unionBox, type PressTarget } from './dock';

/** Dev/CI smoke without a desktop layer (native.ts fakeDesktopEnabled): a plain window on any OS. */
const FAKE = fakeDesktopEnabled(app.isPackaged);
const IS_WIN = !FAKE && process.platform === 'win32';
const IS_MAC = !FAKE && process.platform === 'darwin';
const T0 = Date.now();
const PACK_FILE_MAX_BYTES = 24 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const args = parseSeilinkHostArgs(process.argv);
if (!args) {
  console.error('[seilink-host] bad launch arguments');
  process.exit(2);
}
const ARGS = args!;
const TOKEN = process.env.SEI_SEILINK_TOKEN ?? '';
delete process.env.SEI_SEILINK_TOKEN;

app.setName('Sei');
app.setPath('userData', ARGS.userData);
// The room is wallpaper: it must keep drawing while unfocused and never focused.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (IS_MAC) {
  // No Dock icon, no menu bar, never the active app.
  try {
    app.setActivationPolicy('accessory');
  } catch {
    /* older Electron: app.dock.hide below */
  }
}
protocol.registerSchemesAsPrivileged([
  { scheme: SEILINK_ROOM_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ── Log ─────────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(ARGS.userData, 'host.log');
try {
  mkdirSync(ARGS.userData, { recursive: true });
  if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) writeFileSync(LOG_FILE, '');
} catch {
  /* logging is best effort */
}

function log(msg: string, level: 'info' | 'warn' = 'info'): void {
  const line = `[seilink-host ${process.pid} +${((Date.now() - T0) / 1000).toFixed(2)}s] ${msg}`;
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* ignore */
  }
  if (level === 'warn') send({ type: 'log', level, msg: msg.slice(0, 500) });
}

// ── Pipe to main ────────────────────────────────────────────────────────────

let sock: net.Socket | null = null;
let connected = false;
const outbox: string[] = [];

function send(m: FromHost): void {
  const line = encodeLine(m);
  if (sock && connected && !sock.destroyed) sock.write(line);
  else if (outbox.length < 200) outbox.push(line);
}

function connect(): void {
  const s = net.connect(ARGS.ipc);
  sock = s;
  s.setEncoding('utf8');
  s.on('connect', () => {
    connected = true;
    s.write(encodeLine({ type: 'hello', pid: process.pid, token: TOKEN }));
    while (outbox.length) s.write(outbox.shift()!);
  });
  s.on('data', createLineReader((m) => onCommand(m as ToHost)));
  // Main went away (quit, crash): a host never outlives its app.
  s.on('close', () => shutdown('pipe closed'));
  s.on('error', (e) => log(`pipe error ${e.message}`));
}

// ── State ───────────────────────────────────────────────────────────────────

let addon: SeilinkAddon | null = null;
let win: BrowserWindow | null = null;
/**
 * The room window whose page we talk to: set as soon as it is created, while `win` (the
 * attached window) waits for its first paint. The page's 'ready' can come before that
 * paint; checked against `win` it was dropped and the page never got its room (CI, 261104).
 */
let pageWin: BrowserWindow | null = null;
let pageReady = false;
let quitting = false;
let reattaching = false;
let attached = false;
let attachedOnce = false;
let layout = '';
let macWantedLevel = 0;
let workerWMissingAccepted = false;
/**
 * Windows (261105, T332): Explorer exited and Windows freed the room window with its desktop
 * windows (win.cc "room window guard" turns that into a normal close instead of a host crash).
 * The window is made again once the new shell is up, and that attach is reported as
 * `shell-lost:...`, an Explorer restart, whatever trigger runs it.
 */
let shellLost = false;
let room: SeilinkHostRoom | null = null;
/** The player is chatting with her or just clicked her (main decides; RoomAvatar holds her seated). */
let busy = false;
/** `<packId>/<rel>` -> realpath, from main's room message. */
let allow = new Map<string, string>();
let box: SeilinkBox | null = null;
let frames = 0;
let lastBeat = { t: Date.now(), frames: 0 };
let sceneReady = false;
/** After an attach, report the first frame drawn (frames past this count, or the scene's first draw). */
let firstFramePendingAt: number | null = null;
let held = false;
let downPress: PressPoint | null = null;
/** M4: the dock buttons (page CSS px), part of the click area; what the last press went down on. */
let dock: SeilinkDockButton[] | null = null;
let downTarget: PressTarget = { kind: 'none' };
let deafened = false;
/** 261106: the decorate-together offer on the dock (decorateOffer.ts). */
let offer: SeilinkDockOffer = 'none';
let lineSeq = 0;

const activity = new RoomActivity(SEILINK_HOST_FPS, (a) => {
  log(`activity ${a.reason} fps ${a.fps}`);
  pushFps();
  send({ type: 'activity', covered: a.covered, paused: a.paused, fps: a.fps, reason: a.reason });
});

const clicks = new ClickClassifier({
  dblMs: 500,
  dragPx: 6,
  onClick: () => poke('click'),
  onDoubleClick: () => poke('dblclick'),
  onDrag: () => poke('drag'),
});

function poke(kind: SeilinkPokeKind): void {
  log(`poke ${kind}`);
  if (kind !== 'drag') send({ type: 'click', kind });
  if (pageWin && !pageWin.isDestroyed()) pageWin.webContents.send(CH.poke, kind);
}

/** A press on a dock button: the page decides (move out asks once more) and answers with CH.dockAction. */
function dockPress(id: SeilinkDockAction): void {
  log(`dock ${id}`);
  toPage(CH.dockPress, id);
}

/** Where a native press landed, in page terms. */
function targetAt(x: number, y: number): PressTarget {
  const p = toPagePoint({ x, y }, primaryDisplay(), IS_WIN ? 'physical' : 'points');
  return pressTarget(p, box, dock);
}

function layoutNow(): SeilinkHostLayout {
  const d = primaryDisplay();
  const wa = d.workArea;
  return { workArea: { x: wa.x - d.bounds.x, y: wa.y - d.bounds.y, w: wa.width, h: wa.height } };
}

function toPage(channel: string, payload: unknown): void {
  if (pageWin && !pageWin.isDestroyed() && pageReady) pageWin.webContents.send(channel, payload);
}

function pushFps(): void {
  toPage(CH.fps, activity.current.fps);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function failure(v: unknown, fallback: SeilinkHostFailure): SeilinkHostFailure {
  return isSeilinkHostFailure(v) ? v : fallback;
}

// ── Commands from main ──────────────────────────────────────────────────────

function onCommand(m: ToHost): void {
  switch (m.type) {
    case 'room':
      setRoom(m.payload, m.files, m.portraitFile ?? null);
      break;
    case 'busy':
      busy = m.busy === true;
      toPage(CH.busy, busy);
      break;
    case 'call-result':
      relay.onResult(m);
      break;
    case 'avatar-manifest':
      toPage(CH.avatarManifest, { characterId: m.characterId, manifest: m.manifest });
      break;
    case 'set-fps':
      activity.setCap(Number(m.fps));
      break;
    case 'dock-state':
      deafened = m.deafened === true;
      offer = isSeilinkDockOffer(m.offer) ? m.offer : 'none';
      toPage(CH.dockState, { deafened, offer });
      break;
    case 'line': {
      const text = String(m.text ?? '').slice(0, 400).trim();
      // 261105: her face for the line (seilinkExpression.ts), checked again here: closed shapes only.
      const emotion = isAvatarEmotion(m.emotion) ? m.emotion : null;
      const face = isFaceWord(m.face) ? m.face : null;
      if (text) toPage(CH.line, { id: ++lineSeq, text, kind: m.kind === 'poke' ? 'poke' : 'idle', emotion, face });
      break;
    }
    case 'set-paused':
      held = m.paused === true;
      activity.set({ held });
      break;
    case 'quit':
      shutdown('quit');
      break;
    case 'ping':
      // Answered straight from the pipe read (main's liveness check), not from a timer.
      send({ type: 'pong', seq: Number(m.seq) || 0 });
      break;
    case 'test-hang': {
      if (!ARGS.test) break;
      // CI: wedge this process's main thread (no heartbeats, no IPC) so main's hang detection fires.
      log(`test-hang ${m.ms}`);
      const until = Date.now() + Math.min(60_000, Number(m.ms) || 10_000);
      // The count is logged so the bundler cannot drop the loop as side-effect free (it did).
      let spins = 0;
      while (Date.now() < until) spins++;
      log(`test-hang over (${spins} spins)`);
      break;
    }
  }
}

function setRoom(payload: SeilinkHostRoom, files: Array<[string, string]>, portraitFile: string | null): void {
  room = payload;
  const next = new Map<string, string>();
  if (payload.pack && Array.isArray(files)) {
    for (const [rel, real] of files) if (typeof rel === 'string' && typeof real === 'string') next.set(`${payload.pack.id}/${rel}`, real);
  }
  if (typeof portraitFile === 'string') next.set(`${SEILINK_PORTRAIT_HOST}/${path.basename(portraitFile)}`, portraitFile);
  allow = next;
  log(`room ${payload.pack ? payload.pack.id : 'no pack'} (${next.size} files)`);
  toPage(CH.room, payload);
}

// ── sei-room:// (only the files main listed) ───────────────────────────────

function registerRoomProtocol(): void {
  protocol.handle(SEILINK_ROOM_SCHEME, async (request) => {
    const headers = { 'Access-Control-Allow-Origin': '*' };
    const notFound = (): Response => new Response('not found', { status: 404, headers });
    let key: string;
    try {
      const u = new URL(request.url);
      key = `${u.hostname}/${u.pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/')}`;
    } catch {
      return notFound();
    }
    const real = allow.get(key);
    if (!real) return notFound();
    try {
      // Re-check on disk: a file replaced by a symlink since main listed it resolves elsewhere.
      if ((await realpath(real)) !== real) return notFound();
      const s = await stat(real);
      if (!s.isFile() || s.size > PACK_FILE_MAX_BYTES) return notFound();
      const bytes = await readFile(real);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          ...headers,
          'Content-Type': CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'max-age=31536000, immutable',
        },
      });
    } catch {
      return notFound();
    }
  });
}

// ── The room window ─────────────────────────────────────────────────────────

function primaryDisplay(): Display {
  return screen.getPrimaryDisplay();
}

/** Physical px rect of a display (Windows attach / hit test units). */
function physicalRect(d: Display): { x: number; y: number; w: number; h: number } {
  const b = d.bounds;
  const s = d.scaleFactor;
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), w: Math.round(b.width * s), h: Math.round(b.height * s) };
}

function pagePaths(): { preload: string; page: { url: string } | { file: string } } {
  const root = app.getAppPath();
  const preload = path.join(root, 'dist', 'preload', 'seilinkHost.cjs');
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  return { preload, page: devUrl ? { url: `${devUrl.replace(/\/$/, '')}/seilink-host.html` } : { file: path.join(root, 'dist', 'renderer', 'seilink-host.html') } };
}

async function createRoomWindow(): Promise<BrowserWindow> {
  const b = primaryDisplay().bounds;
  const { preload, page } = pagePaths();
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    // Windows: no resize frame at all. With it, the attached child kept an 8 px non-client
    // strip left and right, and the page measured her box 8 px off (CI 261104).
    thickFrame: false,
    title: 'Sei room',
    backgroundColor: '#101114',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  pageReady = false;
  sceneReady = false;
  pageWin = w;
  w.webContents.on('did-finish-load', () => log('page loaded'));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.on('closed', () => {
    if (IS_WIN && addon && addon.platform === 'win32' && (addon as SeilinkWinAddon).roomLost?.()) shellLost = true;
    log(`room window closed${shellLost ? ' (Explorer exited)' : ''}`);
    if (pageWin === w) pageWin = null;
    if (win === w) {
      win = null;
      attached = false;
      if (!quitting) void recoverWindow('window-closed');
    }
  });
  w.webContents.on('render-process-gone', (_e, d) => {
    // A fresh host is the simplest clean state; the supervisor restarts it at once.
    log(`renderer gone (${d.reason}); exiting for a restart`, 'warn');
    send({ type: 'attach-failed', failure: 'renderer_failed', detail: `renderer ${d.reason}` });
    setTimeout(() => app.exit(5), 100);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`page failed to load (${code} ${desc})`, 'warn');
    send({ type: 'attach-failed', failure: 'renderer_failed', detail: `load ${code}` });
    setTimeout(() => app.exit(5), 100);
  });
  const ready = new Promise<void>((r) => w.once('ready-to-show', () => r()));
  if ('url' in page) void w.loadURL(page.url);
  else void w.loadFile(page.file);
  await Promise.race([ready, sleep(8000)]);
  win = w;
  return w;
}

// The page's own messages.
function fromOurPage(sender: Electron.WebContents): boolean {
  return !!pageWin && !pageWin.isDestroyed() && sender === pageWin.webContents;
}

ipcMain.on(CH.ready, (e) => {
  if (!fromOurPage(e.sender)) return;
  pageReady = true;
  log(`page ready${room ? '' : ' (no room yet)'}`);
  e.sender.send(CH.fps, activity.current.fps);
  e.sender.send(CH.busy, busy);
  e.sender.send(CH.layout, layoutNow());
  e.sender.send(CH.dockState, { deafened, offer });
  if (room) e.sender.send(CH.room, room);
});

// RoomAvatar's avatar calls (window.sei in the host preload), relayed to main.
const relay = new AvatarRelay((m) => send(m), {
  size: async (file) => (await stat(file)).size,
  read: async (file) => new Uint8Array(await readFile(file)),
});

ipcMain.handle(CH.call, async (e, method: unknown, args: unknown) => {
  if (!fromOurPage(e.sender)) throw new Error('not the room page');
  return relay.call(method, args);
});

ipcMain.on(CH.box, (e, raw: unknown) => {
  if (!fromOurPage(e.sender)) return;
  const r = raw as SeilinkBox | null;
  box = r && r.w > 0 && r.h > 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
  applyHitRect();
});

ipcMain.on(CH.dock, (e, raw: unknown) => {
  if (!fromOurPage(e.sender)) return;
  const list = Array.isArray(raw)
    ? (raw as SeilinkDockButton[]).filter((b) => b && isSeilinkDockAction(b.id) && b.w > 0 && b.h > 0).map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))
    : [];
  dock = list.length ? list : null;
  applyHitRect();
});

ipcMain.on(CH.dockAction, (e, action: unknown) => {
  if (!fromOurPage(e.sender) || !isSeilinkDockAction(action)) return;
  log(`dock action ${action}`);
  send({ type: 'dock', action });
});

ipcMain.on(CH.frames, (e, count: unknown) => {
  if (!fromOurPage(e.sender)) return;
  frames = Number(count) || 0;
  if (firstFramePendingAt !== null && sceneReady && frames > firstFramePendingAt) reportFirstFrame();
});

ipcMain.on(CH.firstFrame, (e) => {
  if (!fromOurPage(e.sender)) return;
  sceneReady = true;
  if (firstFramePendingAt !== null) reportFirstFrame();
});

function reportFirstFrame(): void {
  firstFramePendingAt = null;
  const v = verifyNow();
  const a = activity.current;
  send({ type: 'first-frame', sinceStartMs: Date.now() - T0, verified: v.ok, hidden: v.hidden, covered: a.covered, paused: a.paused, reasons: v.reasons });
}

/**
 * 261105 (analytics): is the room where attach() put it, and visible? Windows: validate()
 * (still the child of the Progman / WorkerW we chose, right size) plus the window's own
 * visibility; the raised layout's missing-WorkerW reasons are fine (the room draws under
 * DefView, see validate below). mac: still at the desktop level and visible. Cheap.
 */
function verifyNow(): { ok: boolean; hidden: boolean; reasons: string[] } {
  if (!win || win.isDestroyed() || !addon) return { ok: false, hidden: false, reasons: ['own-window-gone'] };
  const hidden = !win.isVisible();
  const reasons: string[] = [];
  try {
    if (IS_WIN) {
      const px = physicalRect(primaryDisplay());
      const v = (addon as SeilinkWinAddon).validate(win.getNativeWindowHandle(), { w: px.w, h: px.h });
      for (const r of v.reasons) if (!(v.layout === 'raised' && SHELL_ONLY_WORKERW.has(r))) reasons.push(r);
      if (v.hidden) reasons.push('hidden');
    } else if (IS_MAC) {
      if ((addon as SeilinkMacAddon).windowLevel(win.getNativeWindowHandle()) !== macWantedLevel) reasons.push('level-mismatch');
    }
  } catch {
    reasons.push('other');
  }
  if (hidden) reasons.push('not-visible');
  const isHidden = hidden || reasons.includes('hidden');
  return { ok: reasons.length === 0, hidden: isHidden, reasons };
}

/** The last verify-failed set sent ('' after a clean check), so a lasting problem is reported once. */
let lastVerifyKey = '';

/** After an attach, a check that a re-attach does not cover (hidden but still parented, mac not visible). */
function noteVerify(trigger: string, reasons: string[]): void {
  const key = reasons.slice().sort().join('+');
  if (key === lastVerifyKey) return;
  lastVerifyKey = key;
  if (!key) return;
  log(`verify failed (${trigger}): ${key}`);
  send({ type: 'verify-failed', reasons, trigger: trigger.split('+')[0] });
}

/** Display and GPU facts for main's analytics (no names, no ids). */
function sendFacts(): void {
  try {
    const d = primaryDisplay();
    const px = physicalRect(d);
    let gpu = '';
    try {
      gpu = String((app.getGPUFeatureStatus() as unknown as Record<string, unknown>).gpu_compositing ?? '');
    } catch {
      /* optional */
    }
    send({
      type: 'facts',
      displays: screen.getAllDisplays().length,
      scale: d.scaleFactor,
      widthPx: px.w,
      heightPx: px.h,
      gpu,
      hwAccel: app.isHardwareAccelerationEnabled(),
    });
  } catch {
    /* analytics only */
  }
}

// ── Hit area ────────────────────────────────────────────────────────────────

/**
 * macOS: the hit panel keeps this far (points) from the work area's edges. A zoomed window
 * fills the work area only up to the app's own rounding, and any sliver of the panel left
 * showing keeps it "visible", so the room would never drop to 0 fps under it.
 */
const MAC_PANEL_EDGE_INSET = 12;
let lastPanelKey = '';

function applyHitRect(): void {
  if (!addon) return;
  const d = primaryDisplay();
  const b = d.bounds;
  const toScreen = (r: SeilinkBox): SeilinkBox => ({ x: b.x + r.x, y: b.y + r.y, w: r.w, h: r.h });
  // M4: the click area is her box plus the dock (one native rect); presses are routed by position.
  const hit = unionBox([box, ...(box ? (dock ?? []) : [])]);
  const screenBox = hit ? toScreen(hit) : null;
  send({
    type: 'box',
    screen: box ? toScreen(box) : null,
    ...(box && dock ? { dock: dock.map((d0) => ({ id: d0.id, ...toScreen(d0) })) } : {}),
  });
  if (IS_WIN) {
    const s = d.scaleFactor;
    (addon as SeilinkWinAddon).setHitRect(
      screenBox && attached
        ? { x: Math.round(screenBox.x * s), y: Math.round(screenBox.y * s), w: Math.round(screenBox.w * s), h: Math.round(screenBox.h * s) }
        : null,
    );
  } else if (IS_MAC) {
    const mac = addon as SeilinkMacAddon;
    const wa = d.workArea;
    const inset = MAC_PANEL_EDGE_INSET;
    const panel = screenBox && clipRect(screenBox, { x: wa.x + inset, y: wa.y + inset, w: wa.width - 2 * inset, h: wa.height - 2 * inset });
    if (panel && attached) {
      const key = `${Math.round(panel.x)},${Math.round(panel.y)} ${Math.round(panel.w)}x${Math.round(panel.h)}`;
      if (key !== lastPanelKey) log(`hit panel ${key} (work area ${wa.x},${wa.y} ${wa.width}x${wa.height})`);
      lastPanelKey = key;
      const visible = mac.hitPanel(panel);
      activity.set({ hasPanel: true, panelVisible: visible });
    } else {
      mac.hitPanelClose();
      activity.set({ hasPanel: false });
    }
  }
}

// ── Attach ──────────────────────────────────────────────────────────────────

/** Windows: a fresh Explorer starts without its Progman/DefView for a moment. */
async function waitForShell(): Promise<void> {
  if (!IS_WIN || !addon) return;
  const a = addon as SeilinkWinAddon;
  const t = Date.now();
  for (;;) {
    const st = a.shellStatus();
    if (st.progman && st.defView) return;
    if (Date.now() - t > 30_000) throw Object.assign(new Error('no desktop shell after 30 s'), { failure: 'no_shell' });
    await sleep(100);
  }
}

async function attach(reason: string): Promise<boolean> {
  if (!win || win.isDestroyed() || !addon) return false;
  const t = Date.now();
  const handle = win.getNativeWindowHandle();
  let method: string | undefined;
  if (addon.platform === 'fake') {
    // Dev/CI smoke (SEI_SEILINK_FAKE_DESKTOP): a plain window, no desktop layer.
    win.showInactive();
    layout = 'fake';
    method = 'plain window';
  } else if (IS_WIN) {
    const res = (addon as SeilinkWinAddon).attach(handle, physicalRect(primaryDisplay()));
    if (!res.ok) {
      attached = false;
      log(`attach failed (${reason}): ${res.failure} ${res.error ?? ''} ${(res.steps ?? []).join(' | ')}`, 'warn');
      send({ type: 'attach-failed', failure: failure(res.failure, 'attach_failed'), detail: String(res.error ?? '').slice(0, 200) });
      return false;
    }
    win.showInactive();
    layout = res.layout ?? '';
    method = res.method;
    if (res.steps?.length) log(`attach steps: ${res.steps.join(' | ')}`);
  } else if (IS_MAC) {
    const mac = addon as SeilinkMacAddon;
    win.showInactive();
    const res = mac.setDesktopLevel(handle);
    // showInactive can re-level a window; check after it settles (spike round 1).
    await sleep(300);
    const level = mac.windowLevel(handle);
    if (!res.ok || level !== res.wanted) {
      attached = false;
      log(`desktop level not applied (${reason}): wanted ${res.wanted} got ${level}`, 'warn');
      send({ type: 'attach-failed', failure: failure(res.failure, 'level_not_applied'), detail: `level ${level}` });
      return false;
    }
    macWantedLevel = res.wanted ?? level;
    layout = `mac ${res.os ?? ''}`.trim();
    method = `level ${level}`;
    activity.set({ roomVisible: mac.observeOcclusion(handle, 'room') });
  } else {
    return false;
  }
  attached = true;
  shellLost = false;
  const reattach = attachedOnce;
  attachedOnce = true;
  log(`attached (${reason}) ${layout} ${method ?? ''} in ${Date.now() - t} ms`);
  send({ type: 'attached', reattach, reason, layout, method, attachMs: Date.now() - t });
  firstFramePendingAt = frames;
  if (sceneReady && activity.current.fps === 0) reportFirstFrame(); // a still room is already drawn
  applyHitRect();
  pushFps();
  return true;
}

async function recoverWindow(reason: string): Promise<void> {
  if (reattaching || quitting) return;
  reattaching = true;
  try {
    log(`recover (${reason})`);
    await waitForShell();
    await createRoomWindow();
    await attach(shellLost ? `shell-lost:${reason}` : reason);
  } catch (err) {
    log(`recover failed: ${(err as Error).message}`, 'warn');
    send({ type: 'attach-failed', failure: failure((err as { failure?: unknown }).failure, 'attach_failed'), detail: 'recover' });
  } finally {
    reattaching = false;
  }
}

const SHELL_ONLY_WORKERW = new Set(['no-workerw', 'workerw-not-bottom']);

/** Re-check the attachment (shell events, display changes, and every 2 s). */
async function validate(trigger: string): Promise<void> {
  // The shell took the window and the first recovery gave up waiting for a new one: keep trying.
  if (!win && shellLost && !reattaching && !quitting) return void recoverWindow('window-closed');
  if (!win || win.isDestroyed() || reattaching || quitting || !addon) return;
  const handle = win.getNativeWindowHandle();
  if (IS_MAC) {
    const mac = addon as SeilinkMacAddon;
    const b = primaryDisplay().bounds;
    const wb = win.getBounds();
    if (wb.x !== b.x || wb.y !== b.y || wb.width !== b.width || wb.height !== b.height) {
      win.setBounds(b);
      applyHitRect();
    }
    if (attached && mac.windowLevel(handle) !== macWantedLevel) {
      log(`level drifted (${trigger}); re-applying`);
      await attach(`validate:${trigger}:level`);
      return;
    }
    if (attached) noteVerify(trigger, win.isVisible() ? [] : ['not-visible']);
    return;
  }
  if (!IS_WIN) return;
  const a = addon as SeilinkWinAddon;
  const px = physicalRect(primaryDisplay());
  const v = a.validate(handle, { w: px.w, h: px.h });
  if (v.ok) {
    workerWMissingAccepted = false;
    // Parented right but hidden: validate() is ok, so nothing re-attaches. Report it (261105).
    if (attached) noteVerify(trigger, v.hidden || !win.isVisible() ? ['hidden'] : []);
    return;
  }
  // Raised (24H2) layout: once the WorkerW is destroyed, 0x052C does not bring it back, and the
  // room still draws fine directly under DefView (spike round 2). Re-attach once; if only the
  // WorkerW reasons remain, accept that instead of re-attaching every 2 s.
  const onlyWorkerW = v.layout === 'raised' && v.reasons.every((r) => SHELL_ONLY_WORKERW.has(r));
  if (onlyWorkerW && workerWMissingAccepted) return;
  log(`validate failed (${trigger}): ${v.reasons.join('+')} [${v.layout}]`);
  // The shell is mid-rebuild: TaskbarCreated or the next tick retries.
  if (v.reasons.includes('no-progman') || v.reasons.includes('no-defview')) return;
  if (v.reasons.includes('own-window-gone')) {
    const w = win;
    win = null;
    attached = false;
    try {
      w.destroy();
    } catch {
      /* already gone */
    }
    await recoverWindow('own-window-gone');
    return;
  }
  reattaching = true;
  try {
    await attach(`${shellLost ? 'shell-lost' : 'validate'}:${trigger}:${v.reasons.join('+')}`);
  } finally {
    reattaching = false;
  }
  if (v.layout === 'raised' && v.reasons.includes('no-workerw') && win && !win.isDestroyed()) {
    const v2 = a.validate(win.getNativeWindowHandle(), { w: px.w, h: px.h });
    if (!v2.ok && v2.reasons.every((r) => SHELL_ONLY_WORKERW.has(r))) {
      workerWMissingAccepted = true;
      log('raised layout without WorkerW: accepted after one re-attach');
    }
  }
}

function validateSoon(trigger: string): void {
  setTimeout(() => void validate(trigger), 300);
  setTimeout(() => void validate(`${trigger}+1500`), 1500);
}

// ── Native events ───────────────────────────────────────────────────────────

function onNativeEvent(json: string): void {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (e.type) {
    case 'coverage':
      activity.set({ winCovered: e.covered === true });
      if (e.covered) log(`covered (${String(e.trigger)}: ${String(e.kind)})`);
      return;
    case 'pointer': {
      if (e.button !== 'left') return;
      const p = { x: Number(e.x), y: Number(e.y), t: Number(e.t) || Date.now() };
      if (e.kind === 'down') {
        downPress = p;
        downTarget = targetAt(p.x, p.y);
      } else if (e.kind === 'up' && downPress) {
        log(`press at ${p.x},${p.y}`);
        const start = downTarget;
        if (start.kind === 'her') clicks.press(downPress, p);
        else if (start.kind === 'dock') {
          const end = targetAt(p.x, p.y);
          // A press that slid off the button is no press (like a normal button).
          if (end.kind === 'dock' && end.id === start.id && p.t - downPress.t < 1500) dockPress(start.id);
        }
        downPress = null;
        downTarget = { kind: 'none' };
      }
      return;
    }
    case 'hit':
      if (e.kind !== 'down') log(`hit ${String(e.kind)} at ${Number(e.x)},${Number(e.y)}`);
      if (e.kind === 'down') {
        downTarget = targetAt(Number(e.x), Number(e.y));
        return;
      }
      if (downTarget.kind === 'dock') {
        // The dock acts on a click; the second click of a double click and drags are dropped.
        if (e.kind === 'click' && targetAt(Number(e.x), Number(e.y)).kind === 'dock') dockPress(downTarget.id);
        return;
      }
      if (downTarget.kind !== 'her') return;
      if (e.kind === 'click') clicks.tap();
      else if (e.kind === 'dblclick') clicks.doubleTap();
      else if (e.kind === 'drag-end') clicks.drag();
      return;
    case 'occlusion':
      if (e.tag === 'room') activity.set({ roomVisible: e.visible === true });
      else if (e.tag === 'panel') activity.set({ panelVisible: e.visible === true });
      return;
    case 'session':
      if (e.code === WTS_SESSION_LOCK) activity.set({ locked: true });
      else if (e.code === WTS_SESSION_UNLOCK) activity.set({ locked: false });
      validateSoon('session');
      return;
    case 'shellLost':
      // Explorer exited and Windows freed the room window with its desktop windows. Log only:
      // the window's 'closed' handler reads roomLost() itself and makes a new window once the
      // new shell is up (this message can arrive after that).
      log('shell lost: Explorer exited and took the room window');
      return;
    case 'taskbarCreated':
    case 'displayChange':
    case 'settingChange':
      log(`shell event ${String(e.type)}`);
      validateSoon(String(e.type));
      return;
    case 'watchStarted':
      log(`watcher started ${json}`);
      return;
  }
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

function heartbeat(): void {
  const now = Date.now();
  const dt = Math.max(1, now - lastBeat.t);
  const effectiveFps = Math.round(((frames - lastBeat.frames) * 1000) / dt);
  lastBeat = { t: now, frames };
  let cpu = 0;
  let ramMB = 0;
  try {
    for (const p of app.getAppMetrics()) {
      cpu += p.cpu?.percentCPUUsage ?? 0;
      ramMB += (p.memory?.workingSetSize ?? 0) / 1024;
    }
  } catch {
    /* metrics are optional */
  }
  const a = activity.current;
  send({
    type: 'heartbeat',
    fps: a.fps,
    frames,
    effectiveFps,
    covered: a.covered,
    paused: a.paused,
    attached,
    cpu: Math.round(cpu * 10) / 10,
    ramMB: Math.round(ramMB),
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function shutdown(why: string): void {
  if (quitting) return;
  quitting = true;
  log(`shutdown (${why})`);
  clicks.dispose();
  try {
    if (addon && IS_MAC) (addon as SeilinkMacAddon).hitPanelClose();
    if (win && !win.isDestroyed()) {
      // Classic layout: a hidden child keeps its last frame on the wallpaper until it repaints.
      if (addon && IS_WIN) (addon as SeilinkWinAddon).redrawDesktop(win.getNativeWindowHandle(), layout === 'classic');
      else win.hide();
    }
  } catch (err) {
    log(`cleanup: ${(err as Error).message}`);
  }
  setTimeout(() => app.exit(0), 50);
}

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err?.stack ?? err}`, 'warn');
  setTimeout(() => app.exit(4), 100);
});

app.on('window-all-closed', () => {
  /* the host decides when to exit */
});

connect();

void app
  .whenReady()
  .then(async () => {
    if (IS_MAC) app.dock?.hide();
    try {
      addon = loadSeilinkAddon(
        FAKE
          ? FAKE_ADDON_FILE
          : addonPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
      );
    } catch (err) {
      const msg = (err as Error).message;
      send({ type: 'attach-failed', failure: msg.startsWith('addon_load_failed') ? 'addon_load_failed' : 'addon_missing', detail: msg.slice(0, 200) });
      log(`addon: ${msg}`, 'warn');
      setTimeout(() => app.exit(3), 200);
      return;
    }
    registerRoomProtocol();
    if (IS_WIN) {
      const a = addon as SeilinkWinAddon;
      clicksDblMs(a.doubleClickMs());
      a.watchStart(onNativeEvent);
    } else if (IS_MAC) {
      const m = addon as SeilinkMacAddon;
      clicksDblMs(m.doubleClickMs());
      m.onEvents(onNativeEvent);
    }
    powerMonitor.on('lock-screen', () => activity.set({ locked: true }));
    powerMonitor.on('unlock-screen', () => activity.set({ locked: false }));
    powerMonitor.on('suspend', () => activity.set({ suspended: true }));
    powerMonitor.on('resume', () => {
      activity.set({ suspended: false });
      validateSoon('resume');
    });
    // Heartbeats first: a fresh Explorer can take many seconds to bring its desktop back, and a
    // host waiting for it is alive, not hung (CI 261104: it was killed as hung every 3 s).
    setInterval(heartbeat, 1000);
    heartbeat();
    sendFacts();
    await waitForShell();
    await createRoomWindow();
    await attach('initial');
    setInterval(() => void validate('timer'), 2000);
    const onDisplays = (): void => {
      if (IS_WIN && win && !win.isDestroyed()) win.setBounds(primaryDisplay().bounds);
      toPage(CH.layout, layoutNow());
      applyHitRect();
      validateSoon('display');
      sendFacts();
    };
    screen.on('display-metrics-changed', onDisplays);
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
  })
  .catch((err: unknown) => {
    log(`fatal: ${(err as Error)?.stack ?? err}`, 'warn');
    send({ type: 'attach-failed', failure: failure((err as { failure?: unknown })?.failure, 'attach_failed'), detail: 'startup' });
    setTimeout(() => app.exit(4), 200);
  });

/** The OS double-click interval (bounded: a 5 s setting would hold every click for 5 s). */
function clicksDblMs(ms: number): void {
  clicks.setDoubleClickMs(Math.max(200, Math.min(900, Number(ms) || 500)));
}
