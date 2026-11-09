/**
 * Fakes of Electron's login item API for the 261107 open-at-login tests
 * (openAtLogin.test.ts, legacyTrayCleanup.openAtLogin.test.ts):
 * macOS SMAppService status, Windows HKCU Run values + StartupApproved.
 */
import { WIN_RUN_NAME, type OpenAtLoginDeps } from '../openAtLogin';

type MacStatus = 'enabled' | 'requires-approval' | 'not-registered' | 'not-found';

export class FakeMac {
  status: MacStatus = 'not-registered';
  /** The next register asks the user for approval (macOS 13+). */
  needsApproval = false;
  /** macOS 12: no status field. */
  legacy = false;
  throwOnSet = false;
  ignoreSet = false;
  set = (s: Electron.Settings): void => {
    if (this.throwOnSet) throw new Error('SMAppService register failed');
    if (this.ignoreSet) return;
    this.status = s.openAtLogin ? (this.needsApproval ? 'requires-approval' : 'enabled') : 'not-registered';
  };
  get = (): Electron.LoginItemSettings =>
    ({
      openAtLogin: this.status === 'enabled',
      ...(this.legacy ? {} : { status: this.status }),
      wasOpenedAtLogin: false,
      launchItems: [],
    }) as unknown as Electron.LoginItemSettings;
}

export class FakeWin {
  /** HKCU Run: value name -> exe + args, and StartupApproved enabled. */
  run = new Map<string, { path: string; args: string[]; enabled: boolean }>();
  constructor(private readonly aumid = 'com.sei.app') {}
  set = (s: Electron.Settings): void => {
    const name = s.name ?? this.aumid;
    // Electron deletes by name only, whatever the path and args.
    if (!s.openAtLogin) {
      this.run.delete(name);
      return;
    }
    this.run.set(name, { path: s.path ?? 'C:\\Electron\\electron.exe', args: s.args ?? [], enabled: s.enabled ?? true });
  };
  get = (o?: Electron.LoginItemSettingsOptions): Electron.LoginItemSettings => {
    const want = ((o as { path?: string } | undefined)?.path ?? '').toLowerCase();
    const launchItems = [...this.run.entries()]
      .filter(([, v]) => v.path.toLowerCase() === want)
      // Like Electron on Windows: args come from Chromium's CommandLine::GetArgs(),
      // which drops every switch (`--seilink-login` included), keeping loose args only.
      .map(([name, v]) => ({ name, path: v.path, args: v.args.filter((x) => !/^(--|-|\/)/.test(x)), scope: 'user' as const, enabled: v.enabled }));
    return { openAtLogin: false, launchItems, executableWillLaunchAtLogin: launchItems.some((i) => i.enabled) } as unknown as Electron.LoginItemSettings;
  };
  /** The user turns it off in Task Manager (StartupApproved). */
  disable(name = WIN_RUN_NAME): void {
    const v = this.run.get(name);
    if (v) v.enabled = false;
  }
}

export const NSIS_EXE = 'C:\\Users\\robin\\AppData\\Local\\Programs\\sei\\Sei.exe';
export const VELO_EXE = 'C:\\Users\\robin\\AppData\\Local\\Sei\\current\\Sei.exe';
/** The Velopack root stub (runs `Update.exe start -- <args>`). */
export const VELO_STUB = 'C:\\Users\\robin\\AppData\\Local\\Sei\\Sei.exe';

export function fakeDeps(
  fake: FakeMac | FakeWin,
  f: string,
  ev: Array<[string, Record<string, unknown>]>,
  over: Partial<OpenAtLoginDeps> = {},
): OpenAtLoginDeps {
  const mac = fake instanceof FakeMac;
  return {
    platform: mac ? 'darwin' : 'win32',
    isPackaged: true,
    execPath: mac ? '/Applications/Sei.app/Contents/MacOS/Sei' : NSIS_EXE,
    seilinkSupported: () => true,
    filePath: f,
    getLoginItemSettings: fake.get,
    setLoginItemSettings: fake.set,
    capture: (e, p) => ev.push([e, p]),
    log: () => {},
    ...over,
  };
}
