/**
 * Leftover cleanup for the retired menu bar / tray mode (261010).
 *
 * v0.6.8-beta.1 and beta.2 shipped an opt-in "keep Sei in the menu bar /
 * system tray" setting with a "free play is back" notification (T73). It was
 * removed before the 0.6.8 stable. Its state lived in one device-global file,
 * `<userData>/tray-settings.json`; with the opt-in on and "Start Sei when I
 * log in" checked, Sei also registered an OS login item.
 *
 * Nothing reads that file any more, so the tray icon, close-to-tray and the
 * notification are simply gone. The login item is the one piece that lives
 * outside the app: left alone, Sei would keep opening at every login. This
 * runs once at launch, removes the login item when the file says Sei
 * registered it (`login_item_registered`, so a login item the user added by
 * hand on macOS 12 survives), then deletes the file.
 *
 * Best-effort and synchronous-cheap: a missing file is the common case and
 * returns at once; a corrupt file is just deleted; nothing here throws. If
 * removing the login item fails, the file stays so the next launch retries.
 * Can be deleted once no beta.1/beta.2 installs remain.
 *
 * 261107: "Open Sei when I log in" (seilink/openAtLogin.ts) registers a login
 * item of its own, and this cleanup must never remove it:
 *  - Windows: the retired item was the Run value named after the
 *    AppUserModelId (Electron's default name, and Electron deletes by name);
 *    the new one is WIN_RUN_NAME, so this removal cannot reach it.
 *  - macOS: both are the app's one login item. When Sei's new setting holds
 *    it (`ownedByOpenAtLogin`), the file is deleted and the item is left.
 * Order at launch: this cleanup first, then syncOpenAtLoginAtLaunch, which
 * reads the OS state this cleanup left (on Windows it puts back a missing
 * item the user wants). legacyTrayCleanup.openAtLogin.test.ts pins both.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { paths } from './paths';
import { OPEN_AT_LOGIN_FILE, openAtLoginOwnsLoginItem } from './seilink/openAtLogin';

/** argv marker the retired Windows login item was registered with. */
const LEGACY_HIDDEN_ARG = '--hidden';

export interface LegacyTrayCleanupDeps {
  filePath: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  setLoginItemSettings: (settings: Electron.Settings) => void;
  /** macOS: the "Open Sei when I log in" setting holds the app's login item now (see the header). */
  ownedByOpenAtLogin: () => boolean;
  log: (msg: string) => void;
}

export function legacyTraySettingsPath(): string {
  return path.join(paths.userData(), 'tray-settings.json');
}

function defaultDeps(): LegacyTrayCleanupDeps {
  return {
    filePath: legacyTraySettingsPath(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    setLoginItemSettings: (s) => app.setLoginItemSettings(s),
    ownedByOpenAtLogin: () => openAtLoginOwnsLoginItem(path.join(paths.userData(), OPEN_AT_LOGIN_FILE)),
    log: (m) => console.log(`[sei] legacy tray cleanup: ${m}`),
  };
}

/** Returns what it did, for tests and the log. Never throws. */
export function cleanupLegacyTraySettings(
  deps: LegacyTrayCleanupDeps = defaultDeps(),
): 'none' | 'removed' | 'removed-with-login-item' | 'login-item-failed' {
  try {
    if (!existsSync(deps.filePath)) return 'none';
    let registered = false;
    try {
      const raw = JSON.parse(readFileSync(deps.filePath, 'utf8')) as Record<string, unknown> | null;
      registered = !!raw && typeof raw === 'object' && raw.login_item_registered === true;
    } catch {
      // Corrupt file: nothing to trust in it, just remove it.
    }
    let ownsLoginItem =
      registered && deps.isPackaged && (deps.platform === 'darwin' || deps.platform === 'win32');
    if (ownsLoginItem && deps.platform === 'darwin') {
      let taken = true;
      try {
        taken = deps.ownedByOpenAtLogin();
      } catch {
        // Cannot tell: leave the item (a stray login item is better than a lost one).
      }
      if (taken) {
        deps.log('login item now belongs to the open-at-login setting; leaving it');
        ownsLoginItem = false;
      }
    }
    if (ownsLoginItem) {
      try {
        if (deps.platform === 'win32') {
          // Same path + args as the registration, or Windows treats it as a
          // different entry and leaves the original in place.
          deps.setLoginItemSettings({ openAtLogin: false, path: deps.execPath, args: [LEGACY_HIDDEN_ARG] });
        } else {
          deps.setLoginItemSettings({ openAtLogin: false, openAsHidden: false });
        }
      } catch (err) {
        deps.log(`login item removal failed, retrying next launch: ${(err as Error).message}`);
        return 'login-item-failed';
      }
    }
    unlinkSync(deps.filePath);
    deps.log(ownsLoginItem ? 'removed tray settings and login item' : 'removed tray settings');
    return ownsLoginItem ? 'removed-with-login-item' : 'removed';
  } catch (err) {
    try {
      deps.log(`failed: ${(err as Error).message}`);
    } catch {
      /* ignore */
    }
    return 'none';
  }
}
