/**
 * The desktop stage over IPC, and the room editor ON the desktop (261106,
 * first-link flow). desktopStage.ts moves the window; this decides when.
 *
 *  - seilink:stage (main window only): the renderer steps the window out over
 *    the desktop once what it shows is mounted (the first-link intro, the room
 *    editor), and back when it ends. The renderer drives it so the app's own
 *    UI never flashes full screen: the window changes size under a surface
 *    that already covers it.
 *  - openDesktopEditor: the dock's edit button and the offer's "Decorate
 *    together" (and a click in the app for the companion who lives there)
 *    open her editor on the desktop. A hidden or minimized window is NOT
 *    shown first: the push goes out, the renderer mounts the editor and asks
 *    for the stage, which brings the window up already over the desktop. If
 *    no enter arrives within EDITOR_ENTER_WAIT_MS (a busy renderer, the
 *    stage refused), the window is shown as usual and the editor is in it.
 *  - seilink:offer: the desktop shows her new room; ask about decorating
 *    together (decorateOffer.ts).
 *
 *  - seilink:stage minimize_others (261110): "Minimize other windows" on the
 *    live card, so the desktop (her room) shows when Sei steps aside
 *    (minimizeOthers.ts).
 *
 * Analytics, shape only: seilink_desktop_stage {action: entered | exited |
 * failed | revealed, purpose: intro | editor, opened_from (editor), reveal and
 * staged_ms (exited), error_class (failed), character_id}; 261110:
 * seilink_minimize_windows {outcome, windows, surface, os}.
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import {
  SEILINK_STAGE_PURPOSES,
  type SeilinkOfferVia,
  type SeilinkOpenEditor,
  type SeilinkStageError,
  type SeilinkStagePurpose,
  type SeilinkStageResult,
} from '../../shared/seilinkHost';
import { EDITOR_OPENED_FROM, type EditorOpenedFrom } from '../../shared/seilinkTelemetry';
import { loadAnalytics } from '../lazyAnalytics';
import { enterDesktopStage, exitDesktopStage, isStaged, revealDesktop } from './desktopStage';
import { minimizeOtherWindows } from './minimizeOthers';
import { SEILINK_MINIMIZE_EVENT, sanitizeSeilinkSetupTrack } from '../../shared/seilinkSetupTelemetry';
import { offerDecorateTogether } from './decorateOffer';
import { seilinkEnabled } from './gate';
import { seilinkLiveCharacter } from './host/seilinkHost';
import { isRoomCharacterId } from './roomStore';

export const SEILINK_DESKTOP_STAGE_EVENT = 'seilink_desktop_stage';
/** The renderer has this long to put the editor on the stage before the window is shown the usual way. */
export const EDITOR_ENTER_WAIT_MS = 4_000;

export interface StageFlowDeps {
  getMainWindow(): BrowserWindow | null;
  /** Bring the main window forward (or make one) and send `channel` once it listens (index.ts openFromSeilink). */
  openWithWindow(channel: string, payload: SeilinkOpenEditor): void;
}

let deps: StageFlowDeps | null = null;
let registered = false;
/** What is on the stage now (analytics). */
let onStage: { purpose: SeilinkStagePurpose; characterId: string; openedFrom: EditorOpenedFrom | null } | null = null;
/** A desktop editor push waiting for its stage enter. */
let waiting: { characterId: string; openedFrom: EditorOpenedFrom; timer: ReturnType<typeof setTimeout> } | null = null;

function capture(props: Record<string, string | number | boolean | null>): void {
  void loadAnalytics()
    .then((a) => a.capture(SEILINK_DESKTOP_STAGE_EVENT, props))
    .catch(() => {});
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    if (process.platform !== 'linux') win.setOpacity(1);
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
  } catch {
    /* nothing more to do */
  }
}

function clearWaiting(): void {
  if (waiting) clearTimeout(waiting.timer);
  waiting = null;
}

/** Is her editor on the desktop possible right now? She lives there and SeiLink is on. */
export function desktopEditorFor(characterId: string): boolean {
  return seilinkEnabled() && seilinkLiveCharacter() === characterId;
}

/** Her room editor, on the desktop when she lives there (the dock, the offer). */
export function openDesktopEditor(characterId: string, openedFrom: EditorOpenedFrom): void {
  if (!deps) return;
  const desktop = desktopEditorFor(characterId);
  const payload: SeilinkOpenEditor = { characterId, openedFrom, desktop };
  const win = deps.getMainWindow();
  // No window yet (macOS keeps running without one): make one; the editor asks for the stage once it is up.
  if (!win || win.isDestroyed()) {
    deps.openWithWindow(IpcChannel.seilink.openRoomEditor, payload);
    return;
  }
  // The editor stays in the app (she does not live there, or the window is in its own fullscreen Space).
  if (!desktop || win.isFullScreen()) {
    deps.openWithWindow(IpcChannel.seilink.openRoomEditor, { ...payload, desktop: false });
    return;
  }
  clearWaiting();
  win.webContents.send(IpcChannel.seilink.openRoomEditor, payload);
  const timer = setTimeout(() => {
    if (!waiting || waiting.timer !== timer) return;
    waiting = null;
    capture({ action: 'failed', purpose: 'editor', opened_from: openedFrom, error_class: 'timeout', character_id: characterId });
    const w = deps?.getMainWindow();
    if (w && !w.isDestroyed()) showWindow(w);
  }, EDITOR_ENTER_WAIT_MS);
  timer.unref?.();
  waiting = { characterId, openedFrom, timer };
}

function isPurpose(v: unknown): v is SeilinkStagePurpose {
  return typeof v === 'string' && (SEILINK_STAGE_PURPOSES as readonly string[]).includes(v);
}

function isOpenedFrom(v: unknown): v is EditorOpenedFrom {
  return typeof v === 'string' && (EDITOR_OPENED_FROM as readonly string[]).includes(v);
}

function isVia(v: unknown): v is SeilinkOfferVia {
  return v === 'intro' || v === 'move_in';
}

/** seilink:stage, for the main window. Exported for tests. */
export function handleStage(win: BrowserWindow, raw: unknown): SeilinkStageResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.action === 'enter') {
    const purpose = isPurpose(r.purpose) ? r.purpose : 'editor';
    const characterId = isRoomCharacterId(r.characterId) ? r.characterId : null;
    const openedFrom = purpose === 'editor' && isOpenedFrom(r.openedFrom) ? r.openedFrom : null;
    if (purpose === 'editor') clearWaiting();
    const fail = (error: SeilinkStageError): SeilinkStageResult => {
      capture({ action: 'failed', purpose, opened_from: openedFrom, error_class: error, character_id: characterId });
      // The surface stays in the app window: make sure it can be seen.
      showWindow(win);
      return { ok: false, error };
    };
    if (!characterId) return fail('failed');
    if (!seilinkEnabled()) return fail('disabled');
    const res = enterDesktopStage(win);
    if (!res.ok) return fail(res.error);
    onStage = { purpose, characterId, openedFrom };
    capture({ action: 'entered', purpose, opened_from: openedFrom, character_id: characterId });
    return res.frame ? { ok: true, frame: res.frame } : { ok: true };
  }
  if (r.action === 'exit') {
    const reveal = r.reveal === true;
    const was = onStage;
    onStage = null;
    if (!isStaged(win)) return { ok: false, error: 'failed' };
    const res = exitDesktopStage(win, reveal);
    capture({
      action: 'exited',
      purpose: was?.purpose ?? 'editor',
      opened_from: was?.openedFrom ?? null,
      reveal,
      ok: res.ok,
      staged_ms: res.stagedMs,
      character_id: was?.characterId ?? null,
    });
    return res.ok ? { ok: true } : { ok: false, error: 'failed' };
  }
  if (r.action === 'reveal') {
    const purpose = isPurpose(r.purpose) ? r.purpose : 'editor';
    const characterId = isRoomCharacterId(r.characterId) ? r.characterId : null;
    if (!seilinkEnabled()) return { ok: false, error: 'disabled' };
    const ok = revealDesktop(win);
    capture({ action: ok ? 'revealed' : 'failed', purpose, character_id: characterId, ...(ok ? {} : { error_class: 'failed' }) });
    return ok ? { ok: true } : { ok: false, error: 'failed' };
  }
  return { ok: false, error: 'failed' };
}

function osName(): 'mac' | 'windows' | 'linux' {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
}

/** seilink:stage minimize_others (261110). Exported for tests. */
export async function handleMinimizeOthers(raw: unknown): Promise<SeilinkStageResult> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const surface = r.surface === 'live_card' ? 'live_card' : 'other';
  if (!seilinkEnabled()) return { ok: false, error: 'disabled' };
  const res = await minimizeOtherWindows().catch(() => ({ ok: false as const, error: 'failed' as const }));
  const props = sanitizeSeilinkSetupTrack(SEILINK_MINIMIZE_EVENT, {
    outcome: res.ok ? 'ok' : res.error,
    windows: res.ok ? res.minimized : undefined,
    surface,
    os: osName(),
  });
  void loadAnalytics()
    .then((a) => a.capture(SEILINK_MINIMIZE_EVENT, props))
    .catch(() => {});
  if (!res.ok) return { ok: false, error: res.error };
  return res.minimized !== undefined ? { ok: true, minimized: res.minimized } : { ok: true };
}

export function initStageFlow(d: StageFlowDeps): void {
  deps = d;
  if (registered) return;
  registered = true;
  ipcMain.handle(IpcChannel.seilink.stage, async (e, raw: unknown): Promise<SeilinkStageResult> => {
    const win = deps?.getMainWindow() ?? null;
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return { ok: false, error: 'no_window' };
    if ((raw as { action?: unknown } | null)?.action === 'minimize_others') return handleMinimizeOthers(raw);
    return handleStage(win, raw);
  });
  ipcMain.handle(IpcChannel.seilink.offer, async (_e, raw: unknown): Promise<{ shown: boolean }> => {
    const a = (raw ?? {}) as { characterId?: unknown; via?: unknown };
    if (!isRoomCharacterId(a.characterId) || !isVia(a.via)) return { shown: false };
    const r = await offerDecorateTogether(a.characterId, a.via).catch(() => ({ shown: false as const }));
    return { shown: r.shown };
  });
  // The renderer reloaded (or a new main window came up) while on the stage: give the window back.
  ipcMain.on(IpcChannel.app.rendererReady, (e) => {
    const win = deps?.getMainWindow() ?? null;
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !isStaged(win)) return;
    handleStage(win, { action: 'exit', reveal: false });
  });
}

export function __resetStageFlowForTest(): void {
  clearWaiting();
  onStage = null;
  deps = null;
}
