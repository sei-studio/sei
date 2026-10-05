/**
 * Keep Sei in the menu bar / tray (261005, retention fix 2b).
 *
 * Opt-in, off by default (Settings > Background, or one click on the credit
 * wall's prompt). While it is on:
 *   - closing the main window HIDES it instead of quitting (Windows) or
 *     destroying it (macOS); live sessions keep running, the way a chat app
 *     in the tray keeps its call. Quit from the icon's menu (or Cmd+Q) ends
 *     everything through the normal before-quit chain.
 *   - a menu bar icon (macOS, template image) / tray icon (Windows) offers
 *     Open Sei, a status line when free play is paused, Restart to update
 *     when one is staged, and Quit Sei.
 *   - the optional login item starts Sei hidden in the tray at login
 *     (Windows: the --hidden arg; macOS: wasOpenedAtLogin).
 *   - the refill notifier (refillNotifier.ts) can post "free play is back".
 *
 * Supported on macOS and Windows only. On Linux every entry point is a no-op
 * and the Settings rows are hidden: tray support there depends on the
 * desktop environment and nothing here can be verified on it. Every Electron
 * call that can throw on an odd platform/build is wrapped, so a tray failure
 * leaves the app exactly as it was without the feature (in particular, the
 * close button only hides when an icon actually exists to bring it back).
 */
import { app, type BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, Tray } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { IpcChannel } from '../../shared/ipc';
import type { TraySettingsView } from '../../shared/trayIpc';
import { formatResetLine } from '../../shared/freePlayReset';
import { getTrayState, updateTrayState, type TrayState } from './trayStateStore';
import { createRefillNotifier, type RefillNotifier, type RefillStatus } from './refillNotifier';
import { notificationLanguage, pickActiveCompanion, refillNotificationText, trayMenuText, type MenuLang } from './refillCopy';
import { setCreditWallListener } from './wallHook';

/** argv marker the Windows login item passes; a launch carrying it starts hidden. */
export const HIDDEN_ARG = '--hidden';
/** The locked appId (electron-builder.yml). Windows toasts need the process AUMID to match the shortcut's. */
const APP_USER_MODEL_ID = 'com.sei.app';

const logger = {
  info: (m: string) => console.log(`[sei] tray: ${m}`),
  warn: (m: string) => console.warn(`[sei] tray: ${m}`),
};

export function isTraySupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export interface TrayDeps {
  getMainWindow: () => BrowserWindow | null;
  /** Show, restore and focus the main window (recreating it if it is gone). */
  showMainWindow: () => void;
  isUpdateReady: () => boolean;
  installUpdate: () => void;
  capture: (event: string, props?: Record<string, unknown>) => void;
}

let deps: TrayDeps | null = null;
let tray: Tray | null = null;
let notifier: RefillNotifier | null = null;
let quitting = false;
let menuLang: MenuLang = 'en';
// Live notifications, held so they are not garbage-collected before a click.
const liveNotifications = new Set<Notification>();

/**
 * Whether this launch should start hidden in the tray: the setting and the
 * login item are on, and the OS says this was a login launch. Safe to call
 * before app 'ready' work starts (sync read). Never throws.
 */
export function shouldStartHidden(argv: readonly string[] = process.argv): boolean {
  try {
    if (!isTraySupported()) return false;
    const s = getTrayState();
    if (!s.enabled || !s.open_at_login) return false;
    if (process.platform === 'win32') return argv.includes(HIDDEN_ARG);
    const login = app.getLoginItemSettings();
    return login.wasOpenedAtLogin === true || login.wasOpenedAsHidden === true;
  } catch {
    return false;
  }
}

/** True while the close button should hide to the tray instead of closing. */
export function isCloseToTrayActive(): boolean {
  return !quitting && tray !== null && isTraySupported() && getTrayState().enabled;
}

/**
 * Intercept the main window's close while the tray is active. A fullscreen
 * window on macOS is taken out of fullscreen first (hiding it in place leaves
 * an empty black Space).
 */
export function attachCloseToTray(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!isCloseToTrayActive()) return;
    e.preventDefault();
    try {
      if (process.platform === 'darwin' && win.isFullScreen()) {
        win.once('leave-full-screen', () => {
          if (!win.isDestroyed()) win.hide();
        });
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    } catch (err) {
      logger.warn(`hide failed: ${(err as Error).message}`);
    }
  });
  // Windows logoff / shutdown closes windows directly; never stand in its way.
  const letGo = (): void => {
    quitting = true;
  };
  win.on('query-session-end', letGo);
  win.on('session-end', letGo);
}

/** Re-read the UI language for the menu and the confirmation line. Never throws. */
async function refreshMenuLang(): Promise<void> {
  try {
    const { loadConfig } = await import('../configStore');
    menuLang = (await loadConfig()).ui_language === 'zh' ? 'zh' : 'en';
  } catch {
    /* keep the last value */
  }
}

function iconPath(file: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray', file)
    : path.join(app.getAppPath(), 'build', 'tray', file);
}

function buildMenu(): Menu {
  const words = trayMenuText(menuLang);
  const items: Electron.MenuItemConstructorOptions[] = [];
  const status = statusLine();
  if (status) {
    items.push({ label: status, enabled: false }, { type: 'separator' });
  }
  items.push({ label: words.open, click: () => deps?.showMainWindow() });
  let updateReady = false;
  try {
    updateReady = deps?.isUpdateReady() ?? false;
  } catch {
    /* updater not loaded */
  }
  if (updateReady) items.push({ label: words.update, click: () => deps?.installUpdate() });
  items.push({ type: 'separator' }, { label: words.quit, click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

/** "Free play resets tomorrow (Saturday, Sep 27)" while a wall is waiting, else null. */
function statusLine(): string | null {
  const s = getTrayState();
  if (!s.wall) return null;
  const line = formatResetLine(s.wall.resets_at, Date.now(), { lang: menuLang, plan: s.wall.plan ?? 'free' });
  return line ? line.replace(/[.。]$/, '') : null;
}

function createTray(): void {
  if (tray || !isTraySupported()) return;
  try {
    const isMac = process.platform === 'darwin';
    const image = nativeImage.createFromPath(iconPath(isMac ? 'trayTemplate.png' : 'tray.ico'));
    if (image.isEmpty()) {
      logger.warn('tray icon missing; not creating the tray');
      return;
    }
    if (isMac) image.setTemplateImage(true);
    const t = new Tray(image);
    t.setToolTip('Sei');
    const popMenu = (): void => {
      // The UI language can change in Settings at any time; read it per open.
      void refreshMenuLang().then(() => {
        try {
          if (tray === t) t.popUpContextMenu(buildMenu());
        } catch (err) {
          logger.warn(`menu failed: ${(err as Error).message}`);
        }
      });
    };
    if (isMac) {
      // macOS menu bar convention: any click opens the menu. Built on every
      // open so the status line and the update item are current.
      t.on('click', popMenu);
      t.on('right-click', popMenu);
    } else {
      // Windows convention: click opens the app, right-click the menu.
      t.on('click', () => deps?.showMainWindow());
      t.on('double-click', () => deps?.showMainWindow());
      t.on('right-click', popMenu);
    }
    tray = t;
    logger.info('created');
  } catch (err) {
    logger.warn(`create failed: ${(err as Error).message}`);
    tray = null;
  }
}

function destroyTray(): void {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
  // The window may be hidden right now with no icon left to bring it back.
  const win = deps?.getMainWindow();
  if (win && !win.isDestroyed() && !win.isVisible()) deps?.showMainWindow();
}

/** Point the OS login item at the current setting. Packaged builds only. */
function applyLoginItem(s: TrayState): void {
  if (!isTraySupported()) return;
  const want = s.enabled && s.open_at_login;
  if (!app.isPackaged) {
    // In dev this would register the bare Electron binary as a login item.
    logger.info(`login item (dev, not applied): ${want ? 'on' : 'off'}`);
    return;
  }
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: want, path: process.execPath, args: [HIDDEN_ARG] });
    } else {
      // openAsHidden only works before macOS 13; on 13+ the launch is
      // recognised through wasOpenedAtLogin instead (shouldStartHidden).
      app.setLoginItemSettings({ openAtLogin: want, openAsHidden: want });
    }
  } catch (err) {
    logger.warn(`login item failed: ${(err as Error).message}`);
  }
}

function loginNeedsApproval(s: TrayState): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged || !s.enabled || !s.open_at_login) return false;
  try {
    return app.getLoginItemSettings().status === 'requires-approval';
  } catch {
    return false;
  }
}

export function getTraySettingsView(): TraySettingsView {
  const s = getTrayState();
  const supported = isTraySupported();
  return {
    supported,
    enabled: supported && s.enabled,
    openAtLogin: supported && s.enabled && s.open_at_login,
    loginNeedsApproval: supported && loginNeedsApproval(s),
    wallPromptSeen: s.wall_prompt_seen,
  };
}

function applyState(s: TrayState): void {
  if (isTraySupported() && s.enabled) createTray();
  else destroyTray();
  applyLoginItem(s);
  notifier?.replan();
}

/**
 * macOS asks the user to allow notifications the first time an app posts
 * one. Post a single confirmation when the setting is turned on, so that
 * question comes up now, in context, and not in place of the refill
 * notification itself days later.
 */
function confirmEnabledOnMac(): void {
  if (process.platform !== 'darwin') return;
  try {
    if (!Notification.isSupported()) return;
    const body =
      menuLang === 'zh'
        ? 'Sei 会留在菜单栏里，免费游玩恢复时会提醒你。'
        : "Sei will stay in your menu bar and let you know when free play is back.";
    const n = new Notification({ title: 'Sei', body, silent: true });
    hold(n);
    n.show();
  } catch {
    /* best-effort */
  }
}

function hold(n: Notification): void {
  liveNotifications.add(n);
  const drop = (): void => {
    liveNotifications.delete(n);
  };
  n.on('close', drop);
  n.on('failed', drop);
  // A notification that sits in Notification Center still needs its click
  // handler alive; let go after a day at the latest.
  setTimeout(drop, 86_400_000).unref?.();
}

const SetArgsSchema = z.object({
  enabled: z.boolean().optional(),
  openAtLogin: z.boolean().optional(),
  source: z.enum(['settings', 'wall_prompt']),
});

async function setSettings(raw: unknown): Promise<TraySettingsView> {
  const args = SetArgsSchema.parse(raw);
  if (!isTraySupported()) return getTraySettingsView();
  const before = getTrayState();
  const next = await updateTrayState((s) => {
    const enabled = args.enabled ?? s.enabled;
    return {
      ...s,
      enabled,
      // Off takes the login item with it: a login launch without the tray
      // would just open a window at every boot.
      open_at_login: enabled ? (args.openAtLogin ?? s.open_at_login) : false,
      // Accepting the wall prompt also counts as having seen it.
      wall_prompt_seen: s.wall_prompt_seen || args.source === 'wall_prompt',
    };
  });
  applyState(next);
  if (next.enabled !== before.enabled || next.open_at_login !== before.open_at_login) {
    deps?.capture('tray_setting_changed', {
      enabled: next.enabled,
      login_item: next.open_at_login,
      source: args.source,
    });
    if (next.enabled && !before.enabled) void refreshMenuLang().then(confirmEnabledOnMac);
  }
  return getTraySettingsView();
}

async function fetchRefillStatus(): Promise<RefillStatus | null> {
  try {
    const { getClient } = await import('../auth/supabaseClient');
    const { data, error } = await getClient().auth.getSession();
    // An expired JWT whose refresh failed (no network yet on wake or at a
    // login launch) comes back as session null WITH an error. That is a failed
    // read (retry), not a signed-out user (hold without re-arming).
    if (error) throw error;
    const userId = data.session?.user?.id ?? null;
    if (!userId) return { userId: null, cloud: false, over_limit: false, plan: 'free', resets_at: '' };
    const { creditsGet } = await import('../cloud/proxyClient');
    const s = await creditsGet();
    return {
      userId,
      cloud: s.ai_backend_kind === 'cloud-proxy',
      over_limit: s.over_limit,
      plan: s.plan,
      resets_at: s.resets_at,
    };
  } catch (err) {
    logger.warn(`status read failed: ${(err as Error).message}`);
    return null;
  }
}

async function postRefillNotification(
  status: RefillStatus,
  onClick: () => void,
): Promise<Record<string, unknown> | null> {
  try {
    if (!Notification.isSupported()) return null;
  } catch {
    return null;
  }
  let lang: ReturnType<typeof notificationLanguage> = 'en';
  let name: string | null = null;
  try {
    const { loadConfig } = await import('../configStore');
    lang = notificationLanguage(await loadConfig());
  } catch {
    /* English */
  }
  try {
    const { listCharacters } = await import('../characterStore');
    name = pickActiveCompanion(await listCharacters())?.name ?? null;
  } catch {
    /* "Sei" as the sender */
  }
  const { title, body } = refillNotificationText({ name, lang, plan: status.plan });
  const n = new Notification({ title, body });
  hold(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    onClick();
  });
  n.show();
  return { lang, has_companion: name !== null };
}

/**
 * Wire everything: IPC handlers, quit flags, the icon (when the setting is
 * on), the login item and the refill notifier. Call once from bootstrap after
 * the main window exists. Never throws.
 */
let initialized = false;

export function initTray(d: TrayDeps): void {
  deps = d;
  // A macOS re-bootstrap (dock click with no window) calls this again; the
  // handlers and listeners are already in place.
  if (initialized) {
    applyState(getTrayState());
    return;
  }
  initialized = true;
  ipcMain.handle(IpcChannel.tray.get, async () => getTraySettingsView());
  ipcMain.handle(IpcChannel.tray.set, async (_e, raw: unknown) => setSettings(raw));
  ipcMain.handle(IpcChannel.tray.markWallPromptSeen, async () => {
    if (!getTrayState().wall_prompt_seen) await updateTrayState((s) => ({ ...s, wall_prompt_seen: true }));
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  if (isTraySupported()) {
    // quitAndInstall (Squirrel.Mac) closes the windows BEFORE before-quit
    // fires; electron-updater emits this on Electron's autoUpdater first on
    // both platforms. Lazy, so nothing touches autoUpdater at module load.
    void import('electron')
      .then(({ autoUpdater }) => {
        autoUpdater.on('before-quit-for-update', () => {
          quitting = true;
        });
      })
      .catch(() => {
        /* no native updater in this build */
      });
  }
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    } catch {
      /* toasts may not show; nothing else depends on it */
    }
  }

  notifier = createRefillNotifier({
    getState: getTrayState,
    updateState: (fn) => updateTrayState(fn),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    fetchStatus: fetchRefillStatus,
    isWindowFocused: () => {
      const win = d.getMainWindow();
      return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
    },
    notify: postRefillNotification,
    openApp: () => d.showMainWindow(),
    capture: d.capture,
    log: logger.info,
  });
  setCreditWallListener(() => void notifier?.noteWall());
  try {
    // Timers do not run while the machine sleeps; re-plan on wake.
    powerMonitor.on('resume', () => notifier?.replan());
  } catch {
    /* powerMonitor unavailable */
  }

  void refreshMenuLang();
  applyState(getTrayState());
}
