/**
 * The macOS side of the one-click DST helper install (260925): the real
 * MacGrant that install.ts's grantAndInstall drives. Kept apart from
 * install.ts so that file never imports electron.
 *
 * Measured on a signed v0.6.5-beta.2 with App Management off
 * (~/suisei/reports/dst-grant-test-260925):
 *   - Open panel: choosing `Contents/mods` (or the whole .app) writes a
 *     com.apple.macl grant; after it Sei can mkdir, copy, delete and rewrite
 *     modsettings.lua inside that folder, and the grant survives a Sei
 *     restart. Writes outside the chosen folder stay EPERM.
 *   - Finder: `duplicate ... with replacing` sent through /usr/bin/osascript
 *     shows one "Sei wants access to control Finder" prompt and then works
 *     (Finder is exempt from App Management). The Apple Event is sent by
 *     osascript, not by Sei, so no automation entitlement is needed under the
 *     hardened runtime; NSAppleEventsUsageDescription (electron-builder.yml
 *     mac.extendInfo) is the prompt's explanation line.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import type { MacGrant } from './install';

/** The panel copy. Short, no em dashes (house rule). */
export const GRANT_COPY = {
  en: {
    message: 'macOS needs your OK once. Click Install helper to let Sei add its helper to Don\'t Starve Together.',
    hint: 'That was a different folder. Click Install helper while the "mods" folder is open.',
    button: 'Install helper',
  },
  zh: {
    message: 'macOS 需要你确认一次。点击“安装助手”，让 Sei 把助手添加到《饥荒联机版》。',
    hint: '选的不是这个文件夹。请在打开“mods”文件夹时直接点击“安装助手”。',
    button: '安装助手',
  },
} as const;

/**
 * Finder copy with the paths as argv, so a path with a quote in it (every DST
 * path has one: "Don't Starve Together") needs no AppleScript escaping.
 */
const FINDER_SCRIPT = [
  'on run argv',
  'set dest to (POSIX file (item 1 of argv)) as alias',
  'set srcs to {}',
  'repeat with i from 2 to count of argv',
  'set end of srcs to ((POSIX file (item i of argv)) as alias)',
  'end repeat',
  'with timeout of 300 seconds',
  'tell application "Finder" to duplicate srcs to dest with replacing',
  'end timeout',
  'end run',
];

/** Long enough for a player to read the Automation prompt and answer it. */
const FINDER_TIMEOUT_MS = 310_000;

export function finderDuplicateArgs(sources: string[], destDir: string): string[] {
  return [...FINDER_SCRIPT.flatMap((line) => ['-e', line]), destDir, ...sources];
}

async function fileModes(dir: string): Promise<{ rel: string; mode: number }[]> {
  const out: { rel: string; mode: number }[] = [];
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(r);
      else if (entry.isFile()) out.push({ rel: r, mode: (await stat(path.join(dir, r))).mode });
    }
  }
  await walk('');
  return out;
}

export function createMacGrant(opts: { window: BrowserWindow | null; language: 'en' | 'zh' }): MacGrant {
  const copy = GRANT_COPY[opts.language];
  return {
    async pickFolder({ defaultPath, hint }) {
      const { dialog } = await import('electron');
      const options: OpenDialogOptions = {
        defaultPath,
        properties: ['openDirectory', 'treatPackageAsDirectory', 'createDirectory'],
        buttonLabel: copy.button,
        message: hint ? `${copy.hint} ${copy.message}` : copy.message,
      };
      const win = opts.window && !opts.window.isDestroyed() ? opts.window : null;
      const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    },
    finderDuplicate: (sources, destDir) =>
      new Promise((resolve, reject) => {
        execFile('/usr/bin/osascript', finderDuplicateArgs(sources, destDir), { timeout: FINDER_TIMEOUT_MS }, (err, _stdout, stderr) => {
          if (err) reject(new Error(`Finder copy failed: ${String(stderr || err.message).trim()}`));
          else resolve();
        });
      }),
    realpath: (p) => realpath(p),
    makeTempDir: () => mkdtemp(path.join(tmpdir(), 'sei-dst-')),
    fileModes,
    chmod: (p, mode) => chmod(p, mode),
  };
}
